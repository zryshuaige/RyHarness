import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CandidateFact, EmbeddingProvider, MemoryLlm, MemoryOperation } from '@ryagent/memory'
import { HashEmbeddings, MemoryService, NullEmbeddings, SHARED_SPACE } from '@ryagent/memory'
import { afterEach, describe, expect, it, vi } from 'vitest'

const dirs: string[] = []
function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryagent-memory-svc-'))
  dirs.push(dir)
  return join(dir, 'm.db')
}

afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 句柄释放可能滞后；残留目录在临时区。
    }
  }
})

/** 脚本化记忆 LLM：抽取返回固定候选，判定按回调。 */
function mockLlm(overrides: {
  facts?: CandidateFact[]
  decide?: (candidate: CandidateFact, similar: { id: string; content: string }[]) => MemoryOperation[]
  failTimes?: number
}): MemoryLlm & { extractCalls: number; decideCalls: number } {
  const state = { extractCalls: 0, decideCalls: 0 }
  return {
    extractCalls: 0,
    decideCalls: 0,
    async extractFacts() {
      state.extractCalls++
      Object.assign(this, { extractCalls: state.extractCalls })
      if (overrides.failTimes !== undefined && state.extractCalls <= overrides.failTimes) {
        throw new Error('llm down')
      }
      return overrides.facts ?? []
    },
    async decideOperations(input) {
      state.decideCalls++
      Object.assign(this, { decideCalls: state.decideCalls })
      return overrides.decide ? overrides.decide(input.candidate, input.similar) : [{ action: 'ADD' as const }]
    },
  } as MemoryLlm & { extractCalls: number; decideCalls: number }
}

/** 受控向量：dict[text] → 单位向量；默认按哈希。 */
function scriptedVectors(vectors: Record<string, number[]>, dim = 4): EmbeddingProvider {
  const base = new HashEmbeddings(dim)
  return {
    label: 'scripted',
    available: true,
    async embed(texts) {
      return texts.map((text) => {
        const scripted = vectors[text]
        if (scripted !== undefined) return Float32Array.from(scripted)
        return base.vectorOf(text)
      })
    },
  }
}

