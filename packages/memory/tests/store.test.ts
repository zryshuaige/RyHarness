import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ftsMatchQuery,
  MEMORY_SCHEMA_VERSION,
  MemoryStore,
  MIGRATIONS,
  migrateMemory,
  NullEmbeddings,
  SHARED_SPACE,
} from '@ryharness/memory'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-memory-'))
  dirs.push(dir)
  return join(dir, 'm.db')
}
function store(): MemoryStore {
  return new MemoryStore(storePath())
}

/** 测试用：绕过存储层直接操作底层连接（模拟旧版本留下的脏状态）。 */
function raw(s: MemoryStore, sql: string, ...args: unknown[]): void {
  ;(s as unknown as { db: DatabaseSync }).db.prepare(sql).run(...(args as never[]))
}

/** 测试用：绕过存储层直接查底层连接（含故意写错的 FTS 查询）。 */
function rawQuery(s: MemoryStore, sql: string, ...args: unknown[]): unknown[] {
  return (s as unknown as { db: DatabaseSync }).db.prepare(sql).all(...(args as never[])) as unknown[]
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
    expect(MEMORY_SCHEMA_VERSION).toBe(5)
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

  it('FTS 查询转义：带 - . / @ # : " 的输入仍能召回（未转义时 MATCH 直接抛错）', () => {
    const s = store()
    s.insert({ agentId: 'a1', kind: 'fact', content: '用户的邮箱是 zry@example.com' })
    s.insert({ agentId: 'a1', kind: 'fact', content: '项目入口在 src/main.ts（见 #12）' })
    s.insert({ agentId: 'a1', kind: 'fact', content: '备注写的是 note: 待办' })
    s.insert({ agentId: 'a1', kind: 'fact', content: '用户强调"很重要"这条' })
    const cases: [query: string, expected: string][] = [
      ['邮箱 zry@example.com', '用户的邮箱是 zry@example.com'],
      ['入口在 src/main.ts', '项目入口在 src/main.ts（见 #12）'],
      ['note: 待办', '备注写的是 note: 待办'],
      ['强调"很重要"', '用户强调"很重要"这条'],
    ]
    for (const [query, expected] of cases) {
      expect(
        s.searchFts('a1', query).map((row) => {
          return row.content
        }),
        query,
      ).toContain(expected)
    }
    // token 逐个加引号、内部 " 双写：拼错一个就是整条通道抛错
    expect(ftsMatchQuery('a"b')).toBe('"a""" OR """b"')
    // 未转义的 bigram 查询（修复前的拼法）：落单的 " 被当成未闭合字符串，整条通道抛错
    expect(() => {
      rawQuery(s, 'SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?', 'a"')
    }).toThrow(/unterminated string/)
    expect(() => {
      rawQuery(s, 'SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?', 'or OR')
    }).toThrow(/syntax error/)
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

  it('touchAccess 批量递增访问计数与时间（每行一次，重复 id 不叠加）', () => {
    const s = store()
    const a = s.insert({ agentId: 'a1', kind: 'fact', content: 'x' })
    const b = s.insert({ agentId: 'a1', kind: 'fact', content: 'y' })
    s.touchAccess([a.id, b.id, a.id])
    // 一条 WHERE id IN 的批量记账按「这行被访问了一次」计，重复 id 不叠加：
    // 逐 id UPDATE 的旧写法会把同一行记两次，是记账口径而不是业务语义。
    expect(s.get(a.id)?.accessCount).toBe(1)
    expect(s.get(b.id)?.accessCount).toBe(1)
    expect(s.get(a.id)?.lastAccessedAt).toBeGreaterThanOrEqual(a.lastAccessedAt)
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

  it('巩固归档跳过共享画像：用户画像没有恢复入口，归档即等于静默抹掉', () => {
    const s = store()
    const profile = s.insert({ agentId: SHARED_SPACE, kind: 'profile', content: '用户是产品经理' })
    const agentFact = s.insert({ agentId: 'a1', kind: 'fact', content: '很久以前的私有事实' })
    const old = Date.now() - 200 * 86_400_000
    s.backdate(profile.id, old)
    s.backdate(agentFact.id, old)

    expect(s.archiveDormant(90 * 86_400_000)).toBe(1)
    expect(s.get(profile.id)!.status).toBe('active')
    expect(s.get(agentFact.id)!.status).toBe('inactive')
    // 画像仍在注入面上，agent 回来还认得用户。
    expect(s.listSharedProfile().map((row) => row.id)).toEqual([profile.id])
    s.close()
  })

  it('归档同步清出 FTS 索引：死行不再挤占 BM25 候选窗口，恢复时按 rowid 重建', () => {
    const s = store()
    const dormant = s.insert({ agentId: 'a1', kind: 'event', content: '很久以前的事件' })
    const alive = s.insert({ agentId: 'a1', kind: 'preference', content: '稳定偏好' })
    s.backdate(dormant.id, Date.now() - 300 * 86_400_000)
    expect(s.ftsIndexSize()).toBe(2)

    expect(s.archiveDormant(90 * 86_400_000)).toBe(1)
    // 索引只留 active 行：只过滤不清理的话死行会一直挤占 limit*3 的候选窗口
    expect(s.ftsIndexSize()).toBe(1)
    expect(s.get(alive.id)!.status).toBe('active')
    expect(s.stats().total).toBe(2) // 行数据一条不少，可审计可恢复
    expect(s.searchFts('a1', '很久以前的事件')).toEqual([])
    // 冷软删链归档同理（软删时索引行已清，归档不该让索引变大）
    expect(s.archiveColdSuperseded(180 * 86_400_000)).toBe(0)
    expect(s.ftsIndexSize()).toBe(1)

    expect(s.restore(dormant.id)).toBe(true)
    expect(s.ftsIndexSize()).toBe(2)
    expect(
      s.searchFts('a1', '很久以前的事件').map((row) => {
        return row.id
      }),
    ).toEqual([dormant.id])
    s.close()
  })

  it('归档分片：按 limit 一片一片搬，整轮结果与一次性归档一致（FTS 同步清）', () => {
    const s = store()
    const ids: string[] = []
    for (let i = 0; i < 7; i++) {
      const row = s.insert({ agentId: 'a1', kind: 'event', content: `旧事件 ${i}` })
      s.backdate(row.id, Date.now() - 300 * 86_400_000)
      ids.push(row.id)
    }
    const hot = s.insert({ agentId: 'a1', kind: 'preference', content: '稳定偏好' })
    s.touchAccess([hot.id])

    // 一片 3 行：前两片各搬 3 行，第三片搬 1 行后返回 0（扫完了）。
    let archived = 0
    const sizes: number[] = []
    for (let i = 0; i < 10; i++) {
      const chunk = s.archiveDormant(90 * 86_400_000, Date.now(), 3)
      sizes.push(chunk)
      archived += chunk
      if (chunk < 3) break
    }
    expect(sizes).toEqual([3, 3, 1]) // 第三片不足片长 = 扫完了
    expect(archived).toBe(ids.length)
    expect(
      s
        .listArchived()
        .map((row) => {
          return row.id
        })
        .sort(),
    ).toEqual([...ids].sort())
    // 分片归档同样清索引：逐片清，不留死行挤占 BM25 窗口。
    expect(s.ftsIndexSize()).toBe(1)
    expect(s.searchFts('a1', '旧事件')).toEqual([])
    expect(s.get(hot.id)!.status).toBe('active')
    s.close()
  })

  it('冷软删链归档分片：末代保留的语义不变，陈旧的中间版本照样全搬走', () => {
    const s = store()
    const v1 = s.insert({ agentId: 'a1', kind: 'fact', content: '住在北京' })
    s.supersede(v1.id)
    const v2 = s.insert({ agentId: 'a1', kind: 'fact', content: '住在北京海淀', supersedesId: v1.id })
    s.supersede(v2.id)
    const v3 = s.insert({ agentId: 'a1', kind: 'fact', content: '住在北京海淀区', supersedesId: v2.id })
    for (const row of [v1, v2, v3]) s.backdate(row.id, Date.now() - 300 * 86_400_000)

    let archived = 0
    for (;;) {
      const chunk = s.archiveColdSuperseded(180 * 86_400_000, Date.now(), 1)
      archived += chunk
      if (chunk < 1) break
    }
    expect(archived).toBe(1)
    expect(s.get(v1.id)!.status).toBe('inactive')
    expect(s.get(v2.id)!.status).toBe('superseded') // 链尾可追溯
    expect(s.get(v3.id)!.status).toBe('active')
    s.close()
  })

  it('归档分片与一次性归档口径一致（同一批行，谁都不多谁都不少）', () => {
    const build = (s: MemoryStore): void => {
      for (let i = 0; i < 5; i++) {
        const row = s.insert({ agentId: 'a1', kind: 'event', content: `陈旧 ${i}` })
        s.backdate(row.id, Date.now() - 300 * 86_400_000)
      }
    }
    const chunked = store()
    build(chunked)
    let total = 0
    for (;;) {
      const chunk = chunked.archiveDormant(90 * 86_400_000, Date.now(), 2)
      total += chunk
      if (chunk < 2) break
    }
    const oneShot = store()
    build(oneShot)
    const single = oneShot.archiveDormant(90 * 86_400_000)

    expect(total).toBe(single)
    expect(chunked.stats().byStatus).toEqual(oneShot.stats().byStatus)
    chunked.close()
    oneShot.close()
  })

  it('v4 迁移：存量库里归档/软删残留的 FTS 行一次清干净', () => {
    const path = storePath()
    const s = new MemoryStore(path)
    const alive = s.insert({ agentId: 'a1', kind: 'fact', content: '活跃记忆' })
    const archived = s.insert({ agentId: 'a1', kind: 'event', content: '被归档的旧事件' })
    // 模拟旧版本：只改 status 不清索引，并把版本号拨回 v3
    raw(s, "UPDATE memories SET status = 'inactive' WHERE id = ?", archived.id)
    raw(s, "UPDATE memory_meta SET value = '3' WHERE key = 'schema_version'")
    expect(s.ftsIndexSize()).toBe(2)
    s.close()

    const reopened = new MemoryStore(path) // 打开即迁移到 v4
    expect(reopened.ftsIndexSize()).toBe(1)
    expect(reopened.get(archived.id)!.status).toBe('inactive')
    expect(
      reopened.searchFts('a1', '活跃记忆').map((row) => {
        return row.id
      }),
    ).toEqual([alive.id])
    reopened.close()
  })

  it('listActiveEmbeddings 常驻：重复召回不再全表读，写入与跨连接删除后失效', () => {
    const path = storePath()
    const s = new MemoryStore(path)
    const first = s.insert({
      agentId: 'a1',
      kind: 'fact',
      content: '甲',
      embedding: Float32Array.from([1, 0]),
      embeddingModel: 'm',
    })
    const second = s.insert({
      agentId: 'a1',
      kind: 'fact',
      content: '乙',
      embedding: Float32Array.from([0, 1]),
      embeddingModel: 'm',
    })
    const cached = s.listActiveEmbeddings('a1', 'm')
    expect(cached.map((row) => row.content)).toEqual(['甲', '乙'])
    // 缓存的落点是"空间桶"：行对象复用（不再全表读 + 重新解码 BLOB），
    // 拼装的数组本身每次新建（私有 + 共享两桶拼起来）。
    const spaceCached = s.listSpaceEmbeddings('a1', 'm')
    expect(s.listSpaceEmbeddings('a1', 'm')).toBe(spaceCached)
    expect(s.listActiveEmbeddings('a1', 'm')[0]).toBe(spaceCached[0])
    // 命中计数就地同步：每轮 recall 都 touchAccess，若因此整体失效缓存等于没加
    s.touchAccess([first.id])
    expect(s.listActiveEmbeddings('a1', 'm')[0]!.accessCount).toBe(1)

    s.insert({
      agentId: 'a1',
      kind: 'fact',
      content: '丙',
      embedding: Float32Array.from([0, 0, 1]),
      embeddingModel: 'm',
    })
    expect(
      s
        .listActiveEmbeddings('a1', 'm')
        .map((row) => {
          return row.content
        })
        .sort(),
    ).toEqual(['丙', '乙', '甲'].sort())
    s.supersede(first.id, 'superseded')
    expect(
      s
        .listActiveEmbeddings('a1', 'm')
        .map((row) => {
          return row.content
        })
        .sort(),
    ).toEqual(['丙', '乙'].sort())

    // 跨连接写入（session 删 agent 走的就是这条路）同样让缓存失效
    const other = new DatabaseSync(path)
    other.prepare('DELETE FROM memories WHERE id = ?').run(second.id)
    other.close()
    expect(
      s.listActiveEmbeddings('a1', 'm').map((row) => {
        return row.content
      }),
    ).toEqual(['丙'])
    s.close()
  })

  it('listArchived / restore：归档记忆可列出、可拉回活跃面，FTS 索引同步恢复', () => {
    const s = store()
    const archived = s.insert({ agentId: 'a1', kind: 'fact', content: '住在北京' })
    const alive = s.insert({ agentId: 'a1', kind: 'preference', content: '偏好川菜' })
    s.backdate(archived.id, Date.now() - 200 * 86_400_000)
    expect(s.archiveDormant(90 * 86_400_000)).toBe(1)

    expect(s.listArchived().map((row) => row.id)).toEqual([archived.id])
    expect(s.listArchived().map((row) => row.content)).toEqual(['住在北京'])
    expect(s.restore(archived.id)).toBe(true)
    expect(s.get(archived.id)!.status).toBe('active')
    expect(s.listArchived()).toEqual([])
    expect(
      s
        .listActiveForAgent('a1')
        .map((row) => row.id)
        .sort(),
    ).toEqual([alive.id, archived.id].sort())
    // 恢复后重新进检索面（含 FTS 通道：索引行先删后插，不撞 rowid 唯一约束）。
    expect(s.searchFts('a1', '住在北京').map((row) => row.id)).toEqual([archived.id])
    s.close()
  })

  it('restore 只救归档：不存在或非 inactive 一律 false（软删不能被 id 复活）', () => {
    const s = store()
    const active = s.insert({ agentId: 'a1', kind: 'fact', content: '还在活跃' })
    const softDeleted = s.insert({ agentId: 'a1', kind: 'fact', content: '软删掉的' })
    s.supersede(softDeleted.id, 'deleted')
    expect(s.restore('no-such-id')).toBe(false)
    expect(s.restore(active.id)).toBe(false)
    expect(s.restore(softDeleted.id)).toBe(false)
    expect(s.get(softDeleted.id)!.status).toBe('deleted')
    s.close()
  })

  it('listMissingEmbeddings / setEmbedding：换模型后旧向量可被识别并回填', () => {
    const s = store()
    const legacy = s.insert({
      agentId: 'a1',
      kind: 'fact',
      content: '旧模型写的',
      embedding: Float32Array.from([0.5, 0.5]),
      embeddingModel: 'model-a',
    })
    const noVector = s.insert({ agentId: 'a1', kind: 'fact', content: '一直没有向量' })
    const current = s.insert({
      agentId: 'a1',
      kind: 'fact',
      content: '当前模型的',
      embedding: Float32Array.from([1, 0]),
      embeddingModel: 'model-b',
    })
    const archived = s.insert({ agentId: 'a1', kind: 'event', content: '归档的也该能恢复即用' })
    const softDeleted = s.insert({ agentId: 'a1', kind: 'fact', content: '软删的不用重建' })
    s.backdate(archived.id, Date.now() - 200 * 86_400_000)
    s.archiveDormant(90 * 86_400_000)
    s.supersede(softDeleted.id, 'deleted')

    expect(
      s
        .listMissingEmbeddings('model-b')
        .map((row) => row.id)
        .sort(),
    ).toEqual([legacy.id, noVector.id, archived.id].sort())
    s.setEmbedding(legacy.id, Float32Array.from([0, 1, 0]), 'model-b')
    const row = s.get(legacy.id)!
    expect(row.embeddingModel).toBe('model-b')
    expect(row.dim).toBe(3)
    expect(Array.from(row.embedding as Float32Array)).toEqual([0, 1, 0])
    expect(
      s.listMissingEmbeddings('model-b').map((entry) => {
        return entry.id
      }),
    ).not.toContain(current.id)
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

  it('记忆行与索引行同事务：索引写失败时主表一起回滚（不留有行无索引的半条记忆）', () => {
    const s = store()
    // 制造"第二条写会失败"的现场：索引表没了，插记忆行成功、插索引行失败。
    raw(s, 'DROP TABLE memories_fts')
    expect(() => {
      s.insert({ agentId: 'a1', kind: 'fact', content: '写了一半的记忆' })
    }).toThrow()
    // 有行无索引的记忆从此对 BM25 通道永久不可见，而仓库里没有任何"重建 FTS"
    // 的任务能救它——所以主表必须一起回滚。
    expect(s.stats().total).toBe(0)
    s.close()
  })

  it('NullEmbeddings 标记不可用（纯 FTS 降级路径）', () => {
    expect(new NullEmbeddings().available).toBe(false)
    expect(new NullEmbeddings().label).toContain('fts')
  })
})
