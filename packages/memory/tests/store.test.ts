import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  MEMORY_SCHEMA_VERSION,
  MemoryStore,
  MIGRATIONS,
  migrateMemory,
  NullEmbeddings,
  SHARED_SPACE,
} from '@ryagent/memory'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryagent-memory-'))
  dirs.push(dir)
  return join(dir, 'm.db')
}
function store(): MemoryStore {
  return new MemoryStore(storePath())
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

describe('MemoryStore', () => {
  it('schema 迁移幂等，memory_meta 记录版本', () => {
    const s = store()
    migrateMemory(s['db' as keyof MemoryStore] as never) // 二次迁移不抛错
    expect(MEMORY_SCHEMA_VERSION).toBe(3)
    s.close()
  })

  it('v1 旧库升到当前版本：数据保留，向量补上模型溯源列', () => {
    const path = storePath()
    const legacy = new DatabaseSync(path)
    MIGRATIONS[1]?.(legacy)
    legacy.prepare("INSERT INTO memory_meta (key, value) VALUES ('schema_version', '1')").run()
    legacy
      .prepare(
        "INSERT INTO memories (id, agent_id, kind, content, embedding, dim, created_at, updated_at) VALUES ('m1', 'a1', 'fact', '用户住在北京', ?, 2, 1, 1)",
      )
      .run(Buffer.from(new Float32Array([0.5, 0.5]).buffer))
    legacy
      .prepare('INSERT INTO embedding_cache (hash, vector, dim, created_at) VALUES (?, ?, 2, 1)')
      .run('h1', Buffer.from(new Float32Array([1, 0]).buffer))
    legacy.close()

    const s = new MemoryStore(path)
    const row = s.get('m1')!
    expect(row.content).toBe('用户住在北京')
    expect(row.status).toBe('active')
    expect(row.embeddingModel).toBeUndefined() // 旧数据无溯源信息，检索时按模型过滤排除
    // 旧缓存行被保留但挂在 legacy 桶，永不命中新模型
    expect(s.cachedEmbedding('anything', 'model-b')).toBeNull()
    expect(Object.keys(s.embeddingCacheStats())).toEqual(['(legacy)'])
    s.cacheEmbedding('x', Float32Array.from([1, 0]), 'model-b')
    expect(s.embeddingCacheStats()['model-b']).toBe(1)
    s.close()
  })

  it('insert/get/supersede 软删链：FTS 不再命中已删，历史保留', () => {
    const s = store()
    const old = s.insert({ agentId: 'a1', kind: 'fact', content: '用户住在北京朝阳区' })
    expect(s.get(old.id)!.status).toBe('active')
    s.supersede(old.id, 'superseded')
    expect(s.get(old.id)!.status).toBe('superseded')
    expect(s.searchFts('a1', '北京')).toHaveLength(0)
    // 软删链：新记忆 supersedes 旧
    const next = s.insert({ agentId: 'a1', kind: 'fact', content: '用户搬到了上海', supersedesId: old.id })
    expect(next.supersedesId).toBe(old.id)
    s.close()
  })

  it('FTS BM25 命中 active 记忆，跨空间只命中私有与共享', () => {
    const s = store()
    s.insert({ agentId: 'a1', kind: 'fact', content: '用户养了一只橘猫叫布丁' })
    s.insert({ agentId: SHARED_SPACE, kind: 'profile', content: '用户是产品经理' })
    s.insert({ agentId: 'other-agent', kind: 'fact', content: '用户养了一只橘猫叫布丁' })
    const hits = s.searchFts('a1', '用户')
    expect(hits).toHaveLength(2)
    expect(
      hits
        .map((m) => {
          return m.agentId
        })
        .sort(),
    ).toEqual([SHARED_SPACE, 'a1'].sort())
    s.close()
  })

  it('touchAccess 递增访问计数与时间', () => {
    const s = store()
    const m = s.insert({ agentId: 'a1', kind: 'fact', content: 'x' })
    s.touchAccess([m.id, m.id])
    const after = s.get(m.id)!
    expect(after.accessCount).toBe(2)
    expect(after.lastAccessedAt).toBeGreaterThanOrEqual(m.lastAccessedAt)
    s.close()
  })

  it('embedding 缓存：按模型分桶，同文本同模型命中，跨模型不命中', () => {
    const s = store()
    const vector = new Float32Array([0.1, 0.2, 0.3])
    expect(s.cachedEmbedding('hello', 'model-a')).toBeNull()
    s.cacheEmbedding('hello', vector, 'model-a')
    const cached = s.cachedEmbedding('hello', 'model-a')!
    expect(cached.length).toBe(3)
    expect([...cached]).toEqual([...vector])
    expect(s.cachedEmbedding('hello', 'model-b')).toBeNull()
    s.close()
  })

  it('换 embedding 模型：旧向量不参与检索（不静默 -1 混库）', () => {
    const s = store()
    const legacy = s.insert({
      agentId: 'a1',
      kind: 'fact',
      content: '旧模型记忆',
      embedding: Float32Array.from([1, 0, 0, 0]),
      embeddingModel: 'model-a',
    })
    const current = s.insert({
      agentId: 'a1',
      kind: 'fact',
      content: '新模型记忆',
      embedding: Float32Array.from([0, 1, 0, 0]),
      embeddingModel: 'model-b',
    })
    expect(s.listActiveEmbeddings('a1', 'model-b').map((m) => m.id)).toEqual([current.id])
    expect(s.listActiveEmbeddings('a1', 'model-a').map((m) => m.id)).toEqual([legacy.id])
    expect(s.embeddingModelStats()).toEqual({ 'model-a': 1, 'model-b': 1 })
    s.close()
  })

  it('巩固归档：dormant 记忆与陈旧软删链移出检索面但保留数据', () => {
    const s = store()
    const dormant = s.insert({ agentId: 'a1', kind: 'event', content: '很久以前的事件' })
    s.backdate(dormant.id, Date.now() - 200 * 86_400_000)
    const hot = s.insert({ agentId: 'a1', kind: 'preference', content: '稳定偏好' })
    s.touchAccess([hot.id]) // 命中即续命，不该被归档

    // 三代软删链 v1 ← v2 ← v3(active)：v2 是当前有效记忆的直接前身（保留），
    // 更早的 v1 归档。
    const v1 = s.insert({ agentId: 'a1', kind: 'fact', content: '住在北京' })
    s.supersede(v1.id)
    const v2 = s.insert({ agentId: 'a1', kind: 'fact', content: '住在北京海淀', supersedesId: v1.id })
    s.supersede(v2.id)
    const v3 = s.insert({ agentId: 'a1', kind: 'fact', content: '住在北京海淀区', supersedesId: v2.id })
    for (const row of [v1, v2, v3]) s.backdate(row.id, Date.now() - 300 * 86_400_000)

    expect(s.archiveDormant(90 * 86_400_000)).toBe(2) // dormant 事件 + 从未被召回的 v3
    expect(s.archiveColdSuperseded(180 * 86_400_000)).toBe(1) // 只归档 v1
    expect(s.get(dormant.id)!.status).toBe('inactive')
    expect(s.get(v1.id)!.status).toBe('inactive')
    expect(s.get(v2.id)!.status).toBe('superseded') // 链尾可追溯
    expect(s.get(v3.id)!.status).toBe('inactive')
    expect(s.get(hot.id)!.status).toBe('active')
    // 归档记忆仍在库里（可审计、可恢复），只是不进检索面
    expect(s.stats().total).toBe(5)
    expect(s.searchFts('a1', '住在北京')).toHaveLength(0)
    s.close()
  })

  it('stats 按空间/种类/状态分桶', () => {
    const s = store()
    s.insert({ agentId: 'a1', kind: 'fact', content: '一' })
    s.insert({ agentId: SHARED_SPACE, kind: 'profile', content: '二' })
    const gone = s.insert({ agentId: 'a1', kind: 'event', content: '三' })
    s.supersede(gone.id)
    const stats = s.stats()
    expect(stats.total).toBe(3)
    expect(stats.byStatus.active).toBe(2)
    expect(stats.byStatus.superseded).toBe(1)
    expect(stats.byKind.profile).toBe(1)
    s.close()
  })

  it('NullEmbeddings 标记不可用（纯 FTS 降级路径）', () => {
    expect(new NullEmbeddings().available).toBe(false)
    expect(new NullEmbeddings().label).toContain('fts')
  })
})
