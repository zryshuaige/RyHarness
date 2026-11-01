/**
 * 地址安全闸的单元测试：协议白名单、私网拦截、解析失败怎么处理。
 *
 * 这些判定不接网络：解析器是注入的固定结果，所以「域名指向内网」这类事在
 * 测试里是可复现的，不靠运气。
 */
import { describe, expect, it } from 'vitest'
import { assertNavigableUrl, BrowserUseError, isPrivateAddress, judgeHost } from '../src/index.ts'

/** 一个固定解析器：给什么就返回什么。 */
function resolver(map: Record<string, readonly string[]>): (hostname: string) => Promise<readonly string[]> {
  return async (hostname) => map[hostname] ?? []
}

/** 永远解析失败的解析器。 */
const failingResolver = async (): Promise<readonly string[]> => {
  throw new Error('解析不了')
}

describe('安全闸：协议白名单', () => {
  it('http 与 https 都放行', async () => {
    const url = await assertNavigableUrl('https://example.com/a', {
      allowPrivateNetwork: false,
      resolveHost: resolver({ 'example.com': ['93.184.216.34'] }),
    })
    expect(url.protocol).toBe('https:')
    expect(url.pathname).toBe('/a')
  })

  it('file: 协议被拒，错误码是 UNSAFE_URL', async () => {
    await expect(
      assertNavigableUrl('file:///etc/passwd', {
        allowPrivateNetwork: false,
        resolveHost: resolver({}),
      }),
    ).rejects.toThrow(BrowserUseError)
    try {
      await assertNavigableUrl('file:///etc/passwd', {
        allowPrivateNetwork: false,
        resolveHost: resolver({}),
      })
      expect.unreachable('不该放行 file: 协议')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('UNSAFE_URL')
    }
  })

  it('ftp: 与 data: 协议同样被拒', async () => {
    for (const url of ['ftp://example.com/x', 'data:text/html,<b>x</b>']) {
      try {
        await assertNavigableUrl(url, { allowPrivateNetwork: false, resolveHost: resolver({}) })
        expect.unreachable(`不该放行 ${url}`)
      } catch (error) {
        expect((error as BrowserUseError).code).toBe('UNSAFE_URL')
      }
    }
  })

  it('地址格式不对时报 UNSAFE_URL', async () => {
    try {
      await assertNavigableUrl('不是一个地址', {
        allowPrivateNetwork: false,
        resolveHost: resolver({}),
      })
      expect.unreachable('不该放行一个坏地址')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('UNSAFE_URL')
    }
  })
})

describe('安全闸：本机与内网', () => {
  it('localhost 与 *.localhost 被拦', async () => {
    for (const host of ['localhost', 'foo.localhost']) {
      try {
        await assertNavigableUrl(`http://${host}/`, {
          allowPrivateNetwork: false,
          resolveHost: resolver({}),
        })
        expect.unreachable(`不该放行 ${host}`)
      } catch (error) {
        expect((error as BrowserUseError).code).toBe('PRIVATE_ADDRESS')
      }
    }
  })

  it('环回地址被拦', async () => {
    for (const host of ['127.0.0.1', '127.1.2.3']) {
      try {
        await assertNavigableUrl(`http://${host}/`, {
          allowPrivateNetwork: false,
          resolveHost: resolver({}),
        })
        expect.unreachable(`不该放行 ${host}`)
      } catch (error) {
        expect((error as BrowserUseError).code).toBe('PRIVATE_ADDRESS')
      }
    }
  })

  it('内网段位（10/8、172.16/12、192.168/16、169.254/16、0/8）都被拦', async () => {
    const hosts = ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1', '169.254.1.1', '0.0.0.0']
    for (const host of hosts) {
      expect(isPrivateAddress(host)).toBe(true)
      try {
        await assertNavigableUrl(`http://${host}/`, {
          allowPrivateNetwork: false,
          resolveHost: resolver({}),
        })
        expect.unreachable(`不该放行 ${host}`)
      } catch (error) {
        expect((error as BrowserUseError).code).toBe('PRIVATE_ADDRESS')
      }
    }
  })

  it('IPv6 的环回、未指定、唯一本地、链路本地都被拦', async () => {
    for (const host of ['[::1]', '[::]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1]']) {
      expect(isPrivateAddress(host)).toBe(true)
    }
  })

  it('IPv4-mapped 的 IPv6（::ffff:127.0.0.1）按内网处理', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateAddress('::ffff:93.184.216.34')).toBe(false)
  })

  it('公网地址不判定为私网', () => {
    expect(isPrivateAddress('93.184.216.34')).toBe(false)
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('2606:4700::1111')).toBe(false)
  })

  it('域名解析到内网地址时被拦', async () => {
    try {
      await assertNavigableUrl('https://sneaky.example/', {
        allowPrivateNetwork: false,
        resolveHost: resolver({ 'sneaky.example': ['192.168.0.5'] }),
      })
      expect.unreachable('不该放行解析到内网的域名')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('PRIVATE_ADDRESS')
    }
  })

  it('域名解析失败时按不许处理（拿不准就不去）', async () => {
    const verdict = await judgeHost('nowhere.example', failingResolver)
    expect(verdict).toBe('unknown')
    try {
      await assertNavigableUrl('https://nowhere.example/', {
        allowPrivateNetwork: false,
        resolveHost: failingResolver,
      })
      expect.unreachable('解析失败不该放行')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('PRIVATE_ADDRESS')
    }
  })

  it('解析出多条记录时，只要有一条在内网就整体拦掉', async () => {
    const verdict = await judgeHost('mixed.example', resolver({ 'mixed.example': ['93.184.216.34', '10.0.0.9'] }))
    expect(verdict).toBe('private')
  })

  it('IP 字面量不查 DNS（指向哪就是哪）', async () => {
    let asked = false
    const verdict = await judgeHost('93.184.216.34', async () => {
      asked = true
      return ['93.184.216.34']
    })
    expect(verdict).toBe('public')
    expect(asked).toBe(false)
  })

  it('allowPrivateNetwork 打开后内网地址放行', async () => {
    const url = await assertNavigableUrl('http://127.0.0.1:8080/admin', {
      allowPrivateNetwork: true,
      resolveHost: resolver({}),
    })
    expect(url.host).toBe('127.0.0.1:8080')
  })
})
