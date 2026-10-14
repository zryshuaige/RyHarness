/**
 * 进化可观测性：GET /api/evolve/stats（轮次耗时与吞吐）与
 * GET /api/evolve/entries/:id/explain（单条 playbook 条目的证据链）。
 *
 * 附带一条更关键的接线断言：巩固（周期调度与手动触发）必须走
 * runUntilIdle —— 巩固是分片的，runOnce 只返回第一片的快照，拿它当整轮结果
 * 等于把没做完的事报成做完了。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@ryagent/cordis'
import type { ConsolidationResult, EvolveService } from '@ryagent/evolve'
import { EvolveService as EvolveServiceImpl } from '@ryagent/evolve'
import type { GenerateOptions, StreamChunk } from '@ryagent/llm'
import { LlmAdapter } from '@ryagent/llm'
import { RyAgentServer } from '@ryagent/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []
const running: RyAgentServer[] = []

function tempDataDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ryagent-evolve-${prefix}-`))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close()
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

class QuietAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'Quiet' }
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

/** 合成一份"整轮跑完"的巩固结果：真跑一遍的数字不会长这样，便于断言。 */
const FULL_ROUND: ConsolidationResult = {
  expiredReflections: 3,
  mergedMemories: 4,
  dormant: 5,
  archivedDormant: 6,
  archivedSuperseded: 7,
  scannedMemories: 1234,
  linkedOrigins: 8,
  errors: 0,
  durationMs: 9,
  pending: false,
  truncated: false,
}

/**
 * 起一个服务，并把它真正使用的 EvolveService 交出来。
 *
 * 传入的实例就是服务端持有的那一个（create 里用 instanceof 判定），因此可以在
 * 实例上包一层计数，用来断言"走的是 runUntilIdle"。`gateFirstRound` 会把第一轮
 * 挂住，制造一个可稳定复现的重叠窗口（并发去重的用例需要）。
 */
async function startServer(
  options: { evolution?: 'off' | 'spy'; consolidationIntervalMs?: number; gateFirstRound?: boolean } = {},
): Promise<{ server: RyAgentServer; runUntilIdleCalls: () => number; releaseFirstRound: () => void }> {
  const dataDir = tempDataDir('server')
  const evolutionMode = options.evolution ?? 'spy'
  let calls = 0
  let releaseGate = (): void => {}
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  let evolution: EvolveService | undefined
  if (evolutionMode === 'spy') {
    const service = new EvolveServiceImpl({ dbPath: join(dataDir, 'ryagent.db') })
    const original = service.runUntilIdle.bind(service)
    service.runUntilIdle = async (now?: number): Promise<ConsolidationResult> => {
      calls += 1
      if (calls === 1 && options.gateFirstRound === true) await gate
      await original(now)
      return FULL_ROUND
    }
    evolution = service
  }
  const server = await RyAgentServer.create({
    port: 0,
    dataDir,
    memory: null,
    ...(evolutionMode === 'off' ? { evolution: null } : evolution === undefined ? {} : { evolution }),
    consolidationIntervalMs: options.consolidationIntervalMs ?? 0,
    mountLlm: (ctx: Context) => {
      ctx.llm.registerAdapter(['mock'], new QuietAdapter())
    },
  })
  running.push(server)
  return { server, runUntilIdleCalls: () => calls, releaseFirstRound: releaseGate }
}

async function getJson(base: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function postJson(
  base: string,
  path: string,
  payload: unknown = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** 轮询到条件成立（或超时）：用来等一个异步状态点而不是睡死一段时间。 */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
  }
  expect(condition()).toBe(true)
}

