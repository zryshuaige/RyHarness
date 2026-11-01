/**
 * 钉地址的取回器：请求参数长什么样、缺钉子会不会被放行。
 *
 * 这里测的是「连接层会不会自己再做一次解析」：连接目标写的是已校验的地址，
 * 就算哪一层又把域名拿回来解析，交出去的地址也仍然只有那一个。
 */

import type { RequestOptions } from 'node:https'
import { describe, expect, it } from 'vitest'
import { buildRequestOptions, createPinnedFetch } from '../src/index.ts'

const PUBLIC_IP = '93.184.216.34'

/**
 * 从请求参数里读一个头。
 *
 * node 的 headers 类型是个联合（对象或数组），测试只关心字符串头，所以摊平成一张
 * 表再取值。
 */
function headersOf(options: RequestOptions): Record<string, unknown> {
  const headers = options.headers
  if (headers === undefined) return {}
  return Object.fromEntries(Object.entries(headers))
}

describe('钉住地址的请求参数', () => {
  it('连接目标是字面地址，Host 与 SNI 仍是原域名', () => {
    const options = buildRequestOptions(new URL('https://example.test:8443/a/b?c=1'), PUBLIC_IP, undefined)
    expect(options.hostname).toBe(PUBLIC_IP)
    expect(options.servername).toBe('example.test')
    expect(headersOf(options).host).toBe('example.test:8443')
    expect(options.port).toBe(8443)
    expect(options.path).toBe('/a/b?c=1')
    expect(options.method).toBe('GET')
  })

  it('缺省端口交给协议决定，不硬编码', () => {
    const options = buildRequestOptions(new URL('https://example.test/x'), PUBLIC_IP, undefined)
    expect(options.port).toBeUndefined()
  })

  it('IP 直连不发 SNI（RFC 6066 不允许）', () => {
    const options = buildRequestOptions(new URL(`https://${PUBLIC_IP}/x`), PUBLIC_IP, undefined)
    expect(options.servername).toBeUndefined()
  })

  it('调用方给的 Host 头会被忽略：服务器看到的必须是原域名', () => {
    const options = buildRequestOptions(new URL('http://example.test/x'), PUBLIC_IP, {
      headers: { Host: 'evil.test', 'X-Token': 'abc' },
    })
    expect(headersOf(options).host).toBe('example.test')
    expect(headersOf(options)['x-token']).toBe('abc')
  })

  it('lookup 也只给已校验的地址：哪一层再解析域名都拿不到别的', async () => {
    const options = buildRequestOptions(new URL('http://rebind.test/x'), PUBLIC_IP, undefined)
    const lookup = options.lookup
    if (lookup === undefined) throw new Error('请求参数里缺少 lookup')
    const answer = await new Promise<string>((resolve, reject) => {
      lookup('rebind.test', { family: 0 }, (error, address) => {
        if (error !== null) {
          reject(error)
          return
        }
        resolve(typeof address === 'string' ? address : address[0].address)
      })
    })
    expect(answer).toBe(PUBLIC_IP)
  })

  it('缺钉子的请求直接拒绝：不落回「再解析一次」的老路', async () => {
    const fetcher = createPinnedFetch()
    await expect(fetcher('http://example.test/')).rejects.toThrow(/pin/)
    await expect(fetcher('http://example.test/', undefined, '')).rejects.toThrow(/pin/)
  })
})
