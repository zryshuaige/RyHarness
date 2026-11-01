/**
 * 环境清洗。
 *
 * 这一组用例守的是一条底线：**子进程不能看到模型服务的 key**。别的都好商量，
 * 这条不行。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_ENV_ALLOWLIST, scrubEnvironment } from '../src/index.ts'

describe('环境清洗', () => {
  it('白名单里的变量被继承下来', () => {
    const result = scrubEnvironment({
      base: { PATH: '/usr/bin', HOME: '/home/ry', TEMP: '/tmp' },
      platform: 'linux',
    })

    expect(result.env.PATH).toBe('/usr/bin')
    expect(result.env.HOME).toBe('/home/ry')
    expect(result.env.TEMP).toBe('/tmp')
    expect(result.inherited).toContain('PATH')
  })

  it('白名单之外的变量一律不传（模型服务的 key 不能漏出去）', () => {
    const result = scrubEnvironment({
      base: { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-do-not-leak', RY_INTERNAL_TOKEN: 'x' },
      platform: 'linux',
    })

    expect(result.env.OPENAI_API_KEY).toBeUndefined()
    expect(result.env.RY_INTERNAL_TOKEN).toBeUndefined()
    expect(Object.keys(result.env)).toEqual(['PATH'])
  })

  it('名字像密钥的：即使写进白名单也不传，并且记进 blocked', () => {
    const result = scrubEnvironment({
      base: { PATH: '/usr/bin', MY_API_KEY: 'sk-x' },
      allowlist: ['PATH', 'MY_API_KEY'],
      platform: 'linux',
    })

    expect(result.env.MY_API_KEY).toBeUndefined()
    expect(result.blocked).toEqual(['MY_API_KEY'])
  })

  it('调用方追加的变量原样传下去', () => {
    const result = scrubEnvironment({
      base: { PATH: '/usr/bin' },
      extra: { RY_TRACE: 'on' },
      platform: 'linux',
    })

    expect(result.env.RY_TRACE).toBe('on')
  })

  it('追加的变量不算「继承」：清单只列白名单里取到的', () => {
    const result = scrubEnvironment({ base: {}, extra: { RY_TRACE: 'on' }, platform: 'linux' })

    expect(result.inherited).toEqual([])
    expect(result.env.RY_TRACE).toBe('on')
  })

  it('Windows 上环境变量名大小写不敏感', () => {
    const result = scrubEnvironment({ base: { Path: 'C:\\bin' }, platform: 'win32' })

    expect(result.env.PATH).toBe('C:\\bin')
  })

  it('同一个变量不会因为大小写被继承两次', () => {
    const result = scrubEnvironment({ base: { PATH: 'a', Path: 'b' }, platform: 'win32' })

    expect(result.inherited.filter((name) => name.toLowerCase() === 'path')).toHaveLength(1)
  })

  it('默认白名单里没有任何凭据类的名字', () => {
    const suspicious = DEFAULT_ENV_ALLOWLIST.filter((name) => /KEY|TOKEN|SECRET|PASSWORD/i.test(name))

    expect(suspicious).toEqual([])
  })

  it('不传参数：用宿主环境与默认白名单', () => {
    const result = scrubEnvironment()

    expect(result.env.PATH).toBe(process.env.PATH)
    expect(result.inherited).toContain('PATH')
  })

  it('宿主环境里没有的变量不会被凭空造出来', () => {
    const result = scrubEnvironment({ base: {}, platform: 'linux' })

    expect(result.env).toEqual({})
    expect(result.inherited).toEqual([])
  })
})