describe('抽取管线：四操作', () => {
  it('ADD：无相似记忆 → 新写入（scope 路由 shared/agent）', async () => {
    const llm = mockLlm({
      facts: [
        { text: '用户养了一只橘猫叫布丁', scope: 'shared', kind: 'profile' },
        { text: '用户希望周报用简洁的条目式', scope: 'agent', kind: 'preference' },
      ],
    })
    const service = new MemoryService({ dbPath: dbPath(), embeddings: new HashEmbeddings(), llm })
    service.enqueueExtraction('ryen', 'Ryen', 'conv-1', '用户：我养了只橘猫叫布丁\nRyen：记下了')
    await service.flush()

    const shared = service.store.listSharedProfile()
    expect(
      shared.map((m) => {
        return m.content
      }),
    ).toContain('用户养了一只橘猫叫布丁')
    const agentSpace = service.store.listActiveForAgent('ryen')
    expect(
      agentSpace.map((m) => {
        return m.content
      }),
    ).toContain('用户希望周报用简洁的条目式')
    // 共享画像不进入 agent 私有列表
    expect(
      agentSpace.some((m) => {
        return m.agentId === SHARED_SPACE
      }),
    ).toBe(false)
    service.close()
  })

  it('UPDATE：合并为新记忆，旧记忆 superseded 软删保历史', async () => {
    let phase = 1
    let capturedOldId = ''
    const llm: MemoryLlm = {
      async extractFacts() {
        return phase === 1
          ? [{ text: '用户住在北京', scope: 'shared', kind: 'profile' }]
          : [{ text: '用户住在北京海淀', scope: 'shared', kind: 'profile' }]
      },
      async decideOperations({ similar }) {
        if (phase === 1) return [{ action: 'ADD' }]
        capturedOldId = similar[0]?.id ?? ''
        return similar.length > 0
          ? [{ action: 'UPDATE', memoryId: similar[0]!.id, newText: '用户住在北京海淀区' }]
          : [{ action: 'ADD' }]
      },
    }
    const service = new MemoryService({ dbPath: dbPath(), embeddings: new HashEmbeddings(), llm })
    service.enqueueExtraction('ryen', 'Ryen', 'c1', '用户：我住在北京')
    await service.flush()
    expect(service.store.listSharedProfile()).toHaveLength(1)

    phase = 2
    service.enqueueExtraction('ryen', 'Ryen', 'c2', '用户：我搬去海淀了')
    await service.flush()

    expect(capturedOldId).not.toBe('')
    expect(service.store.get(capturedOldId)!.status).toBe('superseded')
    const active = service.store.listSharedProfile()
    expect(active).toHaveLength(1)
    expect(active[0]!.content).toBe('用户住在北京海淀区')
    expect(active[0]!.supersedesId).toBe(capturedOldId)
    service.close()
  })

  it('UPDATE/DELETE 拒绝跨空间 memoryId：幻觉 id 不能改写/删除别的空间的记忆', async () => {
    // 受害者记忆在 agent-a 空间；抽取发生在 agent-b 空间，LLM 幻觉出 agent-a 的 memoryId。
    let victimId = ''
    const llm: MemoryLlm = {
      async extractFacts() {
        return [{ text: 'agent-b 的新事实', scope: 'agent', kind: 'fact' }]
      },
      async decideOperations() {
        return [
          { action: 'UPDATE', memoryId: victimId, newText: '被篡改的内容' },
          { action: 'DELETE', memoryId: victimId },
        ]
      },
    }
    const service = new MemoryService({ dbPath: dbPath(), embeddings: new HashEmbeddings(), llm })
    victimId = service.store.insert({ agentId: 'agent-a', kind: 'fact', content: 'agent-a 的私密约定' }).id

    service.enqueueExtraction('agent-b', 'BotB', 'c1', '用户：随便聊聊')
    await service.flush()

    const victim = service.store.get(victimId)!
    expect(victim.status).toBe('active')
    expect(victim.content).toBe('agent-a 的私密约定')
    // 两个操作都被拒绝：agent-b 空间不得新增任何行
    expect(service.store.listActiveForAgent('agent-b')).toHaveLength(0)
    service.close()
  })

  it('DELETE：矛盾事实 → 旧记忆 superseded', async () => {
    let existingId = ''
    const llm = mockLlm({
      facts: [{ text: '用户不再养猫了', scope: 'shared', kind: 'event' }],
      decide: (_c, similar) => {
        existingId = similar[0]?.id ?? ''
        return similar.length > 0 ? [{ action: 'DELETE', memoryId: similar[0]!.id }] : [{ action: 'NOOP' }]
      },
    })
    const service = new MemoryService({ dbPath: dbPath(), embeddings: new HashEmbeddings(), llm })
    // 先造一条旧记忆
    service.store.insert({ agentId: SHARED_SPACE, kind: 'profile', content: '用户养了一只橘猫叫布丁' })
    service.enqueueExtraction('ryen', 'Ryen', 'c1', '用户：猫送走了')
    await service.flush()
    expect(existingId).not.toBe('')
    expect(service.store.get(existingId)!.status).toBe('superseded')
    expect(service.store.listSharedProfile()).toHaveLength(0)
    service.close()
  })

  it('NOOP 兜底：与旧记忆几乎重复时才允许 NOOP，不写入', async () => {
    const llm = mockLlm({
      facts: [{ text: '用户住在北京', scope: 'shared', kind: 'profile' }],
      decide: () => {
        return [{ action: 'NOOP' }]
      },
    })
    const service = new MemoryService({ dbPath: dbPath(), embeddings: new NullEmbeddings(), llm })
    service.enqueueExtraction('ryen', 'Ryen', 'c1', '用户：我住在北京')
    await service.flush()
    service.enqueueExtraction('ryen', 'Ryen', 'c1', '用户：我住在北京')
    await service.flush()
    // 第二轮与既有记忆几乎重复 → NOOP 成立，仍只有一条
    expect(service.store.listSharedProfile()).toHaveLength(1)
    service.close()
  })

  it('NOOP 兜底：候选与旧记忆不像时强制 ADD（闲聊偏好不再被丢掉）', async () => {
    const llm = mockLlm({
      facts: [{ text: '用户喜欢川菜，越辣越好', scope: 'shared', kind: 'preference' }],
      decide: () => {
        return [{ action: 'NOOP' }]
      },
    })
    const service = new MemoryService({ dbPath: dbPath(), embeddings: new NullEmbeddings(), llm })
    service.store.insert({ agentId: SHARED_SPACE, kind: 'profile', content: '用户养了一只橘猫叫布丁' })
    service.enqueueExtraction('ryen', 'Ryen', 'c1', '用户：我最喜欢吃川菜')
    await service.flush()
    expect(
      service.store.listActiveForAgent(SHARED_SPACE).map((m) => {
        return m.content
      }),
    ).toContain('用户喜欢川菜，越辣越好')
    service.close()
  })

  it('失败重试一次后放弃，不炸主流程', async () => {
    const logs: string[] = []
    const llm = mockLlm({ facts: [], failTimes: 3 })
    const service = new MemoryService({
      dbPath: dbPath(),
      embeddings: new HashEmbeddings(),
      llm,
      logger: (m) => {
        logs.push(m)
      },
    })
    service.enqueueExtraction('ryen', 'Ryen', 'c1', '用户：你好')
    await service.flush()
    expect(
      logs.filter((m) => {
        return m.includes('retrying')
      }),
    ).toHaveLength(1)
    expect(
      logs.filter((m) => {
        return m.includes('gave up')
      }),
    ).toHaveLength(1)
    service.close()
  })
})

