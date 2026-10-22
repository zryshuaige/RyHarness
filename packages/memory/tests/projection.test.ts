/**
 * 对外投影：接口回包不许把向量序列化出去。
 *
 * 这组用例盯的是 P0「记忆列表接口单请求 5.26MB」：MemoryRow 上的 embedding 是
 * Float32Array，JSON.stringify 出来是 `{"0":…,"1":…}` 的下标→数值对象，一条
 * 1024 维记忆就是几千个字段，而渲染层一个都用不上。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryRow } from '@ryharness/memory'
import { MemoryStore, toPublicMemories, toPublicMemory } from '@ryharness/memory'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
function store(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-memory-proj-'))
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

/** 1024 维，贴近真实 embedding 模型的量级。 */
const VECTOR = Float32Array.from({ length: 1024 }, (_unused, i) => {
  return i / 1024
})

function insertWithVector(s: MemoryStore, content: string): MemoryRow {
  return s.insert({
    agentId: 'a1',
    kind: 'fact',
    content,
    embedding: VECTOR,
    embeddingModel: 'model-a',
    sourceConversationId: 'c1',
  })
}

describe('记忆的对外投影', () => {
  it('响应体不含 embedding：序列化后既没有向量字段也没有下标→数值对象', () => {
    const s = store()
    const row = insertWithVector(s, '用户偏好简洁的周报')
    const body = JSON.stringify(toPublicMemories([row]))

    expect(body).not.toContain('embedding')
    expect(body).not.toContain('embeddingModel')
    expect(body).not.toContain('"0":')
    // 业务字段一个不少：UI 的记忆面板全靠这几个。
    expect(JSON.parse(body)).toEqual([
      {
        id: row.id,
        agentId: 'a1',
        kind: 'fact',
        content: '用户偏好简洁的周报',
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        accessCount: 0,
        sourceConversationId: 'c1',
      },
    ])
    s.close()
  })

  it('投影真的挡住了大头：同一行直接序列化会膨胀成下标→数值的一坨', () => {
    const s = store()
    const row = insertWithVector(s, '用户偏好简洁的周报')

    // 前提（这条断言自己也在盯回归）：不做投影就是几 KB～几 MB 的回包，
    // 1024 维记忆一列表就是 5.26MB 量级。
    const raw = JSON.stringify([row])
    const projected = JSON.stringify(toPublicMemories([row]))
    expect(raw).toContain('"embedding":{"0":')
    expect(raw.length).toBeGreaterThan(10_000)
    expect(projected.length).toBeLessThan(500)

    // 单条投影与列表投影同源，不会出现"列表挡了单条没挡"。
    expect(toPublicMemory(row)).toEqual(toPublicMemories([row])[0])
    s.close()
  })

  it('无向量记忆与缺省可选字段照常投影（不会多出 embedding: null）', () => {
    const s = store()
    const plain = s.insert({ agentId: '*shared*', kind: 'profile', content: '用户是产品经理' })
    const publicRow = toPublicMemory(plain)

    expect(JSON.stringify(publicRow)).not.toContain('embedding')
    expect(publicRow.sourceConversationId).toBeUndefined()
    expect(Object.keys(publicRow)).toEqual([
      'id',
      'agentId',
      'kind',
      'content',
      'createdAt',
      'updatedAt',
      'accessCount',
    ])
    s.close()
  })
})
