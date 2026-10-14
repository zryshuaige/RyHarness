/**
 * 进化过程的可解释性证据链：每条 playbook 条目都能回答
 * 「从哪几条记忆 / 哪次反馈 / 哪条教训来的」。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EvolveLlm, MemorySweep, PlaybookDelta } from '@ryagent/evolve'
import { EvolveService, seedIfEmpty } from '@ryagent/evolve'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
function service(llm?: EvolveLlm): EvolveService {
  const dir = mkdtempSync(join(tmpdir(), 'ryagent-origin-'))
  dirs.push(dir)
  return new EvolveService({ dbPath: join(dir, 'e.db'), llm, logger: () => {}, limits: { consolidationSliceMs: 5 } })
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

function scriptedLlm(options: { deltas?: PlaybookDelta[]; lesson?: string } = {}): EvolveLlm {
  return {
    async proposeDeltas() {
      return options.deltas ?? []
    },
    async reflect() {
      return options.lesson ?? '写文件前先确认目录存在'
    },
  }
}

describe('证据链：教训 → playbook 条目', () => {
  it('失败 → 教训 → 转正：条目能指出是哪条教训、哪一轮会话带来的', async () => {
    const s = service(scriptedLlm({ lesson: '写文件前先确认目录存在' }))

    // T1 失败 → 出教训
    s.enqueueTurn(
      'a1',
      'A',
      'conv-1',
      turn({
        toolResults: [
          { name: 'fs_write', isError: true },
          { name: 'fs_write', isError: true },
        ],
      }),
    )
    await s.flush()
    const reflection = s.store.listPendingReflections('a1')[0]!

    // T2/T3 验证成功 → 转正进手册
    s.enqueueTurn('a1', 'A', 'conv-1', turn({ injectedReflectionIds: [reflection.id] }))
    await s.flush()
    s.enqueueTurn('a1', 'A', 'conv-1', turn({ injectedReflectionIds: [reflection.id] }))
    await s.flush()

    const entry = s.store.listActiveForCompile('a1').find((e) => {
      return e.source === 'reflection'
    })!
    const explained = s.explain(entry.id)
    expect(explained).toBeDefined()
    expect(explained!.summary).toContain('教训')

    const kinds = explained!.origins.map((o) => {
      return o.kind
    })
    expect(kinds).toContain('reflection')
    expect(kinds).toContain('trajectory')
    const fromReflection = explained!.origins.find((o) => {
      return o.kind === 'reflection'
    })!
    expect(fromReflection.refId).toBe(reflection.id)
    expect(fromReflection.detail).toBe('写文件前先确认目录存在')

    const fromTurn = explained!.origins.find((o) => {
      return o.kind === 'trajectory'
    })!
    expect(fromTurn.refId.startsWith('conv-1')).toBe(true)
    expect(fromTurn.detail).toContain('转正验证')
    expect(fromTurn.detail).toContain('成功')
  })

  it('Curator 新增/改写条目都记来源轨迹，且同一来源不重复记账', async () => {
    const deltas: PlaybookDelta[] = [
      { op: 'add', section: 'strategy', content: '写文件前先跑一遍 dry-run' },
      { op: 'update', entryId: '', content: '检索时先看索引再读文件' },
    ]
    const s = service(
      scriptedLlm({
        deltas,
      }),
    )
    const target = s.store.insertEntry({ agentId: 'a1', section: 'strategy', content: '检索时先看文件' })
    deltas[1] = { op: 'update', entryId: target.id, content: '检索时先看索引再读文件' }

    s.enqueueTurn('a1', 'A', 'conv-2', turn())
    await s.flush()
    const added = s.store.listActiveForCompile('a1').find((e) => {
      return e.content === '写文件前先跑一遍 dry-run'
    })!
    expect(
      s.explain(added.id)!.origins.map((o) => {
        return o.kind
      }),
    ).toEqual(['trajectory'])
    expect(s.explain(added.id)!.origins[0]!.detail).toContain('Curator 新增')

    const updated = s.explain(target.id)!
    expect(updated.entry.content).toBe('检索时先看索引再读文件')
    expect(
      updated.origins.map((o) => {
        return o.kind
      }),
    ).toEqual(['trajectory'])
    expect(updated.origins[0]!.detail).toContain('Curator 改写')

    // 再跑一轮同样的事：溯源不会重复堆积（UNIQUE(entry,kind,refId) + 不同轮次键）。
    s.enqueueTurn('a1', 'A', 'conv-3', turn())
    await s.flush()
    expect(s.store.listOrigins(target.id)).toHaveLength(2)
  })
})

describe('证据链：用户反馈', () => {
  it('👎/👍 记为 feedback 溯源，条目能回答"哪次反馈"给的赞/踩', async () => {
    const s = service(scriptedLlm())
    const entry = s.store.insertEntry({
      agentId: 'a1',
      section: 'strategy',
      content: '翻译前先确认目标语言',
      source: 'seed',
    })
    s.enqueueTurn('a1', 'A', 'conv-1', turn({ injectedPlaybookEntryIds: [entry.id], userText: '帮我翻译' }))
    await s.flush()

    s.recordFeedback({ agentId: 'a1', conversationId: 'conv-1', signal: 'thumb_down', userText: '不好' })
    await s.flush()
    const explained = s.explain(entry.id)!
    const feedbackOrigin = explained.origins.find((o) => {
      return o.kind === 'feedback'
    })!
    expect(feedbackOrigin.detail).toContain('👎')
    expect(feedbackOrigin.detail).toContain('conv-1')
    expect(explained.summary).toContain('反馈')

    s.recordFeedback({ agentId: 'a1', conversationId: 'conv-1', signal: 'thumb_up' })
    expect(
      s.store.listOrigins(entry.id).filter((o) => {
        return o.kind === 'feedback'
      }),
    ).toHaveLength(2)
    expect(s.explain(entry.id)!.summary).toContain('反馈×2')
  })
})

describe('证据链：种子与记忆关联', () => {
  it('冷启动模板也留痕（来源=模板 key）', () => {
    const s = service()
    seedIfEmpty(s.store, 'a1', 'coding')
    const seeded = s.store.listActiveForCompile('a1')
    expect(seeded).toHaveLength(3)
    for (const entry of seeded) {
      const explained = s.explain(entry.id)!
      expect(explained.origins[0]!.kind).toBe('seed')
      expect(explained.origins[0]!.refId).toBe('coding')
      expect(explained.summary).toContain('种子')
    }
  })

  it('巩固把词面相关的记忆关联到条目上（"从哪几条记忆来"）', async () => {
    const s = service()
    const entry = s.store.insertEntry({
      agentId: 'a1',
      section: 'strategy',
      content: '写文件前先确认目录存在再动手',
      source: 'curator',
    })
    const related = s.store.insertEntry({
      agentId: 'a1',
      section: 'pitfall',
      content: '部署服务前先看端口占用',
      source: 'curator',
    })
    const rows = [
      { id: 'mem-1', content: '写文件前先确认目录存在', embedding: null, accessCount: 3, updatedAt: Date.now() },
      { id: 'mem-2', content: '写文件前确认目录', embedding: null, accessCount: 1, updatedAt: Date.now() },
      { id: 'mem-3', content: '午饭吃什么', embedding: null, accessCount: 1, updatedAt: Date.now() },
    ]
    const sweep: MemorySweep = {
      listSpaces: () => {
        return ['a1']
      },
      listActiveEmbeddings: () => {
        return rows
      },
      supersede: () => {},
      archiveDormant: () => {
        return 0
      },
      archiveColdSuperseded: () => {
        return 0
      },
    }
    s.attachMemorySweep(sweep)

    const result = await s.runUntilIdle()
    expect(result.linkedOrigins).toBeGreaterThan(0)

    const origins = s.store.listOrigins(entry.id)
    expect(
      origins.map((o) => {
        return o.refId
      }),
    ).toEqual(['mem-1', 'mem-2'])
    expect(
      origins.every((o) => {
        return o.kind === 'memory'
      }),
    ).toBe(true)
    // 无关条目不该被挂上不相干的记忆
    expect(s.store.listOrigins(related.id)).toHaveLength(0)

    // 巩固是幂等的：第二轮不再重复关联。
    const second = await s.runUntilIdle()
    expect(second.linkedOrigins).toBe(0)
    expect(s.store.listOrigins(entry.id)).toHaveLength(2)
  })

  it('explain 未知条目返回 undefined（不抛错）', () => {
    const s = service()
    expect(s.explain('nope')).toBeUndefined()
    const entry = s.store.insertEntry({ agentId: 'a1', section: 'tooling', content: '无溯源条目' })
    const explained = s.explain(entry.id)!
    expect(explained.origins).toEqual([])
    expect(explained.summary).toContain('来源未知')
  })
})