describe('检索管线：混合召回', () => {
  it('RRF 融合：语义命中的排前，纯 FTS 时 BM25 命中的排前（降级路径）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ryagent-memory-rrf-'))
    dirs.push(dir)
    const path = join(dir, 'm.db')
    // 构造：query=[1,0,0,0]
    //   A 向量=[1,0,0,0]（语义完全命中），内容不含查询关键词
    //   B 向量=[0,1,0,0]（语义不命中），内容含查询关键词（BM25 命中）
    const vectors = {
      A: [1, 0, 0, 0],
      B: [0, 1, 0, 0],
    }
    const withEmb = new MemoryService({
      dbPath: path,
      embeddings: scriptedVectors(vectors),
    })
    withEmb.store.insert({
      agentId: 'a1',
      kind: 'fact',
      content: 'A',
      embedding: Float32Array.from(vectors.A as number[]),
      embeddingModel: 'scripted',
    })
    withEmb.store.insert({
      agentId: 'a1',
      kind: 'fact',
      content: 'B 关键词命中',
      embedding: Float32Array.from(vectors.B as number[]),
      embeddingModel: 'scripted',
    })
    const ranked = await withEmb.hybridRecall('a1', 'query', 2)
    expect(ranked[0]!.content).toBe('A') // 语义通道压过 BM25
    withEmb.close()

    // 无 embedding：只剩 BM25 通道，B 排前
    const ftsOnly = new MemoryService({ dbPath: path, embeddings: new NullEmbeddings() })
    const rankedFts = await ftsOnly.hybridRecall('a1', '关键词', 2)
    expect(rankedFts[0]!.content).toBe('B 关键词命中')
    ftsOnly.close()
  })

  it('时间衰减：RRF 相同时新记忆排前', async () => {
    const service = new MemoryService({ dbPath: dbPath(), embeddings: new NullEmbeddings() })
    const old = service.store.insert({ agentId: 'a1', kind: 'fact', content: '同分记忆甲' })
    const recent = service.store.insert({ agentId: 'a1', kind: 'fact', content: '同分记忆乙' })
    service.store.backdate(old.id, Date.now() - 60 * 86_400_000)
    const ranked = await service.hybridRecall('a1', '同分记忆', 2)
    expect(ranked[0]!.id).toBe(recent.id)
    service.close()
  })

  it('衰减基准是最后一次召回而非最后一次写入；命中即强化', async () => {
    const service = new MemoryService({ dbPath: dbPath(), embeddings: new NullEmbeddings() })
    const stale = service.store.insert({ agentId: 'a1', kind: 'preference', content: '稳定偏好甲' })
    const fresh = service.store.insert({ agentId: 'a1', kind: 'preference', content: '稳定偏好乙' })
    // 甲：两个月前写入，但本周刚被召回（衰减不应按写入时间算成 e⁻²）
    service.store.backdate(stale.id, Date.now() - 60 * 86_400_000)
    service.store.touchAccess([stale.id])
    service.store.backdate(fresh.id, Date.now() - 60 * 86_400_000)

    const ranked = await service.hybridRecall('a1', '稳定偏好', 2)
    expect(ranked[0]!.id).toBe(stale.id)
    expect(ranked[0]!.id).not.toBe(fresh.id)
    service.close()
  })

  it('embedding 模型切换：旧模型向量不参与余弦（BM25 通道仍可命中）', async () => {
    const service = new MemoryService({ dbPath: dbPath(), embeddings: scriptedVectors({}, 4) })
    service.store.insert({
      agentId: 'a1',
      kind: 'fact',
      content: '旧模型记忆',
      embedding: Float32Array.from([1, 0, 0, 0]),
      embeddingModel: 'other-model',
    })
    // 查询词与内容无词面重叠 → 只有余弦通道可能命中；旧模型向量已被排除。
    const ranked = await service.hybridRecall('a1', 'zzz', 5)
    expect(ranked).toHaveLength(0)
    expect(service.embeddingModel).toBe('scripted')
    service.close()
  })

  it('embedding 维度不符的记忆被排除并记日志（不静默参与排序）', async () => {
    const logs: string[] = []
    const service = new MemoryService({
      dbPath: dbPath(),
      embeddings: scriptedVectors({}, 4),
      logger: (m) => {
        logs.push(m)
      },
    })
    service.store.insert({
      agentId: 'a1',
      kind: 'fact',
      content: '维度不同的记忆',
      embedding: Float32Array.from([1, 0]),
      embeddingModel: 'scripted',
    })
    service.store.insert({
      agentId: 'a1',
      kind: 'fact',
      content: '维度正确的记忆',
      embedding: Float32Array.from([1, 0, 0, 0]),
      embeddingModel: 'scripted',
    })
    const ranked = await service.hybridRecall('a1', 'zzz', 5)
    expect(
      ranked.map((m) => {
        return m.content
      }),
    ).toEqual(['维度正确的记忆'])
    expect(
      logs.some((m) => {
        return m.includes('embedding dim differs')
      }),
    ).toBe(true)
    service.close()
  })

  it('recall 注入格式：[记忆] 用户画像 + 相关记忆；命中更新访问计数', async () => {
    const service = new MemoryService({ dbPath: dbPath(), embeddings: new NullEmbeddings() })
    service.store.insert({ agentId: SHARED_SPACE, kind: 'profile', content: '用户是产品经理' })
    service.store.insert({ agentId: 'a1', kind: 'fact', content: '用户偏好简洁的周报' })
    const block = await service.recall('a1', '周报')!
    expect(block).toContain('[记忆]')
    expect(block).toContain('用户画像：')
    expect(block).toContain('用户是产品经理')
    expect(block).toContain('相关记忆：')
    expect(block).toContain('用户偏好简洁的周报')
    const hit = service.store.listActiveForAgent('a1')[0]!
    expect(hit.accessCount).toBe(1)
    // 画像每轮都被注入 prompt，同样算一次访问：不计数它 access_count 恒为 0，
    // 巩固任务会把整批画像判成"长期零访问"直接归档。
    const profile = service.store.listSharedProfile()[0]!
    expect(profile.accessCount).toBe(1)
    expect(service.store.get(profile.id)!.lastAccessedAt).toBeGreaterThan(0)
    await service.recall('a1', '周报')
    expect(service.store.listSharedProfile()[0]!.accessCount).toBe(2)
    service.close()
  })

  it('召回转义：输入带 - . / @ # : " 仍能召回（未转义时整条长期记忆静默失效）', async () => {
    const service = new MemoryService({ dbPath: dbPath(), embeddings: new NullEmbeddings() })
    service.store.insert({ agentId: SHARED_SPACE, kind: 'profile', content: '用户是产品经理' })
    service.store.insert({ agentId: 'a1', kind: 'fact', content: '用户的邮箱是 zry@example.com' })
    const block = await service.recall('a1', '把周报发到 zry@example.com，谢谢')
    expect(block).toContain('用户的邮箱是 zry@example.com')
    expect(block).toContain('用户是产品经理')
    service.close()
  })

  it('FTS 通道异常只降级词法通道，共享画像照常注入（降级不等于静默失忆）', async () => {
    const logs: string[] = []
    const service = new MemoryService({
      dbPath: dbPath(),
      embeddings: new NullEmbeddings(),
      logger: (m) => {
        logs.push(m)
      },
    })
    service.store.insert({ agentId: SHARED_SPACE, kind: 'profile', content: '用户是产品经理' })
    service.store.insert({ agentId: 'a1', kind: 'fact', content: '用户偏好简洁的周报' })
    vi.spyOn(service.store, 'searchFtsHits').mockImplementation(() => {
      throw new Error('fts5: database disk image is malformed')
    })

    const block = await service.recall('a1', '周报')
    expect(block).toContain('用户是产品经理')
    expect(block).not.toContain('相关记忆')
    expect(
      logs.some((m) => {
        return m.includes('FTS channel degraded')
      }),
    ).toBe(true)
    service.close()
  })

  it('embedding 缓存：相同文本不重复请求嵌入器', async () => {
    let calls = 0
    const counting: EmbeddingProvider = {
      label: 'counting',
      available: true,
      async embed(texts) {
        calls += texts.length
        return texts.map(() => {
          return Float32Array.from([1, 0, 0, 0])
        })
      },
    }
    const service = new MemoryService({ dbPath: dbPath(), embeddings: counting })
    await service.hybridRecall('a1', '同样的查询')
    await service.hybridRecall('a1', '同样的查询')
    expect(calls).toBe(1)
    service.close()
  })

  it('在途合并：同一段输入的并发召回只发一次 embedding 请求（扇出 N 倍往返的根因）', async () => {
    let requests = 0
    const slow: EmbeddingProvider = {
      label: 'slow',
      available: true,
      async embed(texts) {
        requests += 1
        // 真实端点有网络延迟：延迟期间所有并发者都在路上，落库缓存还没写回。
        await new Promise((resolve) => {
          setTimeout(resolve, 20)
        })
        return texts.map(() => {
          return Float32Array.from([1, 0, 0, 0])
        })
      },
    }
    const service = new MemoryService({ dbPath: dbPath(), embeddings: slow, logger: () => {} })
    const spaces = ['a1', 'a2', 'a3', 'a4']
    // 并发扇出：4 个成员同时问同一段输入。
    await Promise.all(
      spaces.map((space) => {
        return service.recall(space, '同一段用户输入')
      }),
    )
    expect(requests).toBe(1)
    service.close()
  })
})

