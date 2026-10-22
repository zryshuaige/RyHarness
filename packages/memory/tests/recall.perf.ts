/**
 * recall 的性能不变量（不进默认 CI 通道，见 vitest.perf.config.ts）。
 *
 * 断言全部写成**比值 / 上界**，不写绝对墙钟值：性能用例对机器负载敏感，写死
 * 毫秒数只会把它变成 flake 源，最后没人敢信它的红灯。这里钉的是结构——
 * 每轮召回发多少条 SQL、SQL 条数是否随 FTS 窗口变化、以及网络往返是否落在
 * 首 token 之后；时间类断言一律写成「同步路径比异步路径快 N 倍」，而异步
 * 路径里有一个已知的人工延迟做标尺。
 *
 * @module
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { EmbeddingProvider } from '@ryharness/memory'
import { HashEmbeddings, MemoryService, MemoryStore, SHARED_SPACE } from '@ryharness/memory'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-memory-perf-'))
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

/** 恒定人工延迟的 embedding：作为"网络往返"的标尺。 */
function slowEmbeddings(base: HashEmbeddings, delayMs: number): EmbeddingProvider {
  return {
    label: 'slow',
    available: true,
    async embed(texts) {
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs)
      })
      return texts.map((text) => {
        return base.vectorOf(text)
      })
    },
  }
}

/** 统计底层连接 prepare 的次数（= 发出的 SQL 条数）；每次读取后清零。 */
function statementCounter(store: MemoryStore): () => number {
  const db: DatabaseSync = Reflect.get(store, 'db')
  const original = db.prepare.bind(db)
  let count = 0
  db.prepare = (sql: string) => {
    count++
    return original(sql)
  }
  return () => {
    const seen = count
    count = 0
    return seen
  }
}

/** 装一个规模接近真实使用的库：画像 + 400 条私有记忆。 */
function loadedService(embeddings?: EmbeddingProvider): MemoryService {
  const svc = new MemoryService({ dbPath: dbPath(), ...(embeddings === undefined ? {} : { embeddings }) })
  for (let index = 0; index < 5; index++) {
    svc.store.insert({ agentId: SHARED_SPACE, kind: 'profile', content: `用户画像条目 ${index}：偏好条目式的沟通` })
  }
  for (let index = 0; index < 400; index++) {
    svc.store.insert({
      agentId: 'a1',
      kind: 'fact',
      content: `记忆 ${index}：用户提到过周报与条目式写法的关系`,
      embedding: new HashEmbeddings().vectorOf(`记忆 ${index}`),
    })
  }
  return svc
}

