import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HashEmbeddings, MemoryService, NullEmbeddings, SHARED_SPACE } from '@ryagent/memory'
import type { EmbeddingProvider } from '@ryagent/memory'
import type { CandidateFact, MemoryLlm, MemoryOperation } from '@ryagent/memory'

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
    expect(shared.map((m) => { return m.content })).toContain('用户养了一只橘猫叫布丁')
    const agentSpace = service.store.listActiveForAgent('ryen')
    expect(agentSpace.map((m) => { return m.content })).toContain('用户希望周报用简洁的条目式')
    // 共享画像不进入 agent 私有列表
    expect(agentSpace.some((m) => { return m.agentId === SHARED_SPACE })).toBe(false)
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

  it('NOOP：不产生写入', async () => {
    const llm = mockLlm({
      facts: [{ text: '用户住在北京', scope: 'shared', kind: 'profile' }],
      decide: () => { return [{ action: 'NOOP' }] },
    })
    const service = new MemoryService({ dbPath: dbPath(), embeddings: new HashEmbeddings(), llm })
    service.enqueueExtraction('ryen', 'Ryen', 'c1', '用户：我住在北京')
    await service.flush()
    expect(service.store.stats().total).toBe(0)
    service.close()
  })

  it('失败重试一次后放弃，不炸主流程', async () => {
    const logs: string[] = []
    const llm = mockLlm({ facts: [], failTimes: 3 })
    const service = new MemoryService({
      dbPath: dbPath(), embeddings: new HashEmbeddings(), llm,
      logger: (m) => { logs.push(m) },
    })
    service.enqueueExtraction('ryen', 'Ryen', 'c1', '用户：你好')
    await service.flush()
    expect(logs.filter((m) => { return m.includes('retrying') })).toHaveLength(1)
    expect(logs.filter((m) => { return m.includes('gave up') })).toHaveLength(1)
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
    withEmb.store.insert({ agentId: 'a1', kind: 'fact', content: 'A', embedding: Float32Array.from(vectors.A as number[]) })
    withEmb.store.insert({ agentId: 'a1', kind: 'fact', content: 'B 关键词命中', embedding: Float32Array.from(vectors.B as number[]) })
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
    service.close()
  })

  it('embedding 缓存：相同文本不重复请求嵌入器', async () => {
    let calls = 0
    const counting: EmbeddingProvider = {
      label: 'counting',
      available: true,
      async embed(texts) {
        calls += texts.length
        return texts.map(() => { return Float32Array.from([1, 0, 0, 0]) })
      },
    }
    const service = new MemoryService({ dbPath: dbPath(), embeddings: counting })
    await service.hybridRecall('a1', '同样的查询')
    await service.hybridRecall('a1', '同样的查询')
    expect(calls).toBe(1)
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
})