describe('扇出召回：一次召回多成员共享', () => {
  /** 注入块拆成行（比较"条数与内容"用，忽略行序）。 */
  function linesOf(block: string | undefined): string[] {
    return (block ?? '').split('\n').sort()
  }

  /** 会数 embedding 请求的提供器（每段文本只该被打一次）。 */
  function countingEmbeddings(): EmbeddingProvider & { calls: number } {
    const provider = {
      calls: 0,
      label: 'hash-counting',
      available: true,
      async embed(texts: readonly string[]) {
        provider.calls += 1
        const out = texts.map((text) => {
          // 逐字符散列成向量：不同文本不同向量，召回排序可复现。
          const vector = new Float32Array(64)
          for (let i = 0; i < text.length; i++) vector[i % 64] = (vector[i % 64] as number) + text.charCodeAt(i)
          return vector
        })
        return out
      },
    }
    return provider
  }

  function seeded(): MemoryService {
    const service = new MemoryService({ dbPath: dbPath(), embeddings: countingEmbeddings(), logger: () => {} })
    service.store.insert({ agentId: SHARED_SPACE, kind: 'profile', content: '用户是产品经理' })
    service.store.insert({ agentId: 'a1', kind: 'fact', content: 'CodeBot 负责写代码' })
    service.store.insert({ agentId: 'a2', kind: 'fact', content: 'Reviewer 负责审代码' })
    service.store.insert({ agentId: SHARED_SPACE, kind: 'fact', content: '团队用 TypeScript 写代码' })
    return service
  }

  const INPUT = '今天的代码谁来写'

  it('recallMany 的每个成员块与逐成员 recall 内容一致（条数与内容都不变）', async () => {
    const batched = seeded()
    const perAgent = seeded()
    const members = ['a1', 'a2']

    const shared = await batched.recallMany(members, INPUT)
    const separate = new Map<string, string | undefined>()
    for (const member of members) {
      separate.set(member, await perAgent.recall(member, INPUT))
    }

    expect([...shared.keys()]).toEqual(members)
    for (const member of members) {
      // 逐行比：条数与注入内容必须一模一样。行序不比——两套数据的时间戳差着
      // 几毫秒，时间衰减项会让同分行换个先后，那与召回结果无关。
      expect(linesOf(shared.get(member))).toEqual(linesOf(separate.get(member)))
    }
    // 内容也确实是召回结果（不是两边的 undefined 在"一致"）。
    expect(shared.get('a1')).toContain('CodeBot 负责写代码')
    expect(shared.get('a2')).toContain('Reviewer 负责审代码')
    expect(shared.get('a1')).toContain('用户是产品经理')
    expect(shared.get('a1')).not.toContain('Reviewer 负责审代码') // 空间隔离仍在
    batched.close()
    perAgent.close()
  })

  it('重复调用不会因为"被访问过"而漂移出不同的召回集合', async () => {
    const service = seeded()
    const first = await service.recallMany(['a1', 'a2'], INPUT)
    const second = await service.recallMany(['a1', 'a2'], INPUT)
    for (const member of ['a1', 'a2']) {
      // 行序会随访问强化（命中即强化）变化，召回集合不会。
      expect(linesOf(second.get(member))).toEqual(linesOf(first.get(member)))
    }
    service.close()
  })

  it('共享画像的访问计数按「一次输入」记 1，而不是每个成员各记 1', async () => {
    const service = seeded()
    const profile = service.store.listSharedProfile()[0]!

    await service.recallMany(['a1', 'a2', 'a3'], INPUT)
    expect(service.store.get(profile.id)!.accessCount).toBe(1)

    await service.recallMany(['a1', 'a2'], INPUT)
    expect(service.store.get(profile.id)!.accessCount).toBe(2)
    service.close()
  })

  it('并发扇出（各自 recall）也只打一次 embedding：批量召回是可选的优化，不是前提', async () => {
    const embeddings = countingEmbeddings()
    const service = new MemoryService({ dbPath: dbPath(), embeddings, logger: () => {} })
    service.store.insert({ agentId: 'a1', kind: 'fact', content: 'CodeBot 负责写代码' })

    await Promise.all(['a1', 'a2', 'a3'].map((space) => service.recall(space, INPUT)))
    expect(embeddings.calls).toBe(1)
    service.close()
  })

  it('无 embedding 的安装（纯 FTS5）下批量召回照常工作', async () => {
    const service = new MemoryService({ dbPath: dbPath(), embeddings: new NullEmbeddings(), logger: () => {} })
    service.store.insert({ agentId: SHARED_SPACE, kind: 'profile', content: '用户是产品经理' })
    service.store.insert({ agentId: 'a1', kind: 'fact', content: 'CodeBot 负责写代码' })

    const shared = await service.recallMany(['a1', 'a2'], INPUT)
    expect(shared.get('a1')).toContain('CodeBot 负责写代码')
    expect(shared.get('a2')).toContain('用户是产品经理')
    expect(shared.get('a2')).not.toContain('CodeBot 负责写代码')
    service.close()
  })
})

