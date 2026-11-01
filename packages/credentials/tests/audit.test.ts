/**
 * 审计：每一次取用都留一条（谁、什么时候、为了什么、批没批）。
 *
 * 没批的也要记——「谁想要、没让他要」正是事后最想看的那一条。
 */
import { describe, expect, it } from 'vitest'
import { type ApprovalDecision, CredentialRegistry } from '../src/index.ts'

/** 建一个注册表：审批行为由用例给，时钟固定。 */
function registryOf(options: { approve?: () => Promise<ApprovalDecision> } = {}) {
  let clock = 1_000
  const registry = new CredentialRegistry({
    requestApproval: async () => {
      clock += 1
      if (options.approve === undefined) return { approved: true }
      return options.approve()
    },
    resolveSecret: async () => 'sk-real',
    now: () => clock,
    newId: () => 'cred-1',
  })
  registry.register({ providerId: 'github', label: 'GitHub 主账号' })
  return { registry }
}

describe('审计记录', () => {
  it('批了并拿到密钥：记 granted，带上谁与为了什么', async () => {
    const { registry } = registryOf()
    await registry.use({ credentialId: 'cred-1', purpose: '拉取私有仓库', requester: 'plugin:web' })
    const entries = registry.audit()
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry?.credentialId).toBe('cred-1')
    expect(entry?.requester).toBe('plugin:web')
    expect(entry?.purpose).toBe('拉取私有仓库')
    expect(entry?.approved).toBe(true)
    expect(entry?.outcome).toBe('granted')
    expect(entry?.at).toBeGreaterThan(0)
  })

  it('没批的也要留一条：approved=false，outcome=denied', async () => {
    const { registry } = registryOf({ approve: () => Promise.resolve({ approved: false, reason: '不批' }) })
    await expect(registry.use({ credentialId: 'cred-1', purpose: '拉取私有仓库' })).rejects.toThrowError()
    const entry = registry.audit()[0]
    expect(entry?.approved).toBe(false)
    expect(entry?.outcome).toBe('denied')
    expect(entry?.reason).toBe('不批')
  })

  it('审批出错记 failed', async () => {
    const { registry } = registryOf({ approve: () => Promise.reject(new Error('面板没弹出来')) })
    await expect(registry.use({ credentialId: 'cred-1', purpose: 'x' })).rejects.toThrowError()
    const entry = registry.audit()[0]
    expect(entry?.outcome).toBe('failed')
    expect(entry?.approved).toBe(false)
    expect(entry?.reason).toContain('面板没弹出来')
  })

  it('批一段时间的记录里带着到期时间', async () => {
    const { registry } = registryOf({
      approve: () => Promise.resolve({ approved: true, scope: 'until', expiresAt: 9_999 }),
    })
    await registry.use({ credentialId: 'cred-1', purpose: 'x' })
    const entry = registry.audit()[0]
    expect(entry?.scope).toBe('until')
    expect(entry?.expiresAt).toBe(9_999)
  })

  it('auditFor 只给某个引用的记录', async () => {
    const { registry } = registryOf()
    registry.register({ providerId: 'gitlab', label: 'GitLab', id: 'cred-2' })
    await registry.use({ credentialId: 'cred-1', purpose: 'a' })
    await registry.use({ credentialId: 'cred-2', purpose: 'b' })
    expect(registry.auditFor('cred-2')).toHaveLength(1)
    expect(registry.auditFor('cred-2')[0]?.purpose).toBe('b')
    expect(registry.audit()).toHaveLength(2)
  })

  it('每次读审计都返回新的副本，外部改不动内部那份', async () => {
    const { registry } = registryOf()
    await registry.use({ credentialId: 'cred-1', purpose: 'x' })
    const first = registry.audit()
    const second = registry.audit()
    expect(first[0]).not.toBe(second[0])
    expect(first[0]?.purpose).toBe(second[0]?.purpose)
  })
})