describe('recall 的 SQL 次数不随数据规模增长', () => {
  it('FTS 命中窗口：取回行数与窗口大小无关（消掉 N+1）', () => {
    const store = new MemoryStore(dbPath())
    for (let index = 0; index < 200; index++) {
      store.insert({ agentId: 'a1', kind: 'fact', content: `条目式周报记忆 ${index}` })
    }
    const read = statementCounter(store)
    read()
    const small = store.searchFtsHits('条目式周报', 10)
    const smallCount = read()
    read()
    store.searchFtsHits('条目式周报', 150)
    const largeCount = read()
    store.close()
    expect(small.length).toBeGreaterThan(0)
    // 15 倍的窗口，一次 SQL——旧写法是 11 次与 151 次。
    expect(smallCount).toBe(1)
    expect(largeCount).toBe(smallCount)
  })

  it('touchAccess：批量与单条发同样多的 SQL（消掉逐 id 事务）', () => {
    const store = new MemoryStore(dbPath())
    const rows = Array.from({ length: 200 }, (_unused, index) => {
      return store.insert({ agentId: 'a1', kind: 'fact', content: `记忆 ${index}` })
    })
    const read = statementCounter(store)
    read()
    store.touchAccess([rows[0]?.id as string])
    const one = read()
    store.touchAccess(
      rows.map((row) => {
        return row.id
      }),
    )
    const many = read()
    store.close()
    expect(one).toBe(1)
    // 200 个 id 一条 UPDATE；旧写法是 200 次（各带一次隐式事务）。
    expect(many).toBe(1)
  })

  it('常驻向量缓存的访问修补按索引命中，不随库规模线性增长', () => {
    const store = new MemoryStore(dbPath())
    const vectors = new HashEmbeddings()
    const rows = Array.from({ length: 300 }, (_unused, index) => {
      return store.insert({
        agentId: 'a1',
        kind: 'fact',
        content: `记忆 ${index}`,
        embedding: vectors.vectorOf(String(index)),
      })
    })
    // 先让常驻缓存建起来。
    store.listSpaceEmbeddings('a1')
    store.touchAccess([rows[0]?.id as string])
    const cached = store.listSpaceEmbeddings('a1')
    expect(cached[0]?.accessCount).toBe(1)
    expect(cached[299]?.accessCount).toBe(0)
    store.close()
  })

  it('一轮同步召回的 SQL 条数有固定上界', async () => {
    const svc = loadedService(new HashEmbeddings())
    const query = '周报 条目式'
    // 预热：补正把查询向量写进缓存，向量通道与常驻缓存都进入热态。
    await svc.recallRefine('a1', query)
    svc.recallSync('a1', query)
    const read = statementCounter(svc.store)
    read()
    svc.recallSync('a1', query)
    const warm = read()
    read()
    svc.recallSync('a1', `${query} 冷启动`)
    const cold = read()
    svc.close()
    // 上界是结构性的：画像 1 + 查询向量缓存 1 + 两个空间的 PRAGMA 2 + FTS 1
    // + 记账 1 = 6；再往上就说明又出现了与数据规模成正比的查询。
    expect(warm).toBeLessThanOrEqual(6)
    expect(cold).toBeLessThanOrEqual(6)
  })
})

describe('recall 不在首 token 上等网络', () => {
  it('同步召回比异步召回快一个量级以上（异步路径里有 120ms 人工网络往返）', async () => {
    const embeddings = slowEmbeddings(new HashEmbeddings(), 120)
    const svc = loadedService(embeddings)
    const query = '周报 条目式'

    const syncStart = Date.now()
    const syncBlock = svc.recallSync('a1', query)
    const syncElapsed = Date.now() - syncStart

    const asyncStart = Date.now()
    const asyncBlock = await svc.recall('a1', `${query} 另一段`)
    const asyncElapsed = Date.now() - asyncStart
    svc.close()

    // 两者内容口径一致（都拿得到画像），差别只有那一次网络往返。
    expect(syncBlock).toContain('用户画像')
    expect(asyncBlock).toContain('用户画像')
    expect(syncElapsed).toBeLessThan(asyncElapsed / 2)
  })

  it('补正的 deadline 是硬上界：超过就返回 false，不把等待透传给首 token', async () => {
    const embeddings = slowEmbeddings(new HashEmbeddings(), 300)
    const svc = loadedService(embeddings)
    const start = Date.now()
    expect(await svc.recallRefine('a1', '一段全新的输入', 20)).toBe(false)
    const elapsed = Date.now() - start
    svc.close()
    expect(elapsed).toBeLessThan(300 / 2)
  })

  it('in-flight embedding 不被重复发起：同段输入的并发补正共享一次请求', async () => {
    let calls = 0
    const base = new HashEmbeddings()
    const svc = loadedService({
      label: 'counting',
      available: true,
      async embed(texts) {
        calls++
        await new Promise((resolve) => {
          setTimeout(resolve, 30)
        })
        return texts.map((text) => {
          return base.vectorOf(text)
        })
      },
    })
    const query = '并发补正专用输入'
    await Promise.all([svc.recallRefine('a1', query), svc.recallRefine('a1', query), svc.recallRefine('a1', query)])
    svc.close()
    expect(calls).toBe(1)
  })
})
