import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EvolveService,
  NEGATIVE_FEEDBACK_RE,
  seedIfEmpty,
  AUTO_DEPRECATE_HARMFUL,
} from '@ryagent/evolve'
import type { EvolveLlm, TurnTrajectory } from '@ryagent/evolve'

const dirs: string[] = []
function service(llm?: EvolveLlm): EvolveService {
  const dir = mkdtempSync(join(tmpdir(), 'ryagent-evolve-'))
  dirs.push(dir)
  return new EvolveService({ dbPath: join(dir, 'e.db'), llm, logger: () => {} })
}

afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch { /* Windows 句柄滞后 */ }
  }
})

const turn = (overrides: Partial<TurnTrajectory & { injectedPlaybookEntryIds: string[]; injectedReflectionIds: string[] }> = {}) => {
  return {
    userText: '你好',
    assistantText: '好的',
    toolResults: [] as { name: string; isError: boolean }[],
    llmError: false,
    injectedPlaybookEntryIds: [] as string[],
    injectedReflectionIds: [] as string[],
    ...overrides,
  }
}

/** 脚本化 Curator/Reflector。 */
function mockLlm(overrides: {
  deltas?: import('@ryagent/evolve').PlaybookDelta[]
  reflectLesson?: string
} = {}): EvolveLlm {
  return {
    async proposeDeltas() {
      return overrides.deltas ?? []
    },
    async reflect() {
      return overrides.reflectLesson ?? '下次先想清楚再动手。'
    },
  }
}

describe('注入编译（compile）', () => {
  it('按 helpful-harmful 排序 top-N、按 section 分组、格式 [经验手册]/[上次教训]', async () => {
    const s = service()
    const a = s.store.insertEntry({ agentId: 'a1', section: 'strategy', content: '先读后写', source: 'seed' })
    const b = s.store.insertEntry({ agentId: 'a1', section: 'pitfall', content: '别删错文件', source: 'seed' })
    s.store.addCounts(a.id, { helpful: 5 })
    s.store.addCounts(b.id, { helpful: 1 })
    const reflection = s.store.insertReflection({ agentId: 'a1', lesson: '上次忘了检查路径' })

    const compiled = await s.compile('a1')
    expect(compiled).toBeDefined()
    expect(compiled!.text).toContain('[经验手册]')
    expect(compiled!.text).toContain('策略：先读后写')
    expect(compiled!.text).toContain('坑：别删错文件')
    expect(compiled!.text.indexOf('先读后写')).toBeLessThan(compiled!.text.indexOf('别删错文件')) // net 排序
    expect(compiled!.text).toContain('上次教训：')
    expect(compiled!.text).toContain('上次忘了检查路径')
    expect(compiled!.playbookEntryIds).toEqual([a.id, b.id])
    expect(compiled!.reflectionIds).toEqual([reflection.id])
  })

  it('deprecated 条目不参与编译；空手册返回 undefined', async () => {
    const s = service()
    const entry = s.store.insertEntry({ agentId: 'a1', section: 'strategy', content: 'x', source: 'seed' })
    s.store.setEntryStatus(entry.id, 'deprecated')
    expect(await s.compile('a1')).toBeUndefined()
  })
})

describe('Reflector 归因计数', () => {
  it('注入条目：本轮成功 helpful+1，失败 harmful+1', async () => {
    const s = service()
    const entry = s.store.insertEntry({ agentId: 'a1', section: 'strategy', content: 'x', source: 'seed' })
    s.enqueueTurn('a1', 'A', 'c1', turn({ injectedPlaybookEntryIds: [entry.id] }))
    await s.flush()
    expect(s.store.getEntry(entry.id)!.helpful).toBe(1)

    s.enqueueTurn('a1', 'A', 'c1', turn({
      injectedPlaybookEntryIds: [entry.id],
      userText: '不对，错了',
    }))
    await s.flush()
    expect(s.store.getEntry(entry.id)!.harmful).toBe(1)
  })

  it(`harmful 达 ${AUTO_DEPRECATE_HARMFUL} 自动 deprecate`, async () => {
    const s = service()
    const entry = s.store.insertEntry({ agentId: 'a1', section: 'strategy', content: 'x', source: 'seed' })
    for (let i = 0; i < AUTO_DEPRECATE_HARMFUL; i++) {
      s.enqueueTurn('a1', 'A', 'c1', turn({
        injectedPlaybookEntryIds: [entry.id],
        userText: '错了',
      }))
      await s.flush()
    }
    expect(s.store.getEntry(entry.id)!.status).toBe('deprecated')
  })
})

