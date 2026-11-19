/**
 * 默认工作区选址与一次性迁移：环境变量优先 > F 盘产品目录 > 旧默认；
 * 迁移只在「新根不存在且旧默认存在」时搬，显式指定环境变量时不碰用户自选的地方。
 */
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { migrateDefaultWorkspace, PREFERRED_WORKSPACE_ROOT, resolveWorkspaceRoot } from '../electron/workspace-dir.ts'

describe('resolveWorkspaceRoot', () => {
  it('显式环境变量永远优先（即便有 F 盘）', () => {
    expect(resolveWorkspaceRoot({ envRoot: 'D:\\my-ws', dataDir: 'C:\\data', preferredDriveExists: true })).toBe(
      'D:\\my-ws',
    )
  })

  it('空串视为未指定，继续往下选址', () => {
    expect(resolveWorkspaceRoot({ envRoot: '', dataDir: 'C:\\data', preferredDriveExists: true })).toBe(
      PREFERRED_WORKSPACE_ROOT,
    )
  })

  it('有 F 盘且未指定环境变量：落到 F 盘产品目录', () => {
    expect(resolveWorkspaceRoot({ envRoot: undefined, dataDir: 'C:\\data', preferredDriveExists: true })).toBe(
      PREFERRED_WORKSPACE_ROOT,
    )
  })

  it('没有 F 盘的机器回退旧默认，行为与从前一致', () => {
    expect(resolveWorkspaceRoot({ envRoot: undefined, dataDir: 'C:\\data', preferredDriveExists: false })).toBe(
      join('C:\\data', 'workspace'),
    )
  })
})

describe('migrateDefaultWorkspace', () => {
  const from = join('C:\\data', 'workspace')
  const to = PREFERRED_WORKSPACE_ROOT

  it('旧默认存在、新根不存在：整体搬过去', () => {
    const move = vi.fn()
    const result = migrateDefaultWorkspace({
      from,
      to,
      envOverride: false,
      exists: (p) => p === from,
      move,
    })
    expect(result.migrated).toBe(true)
    expect(move).toHaveBeenCalledWith(from, to)
  })

  it('显式指定了环境变量：不搬（那是用户自己挑的地方）', () => {
    const move = vi.fn()
    const result = migrateDefaultWorkspace({ from, to, envOverride: true, exists: () => true, move })
    expect(result.migrated).toBe(false)
    expect(result.reason).toBe('env-override')
    expect(move).not.toHaveBeenCalled()
  })

  it('新根已存在：不搬（不拿旧文件盖新文件）', () => {
    const move = vi.fn()
    const result = migrateDefaultWorkspace({ from, to, envOverride: false, exists: () => true, move })
    expect(result.migrated).toBe(false)
    expect(result.reason).toBe('new-exists')
    expect(move).not.toHaveBeenCalled()
  })

  it('旧默认不存在：无可搬', () => {
    const move = vi.fn()
    const result = migrateDefaultWorkspace({ from, to, envOverride: false, exists: () => false, move })
    expect(result.migrated).toBe(false)
    expect(result.reason).toBe('no-legacy')
    expect(move).not.toHaveBeenCalled()
  })

  it('新旧同路径（无 F 盘回退旧默认）：不搬', () => {
    const move = vi.fn()
    const result = migrateDefaultWorkspace({ from, to: from, envOverride: false, exists: () => true, move })
    expect(result.migrated).toBe(false)
    expect(result.reason).toBe('same-path')
    expect(move).not.toHaveBeenCalled()
  })

  it('搬迁失败：如实报因，不吞错误', () => {
    const result = migrateDefaultWorkspace({
      from,
      to,
      envOverride: false,
      exists: (p) => p === from,
      move: () => {
        throw new Error('EBUSY')
      },
    })
    expect(result.migrated).toBe(false)
    expect(result.reason).toContain('move failed')
    expect(result.reason).toContain('EBUSY')
  })
})
