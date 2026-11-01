import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKSPACE_FILE_VERSION, WorkspaceStore } from '@ryharness/workspace'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

/** 一个干净的临时目录。 */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-ws-store-'))
  roots.push(root)
  return root
}

/** 写一份工作区记录文件。 */
function writeFile(dir: string, payload: unknown): string {
  const path = join(dir, 'workspaces.json')
  writeFileSync(path, JSON.stringify(payload), 'utf8')
  return path
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root === undefined) continue
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

describe('工作区存储', () => {
  it('没给路径时是内存存储：读写都不落盘', () => {
    const store = new WorkspaceStore()
    expect(store.path).toBeUndefined()
    expect(store.load()).toEqual({ version: WORKSPACE_FILE_VERSION, workspaces: [], sessions: {} })
    expect(() => store.save({ version: 1, workspaces: [], sessions: {} })).not.toThrow()
  })

  it('给了路径时读回来的是刚写进去的', () => {
    const dir = scratch()
    const path = join(dir, 'workspaces.json')
    const store = new WorkspaceStore({ filePath: path })
    store.save({
      version: WORKSPACE_FILE_VERSION,
      workspaces: [{ id: 'w1', name: '项目', rootPath: dir, createdAt: 5 }],
      sessions: { s1: { workspaceId: 'w1', hidden: false } },
    })
    const loaded = store.load()
    expect(loaded.workspaces).toEqual([{ id: 'w1', name: '项目', rootPath: dir, createdAt: 5 }])
    expect(loaded.sessions['s1']).toEqual({ workspaceId: 'w1', hidden: false })
  })

  it('文件不存在时给空记录', () => {
    const dir = scratch()
    const store = new WorkspaceStore({ filePath: join(dir, '还没有这个文件.json') })
    expect(store.load()).toEqual({ version: WORKSPACE_FILE_VERSION, workspaces: [], sessions: {} })
  })

  it('坏掉的工作区逐条丢掉，好的那些还在', () => {
    const dir = scratch()
    writeFile(dir, {
      version: 1,
      workspaces: [
        { id: 'w1', name: '好的', rootPath: dir, createdAt: 5 },
        '根本不是对象',
        { id: '', name: '没 id', rootPath: dir, createdAt: 5 },
        { id: 'w3', name: '没根目录', createdAt: 5 },
        { id: 'w4', name: '时间不对', rootPath: dir, createdAt: '昨天' },
      ],
      sessions: {},
    })
    const loaded = new WorkspaceStore({ filePath: join(dir, 'workspaces.json') }).load()
    expect(loaded.workspaces.map((w) => w.id)).toEqual(['w1'])
  })

  it('坏掉的会话归属逐条丢掉，好的那些还在', () => {
    const dir = scratch()
    writeFile(dir, {
      version: 1,
      workspaces: [],
      sessions: {
        good: { workspaceId: 'w1', hidden: false },
        ungrouped: { workspaceId: null, hidden: false },
        notObject: '字符串',
        noWorkspace: { hidden: false },
        emptyWorkspace: { workspaceId: '', hidden: false },
      },
    })
    const loaded = new WorkspaceStore({ filePath: join(dir, 'workspaces.json') }).load()
    expect(Object.keys(loaded.sessions).sort()).toEqual(['good', 'ungrouped'])
    expect(loaded.sessions['ungrouped']?.workspaceId).toBeNull()
  })

  it('写坏了时临时文件被清掉，不留半份记录', () => {
    const dir = scratch()
    const path = join(dir, 'workspaces.json')
    // 先把目标位置占成一个目录：rename 覆盖到已存在的目录会失败。
    mkdirSync(path)
    const store = new WorkspaceStore({ filePath: path })
    expect(() =>
      store.save({ version: 1, workspaces: [{ id: 'w1', name: 'x', rootPath: dir, createdAt: 1 }], sessions: {} }),
    ).toThrow()
    expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([])
    expect(existsSync(path)).toBe(true)
  })
})
