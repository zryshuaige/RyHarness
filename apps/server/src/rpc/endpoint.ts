/**
 * 进程外入口的装配：把能力挂上，开一条 stdio 连接。
 *
 * 两种模式，都是同一个进程、同一条 stdio：
 * - **RPC 模式**（`--rpc`）：给程序调。走 `@ryharness/api` 的 Remote 层，方法名
 *   是 `ryharness.listConversations` 这样的。
 * - **ACP 模式**（`--acp`）：给编辑器用。走 `@ryharness/acp` 的 agent 侧协议，
 *   编辑器把 RyHarness 当 agent 驱动。
 *
 * **stdout 只跑协议**：日志一律走 stderr（见 `stdio.ts` 的说明）。这一条是硬的——
 * 日志混进协议流，对端解析就炸。
 *
 * @module @ryharness/server/rpc/endpoint
 */

import { AcpAgentServer } from '@ryharness/acp'
import { RemoteHost } from '@ryharness/api'
import type { SessionStore } from '@ryharness/session'
import { RyHarnessRemoteService } from './service.ts'
import { createRpcLogger, createStdioTransport } from './stdio.ts'

/** 端点的构造选项。 */
export interface RpcEndpointOptions {
  /** 会话存储（远程服务要用）。 */
  readonly store: SessionStore
  /** 列当前注册着的工具。 */
  readonly listTools: () => readonly { name: string; description: string }[]
  /** 召回一位助理的长期记忆。 */
  readonly recallMemory: (agentId: string, query: string) => Promise<readonly string[]>
  /** 写一条应用设置。 */
  readonly writeSetting: (key: string, value: string) => Promise<void>
  /** ACP 模式下的 agent 能力（只有 ACP 模式要）。 */
  readonly acpHandlers?: ConstructorParameters<typeof AcpAgentServer>[0]['handlers']
}

/**
 * 开一条 stdio RPC 端点。
 *
 * @param options - 依赖。
 * @param mode - 模式：`rpc` 给程序调，`acp` 给编辑器用。
 * @returns 关掉端点的函数。
 */
export function startRpcEndpoint(options: RpcEndpointOptions, mode: 'rpc' | 'acp'): () => Promise<void> {
  const log = createRpcLogger(`ryharness:${mode}`)
  const transport = createStdioTransport()

  if (mode === 'acp') {
    const handlers = options.acpHandlers
    if (handlers === undefined) {
      throw new Error('ACP 模式需要 agent 能力实现（acpHandlers）。')
    }
    const server = new AcpAgentServer({ transport, handlers })
    log('ACP 端点已就绪（stdio）。')
    return async () => {
      server.close()
    }
  }

  const host = new RemoteHost({ onError: (error) => log(`远程调用出错：${String(error)}`) })
  host.mount({
    namespace: 'ryharness',
    service: new RyHarnessRemoteService({
      store: options.store,
      listTools: options.listTools,
      recallMemory: options.recallMemory,
      writeSetting: options.writeSetting,
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
        returns: 'string[]',
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
  host.serve(transport)
  log('RPC 端点已就绪（stdio）。')
  return async () => {
    host.close()
  }
}