describe('进化可观测性', () => {
  it('GET /api/evolve/stats 返回轮次快照与按种类合计，limit 收得住条数', async () => {
    const { server } = await startServer()
    const empty = await getJson(server.url, '/api/evolve/stats')
    expect(empty.status).toBe(200)
    expect(empty.body.enabled).toBe(true)
    expect(empty.body.totals).toEqual({ rounds: 0, failures: 0, durationMs: 0, processed: 0 })
    expect(empty.body.droppedTurns).toBe(0)

    await postJson(server.url, '/api/evolve/consolidate')
    const afterConsolidate = await getJson(server.url, '/api/evolve/stats')
    const totals = afterConsolidate.body.totals as { rounds: number }
    expect(totals.rounds).toBeGreaterThanOrEqual(1)
    const byKind = afterConsolidate.body.byKind as Record<string, { rounds: number }>
    expect(byKind.consolidate?.rounds).toBeGreaterThanOrEqual(1)
    const rounds = afterConsolidate.body.rounds as { kind: string; ok: boolean }[]
    expect(rounds.at(0)?.kind).toBe('consolidate')
    expect(rounds.at(0)?.ok).toBe(true)

    const limited = await getJson(server.url, '/api/evolve/stats?limit=1')
    expect((limited.body.rounds as unknown[]).length).toBe(1)
  })

  it('GET /api/evolve/entries/:id/explain 给出条目本体 + 溯源 + 一句人话摘要', async () => {
    const { server } = await startServer()
    const playbook = await getJson(server.url, '/api/agents/ryen/playbook')
    const entries = playbook.body.entries as { id: string }[]
    expect(entries.length).toBeGreaterThan(0)
    const entryId = entries[0]?.id as string

    const explained = await getJson(server.url, `/api/evolve/entries/${entryId}/explain`)

    expect(explained.status).toBe(200)
    const { entry, origins, summary } = explained.body as {
      entry: { id: string }
      origins: unknown[]
      summary: string
    }
    expect(entry.id).toBe(entryId)
    expect(Array.isArray(origins)).toBe(true)
    // 冷启动种子条目没有溯源记录，摘要要说清这一点而不是给一句空话。
    expect(summary.length).toBeGreaterThan(0)
  })

  it('未知条目回 404；进化系统关闭时 stats 说明未启用、explain 回 409', async () => {
    const { server } = await startServer()
    const missing = await getJson(server.url, '/api/evolve/entries/does-not-exist/explain')
    expect(missing.status).toBe(404)
    expect(missing.body.error).toContain('entry not found')

    const off = await startServer({ evolution: 'off' })
    expect((await getJson(off.server.url, '/api/evolve/stats')).body).toEqual({ enabled: false })
    expect((await getJson(off.server.url, '/api/evolve/entries/any/explain')).status).toBe(409)
  })
})

describe('巩固走完整一轮（runUntilIdle）', () => {
  it('手动触发：回包就是 runUntilIdle 的整轮口径，而不是第一片的快照', async () => {
    const { server, runUntilIdleCalls } = await startServer()

    const { status, body } = await postJson(server.url, '/api/evolve/consolidate')

    expect(status).toBe(200)
    expect(body).toEqual({ ...FULL_ROUND })
    expect(body.pending).toBe(false)
    expect(runUntilIdleCalls()).toBe(1)
    // 整轮跑完才记账：/api/memory/stats 的 lastRunAt 要是真跑过的时间戳。
    const stats = await getJson(server.url, '/api/memory/stats')
    expect((stats.body.consolidation as { lastRunAt?: number }).lastRunAt).toBeGreaterThan(0)
  })

  it('周期调度同样走 runUntilIdle（不是只跑第一片就当成整轮）', async () => {
    const { server, runUntilIdleCalls } = await startServer({ consolidationIntervalMs: 20 })

    await waitFor(() => {
      return runUntilIdleCalls() > 0
    })
    const stats = await getJson(server.url, '/api/memory/stats')
    const consolidation = stats.body.consolidation as { intervalMs: number; lastRunAt?: number }
    expect(consolidation.intervalMs).toBe(20)
    expect(consolidation.lastRunAt).toBeGreaterThan(0)
  })

  it('撞上正在跑的一轮时复用同一轮（扫描游标跨调用共享，不能叠加两轮）', async () => {
    const { server, runUntilIdleCalls, releaseFirstRound } = await startServer({ gateFirstRound: true })
    const first = postJson(server.url, '/api/evolve/consolidate')
    await waitFor(() => {
      return runUntilIdleCalls() === 1
    })
    // 第一轮还挂在窗口里就发第二个触发。
    const second = postJson(server.url, '/api/evolve/consolidate')
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
    expect(runUntilIdleCalls()).toBe(1)
    releaseFirstRound()

    for (const result of [await first, await second]) {
      expect(result.status).toBe(200)
      expect(result.body).toEqual({ ...FULL_ROUND })
    }
    expect(runUntilIdleCalls()).toBe(1)
  })
})
