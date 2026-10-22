/**
 * 原子写的行为证据：每次落盘都必须先写同目录临时文件，再 rename 到目标。
 *
 * 只断言「并发结束后文件里有 N 条」的话，把 writeFileAtomic 换成直接覆盖目标
 * 文件也照样绿——串行队列掩盖了写入过程本身的非原子性。这里对 node:fs 的两个
 * 关键调用计数，删除「临时文件 + rename」这一步会立刻变红。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TodoStore } from '../src/plugins/todo-store.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  }
})

const { renameSync, writeFileSync } = await import('node:fs')

const tmpDirs: string[] = []

afterEach(() => {
  vi.clearAllMocks()
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

describe('TodoStore 原子写', () => {
  it('写临时文件再 rename；目标文件从不被直接截断写', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ryharness-todo-atomic-'))
    tmpDirs.push(dir)
    const target = join(dir, 'todos.json')
    const store = new TodoStore(target)
    await store.add('c1', '买牛奶')

    const writes = vi.mocked(writeFileSync).mock.calls
    expect(writes).toHaveLength(1)
    const [tempPath, payload, encoding] = writes[0] as [string, string, string]
    expect(tempPath).not.toBe(target)
    expect(tempPath).toMatch(/todos\.json\.\d+\.\d+\.tmp$/)
    expect(encoding).toBe('utf8')
    // 真正落盘给读端看的是 rename 之后的那一份。
    expect(JSON.parse(payload)).toMatchObject({ conversations: [{ conversationId: 'c1' }] })
    expect(vi.mocked(renameSync).mock.calls).toContainEqual([tempPath, target])
    expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({
      conversations: [{ conversationId: 'c1', items: [{ text: '买牛奶' }] }],
    })
  })
})
