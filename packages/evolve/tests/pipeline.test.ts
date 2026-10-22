/**
 * 每轮进化管线的韧性（超时/失败隔离/过载保护/埋点）与「进化是否真的改变了
 * 后续行为」的链路验证（top-N 选择 → playbook 注入）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EvolveLlm, EvolveServiceOptions } from '@ryharness/evolve'
import { EvolveService } from '@ryharness/evolve'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
function service(llm?: EvolveLlm, limits?: EvolveServiceOptions['limits']): EvolveService {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-pipeline-'))
  dirs.push(dir)
  return new EvolveService({
    dbPath: join(dir, 'e.db'),
    llm,
    logger: () => {},
    ...(limits === undefined ? {} : { limits }),
  })
}

afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      /* Windows 句柄滞后 */
    }
  }
})

const turn = (overrides: Partial<Parameters<EvolveService['enqueueTurn']>[3]> = {}) => {
  return {
    userText: '帮我把文件写到工作区',
    assistantText: '好的',
    toolResults: [] as { name: string; isError: boolean }[],
    llmError: false,
    injectedPlaybookEntryIds: [] as string[],
    injectedReflectionIds: [] as string[],
    ...overrides,
  }
}

/** 永不返回的 LLM：模拟供应商挂死。 */
const hangingLlm: EvolveLlm = {
  async proposeDeltas() {
    return new Promise<never>(() => {})
  },
  async reflect() {
    return new Promise<never>(() => {})
  },
}

describe('管线超时与失败隔离', () => {
  it('LLM 挂死：超时放弃该轮，确定性计数照常落库，服务不被挂住', async () => {
    const s = service(hangingLlm, { turnTimeoutMs: 30 })
    const entry = s.store.insertEntry({
      agentId: 'a1',
      section: 'strategy',
      content: '写文件前先确认目录存在',
      source: 'seed',
    })

    s.enqueueTurn('a1', 'A', 'c1', turn({ injectedPlaybookEntryIds: [entry.id], userText: '写文件前先确认目录存在' }))
    // flush 必须能返回：挂死的 LLM 被超时切断，管线不会永远挂着。
    await s.flush()

    expect(s.store.getEntry(entry.id)!.helpful).toBe(1)
    const round = s.metrics().rounds.find((r) => {
      return r.kind === 'turn'
    })
    expect(round?.ok).toBe(false)
    expect(round?.error).toContain('turnTimeoutMs')
  })

  it('Reflexion 抛错不影响 Curator（阶段隔离）', async () => {
    const s: EvolveLlm = {
      async proposeDeltas() {
        return [{ op: 'add', section: 'strategy', content: '先看索引再读文件' }]
      },
      async reflect() {
        throw new Error('reflect 500')
      },
    }
    const svc = service(s)
    svc.enqueueTurn(
      'a1',
      'A',
      'c1',
      turn({
        toolResults: [
          { name: 'fs_write', isError: true },
          { name: 'fs_write', isError: true },
        ],
      }),
    )
    await svc.flush()

    expect(svc.store.listPendingReflections('a1')).toHaveLength(0) // Reflexion 失败
    expect(
      svc.store.listActiveForCompile('a1').some((e) => {
        return e.content === '先看索引再读文件'
      }),
    ).toBe(true) // Curator 照常生效
    expect(svc.metrics().byKind.turn.failures).toBe(0) // 阶段失败不算整轮失败
  })

  it('Curator 抛错不影响本轮归因计数', async () => {
    const s: EvolveLlm = {
      async proposeDeltas() {
        throw new Error('curator timeout')
      },
      async reflect() {
        return ''
      },
    }
    const svc = service(s)
    const entry = svc.store.insertEntry({ agentId: 'a1', section: 'pitfall', content: '别删错文件', source: 'seed' })
    svc.enqueueTurn('a1', 'A', 'c1', turn({ injectedPlaybookEntryIds: [entry.id] }))
    await svc.flush()
    expect(svc.store.getEntry(entry.id)!.helpful).toBe(1)
  })

  it('过载保护：LLM 慢于对话节奏时丢最旧的轮次并记账', async () => {
    const s = service(hangingLlm, { turnTimeoutMs: 60_000, maxQueuedTurns: 2 })
    for (let i = 0; i < 10; i++) {
      s.enqueueTurn('a1', 'A', `c${i}`, turn())
    }
    // 1 轮在跑 + 2 轮排队 + 7 轮被丢
    expect(s.metrics().droppedTurns).toBe(7)
  })
})

