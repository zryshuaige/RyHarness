/**
 * 出站地址的闸：私网判定、协议白名单、域名解析到私网。
 *
 * 这些用例是这一包存在的理由——模型能直接给出 URL，能直接给出 URL 就意味着
 * 「模型能决定这台机器往哪儿发请求」。所以「私网被挡住」这件事必须有测试钉住，
 * 不能靠读代码确认。
 */
import { describe, expect, it } from 'vitest'
import { isPrivateAddress, resolveSafeTarget } from '../src/index.ts'

const PUBLIC_IP = '93.184.216.34'

/** 解析器：记下被问过的主机名，方便断言「没查 DNS」。 */
function resolver(addresses: readonly string[]) {
  const asked: string[] = []
  const resolve = async (hostname: string): Promise<readonly string[]> => {
    asked.push(hostname)
    return addresses
  }
  return { asked, resolve }
}

describe('私网地址判定', () => {
  it('IPv4 的本机与内网段位都算私网', () => {
    const blocked = [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.1.1',
      '0.0.0.0',
    ]
    for (const address of blocked) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
  })

  it('公网地址与 172.32 往上的地址不算私网', () => {
    const allowed = ['8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.1', '2606:4700:4700::1111']
    for (const address of allowed) {
      expect(isPrivateAddress(address), address).toBe(false)
    }
  })

  it('IPv6 的本机、唯一本地、链路本地与 IPv4-mapped 形式都算私网', () => {
    const blocked = ['::1', '::', 'fd12::1', 'fc::1', 'fe80::1', 'fe80::1234', '::ffff:127.0.0.1', '::ffff:7f00:1']
    for (const address of blocked) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
  })

  it('域名不是地址：判定交给解析结果，不在这里猜', () => {
    expect(isPrivateAddress('internal.example')).toBe(false)
    expect(isPrivateAddress('example.test')).toBe(false)
  })
})

describe('URL 校验', () => {
  it('协议白名单：file: 与 ftp: 都拒绝', async () => {
    const { resolve } = resolver([PUBLIC_IP])
    await expect(resolveSafeTarget('file:///etc/passwd', resolve)).rejects.toThrow('只允许 http/https')
    await expect(resolveSafeTarget('ftp://example.com/a', resolve)).rejects.toThrow('只允许 http/https')
    await expect(resolveSafeTarget('javascript:alert(1)', resolve)).rejects.toThrow('只允许 http/https')
  })

  it('格式不对的链接给中文错误', async () => {
    const { resolve } = resolver([PUBLIC_IP])
    await expect(resolveSafeTarget('不是链接', resolve)).rejects.toThrow('链接格式不正确')
  })

  it('localhost 与本机字面地址拒绝，且一步都不查 DNS', async () => {
    const { asked, resolve } = resolver([PUBLIC_IP])
    const blocked = [
      'http://localhost/',
      'http://foo.localhost/',
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://169.254.1.1/',
      'http://[::1]/',
    ]
    for (const url of blocked) {
      await expect(resolveSafeTarget(url, resolve)).rejects.toThrow('拒绝访问本机或内网地址')
    }
    expect(asked).toEqual([])
  })

  it('域名解析到私网就拒：只查字面量会漏掉内网域名', async () => {
    const { resolve } = resolver(['10.1.2.3'])
    await expect(resolveSafeTarget('http://internal.example/', resolve)).rejects.toThrow('拒绝访问本机或内网地址')
  })

  it('解析结果里混着一个内网地址也拒：让 DNS 挑就等于把选择权交出去了', async () => {
    const { resolve } = resolver([PUBLIC_IP, '192.168.0.9'])
    await expect(resolveSafeTarget('http://mixed.example/', resolve)).rejects.toThrow('拒绝访问本机或内网地址')
  })

  it('解析不出地址、或解析本身失败，都给中文错误', async () => {
    const empty = resolver([])
    await expect(resolveSafeTarget('http://none.example/', empty.resolve)).rejects.toThrow('无法解析主机名')
    const broken = async (): Promise<readonly string[]> => {
      throw new Error('dns down')
    }
    await expect(resolveSafeTarget('http://none.example/', broken)).rejects.toThrow('无法解析主机名')
  })

  it('字面 IP 不查 DNS，钉子就是它自己', async () => {
    const { asked, resolve } = resolver([PUBLIC_IP])
    const target = await resolveSafeTarget(`http://${PUBLIC_IP}/x`, resolve)
    expect(target.ip).toBe(PUBLIC_IP)
    expect(asked).toEqual([])
  })

  it('域名解析通过时，钉子取自那次解析放行的地址', async () => {
    const { asked, resolve } = resolver([PUBLIC_IP])
    const target = await resolveSafeTarget('http://example.test/a?b=1', resolve)
    expect(target.ip).toBe(PUBLIC_IP)
    expect(target.url.toString()).toBe('http://example.test/a?b=1')
    expect(asked).toEqual(['example.test'])
  })
})