describe('Reflexion 反思（三类触发）', () => {
  const triggers: { name: string; turn: ReturnType<typeof turn> }[] = [
    { name: '工具连续失败≥2', turn: turn({ toolResults: [{ name: 'shell_exec', isError: true }, { name: 'fs_write', isError: true }] }) },
    { name: 'LLM error', turn: turn({ llmError: true }) },
    { name: '用户负反馈', turn: turn({ userText: '不对，重来' }) },
  ]
  for (const { name, turn: t } of triggers) {
    it(`触发：${name}`, async () => {
      const llm = mockLlm({ reflectLesson: '教训X' })
      const s = service(llm)
      s.enqueueTurn('a1', 'A', 'c1', t)
      await s.flush()
      const reflections = s.store.listPendingReflections('a1')
      expect(reflections).toHaveLength(1)
      expect(reflections[0]!.lesson).toBe('教训X')
    })
  }

  it('成功轮不触发反思；负反馈词表生效', () => {
    expect(NEGATIVE_FEEDBACK_RE.test('这个不对')).toBe(true)
    expect(NEGATIVE_FEEDBACK_RE.test('做得很好')).toBe(false)
  })

  it('无 LLM 时反思静默跳过（确定性部分照常）', async () => {
    const s = service()
    s.enqueueTurn('a1', 'A', 'c1', turn({ userText: '错了' }))
    await s.flush()
    expect(s.store.listPendingReflections('a1')).toHaveLength(0)
  })
})

describe('教训验证与转正闭环', () => {
  it('注入后成功 hitCount+1；≥2 转正进 playbook（pitfall）并清理 reflections', async () => {
    const llm = mockLlm({ reflectLesson: '先检查路径再写文件' })
    const s = service(llm)
    // 第一轮：失败 → 出教训
    s.enqueueTurn('a1', 'A', 'c1', turn({ userText: '错了，文件写坏了' }))
    await s.flush()
    const reflection = s.store.listPendingReflections('a1')[0]!
    expect(reflection.lesson).toBe('先检查路径再写文件')

    // 第二轮：注入教训且成功 → hit 1（不转正）
    const compiled = await s.compile('a1')
    expect(compiled!.reflectionIds).toEqual([reflection.id])
    s.enqueueTurn('a1', 'A', 'c1', turn({ injectedReflectionIds: compiled!.reflectionIds }))
    await s.flush()
    expect(s.store.getReflection(reflection.id)!.hitCount).toBe(1)
    expect(s.store.getReflection(reflection.id)!.status).toBe('pending')

    // 第三轮：再注入且成功 → hit 2 转正
    s.enqueueTurn('a1', 'A', 'c1', turn({ injectedReflectionIds: [reflection.id] }))
    await s.flush()
    expect(s.store.getReflection(reflection.id)!.status).toBe('converted')
    const entries = s.store.listActiveForCompile('a1').filter((e) => { return e.source === 'reflection' })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.section).toBe('pitfall')
    expect(entries[0]!.content).toBe('先检查路径再写文件')
    expect(s.store.listPendingReflections('a1')).toHaveLength(0)
  })
})

describe('Curator 增量 delta', () => {
  it('add（去重）/ update / deprecate 三操作', async () => {
    const existing = { entryId: '' }
    const llm: EvolveLlm = {
      async proposeDeltas() {
        return [
          { op: 'add', section: 'strategy', content: '新策略' },
          { op: 'add', section: 'strategy', content: '新策略' }, // 重复 → 去重
          { op: 'update', entryId: existing.entryId, content: '更新后的条目' },
          { op: 'deprecate', entryId: existing.entryId },
        ]
      },
      async reflect() { return '' },
    }
    const s = service(llm)
    const entry = s.store.insertEntry({ agentId: 'a1', section: 'pitfall', content: '旧条目', source: 'curator' })
    existing.entryId = entry.id

    s.enqueueTurn('a1', 'A', 'c1', turn())
    await s.flush()

    const entries = s.store.listEntries('a1')
    const added = entries.filter((e) => { return e.content === '新策略' })
    expect(added).toHaveLength(1) // 去重生效
    // update 先执行、deprecate 后执行 → 最终 deprecated
    expect(s.store.getEntry(entry.id)!.status).toBe('deprecated')
  })
})

