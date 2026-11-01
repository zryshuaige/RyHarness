/**
 * 授权流程：没批不给号、审批出错如实失败、超时如实失败、授权范围与过期。
 *
 * 这一组用例守的是「宁可失败，不要假装成功」：任何一种拿不到授权的情况，都必须以
 * 异常结束，不能返回一个空串或一个假密钥。
 */
import { describe, expect, it } from 'vitest'
import { type ApprovalDecision, CredentialError, CredentialRegistry } from '../src/index.ts'

/** 建一个注册表：审批行为由用例给。 */
function registryOf(
  options: {
    approve?: (purpose: string) => Promise<ApprovalDecision>
    secret?: (id: string) => string | Promise<string>
    now?: () => number
    approvalTimeoutMs?: number
  } = {},
) {
  const asked: string[] = []
  const registry = new CredentialRegistry({
    requestApproval: async (request) => {
      asked.push(request.purpose)
      if (options.approve === undefined) return { approved: true }
      return options.approve(request.purpose)
    },
    resolveSecret: async (ref) => {
      if (options.secret === undefined) return `secret-for-${ref.id}`
      return options.secret(ref.id)
    },
    now: options.now ?? (() => 1_000),
    ...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }),
    newId: () => 'cred-1',
  })
  registry.register({ providerId: 'github', label: 'GitHub 主账号' })
  return { registry, asked }
}

describe('没批就不给号', () => {
  it('人没点头：抛 DENIED，拿不到密钥', async () => {
    const { registry } = registryOf({
      approve: () => Promise.resolve({ approved: false, reason: '这次不批' }),
    })
    try {
      await registry.use({ credentialId: 'cred-1', purpose: '拉取仓库' })
      expect.unreachable('应该报错')
    } catch (error) {
      expect(error instanceof CredentialError).toBe(true)
      if (!(error instanceof CredentialError)) return
      expect(error.code).toBe('DENIED')
      expect(error.message).toContain('这次不批')
    }
  })

  it('审批请求里带着「要干什么」，人才知道自己在批什么', async () => {
    let seen: { purpose: string; requester: string; label: string } | undefined
    const registry = new CredentialRegistry({
      requestApproval: async (request) => {
        seen = { purpose: request.purpose, requester: request.requester, label: request.label }
        return { approved: true }
      },
      resolveSecret: async () => 'sk',
    })
    registry.register({ providerId: 'github', label: 'GitHub 主账号', id: 'cred-1' })
    await registry.use({ credentialId: 'cred-1', purpose: '拉取私有仓库', requester: 'plugin:web' })
    expect(seen?.purpose).toBe('拉取私有仓库')
    expect(seen?.requester).toBe('plugin:web')
    expect(seen?.label).toBe('GitHub 主账号')
  })

  it('引用不存在时如实失败', async () => {
    const { registry } = registryOf()
    await expect(registry.use({ credentialId: 'nope', purpose: 'x' })).rejects.toThrowError(/没有这个凭据引用/)
  })

  it('没批又没给理由：文案里说清是没人批', async () => {
    const { registry } = registryOf({ approve: () => Promise.resolve({ approved: false }) })
    try {
      await registry.use({ credentialId: 'cred-1', purpose: '拉取仓库' })
      expect.unreachable('应该报错')
    } catch (error) {
      expect(error instanceof CredentialError).toBe(true)
      if (!(error instanceof CredentialError)) return
      expect(error.code).toBe('DENIED')
      expect(error.message).toContain('没有人批准')
    }
  })

  it('引用带末四位时，审批请求里也带着：人才能确认是哪一把', async () => {
    let hint: string | undefined
    const registry = new CredentialRegistry({
      requestApproval: async (request) => {
        hint = request.hint
        return { approved: true }
      },
      resolveSecret: async () => 'sk',
    })
    registry.register({ providerId: 'github', label: 'GitHub 主账号', hint: '...1234', id: 'cred-1' })
    await registry.use({ credentialId: 'cred-1', purpose: '拉取仓库' })
    expect(hint).toBe('...1234')
  })
})

