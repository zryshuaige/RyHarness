import { readFileSync } from 'node:fs'
import { hostname, networkInterfaces, userInfo } from 'node:os'
import { join } from 'node:path'
import { ANONYMOUS_ID_BYTES, ANONYMOUS_ID_LENGTH, generateAnonymousId, isValidAnonymousId } from '@ryharness/identity'
import { describe, expect, it } from 'vitest'

describe('匿名 id 的形状', () => {
  it('够长：32 个字符，底下 24 字节随机', () => {
    const id = generateAnonymousId()
    expect(id).toHaveLength(ANONYMOUS_ID_LENGTH)
    expect(ANONYMOUS_ID_LENGTH).toBe(32)
    expect(Buffer.from(id, 'base64url')).toHaveLength(ANONYMOUS_ID_BYTES)
  })

  it('URL 安全：只有字母数字与 -_', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateAnonymousId()).toMatch(/^[A-Za-z0-9_-]+$/u)
    }
  })

  it('每次都不一样', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 200; i += 1) ids.add(generateAnonymousId())
    expect(ids.size).toBe(200)
  })

  it('认得出合法与非法', () => {
    expect(isValidAnonymousId(generateAnonymousId())).toBe(true)
    expect(isValidAnonymousId('太短')).toBe(false)
    expect(isValidAnonymousId('有 空格 的 id 长得足够长')).toBe(false)
    expect(isValidAnonymousId('带/斜杠的id长得足够长')).toBe(false)
    expect(isValidAnonymousId(`${'a'.repeat(200)}`)).toBe(false)
  })
})

describe('id 只来自随机源', () => {
  it('注入固定随机源时，id 完全确定', () => {
    const fixed = (length: number): Uint8Array => new Uint8Array(length).fill(7)
    expect(generateAnonymousId(fixed)).toBe(generateAnonymousId(fixed))
    expect(generateAnonymousId(fixed)).toBe('BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH')
  })

  it('换一个随机源就换一个 id', () => {
    const a = generateAnonymousId((length: number) => new Uint8Array(length).fill(1))
    const b = generateAnonymousId((length: number) => new Uint8Array(length).fill(2))
    expect(a).not.toBe(b)
  })
})

describe('id 里没有个人信息', () => {
  it('不含用户名、机器名与 MAC 地址', () => {
    const id = generateAnonymousId()
    const macs: string[] = []
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.mac.length > 0) macs.push(address.mac)
      }
    }
    const secrets = [userInfo().username, hostname(), ...macs]
    for (const secret of secrets) {
      // 太短的值（用户名可能就一两个字符）撞上随机串是常事，
      // 那种情况下这条断言没有意义——按长度门槛跳过。
      if (secret.length < 4) continue
      expect(id).not.toContain(secret)
    }
  })

  it('生成 id 的源码里不碰用户名、机器名与网卡', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'id.ts'), 'utf8')
    expect(source).not.toContain('userInfo')
    expect(source).not.toContain('hostname')
    expect(source).not.toContain('networkInterfaces')
  })
})
