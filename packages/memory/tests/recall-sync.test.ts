import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EmbeddingProvider } from '@ryharness/memory'
import { cosine, HashEmbeddings, MemoryService, SHARED_SPACE } from '@ryharness/memory'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-memory-sync-'))
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 可控延迟的 embedding：记录调用次数，用来断言"同步召回不打网络"。 */
function slowEmbeddings(base: HashEmbeddings, delayMs: number): EmbeddingProvider & { calls: number } {
  return {
    label: 'slow',
    available: true,
    calls: 0,
    async embed(texts) {
      this.calls++
      await delay(delayMs)
      return texts.map((text) => {
        return base.vectorOf(text)
      })
    },
  }
}

/** 建一个带画像 + 若干私有记忆的服务。 */
function service(embeddings?: EmbeddingProvider): MemoryService {
  const svc = new MemoryService({ dbPath: dbPath(), ...(embeddings === undefined ? {} : { embeddings }) })
  svc.store.insert({ agentId: SHARED_SPACE, kind: 'profile', content: '用户养了一只橘猫叫布丁' })
  svc.store.insert({ agentId: 'a1', kind: 'preference', content: '用户的周报希望用条目式的写法' })
  return svc
}

describe('recallSync：首 token 路径上的同步召回', () => {
  it('不触发任何 embedding 网络请求', () => {
    const embeddings = slowEmbeddings(new HashEmbeddings(), 50)
    const svc = service(embeddings)
    const block = svc.recallSync('a1', '周报怎么写')
    expect(block).toContain('用户养了一只橘猫叫布丁')
    expect(embeddings.calls).toBe(0)
  })

  it('与 await 路径召回同一批记忆（本地通道下两者等价）', async () => {
    const svc = service()
    const query = '周报'
    const syncBlock = svc.recallSync('a1', query) ?? ''
    const asyncBlock = (await svc.recall('a1', query)) ?? ''
    const memoriesOf = (block: string): string[] => {
      return block
        .split('\n')
        .filter((line) => {
          return line.startsWith('- ')
        })
        .sort()
    }
    expect(memoriesOf(syncBlock)).toEqual(memoriesOf(asyncBlock))
    expect(memoriesOf(syncBlock).length).toBeGreaterThan(1)
  })

  it('无命中时不注入空块', () => {
    const svc = new MemoryService({ dbPath: dbPath() })
    expect(svc.recallSync('a1', '查无此事的关键词zzz')).toBeUndefined()
  })

  it('存储层故障时静默降级，不抛', () => {
    const svc = service()
    svc.store.close()
    expect(() => svc.recallSync('a1', '周报')).not.toThrow()
    expect(svc.recallSync('a1', '周报')).toBeUndefined()
  })

  it('共享画像的访问计数每轮只记一次（补正不重复记账）', async () => {
    const svc = service()
    const before = svc.store.listSharedProfile()[0]?.accessCount ?? 0
    svc.recallSync('a1', '周报')
    await svc.recallRefine('a1', '周报')
    const after = svc.store.listSharedProfile()[0]?.accessCount ?? 0
    expect(after - before).toBe(1)
  })
})

