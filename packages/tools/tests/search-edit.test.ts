/**
 * fs_glob / fs_grep / fs_edit：助理「找得到、改得动」的那条路。
 *
 * 每条用例都断言**边界**：工作区外的路径要被拒、找不到的文字要明确报错而不是
 * 静默改坏文件、写盘要是原子的。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@ryharness/agent'
import { fsEdit, fsGlob, fsGrep, replaceInFile } from '@ryharness/tools'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-search-'))
  tmpDirs.push(dir)
  return dir
}

function write(root: string, relativePath: string, content: string): void {
  const target = join(root, relativePath)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

function context(root: string): ToolContext {
  return { workspaceRoot: root, signal: undefined }
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

describe('fs_glob', () => {
  it('按模式找工作区里的文件，返回相对路径', async () => {
    const root = workspace()
    write(root, 'src/a.ts', 'export const a = 1')
    write(root, 'src/deep/b.ts', 'export const b = 2')
    write(root, 'src/c.md', '# 文档')
    const result = await fsGlob.execute({ pattern: 'src/**/*.ts' }, context(root))
    expect(result.isError).not.toBe(true)
    expect(result.content).toContain('src/a.ts')
    expect(result.content).toContain('src/deep/b.ts')
    expect(result.content).not.toContain('src/c.md')
  })

  it('工作区外的路径被拒', async () => {
    const root = workspace()
    const result = await fsGlob.execute({ pattern: '*', path: '..' }, context(root))
    expect(result.isError).toBe(true)
  })

  it('缺 pattern 时给出可读错误', async () => {
    const root = workspace()
    const result = await fsGlob.execute({}, context(root))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('pattern')
  })
})

describe('fs_grep', () => {
  it('搜到内容时报出文件、行号与那一行', async () => {
    const root = workspace()
    write(root, 'src/a.ts', 'const needle = 1\nconst other = 2\n')
    write(root, 'src/b.ts', 'nothing here\n')
    const result = await fsGrep.execute({ pattern: 'needle' }, context(root))
    expect(result.isError).not.toBe(true)
    expect(result.content).toContain('src/a.ts:1')
    expect(result.content).toContain('const needle = 1')
  })

  it('glob 可以限定范围', async () => {
    const root = workspace()
    write(root, 'src/a.ts', 'needle\n')
    write(root, 'docs/b.md', 'needle\n')
    const result = await fsGrep.execute({ pattern: 'needle', glob: 'src/**' }, context(root))
    expect(result.content).toContain('src/a.ts')
    expect(result.content).not.toContain('docs/b.md')
  })

  it('正则不合法时回中文错误，不抛英文异常', async () => {
    const root = workspace()
    const result = await fsGrep.execute({ pattern: '([' }, context(root))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('正则')
  })

  it('没有命中时如实说没有', async () => {
    const root = workspace()
    write(root, 'a.ts', 'hello\n')
    const result = await fsGrep.execute({ pattern: 'zzz-not-there' }, context(root))
    expect(result.isError).not.toBe(true)
    expect(result.content).toContain('没有匹配')
  })
})

describe('fs_edit', () => {
  it('按精确文字替换', async () => {
    const root = workspace()
    write(root, 'a.ts', 'const a = 1\nconst b = 2\n')
    const result = await fsEdit.execute({ path: 'a.ts', oldText: 'const b = 2', newText: 'const b = 3' }, context(root))
    expect(result.isError).not.toBe(true)
    expect(result.content).toContain('替换 1 处')
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('const a = 1\nconst b = 3\n')
  })

  it('文字对不上时明确报错，并把文件开头回给模型', async () => {
    const root = workspace()
    write(root, 'a.ts', '真实的文件内容\n')
    const result = await fsEdit.execute({ path: 'a.ts', oldText: '不存在的文字', newText: 'x' }, context(root))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('真实的文件内容')
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('真实的文件内容\n')
  })

  it('出现多次且没给 replaceAll 时拒绝改（避免改错地方）', async () => {
    const root = workspace()
    write(root, 'a.ts', 'x = 1\nx = 1\n')
    const result = await fsEdit.execute({ path: 'a.ts', oldText: 'x = 1', newText: 'x = 2' }, context(root))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('出现了 2 次')
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('x = 1\nx = 1\n')
  })

  it('replaceAll 会全部替换', async () => {
    const root = workspace()
    write(root, 'a.ts', 'x = 1\nx = 1\n')
    const result = await fsEdit.execute(
      { path: 'a.ts', oldText: 'x = 1', newText: 'x = 2', replaceAll: true },
      context(root),
    )
    expect(result.isError).not.toBe(true)
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('x = 2\nx = 2\n')
  })

  it('工作区外的路径被拒', async () => {
    const root = workspace()
    const result = await fsEdit.execute({ path: '../x.txt', oldText: 'a', newText: 'b' }, context(root))
    expect(result.isError).toBe(true)
  })

  it('oldText 为空时拒绝（空串会匹配每个位置）', async () => {
    const root = workspace()
    write(root, 'a.ts', 'abc')
    const result = await fsEdit.execute({ path: 'a.ts', oldText: '', newText: 'x' }, context(root))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('oldText')
  })

  it('写盘是原子的：临时文件不留残留', async () => {
    const root = workspace()
    write(root, 'a.ts', 'hello')
    const result = replaceInFile({ absolutePath: join(root, 'a.ts'), oldText: 'hello', newText: 'world' })
    expect(result.ok).toBe(true)
    expect(readdirSync(root)).toEqual(['a.ts'])
  })
})