describe('记忆闭环集成', () => {
  it('第一轮写入的事实，第二轮 recall 能召回', async () => {
    const llm = mockLlm({
      facts: [{ text: '用户的猫叫布丁', scope: 'shared', kind: 'profile' }],
    })
    const service = new MemoryService({ dbPath: dbPath(), embeddings: new HashEmbeddings(), llm })
    // 第一轮：对话 → 抽取
    service.enqueueExtraction('ryen', 'Ryen', 'conv-1', '用户：我的猫叫布丁\nRyen：好可爱的名字')
    await service.flush()
    // 第二轮：recall 注入
    const block = await service.recall('ryen', '给它买点零食')
    expect(block).toContain('用户的猫叫布丁')
    service.close()
  })

  it('空间隔离：agent B 的 recall 看不到 agent A 的私有记忆', async () => {
    const service = new MemoryService({ dbPath: dbPath(), embeddings: new HashEmbeddings() })
    service.store.insert({ agentId: 'agent-a', kind: 'fact', content: 'agent-a 的私密约定' })
    const block = await service.recall('agent-b', '私密约定')
    expect(block ?? '').not.toContain('agent-a 的私密约定')
    service.close()
  })

  it('纯 FTS5 安装：写路径文本判重，近重复事实不再永久累积', async () => {
    const turns = ['用户养了一只橘猫叫布丁', '用户养了只橘猫叫布丁', '用户下周要搬到杭州']
    let cursor = 0
    const llm: MemoryLlm = {
      async extractFacts() {
        const text = turns[cursor++] as string
        return [{ text, scope: 'shared', kind: 'profile' }]
      },
      // 模型每轮都说 ADD：判重不能依赖模型自觉，也不能依赖语义通道
      async decideOperations() {
        return [{ action: 'ADD' }]
      },
    }
    const service = new MemoryService({ dbPath: dbPath(), embeddings: new NullEmbeddings(), llm })
    for (let round = 0; round < turns.length; round++) {
      service.enqueueExtraction('ryen', 'Ryen', `c${round}`, '用户：随便聊聊')
      await service.flush()
    }
    const contents = service.store
      .listActiveForAgent(SHARED_SPACE)
      .map((m) => {
        return m.content
      })
      .sort()
    expect(contents).toEqual(['用户下周要搬到杭州', '用户养了一只橘猫叫布丁'].sort())
    service.close()
  })

  it('纯 FTS5 安装：细化式改写不算近重复，仍然写入（判重不许吃掉 UPDATE 的机会）', async () => {
    const turns = ['用户住在北京', '用户住在北京市朝阳区']
    let cursor = 0
    const llm: MemoryLlm = {
      async extractFacts() {
        const text = turns[cursor++] as string
        return [{ text, scope: 'shared', kind: 'profile' }]
      },
      async decideOperations() {
        return [{ action: 'ADD' }]
      },
    }
    const service = new MemoryService({ dbPath: dbPath(), embeddings: new NullEmbeddings(), llm })
    for (let round = 0; round < turns.length; round++) {
      service.enqueueExtraction('ryen', 'Ryen', `c${round}`, '用户：搬家了')
      await service.flush()
    }
    expect(service.store.listActiveForAgent(SHARED_SPACE)).toHaveLength(2)
    service.close()
  })
})