describe('群聊扇出的同步召回：共享空间只打分一次', () => {
  /**
   * 打分探针：包住 store.spaceEmbeddingMatrix 按空间计数（手法同 recall.perf.ts
   * 的 statementCounter——不改产品代码，只观察内部调用）。
   */
  function scoringProbe(svc: MemoryService): { shared: () => number; privateScans: () => number } {
    const store = svc.store
    const original = store.spaceEmbeddingMatrix.bind(store)
    let shared = 0
    let privateScans = 0
    store.spaceEmbeddingMatrix = (spaceId: string, embeddingModel?: string, stamp?: string) => {
      if (spaceId === SHARED_SPACE) shared += 1
      else privateScans += 1
      return original(spaceId, embeddingModel, stamp)
    }
    return { shared: () => shared, privateScans: () => privateScans }
  }

  /** 共享空间带向量 + 两个成员各带私有向量 + 一条共享画像。 */
  function fanoutService(): MemoryService {
    const vectors = new HashEmbeddings()
    const svc = new MemoryService({ dbPath: dbPath(), embeddings: vectors })
    svc.store.insert({ agentId: SHARED_SPACE, kind: 'profile', content: '用户养了一只橘猫叫布丁' })
    svc.store.insert({
      agentId: SHARED_SPACE,
      kind: 'fact',
      content: '共享事实：用户在全群面前提过喜欢条目式写法',
      embedding: vectors.vectorOf('共享 条目式'),
      embeddingModel: vectors.model,
    })
    svc.store.insert({
      agentId: 'a1',
      kind: 'fact',
      content: 'A 的私有事实：用户喜欢川菜',
      embedding: vectors.vectorOf('川菜'),
      embeddingModel: vectors.model,
    })
    svc.store.insert({
      agentId: 'b1',
      kind: 'fact',
      content: 'B 的私有事实：用户在学日语',
      embedding: vectors.vectorOf('日语'),
      embeddingModel: vectors.model,
    })
    return svc
  }

  it('同一段输入的 3 成员同步召回：共享空间打分 1 次，私有空间各扫各的', async () => {
    const svc = fanoutService()
    const query = '条目式 写法'
    await svc.recallRefine('a1', query)
    const probe = scoringProbe(svc)
    const blocks = ['a1', 'b1', 'c1'].map((agentId) => {
      return svc.recallSync(agentId, query)
    })
    expect(probe.shared()).toBe(1)
    expect(probe.privateScans()).toBe(3)
    svc.close()
    // 共享事实对每个成员都可见；A 的私有事实不进 B 的注入块。
    expect(blocks[0]).toContain('共享事实')
    expect(blocks[1]).toContain('共享事实')
    expect(blocks[1]).not.toContain('川菜')
  })

  it('换一段输入或写代变化后重新打分（缓存不跨输入、不跨写代复用）', async () => {
    const svc = fanoutService()
    const first = '条目式 写法'
    const second = '橘猫 布丁'
    await svc.recallRefine('a1', first)
    await svc.recallRefine('b1', second)
    const probe = scoringProbe(svc)
    svc.recallSync('a1', first)
    expect(probe.shared()).toBe(1)
    // 不同输入：查询向量不同，共享空间必须真算一遍。
    svc.recallSync('b1', second)
    expect(probe.shared()).toBe(2)
    // 写代变化（抽取落库、编辑都走这条路）：同一输入也立即重算。
    svc.store.insert({ agentId: 'b1', kind: 'fact', content: '新落库的事实' })
    svc.recallSync('a1', first)
    expect(probe.shared()).toBe(3)
    svc.close()
  })

  it('共享访问计数口径不变：仍按每个成员的注入各记一次（与逐成员透传时一致）', async () => {
    const svc = fanoutService()
    const query = '条目式 写法'
    await svc.recallRefine('a1', query)
    const before = svc.store.listSharedProfile()[0]?.accessCount ?? 0
    svc.recallSync('a1', query)
    svc.recallSync('b1', query)
    const after = svc.store.listSharedProfile()[0]?.accessCount ?? 0
    svc.close()
    // 同步路径逐成员各自组装注入块，画像各记 1 次；共享的只是"打分"，不是"记账"。
    expect(after - before).toBe(2)
  })
})

describe('语义通道打分：矩阵单趟与逐行 cosine 同一结果', () => {
  /**
   * 对照函数：旧 scoreSemantic 的打分形状（逐行 cosine + 降序）。
   *
   * 查询文本与全部记忆字面无交集 → FTS 通道零命中，注入的"相关记忆"就是语义
   * 通道的 top-5；它必须与对照函数在同一桶、同一向量上算出的 top-5 完全一致。
   */
  it('召回集合与排序和逐行 cosine 对照完全一致', () => {
    const vectors = new HashEmbeddings()
    const svc = new MemoryService({ dbPath: dbPath(), embeddings: vectors })
    for (let index = 0; index < 40; index++) {
      svc.store.insert({
        agentId: 'a1',
        kind: 'fact',
        content: `记忆 ${index}：主题甲乙丙丁戊己庚辛壬癸#${index}`,
        embedding: vectors.vectorOf(`种子 ${index}`),
        embeddingModel: vectors.model,
      })
    }
    const query = '完全无关的查询词组'
    svc.store.cacheEmbedding(query, vectors.vectorOf(query), svc.embeddingModel)
    const vector = svc.store.cachedEmbedding(query, svc.embeddingModel)
    expect(vector).not.toBeNull()
    if (vector === null) {
      svc.close()
      throw new Error('查询向量未入缓存')
    }
    const expected = svc.store
      .listSpaceEmbeddings('a1', svc.embeddingModel)
      .filter((memory) => {
        return memory.embedding !== null && memory.embedding.length === vector.length
      })
      .map((memory) => {
        return { memory, score: cosine(vector, memory.embedding as Float32Array) }
      })
      .sort((a, b) => {
        return b.score - a.score
      })
      .slice(0, 5)
      .map((hit) => {
        return hit.memory.content
      })
    const block = svc.recallSync('a1', query) ?? ''
    svc.close()
    const recalled = block
      .split('\n')
      .filter((line) => {
        return line.startsWith('- ') && line.includes('记忆 ')
      })
      .map((line) => {
        return line.slice(2)
      })
    expect(recalled).toEqual(expected)
  })
})

