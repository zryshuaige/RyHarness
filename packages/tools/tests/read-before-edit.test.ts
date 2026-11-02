/**
 * 「改前必须先读过」这条策略。
 *
 * 模型最常见的错是按自己以为的内容去改——而它以为的那份可能已经是旧的。没读过就
 * 改，改坏了它自己都不知道坏在哪。所以 fs_edit 先问一句「读过没有」。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReadTracker, ToolContext } from '@ryharness/agent'
import { fsEdit, fsRead } from '@ryharness/tools'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

function workspace(): { root: string; ctx: ToolContext; tracker: ReadTracker } {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-read-before-edit-'))
  roots.push(root)
  const read = new Set<string>()
  const tracker: ReadTracker = {
    markRead: (path: string) => {
      read.add(path)
    },
    hasRead: (path: string) => {
      return read.has(path)
    },
  }
  return { root, ctx: { workspaceRoot: root, readTracker: tracker }, tracker }
}

afterEach(() => {
  while (roots.length > 0) {
    try {
      rmSync(roots.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

describe('改前必须先读过', () => {
  it('没读过就改：拒绝，并说清要先读哪个文件', async () => {
    const { root, ctx } = workspace()
    writeFileSync(join(root, 'a.txt'), 'old text', 'utf8')
    const result = await fsEdit.execute({ path: 'a.txt', oldText: 'old text', newText: 'new text' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('还没读过')
    expect(result.content).toContain('a.txt')
  })

  it('读过就能改：改完内容真的变了', async () => {
    const { root, ctx } = workspace()
    writeFileSync(join(root, 'b.txt'), 'old text', 'utf8')
    const read = await fsRead.execute({ path: 'b.txt' }, ctx)
    expect(read.isError).toBeUndefined()
    const result = await fsEdit.execute({ path: 'b.txt', oldText: 'old text', newText: 'new text' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('已改')
  })

  it('没有追踪器时不做这道闸：独立调用工具不该被拦', async () => {
    const { root } = workspace()
    const plain: ToolContext = { workspaceRoot: root }
    writeFileSync(join(root, 'c.txt'), 'old text', 'utf8')
    const result = await fsEdit.execute({ path: 'c.txt', oldText: 'old text', newText: 'new text' }, plain)
    expect(result.isError).toBeUndefined()
  })

  it('读的是另一个文件不算读过：闸按路径算', async () => {
    const { root, ctx } = workspace()
    writeFileSync(join(root, 'd.txt'), 'old text', 'utf8')
    writeFileSync(join(root, 'e.txt'), 'other', 'utf8')
    await fsRead.execute({ path: 'e.txt' }, ctx)
    const result = await fsEdit.execute({ path: 'd.txt', oldText: 'old text', newText: 'new text' }, ctx)
    expect(result.isError).toBe(true)
  })
})
