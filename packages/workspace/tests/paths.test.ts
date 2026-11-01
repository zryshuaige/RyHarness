import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import {
  isFilesystemRoot,
  isInsideRoot,
  resolveInWorkspace,
  type Workspace,
  WorkspacePathError,
} from '@ryharness/workspace'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

/** 一个干净的临时目录。 */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-ws-paths-'))
  roots.push(root)
  return root
}

/** 造一个工作区对象（只测路径那一层时用不着真的注册）。 */
function workspaceOf(rootPath: string): Workspace {
  return { id: 'w1', name: '项目', rootPath, createdAt: 1 }
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root === undefined) continue
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

describe('文件系统根的判定', () => {
  it('盘符根与 / 都是文件系统根', () => {
    const systemRoot = parse(resolve(tmpdir())).root
    expect(isFilesystemRoot(systemRoot)).toBe(true)
  })

  it('普通目录不是文件系统根', () => {
    const root = scratch()
    expect(isFilesystemRoot(root)).toBe(false)
    expect(isFilesystemRoot(join(root, 'a', 'b'))).toBe(false)
  })
})

describe('根目录的包含关系', () => {
  it('根之内与根本身算在里面', () => {
    const root = scratch()
    expect(isInsideRoot(root, root)).toBe(true)
    expect(isInsideRoot(root, join(root, 'a', 'b.md'))).toBe(true)
  })

  it('越出根的路径在外面', () => {
    const root = scratch()
    expect(isInsideRoot(root, join(root, '..', 'x.md'))).toBe(false)
    expect(isInsideRoot(root, join(root, '..', '..', 'x.md'))).toBe(false)
  })

  it('不同盘符的绝对路径在外面', () => {
    const root = scratch()
    const elsewhere = process.platform === 'win32' ? 'D:\\elsewhere\\x.md' : '/elsewhere/x.md'
    expect(isInsideRoot(root, elsewhere)).toBe(false)
  })
})

describe('工作区内的路径解析', () => {
  it('相对路径按工作区根解', () => {
    const root = scratch()
    const target = resolveInWorkspace(workspaceOf(root), join('src', 'a.md'))
    expect(target).toBe(join(root, 'src', 'a.md'))
  })

  it('根内的绝对路径原样保留', () => {
    const root = scratch()
    const target = resolveInWorkspace(workspaceOf(root), join(root, 'src', 'a.md'))
    expect(target).toBe(join(root, 'src', 'a.md'))
  })

  it('路径逃出根目录时报错', () => {
    const root = scratch()
    expect(() => resolveInWorkspace(workspaceOf(root), join('..', 'outside.md'))).toThrow(WorkspacePathError)
  })

  it('错误信息里说得清是哪个工作区', () => {
    const root = scratch()
    let caught: unknown
    try {
      resolveInWorkspace(workspaceOf(root), join('..', 'outside.md'))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(WorkspacePathError)
    expect((caught as WorkspacePathError).message).toContain('项目')
    expect((caught as WorkspacePathError).path).toContain('outside.md')
  })

  it('根目录本身是合法目标', () => {
    const root = scratch()
    expect(resolveInWorkspace(workspaceOf(root), '.')).toBe(resolve(root))
  })

  it('跨盘符的绝对路径也算逃逸', () => {
    const root = scratch()
    const elsewhere = process.platform === 'win32' ? 'D:\\elsewhere\\x.md' : '/elsewhere/x.md'
    expect(() => resolveInWorkspace(workspaceOf(root), elsewhere)).toThrow(WorkspacePathError)
  })
})
