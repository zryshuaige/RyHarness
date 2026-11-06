/**
 * 进程外链路的自检：服务端用 SDK 连自己。
 *
 * ## 为什么要有这个端点
 *
 * `@ryharness/sdk` 是**给外部程序用的库**——它被外部程序 import，服务端不会
 * import 它。但「库写好了没人用过」是本轮要消灭的那类死代码，所以这里给它一个
 * 真实的用法：**服务端起一个自己的 `--rpc` 子进程，用 SDK 连上去，问它一句话**。
 *
 * 这条链路一旦坏了（协议改了、分帧错了、SDK 与服务端对不上），这个端点就会
 * 报错——而它是**真的跑一遍**，不是模拟。
 *
 * ## 它不做什么
 *
 * 不做任何业务操作（不列会话、不发消息）：它只证明「协议对得上」。
 *
 * @module @ryharness/server/rpc/selfcheck
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RyHarnessClient } from '@ryharness/sdk'

/**
 * 服务端自己的入口脚本路径。
 *
 * **按本文件的位置算，不按 cwd**：服务端可能被从任何目录拉起（桌面端内嵌时
 * cwd 是用户的工作目录）。`src/rpc/selfcheck.ts` 往上两级是 `src/`，那里有
 * `main.ts`。
 *
 * **算的时候要防住 jsdom**：vitest 的 jsdom 环境里 `import.meta.url` 是
 * `http://localhost/...` 而不是 `file://`，`fileURLToPath` 会抛「The URL must
 * be of scheme file」。所以这里**不急着算**，等到真要用时再算；真要用的时候
 * 一定是 node 环境，路径是对的。
 */
function computeServerEntry(): string {
  const url = import.meta.url
  if (!url.startsWith('file:')) {
    throw new Error('rpc: 只能在 Node 环境里算出服务端入口路径。')
  }
  return resolve(fileURLToPath(new URL('../main.ts', url)))
}

/**
 * 服务端自己的入口脚本路径（给组合根用）。
 * @returns 入口脚本的绝对路径。
 */
export function serverEntryPath(): string {
  return computeServerEntry()
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
 * 跑一次自检：起一个 `--rpc` 子进程，用 SDK 连上去，取一张类型图。
 *
 * @param options - 起子进程用的命令与参数。
 * @returns 自检结果（**不抛异常**：失败也是一条结果，端点据此回 200 与失败说明）。
 */
export async function runRpcSelfCheck(options: {
  command: string
  args: readonly string[]
}): Promise<RpcSelfCheckResult> {
  let client: RyHarnessClient | undefined
  try {
    client = await RyHarnessClient.spawn({
      command: options.command,
      args: options.args,
      timeoutMs: 20_000,
    })
    const graph = (await client.graph()) as { services?: unknown[] } | undefined
    const serviceCount = Array.isArray(graph?.services) ? graph.services.length : 0
    return { ok: true, serviceCount }
  } catch (error) {
    return {
      ok: false,
      serviceCount: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (client !== undefined) {
      try {
        await client.close()
      } catch {
        // 收尾失败不影响自检结论。
      }
    }
  }
}
