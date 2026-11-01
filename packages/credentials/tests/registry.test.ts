/**
 * 注册表：登记引用、列举、吊销，以及「引用里不许有密钥」这条底线。
 */
import { describe, expect, it } from 'vitest'
import { type ApprovalDecision, CredentialError, CredentialRegistry } from '../src/index.ts'

/** 建一个注册表：审批一律批，密钥给固定值。 */
function registryOf(
  options: {
    approve?: (purpose: string) => ApprovalDecision
    secret?: (id: string) => string
    now?: () => number
    newId?: () => string
  } = {},
) {
  const asked: string[] = []
  const registry = new CredentialRegistry({
    requestApproval: async (request) => {
      asked.push(request.purpose)
      return options.approve?.(request.purpose) ?? { approved: true }
    },
    resolveSecret: async (ref) => {
      return options.secret?.(ref.id) ?? `secret-for-${ref.id}`
    },
    now: options.now ?? (() => 1_000),
    newId: options.newId ?? (() => 'cred-1'),
  })
  return { registry, asked }
}

describe('登记与列举', () => {
  it('登记后拿到一条引用：id、供应商、名字、时间', () => {
    const { registry } = registryOf()
    const ref = registry.register({ providerId: 'github', label: 'GitHub 主账号' })
    expect(ref.id).toBe('cred-1')
    expect(ref.providerId).toBe('github')
    expect(ref.label).toBe('GitHub 主账号')
    expect(ref.createdAt).toBe(1_000)
  })

  it('引用里**没有**密钥本身：连字段名都不许出现', () => {
    const { registry } = registryOf()
    const ref = registry.register({ providerId: 'github', label: 'GitHub', hint: '...1234' })
    expect(Object.keys(ref).sort()).toEqual(['createdAt', 'hint', 'id', 'label', 'providerId'])
    expect(JSON.stringify(ref)).not.toContain('secret')
  })

  it('登记时硬塞密钥会被挡下', () => {
    const { registry } = registryOf()
    const bad = { providerId: 'github', label: 'GitHub', secret: 'sk-live-123' }
    try {
      registry.register(bad)
      expect.unreachable('应该报错')
    } catch (error) {
      expect(error instanceof CredentialError).toBe(true)
      if (!(error instanceof CredentialError)) return
      expect(error.code).toBe('SECRET_IN_REGISTRATION')
    }
  })

  it('缺供应商或名字要被挡下', () => {
    const { registry } = registryOf()
    expect(() => registry.register({ providerId: '', label: 'x' })).toThrowError(CredentialError)
    expect(() => registry.register({ providerId: 'github', label: '  ' })).toThrowError(/名字/)
  })

  it('id 重复要报错', () => {
    const { registry } = registryOf()
    registry.register({ providerId: 'github', label: 'GitHub' })
    expect(() => registry.register({ providerId: 'github', label: '又一个' })).toThrowError(/已经有/)
  })

  it('list 列出全部引用', () => {
    const { registry } = registryOf({ newId: () => 'x' })
    registry.register({ providerId: 'github', label: 'A' })
    registry.register({ providerId: 'gitlab', label: 'B', id: 'second' })
    expect(registry.list().map((ref) => ref.label)).toEqual(['A', 'B'])
  })

  it('get 能按 id 拿到引用', () => {
    const { registry } = registryOf()
    registry.register({ providerId: 'github', label: 'GitHub' })
    expect(registry.get('cred-1')?.label).toBe('GitHub')
    expect(registry.get('nope')).toBeUndefined()
  })

  it('不给 id 时自己生成一个', () => {
    const registry = new CredentialRegistry({
      requestApproval: async () => ({ approved: true }),
      resolveSecret: async () => 'sk',
    })
    const ref = registry.register({ providerId: 'github', label: 'GitHub' })
    expect(ref.id.startsWith('cred-')).toBe(true)
    expect(ref.id.length).toBeGreaterThan(5)
  })
})

describe('吊销', () => {
  it('吊销后默认清单里不再有它', () => {
    const { registry } = registryOf()
    registry.register({ providerId: 'github', label: 'GitHub' })
    expect(registry.revoke('cred-1')).toBe(true)
    expect(registry.list()).toEqual([])
  })

  it('要查历史时还能看到它', () => {
    const { registry } = registryOf()
    registry.register({ providerId: 'github', label: 'GitHub' })
    registry.revoke('cred-1')
    expect(registry.list({ includeRevoked: true })).toHaveLength(1)
  })

  it('吊销不存在的引用返回 false', () => {
    const { registry } = registryOf()
    expect(registry.revoke('nope')).toBe(false)
  })

  it('吊销之后再取号要被挡下', async () => {
    const { registry } = registryOf()
    registry.register({ providerId: 'github', label: 'GitHub' })
    registry.revoke('cred-1')
    await expect(registry.use({ credentialId: 'cred-1', purpose: '拉取仓库' })).rejects.toThrowError(/吊销/)
  })

  it('吊销之后之前批的那段时间内授权也不算数', async () => {
    let now = 1_000
    const { registry } = registryOf({
      now: () => now,
      approve: () => ({ approved: true, scope: 'until', expiresAt: 5_000 }),
    })
    registry.register({ providerId: 'github', label: 'GitHub' })
    await registry.use({ credentialId: 'cred-1', purpose: '第一次' })
    registry.revoke('cred-1')
    now = 2_000
    await expect(registry.use({ credentialId: 'cred-1', purpose: '第二次' })).rejects.toThrowError(/吊销/)
  })
})
