/**
 * 进程外链路的自检：服务端用 SDK 连自己。
 *
 * ## 为什么要有这个端点
 *
 * `@ryharness/sdk` 是**给外部程序用的库**——它被外部程序 import，服务端不会
 * import 它。但「库写好了没人用过」是本轮要消灭的那类死代码，所以这里给它一个
 * 真实的用法：**把同一套远程服务挂上一条内存管道，用 SDK 连上去，问它一句话**。
 *
 * 这条链路一旦坏了（协议改了、分帧错了、SDK 与服务端对不上），这个端点就会
 * 报错——而它是**真的跑一遍**，不是模拟：请求真的走 JSON-RPC 帧、真的过网关、
 * 真的按人写的方法签名注解校验参数。
 *
 * ## 为什么在进程内而不是起子进程
 *
 * 起子进程那条路**在任何环境下都跑不起来**：
 * - 源码下 `node main.ts` 起不来（Node 的 type stripping 不支持参数属性这种写法）；
 * - 打包后 `main.ts` 根本不在（dist 里是 `main.js`）；
 * - 而且子进程默认还要抢 32100 端口——主服务正占着它，撞上就是 listen 失败，
 *   而 listen 失败在没有 error 监听时是**未捕获异常**，进程直接消失。
 *
 * 进程内这条路的代价是「测不到被外部程序拉起」这一段；那一段由 `--rpc` 开关本身
 * 保证（外部程序走的就是同一条 `startRpcEndpoint`），selfcheck 要保证的是
 * **协议对得上**。
 *
 * ## 它做什么、不做什么
 *
 * 发一次**只读**的真调用（`listConversations`，limit=1）：`remote/graph` 与
 * `remote/call` 是网关的两条分发路径，只问类型图等于只验了一半——业务方法
 * 真的能走通一轮，协议或参数校验坏了才会在这里炸。仍然不做任何有副作用的
 * 操作（不发消息、不写设置）。
 *
 * @module @ryharness/server/rpc/selfcheck
 */

import { RemoteHost, type RemoteMemoryHit } from '@ryharness/api'
import { RyHarnessClient } from '@ryharness/sdk'
import type { SessionStore } from '@ryharness/session'
import { createMemoryTransportPair } from '@ryharness/typert-gateway'
import { RyHarnessRemoteService } from './service.ts'

/** 自检需要的依赖（与服务端跑的是同一套）。 */
export interface RpcSelfCheckDeps {
  /** 会话存储（远程服务要用）。 */
  readonly store: SessionStore
  /** 列当前注册着的工具。 */
  readonly listTools: () => readonly { name: string; description: string }[]
  /** 召回一位助理的长期记忆（条目带分数/时间/来源，见 RemoteMemoryHit）。 */
  readonly recallMemory: (agentId: string, query: string) => Promise<readonly RemoteMemoryHit[]>
  /** 写一条应用设置。 */
  readonly writeSetting: (key: string, value: string) => Promise<void>
}

/** 自检的结果。 */
export interface RpcSelfCheckResult {
  /** 通不通。 */
  readonly ok: boolean
  /** 宿主暴露的类型图里有多少个服务。 */
  readonly serviceCount: number
  /** 失败时的说明。 */
  readonly error?: string
}

/**
 * 跑一次自检：挂上远程服务，用 SDK 连上去，取一张类型图。
 *
 * @param deps - 与服务端跑的是同一套依赖。
 * @returns 自检结果（**不抛异常**：失败也是一条结果，端点据此回 200 与失败说明）。
 */
export async function runRpcSelfCheck(deps: RpcSelfCheckDeps): Promise<RpcSelfCheckResult> {
  let host: RemoteHost | undefined
  try {
    const [hostSide, clientSide] = createMemoryTransportPair()
    host = new RemoteHost({ onError: () => {} })
    host.mount({
      namespace: 'ryharness',
      service: new RyHarnessRemoteService({
        store: deps.store,
        listTools: deps.listTools,
        recallMemory: deps.recallMemory,
        writeSetting: deps.writeSetting,
      }),
      serviceKey: 'RyHarness',
      // 方法签名注解：**类型必须由人写**（运行时不读 TS 类型）。
      // 参数名要和实际签名对上——对不上时网关会拒这次调用。
      methods: {
        listConversations: {
          params: [{ name: 'limit', type: 'number', optional: true }],
          returns: 'RyHarnessConversation[]',
        },
        listMessages: {
          params: [
            { name: 'conversationId', type: 'string' },
            { name: 'limit', type: 'number', optional: true },
          ],
          returns: 'RyHarnessMessage[]',
        },
        listTools: { params: [], returns: 'RyHarnessTool[]' },
        recallMemory: {
          params: [
            { name: 'agentId', type: 'string' },
            { name: 'query', type: 'string' },
          ],
          returns: 'RemoteMemoryHit[]',
        },
        writeSetting: {
          params: [
            { name: 'key', type: 'string' },
            { name: 'value', type: 'string' },
          ],
          returns: 'void',
        },
      },
    })
    host.serve(hostSide)

    const client = await RyHarnessClient.attach(clientSide, { timeoutMs: 10_000 })
    try {
      const graph = (await client.graph()) as { services?: unknown[] } | undefined
      const serviceCount = Array.isArray(graph?.services) ? graph.services.length : 0
      // 光有类型图不够：graph 只证明网关能分发一个元方法。发一次真的只读调用
      // （空库也该回数组），remote/call 这条分发路径才算被走过。
      const conversations = await client.listConversations(1)
      if (!Array.isArray(conversations)) {
        throw new Error(`selfcheck: listConversations 没有返回数组（${typeof conversations}）`)
      }
      return { ok: true, serviceCount }
    } finally {
      await client.close().catch(() => {
        // 收尾失败不影响自检结论。
      })
    }
  } catch (error) {
    return {
      ok: false,
      serviceCount: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    host?.close()
  }
}