describe('审批本身出错', () => {
  it('审批函数抛错：如实失败，不给号', async () => {
    const { registry } = registryOf({
      approve: () => Promise.reject(new Error('审批面板没弹出来')),
    })
    try {
      await registry.use({ credentialId: 'cred-1', purpose: '拉取仓库' })
      expect.unreachable('应该报错')
    } catch (error) {
      expect(error instanceof CredentialError).toBe(true)
      if (!(error instanceof CredentialError)) return
      expect(error.code).toBe('APPROVAL_FAILED')
      expect(error.message).toContain('审批面板没弹出来')
    }
  })

  it('等太久没等到人：如实超时', async () => {
    const { registry } = registryOf({
      approvalTimeoutMs: 20,
      approve: () =>
        new Promise<ApprovalDecision>(() => {
          // 一直不批：模拟人没看见弹窗
        }),
    })
    try {
      await registry.use({ credentialId: 'cred-1', purpose: '拉取仓库' })
      expect.unreachable('应该超时')
    } catch (error) {
      expect(error instanceof CredentialError).toBe(true)
      if (!(error instanceof CredentialError)) return
      expect(error.code).toBe('APPROVAL_TIMEOUT')
    }
  })

  it('批了但密钥取不到：如实失败，不给空串', async () => {
    const { registry } = registryOf({
      secret: () => {
        throw new Error('密钥库没打开')
      },
    })
    try {
      await registry.use({ credentialId: 'cred-1', purpose: '拉取仓库' })
      expect.unreachable('应该报错')
    } catch (error) {
      expect(error instanceof CredentialError).toBe(true)
      if (!(error instanceof CredentialError)) return
      expect(error.code).toBe('SECRET_UNAVAILABLE')
    }
  })

  it('取到的密钥是空串：一样当作失败', async () => {
    const { registry } = registryOf({ secret: () => '' })
    await expect(registry.use({ credentialId: 'cred-1', purpose: 'x' })).rejects.toThrowError(/空的/)
  })
})

describe('授权范围与过期', () => {
  it('批「这一次」：下一次还要再问', async () => {
    const { registry, asked } = registryOf({ approve: () => Promise.resolve({ approved: true, scope: 'once' }) })
    await registry.use({ credentialId: 'cred-1', purpose: '第一次' })
    await registry.use({ credentialId: 'cred-1', purpose: '第二次' })
    expect(asked).toEqual(['第一次', '第二次'])
  })

  it('批「一段时间内都批」：有效期内不再问', async () => {
    let now = 1_000
    const { registry, asked } = registryOf({
      now: () => now,
      approve: () => Promise.resolve({ approved: true, scope: 'until', expiresAt: 5_000 }),
    })
    await registry.use({ credentialId: 'cred-1', purpose: '第一次' })
    await registry.use({ credentialId: 'cred-1', purpose: '第二次' })
    expect(asked).toEqual(['第一次'])
    now = 4_999
    await registry.use({ credentialId: 'cred-1', purpose: '第三次' })
    expect(asked).toEqual(['第一次'])
  })

  it('过期之后要再批一次', async () => {
    let now = 1_000
    const { registry, asked } = registryOf({
      now: () => now,
      approve: () => Promise.resolve({ approved: true, scope: 'until', expiresAt: 5_000 }),
    })
    await registry.use({ credentialId: 'cred-1', purpose: '第一次' })
    now = 6_000
    await registry.use({ credentialId: 'cred-1', purpose: '第二次' })
    expect(asked).toEqual(['第一次', '第二次'])
  })

  it('没给到期时间的「一段时间内」按「这一次」处理：宁可多问一次', async () => {
    const { registry, asked } = registryOf({
      approve: () => Promise.resolve({ approved: true, scope: 'until' }),
    })
    await registry.use({ credentialId: 'cred-1', purpose: '第一次' })
    await registry.use({ credentialId: 'cred-1', purpose: '第二次' })
    expect(asked).toEqual(['第一次', '第二次'])
  })

  it('批了就能拿到真密钥', async () => {
    const { registry } = registryOf({ secret: () => 'sk-real-123' })
    const secret = await registry.use({ credentialId: 'cred-1', purpose: '拉取仓库' })
    expect(secret).toBe('sk-real-123')
  })
})
