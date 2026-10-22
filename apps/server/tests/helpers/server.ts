/**
 * 服务端测试共用的服务夹具。
 *
 * 「起一个带 mock 供应商的服务」这件事，每个服务端测试都要做一遍。抄到各文件里，
 * 重复代码门禁（scripts/verify-duplication.mjs）会判为复制粘贴——它比的是代码
 * 结构（注释与字符串都被剥掉），所以抄来的那一段几乎逐 token 相同。
 *
 * 放这里，各处 import。
 * @module @ryharness/server/tests/helpers/server
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@ryharness/cordis'
import type { EvolveService } from '@ryharness/evolve'
import type { LlmAdapter } from '@ryharness/llm'
import type { MemoryService } from '@ryharness/memory'
import { RyHarnessServer } from '@ryharness/server'

/** 一个跑起来的测试服务（连同它的数据目录，关的时候一起收拾）。 */
export interface MockServer {
  readonly server: RyHarnessServer
  /** 服务的基地址（http://127.0.0.1:端口）。 */
  readonly base: string
  /** 数据目录；重启同一个目录就能测"重启后发生了什么"。 */
  readonly dataDir: string
}

/** 起服务要的东西。 */
export interface MockServerOptions {
  /** 注册到 mock 供应商上的适配器。 */
  adapter: LlmAdapter
  /** 数据目录；不给就现开一个临时目录。 */
  dataDir?: string
  /** 长期记忆服务；null = 关掉。 */
  memory?: MemoryService | null
  /** 进化服务；null = 关掉。 */
  evolution?: EvolveService | null
  /** 主动消息的检查间隔（毫秒）。 */
  proactiveIntervalMs?: number
}

/**
 * 起一个带 mock 供应商的服务。
 *
 * 端口给 0（由系统分配）：测试并行跑时固定端口会互相撞。
 */
export async function startMockServer(options: MockServerOptions): Promise<MockServer> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'ryharness-mock-'))
  const adapter = options.adapter
  const server = await RyHarnessServer.create({
    port: 0,
    dataDir,
    memory: options.memory ?? null,
    evolution: options.evolution ?? null,
    consolidationIntervalMs: 0,
    proactiveIntervalMs: options.proactiveIntervalMs ?? 0,
    mountLlm: (ctx: Context) => {
      ctx.llm.registerAdapter(['mock'], adapter)
    },
  })
  return { server, base: server.url, dataDir }
}

/** 请求一个 JSON 接口，返回状态码与解析后的 body。 */
export async function fetchJson(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, init)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}
