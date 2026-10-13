import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@ryagent/agent'
import { fileProduce, fsRead, fsWrite, PathEscapeError, resolveInWorkspace, shellExec } from '@ryagent/tools'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
function workspace(): { root: string; ctx: ToolContext } {
  const root = mkdtempSync(join(tmpdir(), 'ryagent-tools-'))
  roots.push(root)
  return { root, ctx: { workspaceRoot: root } }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('resolveInWorkspace', () => {
  it('resolves relative paths inside the root and rejects escapes', () => {
    const { root } = workspace()
    expect(resolveInWorkspace(root, 'a/b.txt')).toBe(join(root, 'a', 'b.txt'))
    expect(() => {
      resolveInWorkspace(root, '../evil.txt')
    }).toThrow(PathEscapeError)
    expect(() => {
      resolveInWorkspace(root, 'a/../../evil.txt')
    }).toThrow(/escapes/)
    expect(resolveInWorkspace(root, root)).toBe(root)
  })
})

describe('fs_read / fs_write', () => {
  it('writes and reads back a file, creating parent directories', async () => {
    const { root, ctx } = workspace()
    const wrote = await fsWrite.execute({ path: 'notes/daily.md', content: '# hello' }, ctx)
    expect(wrote.isError).toBeUndefined()
    expect(readFileSync(join(root, 'notes', 'daily.md'), 'utf8')).toBe('# hello')
    const read = await fsRead.execute({ path: 'notes/daily.md' }, ctx)
    expect(read.content).toBe('# hello')
  })

  it('rejects paths that escape the workspace', async () => {
    const { ctx } = workspace()
    const wrote = await fsWrite.execute({ path: '../outside.txt', content: 'x' }, ctx)
    expect(wrote.isError).toBe(true)
    const read = await fsRead.execute({ path: '../../etc/passwd' }, ctx)
    expect(read.isError).toBe(true)
  })

  it('reports missing files as errors', async () => {
    const { ctx } = workspace()
    const result = await fsRead.execute({ path: 'nope.txt' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not found')
  })

  it('truncates very long files', async () => {
    const { ctx } = workspace()
    await fsWrite.execute({ path: 'big.txt', content: 'x'.repeat(100_000) }, ctx)
    const read = await fsRead.execute({ path: 'big.txt' }, ctx)
    expect(read.content).toContain('[truncated:')
  })

  it('超大文件只读开头窗口（不整文件入内存），截断标注真实文件大小', async () => {
    const { root, ctx } = workspace()
    // 100k 个 CJK 字符 ≈ 300KB，超过 256KB 读窗口。
    writeFileSync(join(root, 'huge.txt'), '汉'.repeat(100_000))
    const read = await fsRead.execute({ path: 'huge.txt' }, ctx)
    expect(read.content).toContain('[truncated: file is 300000 bytes')
    expect(read.content.length).toBeLessThan(70_000)
  })
})

describe('shell_exec', () => {
  it('runs a simple command in the workspace', async () => {
    const { root, ctx } = workspace()
    writeFileSync(join(root, 'marker.txt'), 'hi')
    const result = await shellExec.execute({ command: 'ls' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('marker.txt')
  })

  it('captures stdout of echo-level commands', async () => {
    const { ctx } = workspace()
    const result = await shellExec.execute({ command: 'echo hello-ryagent' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('hello-ryagent')
  })

  it('reports failures without throwing', async () => {
    const { ctx } = workspace()
    const result = await shellExec.execute({ command: 'exit 3' }, ctx)
    expect(result.isError).toBe(true)
  })

  it('times out long-running commands', async () => {
    const { ctx } = workspace()
    const result = await shellExec.execute({ command: 'sleep 5', timeoutMs: 300 }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('timed out')
  }, 10_000)
})

describe('file_produce', () => {
  it('writes into the artifacts dir and returns a produce card', async () => {
    const { root, ctx } = workspace()
    const result = await fileProduce.execute({ name: 'report.md', content: '# 周报' }, ctx)
    expect(result.isError).toBeUndefined()
    const card = result.produce
    expect(card).toBeDefined()
    expect(card!.name).toBe('report.md')
    expect(card!.mime).toBe('text/markdown')
    expect(card!.size).toBe(Buffer.byteLength('# 周报', 'utf8'))
    expect(card!.path.startsWith(root)).toBe(true)
    expect(readFileSync(card!.path, 'utf8')).toBe('# 周报')
  })

  it('rejects path components in the file name', async () => {
    const { ctx } = workspace()
    await expect(fileProduce.execute({ name: 'a/../../evil.txt', content: 'x' }, ctx)).rejects.toThrow(/leaf|invalid/)
  })

  it('falls back to octet-stream for unknown extensions', async () => {
    const { ctx } = workspace()
    const result = await fileProduce.execute({ name: 'data.unknownext', content: 'x' }, ctx)
    expect(result.produce!.mime).toBe('application/octet-stream')
  })
})