describe('进化耗时埋点', () => {
  it('turn / feedback 都记录耗时与处理条目数（供服务端聚合）', async () => {
    const rounds: { kind: string; processed: number; durationMs: number }[] = []
    const dir = mkdtempSync(join(tmpdir(), 'ryharness-metrics-'))
    dirs.push(dir)
    const llm: EvolveLlm = {
      async proposeDeltas() {
        return []
      },
      async reflect() {
        return '教训'
      },
    }
    const s = new EvolveService({
      dbPath: join(dir, 'e.db'),
      llm,
      logger: () => {},
      onRound: (round) => {
        rounds.push({ kind: round.kind, processed: round.processed, durationMs: round.durationMs })
      },
    })
    const entry = s.store.insertEntry({ agentId: 'a1', section: 'strategy', content: '翻译前确认语言', source: 'seed' })
    s.enqueueTurn('a1', 'A', 'c1', turn({ injectedPlaybookEntryIds: [entry.id], userText: '帮我翻译' }))
    await s.flush()
    s.recordFeedback({ agentId: 'a1', conversationId: 'c1', signal: 'thumb_up' })
    s.runOnce()

    const kinds = rounds.map((r) => {
      return r.kind
    })
    expect(kinds).toContain('turn')
    expect(kinds).toContain('feedback')
    expect(kinds).toContain('consolidate')
    expect(
      rounds.every((r) => {
        return r.durationMs >= 0
      }),
    ).toBe(true)

    const metrics = s.metrics()
    expect(metrics.byKind.turn.processed).toBe(1) // 计了 1 个条目的分
    expect(metrics.byKind.feedback.processed).toBe(1)
    expect(metrics.byKind.turn.failures).toBe(0)
  })
})