describe('recallRefine：首 token 之后的补正', () => {
  it('把向量写进缓存，下一轮同步召回就能命中语义通道', async () => {
    const embeddings = slowEmbeddings(new HashEmbeddings(), 1)
    const svc = service(embeddings)
    const query = '周报'
    expect(svc.store.cachedEmbedding(query, svc.embeddingModel)).toBeNull()
    expect(await svc.recallRefine('a1', query)).toBe(true)
    expect(embeddings.calls).toBe(1)
    expect(svc.store.cachedEmbedding(query, svc.embeddingModel)).not.toBeNull()
    // 缓存热了之后再补正不会重复请求。
    expect(await svc.recallRefine('a1', query)).toBe(true)
    expect(embeddings.calls).toBe(1)
  })

  it('超过 deadline 就放弃等待，但在途请求仍会把向量写回缓存', async () => {
    const embeddings = slowEmbeddings(new HashEmbeddings(), 120)
    const svc = service(embeddings)
    const query = '周报'
    expect(await svc.recallRefine('a1', query, 10)).toBe(false)
    // 同步召回此刻仍是纯 FTS5，不阻塞也不报错。
    expect(svc.recallSync('a1', query)).toContain('用户养了一只橘猫叫布丁')
    await delay(200)
    expect(svc.store.cachedEmbedding(query, svc.embeddingModel)).not.toBeNull()
  })

  it('embedding 不可用时直接返回 false', async () => {
    const svc = new MemoryService({ dbPath: dbPath() })
    expect(await svc.recallRefine('a1', '周报')).toBe(false)
  })

  it('embedding 抛错不影响补正之外的任何东西', async () => {
    const broken: EmbeddingProvider = {
      label: 'broken',
      available: true,
      embed() {
        return Promise.reject(new Error('endpoint down'))
      },
    }
    const svc = service(broken)
    expect(await svc.recallRefine('a1', '周报')).toBe(false)
    expect(svc.recallSync('a1', '周报')).toContain('用户养了一只橘猫叫布丁')
  })
})