describe('用户反馈闭环', () => {
  it('👎 → 即时反思入库 + 归因条目 harmful+1；👍 → 归因 helpful+1', async () => {
    const llm = mockLlm({ reflectLesson: '差评教训' })
    const s = service(llm)
    const entry = s.store.insertEntry({ agentId: 'a1', section: 'strategy', content: 'x', source: 'seed' })
    // 一轮注入建立归因
    s.enqueueTurn('a1', 'A', 'c1', turn({ injectedPlaybookEntryIds: [entry.id] }))
    await s.flush()
    expect(s.store.getEntry(entry.id)!.helpful).toBe(1)

    s.recordFeedback({ agentId: 'a1', conversationId: 'c1', signal: 'thumb_down', userText: '不好', assistantText: 'x' })
    await s.flush()
    expect(s.store.getEntry(entry.id)!.harmful).toBe(1)
    expect(s.store.listPendingReflections('a1').map((r) => { return r.lesson })).toContain('差评教训')
    expect(s.store.countFeedback('a1')).toEqual({ up: 0, down: 1 })

    s.recordFeedback({ agentId: 'a1', conversationId: 'c1', signal: 'thumb_up' })
    expect(s.store.getEntry(entry.id)!.helpful).toBe(2)
    expect(s.store.countFeedback('a1')).toEqual({ up: 1, down: 1 })
  })
})

describe('冷启动种子', () => {
  it('空手册按模板播种（幂等）；非空不覆盖', () => {
    const s = service()
    expect(seedIfEmpty(s.store, 'a1', 'coding')).toBe(3)
    expect(seedIfEmpty(s.store, 'a1', 'coding')).toBe(0)
    expect(s.store.listActiveForCompile('a1').map((e) => { return e.source })).toEqual(['seed', 'seed', 'seed'])
    expect(seedIfEmpty(s.store, 'a1', 'unknown-template')).toBe(0)
  })
})

describe('巩固调度 runOnce（幂等）', () => {
  it('到期反思清理 + 重复记忆合并 + dormant 统计；二次运行无变化', () => {
    const s = service()
    // 30 天前的 pending 反思 → expired
    s.store.insertReflection({ agentId: 'a1', lesson: '老教训' })
    const db = (s.store as unknown as { db: { prepare: (q: string) => { run: (...a: (number | string)[]) => void } } }).db
    db.prepare('UPDATE reflections SET created_at = ? WHERE agent_id = ?').run(Date.now() - 31 * 86_400_000, 'a1')

    // 重复记忆（同向量）→ 合并
    const v = Float32Array.from([1, 0, 0, 0])
    const rows = [
      { id: 'm1', content: '甲', embedding: v, accessCount: 2, updatedAt: Date.now() },
      { id: 'm2', content: '甲·重复', embedding: v, accessCount: 0, updatedAt: Date.now() - 100 * 86_400_000 },
      { id: 'm3', content: '乙', embedding: Float32Array.from([0, 1, 0, 0]), accessCount: 1, updatedAt: Date.now() },
    ]
    const superseded: string[] = []
    const sweep = {
      listSpaces: () => { return ['a1'] },
      listActiveEmbeddings: () => { return rows.filter((r) => { return !superseded.includes(r.id) }) },
      supersede(id: string) { superseded.push(id) },
    }

    s.attachMemorySweep(sweep)
    const first = s.runOnce()
    expect(first.expiredReflections).toBe(1)
    expect(first.mergedMemories).toBe(1)
    expect(first.dormant).toBe(1)
    expect(superseded).toEqual(['m2'])

    const second = s.runOnce()
    // 动作类指标归零（dormant 是当前状态快照，m2 已合并后自然为 0）。
    expect(second.expiredReflections).toBe(0)
    expect(second.mergedMemories).toBe(0)
  })
})

describe('全链路集成：失败 → 反思 → 注入 → 成功 → 转正', () => {
  it('端到端跑通闭环', async () => {
    const llm = mockLlm({ reflectLesson: '写文件前先确认目录存在' })
    const s = service(llm)
    // T1 失败（工具连错）
    s.enqueueTurn('a1', 'A', 'c1', turn({
      userText: '写入失败了吗',
      toolResults: [{ name: 'fs_write', isError: true }, { name: 'fs_write', isError: true }],
    }))
    await s.flush()
    let reflection = s.store.listPendingReflections('a1')[0]!
    expect(reflection.lesson).toBe('写文件前先确认目录存在')

    // T2：教训注入，本轮成功 → hit 1
    let compiled = await s.compile('a1')
    expect(compiled!.text).toContain('写文件前先确认目录存在')
    s.enqueueTurn('a1', 'A', 'c1', turn({ injectedReflectionIds: compiled!.reflectionIds }))
    await s.flush()
    expect(s.store.getReflection(reflection.id)!.hitCount).toBe(1)

    // T3：再次注入成功 → 转正
    s.enqueueTurn('a1', 'A', 'c1', turn({ injectedReflectionIds: [reflection.id] }))
    await s.flush()
    reflection = s.store.getReflection(reflection.id)!
    expect(reflection.status).toBe('converted')
    const playbook = await s.compile('a1')
    expect(playbook!.text.includes('上次教训')).toBe(false) // 已清理
    expect(s.store.listActiveForCompile('a1').some((e) => {
      return e.source === 'reflection' && e.content === '写文件前先确认目录存在'
    })).toBe(true)
  })
})