describe('进化是否真的影响后续行为', () => {
  it('候选池不再被 section 饿死：净分最高的工具用法条目能挤进手册', async () => {
    const s = service()
    // 250 条 strategy 净分都是 1（旧查询按 section 排 + LIMIT 200，会把它们
    // 全部塞满候选池，后面的 section 一条都进不来）。
    for (let i = 0; i < 250; i++) {
      const entry = s.store.insertEntry({ agentId: 'a1', section: 'strategy', content: `策略 ${i}`, source: 'seed' })
      s.store.addCounts(entry.id, { helpful: 1 })
    }
    const tooling = ['用 rg 搜索比 grep 更快', '跑测试前先看 package.json 脚本'].map((content) => {
      const entry = s.store.insertEntry({ agentId: 'a1', section: 'tooling', content, source: 'curator' })
      s.store.addCounts(entry.id, { helpful: 30 })
      return entry.id
    })

    const compiled = await s.compile('a1', '帮我查一下代码')
    expect(compiled!.playbookEntryIds).toEqual(expect.arrayContaining(tooling))
    expect(compiled!.playbookEntryIds).toHaveLength(12)
    expect(compiled!.text).toContain('用 rg 搜索比 grep 更快')
    expect(compiled!.text).toContain('跑测试前先看 package.json 脚本')
  })

  it('失败→教训→验证→转正：新学到的经验真的进了下一次注入', async () => {
    const s: EvolveLlm = {
      async proposeDeltas() {
        return []
      },
      async reflect() {
        return '写文件前先确认目录存在'
      },
    }
    const svc = service(s)

    // 冷启动：手册与教训都为空，编译不注入任何东西。
    expect(await svc.compile('a1', '写文件前先确认目录存在')).toBeUndefined()

    // 一轮失败 → 教训入库 → 下一轮开始被注入。
    svc.enqueueTurn(
      'a1',
      'A',
      'c1',
      turn({
        userText: '文件写坏了',
        toolResults: [
          { name: 'fs_write', isError: true },
          { name: 'fs_write', isError: true },
        ],
      }),
    )
    await svc.flush()
    const withLesson = await svc.compile('a1', '写文件前先确认目录存在')
    expect(withLesson!.text).toContain('写文件前先确认目录存在')
    expect(withLesson!.reflectionIds).toHaveLength(1)

    // 两次验证成功 → 转正进手册，注入块从「上次教训」换成「经验手册」。
    for (let i = 0; i < 2; i++) {
      svc.enqueueTurn('a1', 'A', 'c1', turn({ injectedReflectionIds: withLesson!.reflectionIds }))
      await svc.flush()
    }
    const withPlaybook = await svc.compile('a1', '写文件前先确认目录存在')
    expect(withPlaybook!.text).not.toContain('上次教训')
    expect(withPlaybook!.reflectionIds).toEqual([])
    const learned = svc.store.listActiveForCompile('a1').find((e) => {
      return e.source === 'reflection'
    })!
    expect(withPlaybook!.playbookEntryIds).toContain(learned.id)
    expect(withPlaybook!.text).toContain('坑：写文件前先确认目录存在')
  })

  it('转正也要过近似去重：同义教训不会把 top-N 名额挤成重复条目', async () => {
    const lessons = ['写文件前先确认目录存在', '写文件前先确认目录存在。']
    let index = 0
    const s: EvolveLlm = {
      async proposeDeltas() {
        return []
      },
      async reflect() {
        const lesson = lessons[index % lessons.length] as string
        index += 1
        return lesson
      },
    }
    const svc = service(s)
    // 两条措辞近似的教训各自被验证两次。
    for (const _ of [0, 1]) {
      svc.enqueueTurn(
        'a1',
        'A',
        'c1',
        turn({
          toolResults: [
            { name: 'fs_write', isError: true },
            { name: 'fs_write', isError: true },
          ],
        }),
      )
      await svc.flush()
    }
    expect(svc.store.listPendingReflections('a1')).toHaveLength(2)
    for (const reflection of svc.store.listPendingReflections('a1')) {
      for (let i = 0; i < 2; i++) {
        svc.enqueueTurn('a1', 'A', 'c1', turn({ injectedReflectionIds: [reflection.id] }))
        await svc.flush()
      }
    }
    const converted = svc.store.listActiveForCompile('a1').filter((e) => {
      return e.source === 'reflection'
    })
    expect(converted).toHaveLength(1)
    // 两条教训都被验证并结案，没有留在待验证池里反复占坑。
    expect(svc.store.listPendingReflections('a1')).toHaveLength(0)
  })

  it('被证伪的条目会退出注入（自动 deprecate 后不再进手册）', async () => {
    const s = service()
    const good = s.store.insertEntry({
      agentId: 'a1',
      section: 'strategy',
      content: '写文件前先确认目录',
      source: 'seed',
    })
    const bad = s.store.insertEntry({
      agentId: 'a1',
      section: 'pitfall',
      content: '部署脚本要带版本号',
      source: 'seed',
    })
    s.store.addCounts(good.id, { helpful: 5 })

    for (let i = 0; i < 3; i++) {
      s.enqueueTurn('a1', 'A', 'c1', turn({ injectedPlaybookEntryIds: [bad.id], userText: '部署脚本错了' }))
      await s.flush()
    }
    expect(s.store.getEntry(bad.id)!.status).toBe('deprecated')
    const compiled = await s.compile('a1', '部署脚本')
    expect(compiled!.playbookEntryIds).toEqual([good.id])
    expect(compiled!.text).not.toContain('部署脚本要带版本号')
  })
})
