import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { collectFileReferences, isInsideWorkspace, parseFileMentions, resolveWorkspaceFile } from '@ryharness/context'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-ctx-file-'))
  roots.push(root)
  return root
}

/** Windows 上 junction 不需要管理员权限，普通 symlink 需要；目录逃逸用 junction 就够。 */
function linkDir(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

afterEach(() => {
  while (roots.length > 0) {
    try {
      rmSync(roots.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 残留目录落在系统临时区，不影响仓库。
    }
  }
})

describe('@引用的识别', () => {
  it('带扩展名或带分隔符的才算文件引用', () => {
    expect(parseFileMentions('看 @notes/todo.md 和 @README.md')).toEqual(['notes/todo.md', 'README.md'])
  })

  it('@人名不算文件引用（本仓的 @ 也是 @某个 agent）', () => {
    expect(parseFileMentions('@阿码 你去查一下')).toEqual([])
  })

  it('引号形式能带空格', () => {
    expect(parseFileMentions('@"带空格的 名字.md"')).toEqual(['带空格的 名字.md'])
  })

  it('句末的标点不算路径的一部分', () => {
    expect(parseFileMentions('看 @notes/todo.md。')).toEqual(['notes/todo.md'])
  })

  it('同一个路径只算一次', () => {
    expect(parseFileMentions('@a/b.md 和 @a/b.md')).toEqual(['a/b.md'])
  })
})

describe('@文件引用的装配', () => {
  it('工作区里的文件按内容装配', () => {
    const root = workspace()
    writeFileSync(join(root, 'todo.md'), '先做 A 再做 B。', 'utf8')
    const block = collectFileReferences({ workspaceRoot: root, text: '看下 @todo.md' })
    expect(block?.entries).toHaveLength(1)
    expect(block?.entries[0]?.status).toBe('included')
    expect(block?.entries[0]?.path).toBe('todo.md')
    expect(block?.text).toContain('先做 A 再做 B。')
    expect(block?.text).toContain('--- todo.md ---')
  })

  it('没找到的文件要说明没找到，而不是静默忽略', () => {
    const root = workspace()
    const block = collectFileReferences({ workspaceRoot: root, text: '看下 @missing.md' })
    expect(block?.entries[0]?.status).toBe('missing')
    expect(block?.text).toContain('没找到这个文件')
  })

  it('工作区外的引用不装配内容', () => {
    const root = workspace()
    const outside = workspace()
    writeFileSync(join(outside, 'secret.md'), '不该被读到的内容。', 'utf8')
    const escaping = relative(root, join(outside, 'secret.md'))
    const block = collectFileReferences({ workspaceRoot: root, text: `看下 @${escaping}` })
    expect(block?.entries[0]?.status).toBe('outside')
    expect(block?.text).toContain('不在工作区里')
    expect(block?.text).not.toContain('不该被读到的内容')
  })

  it('工作区里指向外部的链接同样不装配', () => {
    const root = workspace()
    const outside = workspace()
    writeFileSync(join(outside, 'secret.md'), '不该被读到的内容。', 'utf8')
    linkDir(outside, join(root, 'link'))
    const block = collectFileReferences({ workspaceRoot: root, text: '看下 @link/secret.md' })
    expect(block?.entries[0]?.status).toBe('outside')
    expect(block?.text).not.toContain('不该被读到的内容')
  })

  it('单个文件超长时截断并写明', () => {
    const root = workspace()
    writeFileSync(join(root, 'big.md'), 'y'.repeat(200), 'utf8')
    const block = collectFileReferences({ workspaceRoot: root, text: '@big.md', maxCharsPerFile: 20 })
    expect(block?.entries[0]?.truncated).toBe(true)
    expect(block?.text).toContain('已截断：全文 200 字符，这里只保留前 20 字符')
  })

  it('总量用完后其余文件只说明没装', () => {
    const root = workspace()
    writeFileSync(join(root, 'a.md'), 'a'.repeat(100), 'utf8')
    writeFileSync(join(root, 'b.md'), 'b'.repeat(100), 'utf8')
    const block = collectFileReferences({ workspaceRoot: root, text: '@a.md @b.md', maxTotalChars: 100 })
    expect(block?.entries[0]?.status).toBe('included')
    expect(block?.entries[1]?.status).toBe('skipped')
    expect(block?.text).toContain('超过本轮的装配上限')
  })

  it('总量还剩一点时下一个文件按剩下的量截断', () => {
    const root = workspace()
    writeFileSync(join(root, 'a.md'), 'a'.repeat(100), 'utf8')
    writeFileSync(join(root, 'b.md'), 'b'.repeat(100), 'utf8')
    const block = collectFileReferences({ workspaceRoot: root, text: '@a.md @b.md', maxTotalChars: 120 })
    expect(block?.entries[1]?.status).toBe('included')
    expect(block?.entries[1]?.truncated).toBe(true)
    expect(block?.text).toContain('已截断：全文 100 字符，这里只保留前 20 字符')
  })

  it('文件数超上限时其余的也要说一句', () => {
    const root = workspace()
    writeFileSync(join(root, 'a.md'), 'A', 'utf8')
    writeFileSync(join(root, 'b.md'), 'B', 'utf8')
    const block = collectFileReferences({ workspaceRoot: root, text: '@a.md @b.md', maxFiles: 1 })
    expect(block?.entries).toHaveLength(2)
    expect(block?.entries[1]?.status).toBe('skipped')
  })

  it('文本里没有文件引用时不产出块', () => {
    const root = workspace()
    expect(collectFileReferences({ workspaceRoot: root, text: '今天天气不错' })).toBeUndefined()
  })

  it('读不出来（同名的是个目录）时也当没找到', () => {
    const root = workspace()
    mkdirSync(join(root, 'x.md'))
    const block = collectFileReferences({ workspaceRoot: root, text: '@x.md' })
    expect(block?.entries[0]?.status).toBe('missing')
    expect(block?.text).toContain('没找到这个文件')
  })
})

describe('工作区边界', () => {
  it('根之内与根本身算在里面', () => {
    const root = workspace()
    expect(isInsideWorkspace(root, root)).toBe(true)
    expect(isInsideWorkspace(root, join(root, 'a', 'b.md'))).toBe(true)
  })

  it('越出根的路径在外面', () => {
    const root = workspace()
    expect(isInsideWorkspace(root, join(root, '..', 'x.md'))).toBe(false)
    expect(isInsideWorkspace(root, join(root, '..', '..', 'x.md'))).toBe(false)
  })

  it('不同盘符的绝对路径在外面', () => {
    const root = workspace()
    expect(isInsideWorkspace(root, process.platform === 'win32' ? 'D:\\elsewhere\\x.md' : '/elsewhere/x.md')).toBe(
      false,
    )
  })

  it('不存在的路径判成 missing，根外的判成 outside', () => {
    const root = workspace()
    expect(resolveWorkspaceFile(root, 'nope.md').kind).toBe('missing')
    expect(resolveWorkspaceFile(root, join(root, '..', 'x.md')).kind).toBe('outside')
  })
})
