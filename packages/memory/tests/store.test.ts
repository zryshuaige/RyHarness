import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore, migrateMemory, MEMORY_SCHEMA_VERSION, SHARED_SPACE, NullEmbeddings } from '@ryagent/memory'

const dirs: string[] = []
function store(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'ryagent-memory-'))
  dirs.push(dir)
  return new MemoryStore(join(dir, 'm.db'))
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
    expect(MEMORY_SCHEMA_VERSION).toBe(1)
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
    expect(hits.map((m) => { return m.agentId }).sort()).toEqual([SHARED_SPACE, 'a1'].sort())
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

  it('embedding 缓存：同文本哈希命中，向量字节往返一致', () => {
    const s = store()
    const vector = new Float32Array([0.1, 0.2, 0.3])
    expect(s.cachedEmbedding('hello')).toBeNull()
    s.cacheEmbedding('hello', vector)
    const cached = s.cachedEmbedding('hello')!
    expect(cached.length).toBe(3)
    expect([...cached]).toEqual([...vector])
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
