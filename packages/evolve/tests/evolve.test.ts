import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EvolveLlm, PlaybookSection, TurnTrajectory } from '@ryharness/evolve'
import { AUTO_DEPRECATE_HARMFUL, EvolveService, NEGATIVE_FEEDBACK_RE, seedIfEmpty } from '@ryharness/evolve'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
function service(llm?: EvolveLlm): EvolveService {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-evolve-'))
  dirs.push(dir)
  return new EvolveService({ dbPath: join(dir, 'e.db'), llm, logger: () => {} })
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

const turn = (
  overrides: Partial<TurnTrajectory & { injectedPlaybookEntryIds: string[]; injectedReflectionIds: string[] }> = {},
) => {
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
function mockLlm(
  overrides: { deltas?: import('@ryharness/evolve').PlaybookDelta[]; reflectLesson?: string } = {},
): EvolveLlm {
  return {
    async proposeDeltas() {
      return overrides.deltas ?? []
    },
    async reflect() {
      return overrides.reflectLesson ?? '下次先想清楚再动手。'
    },
  }
}

/**
 * 免 ! 断言的读取器：noNonNullAssertion 的冻结基线只减不增，新增用例一律
 * 从这里取数（条目缺失时给 -1/'missing'，断言自然红）。
 */
function entryOf(service: EvolveService, id: string) {
  const entry = service.store.getEntry(id)
  return {
    helpful: entry?.helpful ?? -1,
    harmful: entry?.harmful ?? -1,
    status: entry?.status ?? 'missing',
  }
}

/** 同上：教训的验证 hit 数。 */
function hitOf(service: EvolveService, id: string): number {
  return service.store.getReflection(id)?.hitCount ?? -1
}

describe('注入编译（compile）', () => {
  it('按 helpful-harmful 排序 top-N、按 section 分组、格式 [经验手册]/[上次教训]', async () => {
    const s = service()
    const a = s.store.insertEntry({ agentId: 'a1', section: 'strategy', content: '先读后写', source: 'seed' })
    const b = s.store.insertEntry({ agentId: 'a1', section: 'pitfall', content: '别删错文件', source: 'seed' })
    s.store.addCounts(a.id, { helpful: 5 })
    s.store.addCounts(b.id, { helpful: 1 })
    const reflection = s.store.insertReflection({ agentId: 'a1', lesson: '上次忘了检查路径' })

    const compiled = await s.compile('a1', '帮我检查一下文件路径')
    expect(compiled).toBeDefined()
    expect(compiled!.text).toContain('[经验手册]')
    expect(compiled!.text).toContain('策略：先读后写')
    expect(compiled!.text).toContain('坑：别删错文件')
    expect(compiled!.text.indexOf('先读后写')).toBeLessThan(compiled!.text.indexOf('别删错文件')) // 分组按 SECTION_ORDER，组内才是 net 序
    expect(compiled!.text).toContain('上次教训：')
    expect(compiled!.text).toContain('上次忘了检查路径')
    expect(compiled!.playbookEntryIds).toEqual([a.id, b.id])
    expect(compiled!.reflectionIds).toEqual([reflection.id])
  })

  it('top-N 按 net=helpful-harmful 排序：30 条目下 high-harmful 的高 helpful 条目被挡在手册外', async () => {
    const s = service()
    // 12 条真策略（net 48..59，harmful 恒为 3）
    const gold = Array.from({ length: 12 }, (_, i) => {
      const net = 48 + i
      const entry = s.store.insertEntry({ agentId: 'a1', section: 'strategy', content: `策略 ${i}`, source: 'seed' })
      s.store.addCounts(entry.id, { helpful: net + 3, harmful: 3 })
      return entry.id
    })
    // 18 条诱饵：helpful 高达 200+，但 harmful 更高（net 只有 2/8/10/…/40）
    const decoyNets = [2, 8, 10, 15, 20, 25, 30, 35, 40]
    for (let i = 0; i < 18; i++) {
      const net = decoyNets[i % decoyNets.length] as number
      const entry = s.store.insertEntry({ agentId: 'a1', section: 'strategy', content: `诱饵 ${i}`, source: 'seed' })
      s.store.addCounts(entry.id, { helpful: 200 + net, harmful: 200 })
    }
    const compiled = await s.compile('a1', '随便聊聊')
    // 注入集合 = net 最高的 12 条，按 net 降序（与 harmful 计数无关）。
    expect(compiled!.playbookEntryIds).toEqual([...gold].reverse())
    expect(compiled!.text).not.toContain('诱饵')
  })

  it('26 条跨 section 条目下 top-N 严格按净分降序（比较器回归防护）', async () => {
    const s = service()
    const sections = ['strategy', 'pitfall', 'tooling'] as const
    // 26 条互异净分（25..1 加一条负分）。存储层按 (section, net desc) 返回，
    // section 分块序与全局净分序互相冲突——compile() 必须自己把全部条目重排
    // 成全局净分降序再取 top-12，只依赖底层分块序会排出「整块 strategy 排在
    // 整块 pitfall 前面」而非真正的最优条目。
    const seeds = [
      ...Array.from({ length: 25 }, (_, i) => {
        return i + 1
      }),
      -2,
    ].map((net, index) => {
      const entry = s.store.insertEntry({
        agentId: 'a1',
        section: sections[index % sections.length] as PlaybookSection,
        content: `条目 ${index}`,
        source: 'seed',
      })
      // 负分条目 harmful=2 < AUTO_DEPRECATE_HARMFUL，仍是合法的 active 条目。
      s.store.addCounts(entry.id, net >= 0 ? { helpful: net + 2, harmful: 2 } : { harmful: 2 })
      return { id: entry.id, net }
    })
    const expectedNets = [...seeds]
      .sort((a, b) => {
        return b.net - a.net
      })
      .slice(0, 12)
      .map((seed) => {
        return seed.net
      })

    const compiled = await s.compile('a1', '随便聊聊')
    // 注入内容按 section 分组（SECTION_ORDER），比较器管的是「哪 12 条进
    // top-N」：选中集合必须正好是净分最高的 12 条。
    const injected = compiled!.playbookEntryIds.map((id) => {
      return s.store.getEntry(id)!
    })
    expect(
      injected
        .map((entry) => {
          return entry.helpful - entry.harmful
        })
        .sort((a, b) => {
          return b - a
        }),
    ).toEqual(expectedNets)
    expect(new Set(compiled!.playbookEntryIds)).toEqual(
      new Set(
        seeds
          .filter((seed) => {
            return expectedNets.includes(seed.net)
          })
          .map((seed) => {
            return seed.id
          }),
      ),
    )
    // 组内（同一 section 的连续块）严格按净分降序。
    for (let i = 1; i < injected.length; i++) {
      if (injected[i]!.section === injected[i - 1]!.section) {
        expect(injected[i]!.helpful - injected[i]!.harmful).toBeLessThan(
          injected[i - 1]!.helpful - injected[i - 1]!.harmful,
        )
      }
    }
  })

  it('deprecated 条目不参与编译；空手册返回 undefined', async () => {
    const s = service()
    const entry = s.store.insertEntry({ agentId: 'a1', section: 'strategy', content: 'x', source: 'seed' })
    s.store.setEntryStatus(entry.id, 'deprecated')
    expect(await s.compile('a1', '随便聊聊')).toBeUndefined()
  })
})

describe('Reflector 归因计数', () => {
  it('注入条目：本轮成功 helpful+1，失败 harmful+1', async () => {
    const s = service()
    const entry = s.store.insertEntry({
      agentId: 'a1',
      section: 'strategy',
      content: '翻译前先确认目标语言',
      source: 'seed',
    })
    s.enqueueTurn('a1', 'A', 'c1', turn({ injectedPlaybookEntryIds: [entry.id], userText: '帮我翻译这段话' }))
    await s.flush()
    expect(s.store.getEntry(entry.id)!.helpful).toBe(1)

    s.enqueueTurn(
      'a1',
      'A',
      'c1',
      turn({
        injectedPlaybookEntryIds: [entry.id],
        userText: '翻译错了重来',
      }),
    )
    await s.flush()
    expect(s.store.getEntry(entry.id)!.harmful).toBe(1)
  })

  it('与本轮无关的注入条目不参与归因（噪声不拿 ±1）', async () => {
    const s = service()
    const relevant = s.store.insertEntry({
      agentId: 'a1',
      section: 'strategy',
      content: '写文件前先确认目录存在',
      source: 'seed',
    })
    const noise = s.store.insertEntry({
      agentId: 'a1',
      section: 'pitfall',
      content: '部署脚本要带版本号标签',
      source: 'seed',
    })
    s.enqueueTurn(
      'a1',
      'A',
      'c1',
      turn({ injectedPlaybookEntryIds: [relevant.id, noise.id], userText: '把文件写一下' }),
    )
    await s.flush()
    expect(s.store.getEntry(relevant.id)!.helpful).toBe(1)
    expect(s.store.getEntry(noise.id)!.helpful).toBe(0)
    expect(s.store.getEntry(noise.id)!.harmful).toBe(0)
  })

  it(`harmful 达 ${AUTO_DEPRECATE_HARMFUL} 自动 deprecate`, async () => {
    const s = service()
    const entry = s.store.insertEntry({
      agentId: 'a1',
      section: 'strategy',
      content: '部署脚本要带版本号标签',
      source: 'seed',
    })
    for (let i = 0; i < AUTO_DEPRECATE_HARMFUL; i++) {
      s.enqueueTurn(
        'a1',
        'A',
        'c1',
        turn({
          injectedPlaybookEntryIds: [entry.id],
          userText: '部署脚本错了',
        }),
      )
      await s.flush()
    }
    expect(s.store.getEntry(entry.id)!.status).toBe('deprecated')
  })

  it('基础设施故障（llmError）轮：注入条目不加 harmful 也不加 helpful', async () => {
    const s = service()
    const entry = s.store.insertEntry({
      agentId: 'a1',
      section: 'strategy',
      content: '写文件前先确认目录存在',
      source: 'seed',
    })
    s.enqueueTurn(
      'a1',
      'A',
      'c1',
      turn({ injectedPlaybookEntryIds: [entry.id], userText: '写文件前先确认目录存在', llmError: true }),
    )
    await s.flush()
    // 供应商 429/超时/断网与条目内容无因果：两个方向都不计数。
    expect(entryOf(s, entry.id).harmful).toBe(0)
    expect(entryOf(s, entry.id).helpful).toBe(0)
  })

  it('供应商连续故障凑不满 harmful：条目不被纯 llmError 轮自动 deprecate', async () => {
    const s = service()
    const entry = s.store.insertEntry({
      agentId: 'a1',
      section: 'strategy',
      content: '写文件前先确认目录存在',
      source: 'seed',
    })
    for (let i = 0; i < AUTO_DEPRECATE_HARMFUL + 2; i++) {
      s.enqueueTurn(
        'a1',
        'A',
        'c1',
        turn({ injectedPlaybookEntryIds: [entry.id], userText: '写文件前先确认目录存在', llmError: true }),
      )
      await s.flush()
    }
    expect(entryOf(s, entry.id).harmful).toBe(0)
    expect(entryOf(s, entry.id).status).toBe('active')
  })

  it('llmError 轮不给注入教训记验证 hit（转正不能建立在故障轮上）', async () => {
    const s = service()
    const reflection = s.store.insertReflection({ agentId: 'a1', lesson: '写文件前先确认目录存在' })
    s.enqueueTurn(
      'a1',
      'A',
      'c1',
      turn({ injectedReflectionIds: [reflection.id], userText: '写文件前先确认目录存在', llmError: true }),
    )
    await s.flush()
    expect(hitOf(s, reflection.id)).toBe(0)
  })

  it('llmError 与真实负反馈同轮出现：质量信号照常归因（护栏只挡纯故障轮）', async () => {
    const s = service()
    const entry = s.store.insertEntry({
      agentId: 'a1',
      section: 'strategy',
      content: '翻译前先确认目标语言',
      source: 'seed',
    })
    s.enqueueTurn(
      'a1',
      'A',
      'c1',
      turn({ injectedPlaybookEntryIds: [entry.id], userText: '翻译错了重来', llmError: true }),
    )
    await s.flush()
    expect(entryOf(s, entry.id).harmful).toBe(1)
  })
})

describe('自动废弃护栏（净证据相持不处决）', () => {
  it('真实负反馈凑满 harmful 且净分为负：仍自动 deprecate（原路径不回归）', async () => {
    const s = service()
    const entry = s.store.insertEntry({
      agentId: 'a1',
      section: 'strategy',
      content: '部署脚本要带版本号标签',
      source: 'seed',
    })
    for (let i = 0; i < AUTO_DEPRECATE_HARMFUL; i++) {
      s.enqueueTurn('a1', 'A', 'c1', turn({ injectedPlaybookEntryIds: [entry.id], userText: '部署脚本错了' }))
      await s.flush()
    }
    expect(entryOf(s, entry.id).status).toBe('deprecated')
  })

  it('helpful ≥ harmful（净证据非负）时不自动废弃，留给 Curator 复核', async () => {
    const s = service()
    const entry = s.store.insertEntry({
      agentId: 'a1',
      section: 'strategy',
      content: '部署脚本要带版本号标签',
      source: 'seed',
    })
    s.store.addCounts(entry.id, { helpful: AUTO_DEPRECATE_HARMFUL + 2 })
    for (let i = 0; i < AUTO_DEPRECATE_HARMFUL; i++) {
      s.enqueueTurn('a1', 'A', 'c1', turn({ injectedPlaybookEntryIds: [entry.id], userText: '部署脚本错了' }))
      await s.flush()
    }
    expect(entryOf(s, entry.id).harmful).toBe(AUTO_DEPRECATE_HARMFUL)
    expect(entryOf(s, entry.id).status).toBe('active')
  })

  it('👎 反馈路径同护栏：净证据非负时不自动废弃', async () => {
    const llm = mockLlm({ reflectLesson: '差评教训' })
    const s = service(llm)
    const entry = s.store.insertEntry({
      agentId: 'a1',
      section: 'strategy',
      content: '翻译前先确认目标语言',
      source: 'seed',
    })
    s.store.addCounts(entry.id, { helpful: AUTO_DEPRECATE_HARMFUL + 1 })
    s.enqueueTurn('a1', 'A', 'c1', turn({ injectedPlaybookEntryIds: [entry.id], userText: '帮我翻译' }))
    await s.flush()
    for (let i = 0; i < AUTO_DEPRECATE_HARMFUL; i++) {
      s.recordFeedback({ agentId: 'a1', conversationId: 'c1', signal: 'thumb_down' })
    }
    await s.flush()
    expect(entryOf(s, entry.id).harmful).toBe(AUTO_DEPRECATE_HARMFUL)
    expect(entryOf(s, entry.id).status).toBe('active')
  })
})

describe('Reflexion 反思（三类触发）', () => {
  const triggers: { name: string; turn: ReturnType<typeof turn> }[] = [
    {
      name: '工具连续失败≥2',
      turn: turn({
        toolResults: [
          { name: 'shell_exec', isError: true },
          { name: 'fs_write', isError: true },
        ],
      }),
    },
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

  it('否定疑问句不算负反馈（「不对吗？」是在确认理解，不是批评）', () => {
    expect(NEGATIVE_FEEDBACK_RE.test('这样不对吗？')).toBe(false)
    expect(NEGATIVE_FEEDBACK_RE.test('这样不对?')).toBe(false)
    expect(NEGATIVE_FEEDBACK_RE.test('我做得不对吗')).toBe(false)
    expect(NEGATIVE_FEEDBACK_RE.test('是不是错了？重来吗？')).toBe(false)
    expect(NEGATIVE_FEEDBACK_RE.test('Is that wrong?')).toBe(false)
    // 问句之外的否定陈述仍是负反馈（宁可少判，但不能漏判真差评）。
    expect(NEGATIVE_FEEDBACK_RE.test('这样不对')).toBe(true)
    expect(NEGATIVE_FEEDBACK_RE.test('这样不对，重来！')).toBe(true)
    expect(NEGATIVE_FEEDBACK_RE.test('这样不对。下一句是问句也不影响本句')).toBe(true)
    expect(NEGATIVE_FEEDBACK_RE.test("That's not right.")).toBe(true)
  })

  it('否定疑问句整轮不判失败：注入条目按成功记 helpful', async () => {
    const s = service()
    const entry = s.store.insertEntry({
      agentId: 'a1',
      section: 'strategy',
      content: '翻译前先确认目标语言',
      source: 'seed',
    })
    s.enqueueTurn('a1', 'A', 'c1', turn({ injectedPlaybookEntryIds: [entry.id], userText: '翻译得不对吗' }))
    await s.flush()
    expect(entryOf(s, entry.id).harmful).toBe(0)
    expect(entryOf(s, entry.id).helpful).toBe(1)
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
    const compiled = await s.compile('a1', '帮我检查下路径再写文件')
    expect(compiled!.reflectionIds).toEqual([reflection.id])
    s.enqueueTurn('a1', 'A', 'c1', turn({ injectedReflectionIds: compiled!.reflectionIds }))
    await s.flush()
    expect(s.store.getReflection(reflection.id)!.hitCount).toBe(1)
    expect(s.store.getReflection(reflection.id)!.status).toBe('pending')

    // 第三轮：再注入且成功 → hit 2 转正
    s.enqueueTurn('a1', 'A', 'c1', turn({ injectedReflectionIds: [reflection.id] }))
    await s.flush()
    expect(s.store.getReflection(reflection.id)!.status).toBe('converted')
    const entries = s.store.listActiveForCompile('a1').filter((e) => {
      return e.source === 'reflection'
    })
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
      async reflect() {
        return ''
      },
    }
    const s = service(llm)
    const entry = s.store.insertEntry({ agentId: 'a1', section: 'pitfall', content: '旧条目', source: 'curator' })
    existing.entryId = entry.id

    s.enqueueTurn('a1', 'A', 'c1', turn())
    await s.flush()

    const entries = s.store.listEntries('a1')
    const added = entries.filter((e) => {
      return e.content === '新策略'
    })
    expect(added).toHaveLength(1) // 去重生效
    // update 先执行、deprecate 后执行 → 最终 deprecated
    expect(s.store.getEntry(entry.id)!.status).toBe('deprecated')
  })
})

describe('用户反馈闭环', () => {
  it('👎 → 即时反思入库 + 归因条目 harmful+1；👍 → 归因 helpful+1', async () => {
    const llm = mockLlm({ reflectLesson: '差评教训' })
    const s = service(llm)
    const entry = s.store.insertEntry({
      agentId: 'a1',
      section: 'strategy',
      content: '翻译前先确认目标语言',
      source: 'seed',
    })
    // 一轮注入建立归因
    s.enqueueTurn('a1', 'A', 'c1', turn({ injectedPlaybookEntryIds: [entry.id], userText: '帮我翻译' }))
    await s.flush()
    expect(s.store.getEntry(entry.id)!.helpful).toBe(1)

    s.recordFeedback({
      agentId: 'a1',
      conversationId: 'c1',
      signal: 'thumb_down',
      userText: '不好',
      assistantText: 'x',
    })
    await s.flush()
    expect(s.store.getEntry(entry.id)!.harmful).toBe(1)
    expect(
      s.store.listPendingReflections('a1').map((r) => {
        return r.lesson
      }),
    ).toContain('差评教训')
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
    expect(
      s.store.listActiveForCompile('a1').map((e) => {
        return e.source
      }),
    ).toEqual(['seed', 'seed', 'seed'])
    expect(seedIfEmpty(s.store, 'a1', 'unknown-template')).toBe(0)
  })
})

describe('巩固调度 runOnce（幂等）', () => {
  it('到期反思清理 + 重复记忆合并 + dormant 统计；二次运行无变化', () => {
    const s = service()
    // 30 天前的 pending 反思 → expired
    s.store.insertReflection({ agentId: 'a1', lesson: '老教训' })
    const db = (s.store as unknown as { db: { prepare: (q: string) => { run: (...a: (number | string)[]) => void } } })
      .db
    db.prepare('UPDATE reflections SET created_at = ? WHERE agent_id = ?').run(Date.now() - 31 * 86_400_000, 'a1')

    // 重复记忆（同向量）→ 合并
    const v = Float32Array.from([1, 0, 0, 0])
    const rows = [
      { id: 'm1', content: '甲', embedding: v, accessCount: 2, updatedAt: Date.now() },
      { id: 'm2', content: '甲·重复', embedding: v, accessCount: 0, updatedAt: Date.now() - 100 * 86_400_000 },
      { id: 'm3', content: '乙', embedding: Float32Array.from([0, 1, 0, 0]), accessCount: 1, updatedAt: Date.now() },
    ]
    const superseded: string[] = []
    const archived: string[] = []
    const sweep = {
      listSpaces: () => {
        return ['a1']
      },
      listActiveEmbeddings: () => {
        return rows.filter((r) => {
          return !superseded.includes(r.id)
        })
      },
      supersede(id: string) {
        superseded.push(id)
      },
      archiveDormant: (dormantAfterMs: number, now: number) => {
        const hits = rows.filter(
          (r) => r.accessCount === 0 && now - r.updatedAt > dormantAfterMs && !archived.includes(r.id),
        )
        archived.push(...hits.map((r) => r.id))
        return hits.length
      },
      archiveColdSuperseded: (maxAgeMs: number, now: number) => {
        const hits = rows.filter(
          (r) => superseded.includes(r.id) && now - r.updatedAt > maxAgeMs && !archived.includes(r.id),
        )
        archived.push(...hits.map((r) => r.id))
        return hits.length
      },
    }

    s.attachMemorySweep(sweep)
    const first = s.runOnce()
    expect(first.expiredReflections).toBe(1)
    expect(first.mergedMemories).toBe(1)
    expect(first.dormant).toBe(1)
    expect(superseded).toEqual(['m2'])
    // 长期零访问的记忆被归档（不物理删除），陈旧软删链同样归档
    expect(first.archivedDormant).toBeGreaterThanOrEqual(1)
    expect(archived).toContain('m2')

    const second = s.runOnce()
    // 动作类指标归零（dormant 是当前状态快照，m2 已合并后自然为 0）。
    expect(second.expiredReflections).toBe(0)
    expect(second.mergedMemories).toBe(0)
    expect(second.archivedDormant).toBe(0)
  })
})

describe('全链路集成：失败 → 反思 → 注入 → 成功 → 转正', () => {
  it('端到端跑通闭环', async () => {
    const llm = mockLlm({ reflectLesson: '写文件前先确认目录存在' })
    const s = service(llm)
    // T1 失败（工具连错）
    s.enqueueTurn(
      'a1',
      'A',
      'c1',
      turn({
        userText: '写入失败了吗',
        toolResults: [
          { name: 'fs_write', isError: true },
          { name: 'fs_write', isError: true },
        ],
      }),
    )
    await s.flush()
    let reflection = s.store.listPendingReflections('a1')[0]!
    expect(reflection.lesson).toBe('写文件前先确认目录存在')

    // T2：教训注入，本轮成功 → hit 1
    let compiled = await s.compile('a1', '写文件前先确认目录存在')
    expect(compiled!.text).toContain('写文件前先确认目录存在')
    s.enqueueTurn('a1', 'A', 'c1', turn({ injectedReflectionIds: compiled!.reflectionIds }))
    await s.flush()
    expect(s.store.getReflection(reflection.id)!.hitCount).toBe(1)

    // T3：再次注入成功 → 转正
    s.enqueueTurn('a1', 'A', 'c1', turn({ injectedReflectionIds: [reflection.id] }))
    await s.flush()
    reflection = s.store.getReflection(reflection.id)!
    expect(reflection.status).toBe('converted')
    const playbook = await s.compile('a1', '写文件前先确认目录存在')
    expect(playbook!.text.includes('上次教训')).toBe(false) // 已清理
    expect(
      s.store.listActiveForCompile('a1').some((e) => {
        return e.source === 'reflection' && e.content === '写文件前先确认目录存在'
      }),
    ).toBe(true)
  })
})

describe('Curator 看得见既有条目（update/deprecate 才可用）', () => {
  it('proposeDeltas 收到既有条目（id+内容+得分），update 后手册被真正改写', async () => {
    const captured: { ids: string[]; contents: string[] } = { ids: [], contents: [] }
    const llm: EvolveLlm = {
      async proposeDeltas(input) {
        captured.ids = (input.entries ?? []).map((e) => {
          return e.id
        })
        captured.contents = (input.entries ?? []).map((e) => {
          return e.content
        })
        const target = input.entries?.[0]
        return target === undefined
          ? []
          : [{ op: 'update', entryId: target.id, content: '每次检索先看索引再决定读哪些文件' }]
      },
      async reflect() {
        return ''
      },
    }
    const s = service(llm)
    const entry = s.store.insertEntry({ agentId: 'a1', section: 'strategy', content: '检索时先看索引', source: 'seed' })
    s.enqueueTurn('a1', 'A', 'c1', turn({ userText: '帮我查资料' }))
    await s.flush()
    expect(captured.ids).toEqual([entry.id])
    expect(captured.contents).toEqual(['检索时先看索引'])
    expect(s.store.getEntry(entry.id)!.content).toBe('每次检索先看索引再决定读哪些文件')
  })

  it('近似重复的 add 被去重（换措辞不会把手册撑爆）', async () => {
    const llm = mockLlm({ deltas: [{ op: 'add', section: 'strategy', content: '检索时先看索引再读文件' }] })
    const s = service(llm)
    s.store.insertEntry({ agentId: 'a1', section: 'strategy', content: '检索时先看索引再读文件。', source: 'seed' })
    s.enqueueTurn('a1', 'A', 'c1', turn({ userText: '帮我查资料' }))
    await s.flush()
    expect(s.store.listActiveForCompile('a1')).toHaveLength(1)
  })
})

describe('教训注入的相关性选择', () => {
  it('与本轮输入无关的 pending 教训不注入', async () => {
    const s = service()
    s.store.insertReflection({ agentId: 'a1', lesson: '写文件前先确认目录存在' })
    const unrelated = await s.compile('a1', '帮我把这段英文翻译成中文')
    expect(unrelated?.reflectionIds ?? []).toEqual([])
    expect(unrelated?.text ?? '').not.toContain('写文件前先确认目录存在')

    const related = await s.compile('a1', '写文件的时候记得目录')
    expect(related?.text).toContain('写文件前先确认目录存在')
  })
})