describe('语义通道回灌：两段式下语义结果真的进过注入块', () => {
  /**
   * 固定向量的 embedding：只有它能把"语义相关但字面无交集"这一情形测出来。
   *
   * 哈希伪向量（HashEmbeddings）与词法相似度同源，BM25 能捞到的它也能捞到，
   * 用它写"只有语义通道能召回"的断言等于什么都没断言。
   */
  function fixedEmbeddings(table: Record<string, [number, number, number]>): EmbeddingProvider {
    return {
      label: 'fixed:test',
      model: 'fixed:test',
      available: true,
      async embed(texts) {
        return texts.map((text) => {
          const point = table[text]
          if (point === undefined) throw new Error(`fixed embedding 缺 "${text}"`)
          return Float32Array.from(point)
        })
      },
    }
  }

  const NEAR_TEXT = '用户偏好靠窗的位置，环境安静，适合长时间专注'
  /** 余弦 0 / 0.2 / 0.4：回灌只取 top-3，最远的那条必须落在窗口外。 */
  const FAR_TEXTS = [
    '用户希望周报用条目式的写法，不要大段叙述',
    '用户的台灯偏暖色，房间不要开顶灯',
    '用户的键盘布局是美式，习惯用 Cmd 键',
  ]
  const ASK_TEXT = '我想找个地方专心写点东西'
  const NEXT_TEXT = '那我们换个话题聊聊周末的安排'

  function semanticService(embeddings: EmbeddingProvider): MemoryService {
    const svc = new MemoryService({ dbPath: dbPath(), embeddings })
    const put = (content: string, point: [number, number, number], space = 'a1'): void => {
      svc.store.insert({
        agentId: space,
        kind: 'preference',
        content,
        embedding: Float32Array.from(point),
        embeddingModel: 'fixed:test',
      })
    }
    put(NEAR_TEXT, [0.98, 0.1, 0])
    put(FAR_TEXTS[0] as string, [0, 1, 0])
    put(FAR_TEXTS[1] as string, [0.2, 0.98, 0])
    put(FAR_TEXTS[2] as string, [0.4, 0.92, 0])
    put('B 空间自己的记忆', [1, 0, 0], 'b1')
    return svc
  }

  const table: Record<string, [number, number, number]> = {
    [ASK_TEXT]: [1, 0, 0],
    [NEXT_TEXT]: [0.6, 0.8, 0],
  }

  it('补正前的同步召回确实只有词法通道（语义那条命中的字面与查询无交集）', async () => {
    const svc = semanticService(fixedEmbeddings(table))
    const first = svc.recallSync('a1', ASK_TEXT)
    expect(first).toBeUndefined()
    expect(await svc.recallRefine('a1', ASK_TEXT)).toBe(true)
  })

  it('补正算出的语义命中在下一轮 recallSync 里被注入', async () => {
    const svc = semanticService(fixedEmbeddings(table))
    await svc.recallRefine('a1', ASK_TEXT)
    const next = svc.recallSync('a1', NEXT_TEXT) ?? ''
    expect(next).toContain(NEAR_TEXT)
    // 回灌只取语义 top-3：排在窗口外的余弦 0 那条不该被带进来。
    expect(next).not.toContain(FAR_TEXTS[0] as string)
  })

  it('回灌是一次性的：下一轮不会被同一条重复注入', async () => {
    const svc = semanticService(fixedEmbeddings(table))
    await svc.recallRefine('a1', ASK_TEXT)
    expect(svc.recallSync('a1', NEXT_TEXT) ?? '').toContain(NEAR_TEXT)
    const third = svc.recallSync('a1', NEXT_TEXT) ?? ''
    // 第三轮的查询向量这次已在缓存里，纯 FTS5 与语义通道都捞不到那条记忆。
    expect(third).not.toContain(NEAR_TEXT)
  })

  it('回灌按空间隔离：A 的语义命中不会流进 B 的注入块', async () => {
    const svc = semanticService(fixedEmbeddings(table))
    await svc.recallRefine('a1', ASK_TEXT)
    const forB = svc.recallSync('b1', NEXT_TEXT) ?? ''
    expect(forB).not.toContain(NEAR_TEXT)
    // A 自己那份还在（B 的同步召回只取自己空间的回灌）。
    expect(svc.recallSync('a1', NEXT_TEXT) ?? '').toContain(NEAR_TEXT)
  })

  it('补正与下一次召回之间被软删的记忆不回灌', async () => {
    const svc = semanticService(fixedEmbeddings(table))
    await svc.recallRefine('a1', ASK_TEXT)
    const near = svc.store.listActiveForAgent('a1').find((row) => {
      return row.content === NEAR_TEXT
    })
    expect(near).toBeDefined()
    svc.store.supersede((near as { id: string }).id, 'superseded')
    const next = svc.recallSync('a1', NEXT_TEXT) ?? ''
    expect(next).not.toContain(NEAR_TEXT)
  })

  it('await 路径不吃回灌（它自己就等得到向量，回灌只服务首 token 路径）', async () => {
    const svc = semanticService(fixedEmbeddings(table))
    await svc.recallRefine('a1', ASK_TEXT)
    const asyncBlock = (await svc.recall('a1', NEXT_TEXT)) ?? ''
    // NEXT_TEXT 的向量此时已在缓存里，await 路径自己算出语义通道，不需要回灌。
    expect(asyncBlock).toContain(NEAR_TEXT)
    // 回灌也没被 await 路径消耗掉。
    expect(svc.recallSync('a1', NEXT_TEXT) ?? '').toContain(NEAR_TEXT)
  })
})

describe('recall 的整体预算真的是预算', () => {
  it('recallBudgetMs 覆盖 embedding 等待，而不只是画像查询', async () => {
    const budgetMs = 20
    const svc = new MemoryService({
      dbPath: dbPath(),
      embeddings: slowEmbeddings(new HashEmbeddings(), 400),
      recallBudgetMs: budgetMs,
    })
    svc.store.insert({ agentId: 'a1', kind: 'preference', content: '用户的周报希望用条目式的写法' })
    const started = Date.now()
    const block = await svc.recall('a1', '周报')
    const elapsed = Date.now() - started
    // 超预算降级纯 FTS5：注入块照样有内容，但不再等那次 400ms 的网络往返。
    expect(block).toContain('用户的周报希望用条目式的写法')
    expect(elapsed).toBeLessThan(400 / 2)
  })

  it('预算内能等到向量时，语义通道照常参与融合', async () => {
    const svc = new MemoryService({
      dbPath: dbPath(),
      embeddings: slowEmbeddings(new HashEmbeddings(), 5),
      recallBudgetMs: 1_200,
    })
    svc.store.insert({ agentId: 'a1', kind: 'preference', content: '用户的周报希望用条目式的写法' })
    expect(await svc.recall('a1', '周报')).toContain('用户的周报希望用条目式的写法')
    expect(svc.store.cachedEmbedding('周报', svc.embeddingModel)).not.toBeNull()
  })
})
