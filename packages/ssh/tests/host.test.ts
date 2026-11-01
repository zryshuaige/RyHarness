/**
 * 主机名校验：这一道是防「主机名被 ssh 当成选项」的注入。
 */
import { describe, expect, it } from 'vitest'
import { buildSshTarget, isSshError, userFromHost, validateSshHost } from '../src/index.ts'

describe('主机名校验', () => {
  it('普通主机名、IP、user@host 都放行', () => {
    expect(validateSshHost('example.com')).toBe('example.com')
    expect(validateSshHost('10.0.0.7')).toBe('10.0.0.7')
    expect(validateSshHost('deploy@example.com')).toBe('deploy@example.com')
    expect(validateSshHost('[::1]')).toBe('[::1]')
  })

  it('以 - 开头 → INVALID_HOST（会被 ssh 当成选项）', () => {
    let caught: unknown
    try {
      validateSshHost('-oProxyCommand=curl evil')
    } catch (error) {
      caught = error
    }
    expect(isSshError(caught, 'INVALID_HOST')).toBe(true)
  })

  it('含 = 的主机名一律拒绝', () => {
    expect(() => validateSshHost('host=1')).toThrow()
    expect(() => validateSshHost('host;rm -rf /')).toThrow()
  })

  it('含空白或控制字符的拒绝', () => {
    expect(() => validateSshHost('host name')).toThrow()
    expect(() => validateSshHost('host\nname')).toThrow()
  })

  it('空名字拒绝', () => {
    expect(() => validateSshHost('')).toThrow()
  })

  it('两个 @ 拒绝', () => {
    expect(() => validateSshHost('a@b@c')).toThrow()
  })

  it('太长的名字拒绝', () => {
    expect(() => validateSshHost('a'.repeat(300))).toThrow()
  })
})

describe('目标串拼装', () => {
  it('host 里的 user@ 会被认出来', () => {
    expect(userFromHost('deploy@example.com')).toBe('deploy')
    expect(userFromHost('example.com')).toBeUndefined()
  })

  it('单独给 user 时拼成 user@host', () => {
    const target = buildSshTarget({ host: 'example.com', user: 'deploy' })
    expect(target.destination).toBe('deploy@example.com')
    expect(target.host).toBe('example.com')
    expect(target.user).toBe('deploy')
  })

  it('host 里已经有 user 时不重复拼', () => {
    const target = buildSshTarget({ host: 'deploy@example.com' })
    expect(target.destination).toBe('deploy@example.com')
  })

  it('两处用户名不一致 → INVALID_HOST', () => {
    expect(() => buildSshTarget({ host: 'a@example.com', user: 'b' })).toThrow()
  })

  it('用户名里有怪字符 → INVALID_HOST', () => {
    expect(() => buildSshTarget({ host: 'example.com', user: 'a b' })).toThrow()
  })

  it('只有 @ 没有主机部分 → INVALID_HOST', () => {
    expect(() => buildSshTarget({ host: '@' })).toThrow()
  })
})