describe('向量索引重建', () => {
  it('reembedAll 为存量记忆回填向量，第二次不再重复请求嵌入器', async () => {
    let embedded = 0
    const counting: EmbeddingProvider = {
      label: 'counting-model',
      available: true,
      async embed(texts) {
        embedded += texts.length
        return texts.map((_text, index) => {
          return Float32Array.from([1, 0, 0, index])
        })
      },
    }
    const service = new MemoryService({ dbPath: dbPath(), embeddings: counting })
    service.store.insert({ agentId: 'ryen', kind: 'fact', content: '用户住在北京' })
    service.store.insert({ agentId: 'ryen', kind: 'preference', content: '用户偏好川菜' })
    expect(service.store.embeddingModelStats()['counting-model'] ?? 0).toBe(0)

    expect(await service.reembedAll()).toBe(2)
    expect(embedded).toBe(2)
    expect(service.store.embeddingModelStats()['counting-model']).toBe(2)
    // 回填后语义通道可用（此前只能靠 BM25 命中）。
    const recalled = await service.hybridRecall('ryen', '北京')
    expect(
      recalled.map((memory) => {
        return memory.content
      }),
    ).toContain('用户住在北京')

    // 幂等：当前模型下已有向量就整条跳过，且不再打网络（查询向量那次请求不算）。
    const beforeSecond = embedded
    expect(await service.reembedAll()).toBe(0)
    expect(embedded).toBe(beforeSecond)
    service.close()
  })

  it('reembedAll 在 embedding 不可用（纯 FTS5）时返回 0，不假装重建过', async () => {
    const service = new MemoryService({ dbPath: dbPath(), embeddings: new NullEmbeddings() })
    service.store.insert({ agentId: 'ryen', kind: 'fact', content: '用户住在北京' })
    expect(await service.reembedAll()).toBe(0)
    expect(service.store.get(service.store.listActiveForAgent('ryen')[0]!.id)?.embedding).toBeNull()
    service.close()
  })

  it('换 embedding 模型后重建：旧模型向量被新模型接管，语义通道恢复', async () => {
    const path = dbPath()
    const old = new MemoryService({ dbPath: path, embeddings: new HashEmbeddings(4) })
    old.store.insert({ agentId: 'ryen', kind: 'fact', content: '用户养了一只橘猫叫布丁' })
    expect(await old.reembedAll()).toBe(1)
    expect(old.store.embeddingModelStats()['hash:test']).toBe(1)
    old.close()

    const fresh = new MemoryService({
      dbPath: path,
      embeddings: {
        label: 'next-model',
        available: true,
        async embed(texts) {
          return texts.map(() => {
            return Float32Array.from([1, 0, 0, 0])
          })
        },
      },
    })
    // 新模型下旧向量不可用：语义通道空，召回只能靠 BM25。
    expect(fresh.store.listActiveEmbeddings('ryen', fresh.embeddingModel)).toHaveLength(0)
    expect(await fresh.reembedAll()).toBe(1)
    expect(fresh.store.listActiveEmbeddings('ryen', fresh.embeddingModel)).toHaveLength(1)
    fresh.close()
  })

  it('重建用后台预算而不是首 token 的 800ms：慢端点下照样重建成功', async () => {
    const slow: EmbeddingProvider = {
      label: 'slow-model',
      available: true,
      async embed(texts) {
        await new Promise((resolve) => {
          return setTimeout(resolve, 60)
        })
        return texts.map(() => {
          return Float32Array.from([1, 0, 0, 0])
        })
      },
    }
    // 召回预算 20ms（端点慢到召回只能走纯 FTS5），重建预算用默认后台值
    const service = new MemoryService({ dbPath: dbPath(), embeddings: slow, embedTimeoutMs: 20 })
    service.store.insert({ agentId: 'ryen', kind: 'fact', content: '用户住在北京' })
    expect(await service.reembedAll()).toBe(1)
    expect(service.store.embeddingModelStats()['slow-model']).toBe(1)
    service.close()
  })

  it('reembedAll 分片推进：条数超过单片上限时逐片重建，返回值如实等于写入条数', async () => {
    let batches = 0
    const batched: EmbeddingProvider = {
      label: 'batched-model',
      available: true,
      async embed(texts) {
        batches += 1
        return texts.map(() => {
          return Float32Array.from([1, 0, 0, 0])
        })
      },
    }
    const service = new MemoryService({ dbPath: dbPath(), embeddings: batched, reembedBatchSize: 2 })
    for (let i = 0; i < 5; i++) {
      service.store.insert({ agentId: 'ryen', kind: 'fact', content: `事实 ${i}` })
    }
    expect(await service.reembedAll()).toBe(5)
    expect(batches).toBe(3) // 2 + 2 + 1
    expect(service.store.embeddingModelStats()['batched-model']).toBe(5)
    expect(await service.reembedAll()).toBe(0)
    service.close()
  })

  it('端点无响应时如实停住：返回已写入条数，不把处理过的条数当成功', async () => {
    const logs: string[] = []
    const hanging: EmbeddingProvider = {
      label: 'hanging-model',
      available: true,
      embed: () => {
        return new Promise(() => {})
      },
    }
    const service = new MemoryService({
      dbPath: dbPath(),
      embeddings: hanging,
      reembedBatchSize: 2,
      reembedTimeoutMs: 20,
      logger: (m) => {
        logs.push(m)
      },
    })
    for (let i = 0; i < 4; i++) {
      service.store.insert({ agentId: 'ryen', kind: 'fact', content: `事实 ${i}` })
    }
    expect(await service.reembedAll()).toBe(0)
    expect(service.store.embeddingModelStats()['hanging-model']).toBeUndefined()
    expect(
      logs.some((m) => {
        return m.includes('reembed stalled')
      }),
    ).toBe(true)
    service.close()
  })
})
