import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import {
  WorkspaceNotFoundError,
  WorkspacePathError,
  WorkspaceRegistry,
  type WorkspaceRegistryOptions,
  WorkspaceStoreError,
} from '@ryharness/workspace'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

/** 一个干净的临时目录。 */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-ws-reg-'))
  roots.push(root)
  return root
}

/** 在临时目录里造一个项目目录，返回它的绝对路径。 */
function projectDir(name: string): string {
  const dir = join(scratch(), name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 一个固定 id 的注册表：id 随机的话没法断言。 */
function registryWith(options: Partial<WorkspaceRegistryOptions> = {}): WorkspaceRegistry {
  let seq = 0
  return new WorkspaceRegistry({
    newId: () => {
      seq += 1
      return `w${seq}`
    },
    now: () => 1000 + seq * 10,
    ...options,
  })
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root === undefined) continue
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

describe('建立与列举工作区', () => {
  it('建出来的工作区带 id、名字、根目录与建立时间', () => {
    const registry = registryWith()
    const dir = projectDir('proj')
    const workspace = registry.create('我的项目', dir)
    expect(workspace.id).toBe('w1')
    expect(workspace.name).toBe('我的项目')
    expect(workspace.rootPath).toBe(resolve(dir))
    expect(workspace.createdAt).toBe(1010)
  })

  it('根目录存的是绝对路径', () => {
    const registry = registryWith()
    const dir = projectDir('proj')
    const workspace = registry.create('项目', dir)
    expect(workspace.rootPath).toBe(resolve(dir))
  })

  it('列表按建立时间排', () => {
    const registry = registryWith()
    registry.create('先', projectDir('a'))
    registry.create('后', projectDir('b'))
    expect(registry.list().map((w) => w.name)).toEqual(['先', '后'])
  })

  it('按 id 取得到同一个工作区', () => {
    const registry = registryWith()
    const created = registry.create('项目', projectDir('proj'))
    expect(registry.get(created.id)?.name).toBe('项目')
    expect(registry.get('根本没有这个 id')).toBeUndefined()
  })

  it('名字留白会被去掉，全空名字要报错', () => {
    const registry = registryWith()
    expect(registry.create('  项目  ', projectDir('proj')).name).toBe('项目')
    expect(() => registry.create('   ', projectDir('proj2'))).toThrow(/名字不能是空串/u)
  })

  it('改成空名字要报错', () => {
    const registry = registryWith()
    const created = registry.create('项目', projectDir('proj'))
    expect(() => registry.rename(created.id, '   ')).toThrow(/名字不能是空串/u)
    expect(registry.get(created.id)?.name).toBe('项目')
  })

  it('空根目录要报错', () => {
    const registry = registryWith()
    expect(() => registry.create('项目', '   ')).toThrow(/根目录不能是空串/u)
  })
})

describe('改名与移除', () => {
  it('改名只动名字，根目录与建立时间不变', () => {
    const registry = registryWith()
    const created = registry.create('旧名字', projectDir('proj'))
    const renamed = registry.rename(created.id, '新名字')
    expect(renamed.name).toBe('新名字')
    expect(renamed.rootPath).toBe(created.rootPath)
    expect(renamed.createdAt).toBe(created.createdAt)
    expect(registry.get(created.id)?.name).toBe('新名字')
  })

  it('改一个不存在的工作区要报错', () => {
    const registry = registryWith()
    expect(() => registry.rename('没有这个 id', '新名字')).toThrow(WorkspaceNotFoundError)
  })

  it('移除只删记录，文件夹还在', () => {
    const registry = registryWith()
    const dir = projectDir('proj')
    const created = registry.create('项目', dir)
    expect(registry.remove(created.id)).toBe(true)
    expect(registry.get(created.id)).toBeUndefined()
    expect(existsSync(dir)).toBe(true)
  })

  it('移除不存在的 id 返回 false', () => {
    const registry = registryWith()
    expect(registry.remove('没有这个 id')).toBe(false)
  })

  it('移除工作区后，原来的会话变成未分组（历史没丢）', () => {
    const registry = registryWith()
    const created = registry.create('项目', projectDir('proj'))
    registry.assignSession('s1', created.id)
    registry.remove(created.id)
    expect(registry.sessionsOf(created.id)).toEqual([])
    expect(registry.ungroupedSessions()).toEqual(['s1'])
  })
})

describe('会话归属', () => {
  it('归到工作区后能按工作区列出', () => {
    const registry = registryWith()
    const created = registry.create('项目', projectDir('proj'))
    registry.assignSession('s1', created.id)
    registry.assignSession('s2', created.id)
    expect(registry.sessionsOf(created.id)).toEqual(['s1', 's2'])
    expect(registry.workspaceOf('s1')).toBe(created.id)
  })

  it('一个会话只能属于一个工作区：重新归就是搬过去', () => {
    const registry = registryWith()
    const first = registry.create('甲', projectDir('a'))
    const second = registry.create('乙', projectDir('b'))
    registry.assignSession('s1', first.id)
    registry.assignSession('s1', second.id)
    expect(registry.sessionsOf(first.id)).toEqual([])
    expect(registry.sessionsOf(second.id)).toEqual(['s1'])
  })

  it('归到不存在的工作区要报错', () => {
    const registry = registryWith()
    expect(() => registry.assignSession('s1', '没有这个 id')).toThrow(WorkspaceNotFoundError)
  })

  it('空会话 id 要报错', () => {
    const registry = registryWith()
    const created = registry.create('项目', projectDir('proj'))
    expect(() => registry.assignSession('   ', created.id)).toThrow(/会话 id 不能是空串/u)
  })

  it('摘出来之后就没有归属了', () => {
    const registry = registryWith()
    const created = registry.create('项目', projectDir('proj'))
    registry.assignSession('s1', created.id)
    expect(registry.unassignSession('s1')).toBe(true)
    expect(registry.unassignSession('s1')).toBe(false)
    expect(registry.workspaceOf('s1')).toBeUndefined()
    expect(registry.ungroupedSessions()).toEqual(['s1'])
  })

  it('藏起来的会话不在分组里，但还找得到', () => {
    const registry = registryWith()
    const created = registry.create('项目', projectDir('proj'))
    registry.assignSession('s1', created.id)
    expect(registry.hideSession('s1')).toBe(true)
    expect(registry.sessionsOf(created.id)).toEqual([])
    expect(registry.ungroupedSessions()).toEqual(['s1'])
    expect(registry.workspaceOf('s1')).toBe(created.id)
  })

  it('放回来之后又出现在分组里', () => {
    const registry = registryWith()
    const created = registry.create('项目', projectDir('proj'))
    registry.assignSession('s1', created.id)
    registry.hideSession('s1')
    expect(registry.showSession('s1')).toBe(true)
    expect(registry.sessionsOf(created.id)).toEqual(['s1'])
  })

  it('没归属的会话藏不了也放不回', () => {
    const registry = registryWith()
    expect(registry.hideSession('s1')).toBe(false)
    expect(registry.showSession('s1')).toBe(false)
  })
})

describe('根目录的边界', () => {
  it('文件系统根不能当工作区根', () => {
    const registry = registryWith()
    const systemRoot = parse(resolve(tmpdir())).root
    expect(() => registry.create('危险', systemRoot)).toThrow(WorkspacePathError)
    expect(() => registry.create('危险', systemRoot)).toThrow(/不能把文件系统根当工作区根/u)
  })

  it('相对路径不能当工作区根', () => {
    const registry = registryWith()
    expect(() => registry.create('相对', 'relative/path')).toThrow(/必须是绝对路径/u)
  })

  it('不存在的目录不能当工作区根', () => {
    const registry = registryWith()
    const missing = join(scratch(), '根本没有这个目录')
    expect(() => registry.create('不存在', missing)).toThrow(/目录不存在/u)
  })

  it('文件不能当工作区根', () => {
    const registry = registryWith()
    const file = join(scratch(), 'a.txt')
    writeFileSync(file, 'x', 'utf8')
    expect(() => registry.create('是文件', file)).toThrow(/不是一个目录/u)
  })

  it('不在允许范围内的根目录要报错', () => {
    const allowed = scratch()
    const elsewhere = projectDir('outside')
    const registry = registryWith({ allowedRoots: [allowed] })
    expect(() => registry.create('越界', elsewhere)).toThrow(/不在允许的范围内/u)
    expect(() => registry.create('合法', join(allowed, 'inside'))).toThrow(/目录不存在/u)
  })

  it('落在允许范围之内就放行', () => {
    const allowed = scratch()
    const inside = join(allowed, 'inside')
    mkdirSync(inside, { recursive: true })
    const registry = registryWith({ allowedRoots: [allowed] })
    expect(registry.create('合法', inside).rootPath).toBe(resolve(inside))
  })
})

describe('按会话解析路径', () => {
  it('落在会话所属工作区的根之内', () => {
    const registry = registryWith()
    const dir = projectDir('proj')
    const created = registry.create('项目', dir)
    registry.assignSession('s1', created.id)
    expect(registry.resolveSessionPath('s1', 'src/a.md')).toBe(join(resolve(dir), 'src', 'a.md'))
  })

  it('路径逃出工作区根时报错', () => {
    const registry = registryWith()
    const created = registry.create('项目', projectDir('proj'))
    registry.assignSession('s1', created.id)
    expect(() => registry.resolveSessionPath('s1', join('..', 'outside.md'))).toThrow(WorkspacePathError)
  })

  it('会话没有归属的工作区时报错', () => {
    const registry = registryWith()
    expect(() => registry.resolveSessionPath('s1', 'a.md')).toThrow(WorkspaceNotFoundError)
  })

  it('会话指向的工作区在记录里没了时报错', () => {
    const dir = scratch()
    const storePath = join(dir, 'workspaces.json')
    // 记录里有个会话指向一个不存在的工作区（比如那个工作区被别的进程删了）。
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        workspaces: [],
        sessions: { s1: { workspaceId: '已经没了', hidden: false } },
      }),
      'utf8',
    )
    const registry = new WorkspaceRegistry({ storePath })
    expect(() => registry.resolveSessionPath('s1', 'a.md')).toThrow(WorkspaceNotFoundError)
  })
})

describe('落盘', () => {
  it('换个实例读同一个文件，工作区与会话归属都还在', () => {
    const dir = scratch()
    const storePath = join(dir, 'workspaces.json')
    const project = projectDir('proj')
    const first = new WorkspaceRegistry({ storePath, newId: () => 'w1', now: () => 1000 })
    first.create('项目', project)
    first.assignSession('s1', 'w1')

    const second = new WorkspaceRegistry({ storePath })
    expect(second.list().map((w) => w.name)).toEqual(['项目'])
    expect(second.get('w1')?.rootPath).toBe(resolve(project))
    expect(second.sessionsOf('w1')).toEqual(['s1'])
  })

  it('没给存储路径就只在内存里', () => {
    const registry = registryWith()
    registry.create('项目', projectDir('proj'))
    expect(registry.list()).toHaveLength(1)
    expect(new WorkspaceRegistry().list()).toEqual([])
  })

  it('文件坏掉时报「记录损坏」，不当成空列表', () => {
    const dir = scratch()
    const storePath = join(dir, 'workspaces.json')
    writeFileSync(storePath, '{ 写了一半', 'utf8')
    expect(() => new WorkspaceRegistry({ storePath })).toThrow(WorkspaceStoreError)
  })

  it('文件里不是一份记录时也报「记录损坏」', () => {
    const dir = scratch()
    const storePath = join(dir, 'workspaces.json')
    writeFileSync(storePath, '[]', 'utf8')
    expect(() => new WorkspaceRegistry({ storePath })).toThrow(/不像一份工作区记录/u)
  })

  it('坏掉的一条记录被丢掉，好的那些还在', () => {
    const dir = scratch()
    const storePath = join(dir, 'workspaces.json')
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        workspaces: [{ id: 'w1', name: '好的', rootPath: dir, createdAt: 1 }, { id: 'w2' }],
        sessions: {},
      }),
      'utf8',
    )
    const registry = new WorkspaceRegistry({ storePath })
    expect(registry.list().map((w) => w.id)).toEqual(['w1'])
  })

  it('写的是临时文件 + rename：目录里不会多出半个文件', () => {
    const dir = scratch()
    const storePath = join(dir, 'workspaces.json')
    const registry = new WorkspaceRegistry({ storePath, newId: () => 'w1', now: () => 1000 })
    registry.create('项目', projectDir('proj'))
    expect(existsSync(storePath)).toBe(true)
    // 落盘的是一份完整的 JSON，不是半截。
    expect(JSON.parse(readFileSync(storePath, 'utf8'))).toMatchObject({
      version: 1,
      workspaces: [{ id: 'w1', name: '项目' }],
    })
  })
})
