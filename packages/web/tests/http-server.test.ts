/**
 * 取回器的真实链路：起一个本地服务，走一遍 node:http 那条路。
 *
 * 别的用例都注入了假响应，传输层因此没被真的走过——这里补上：连接目标写的是字面
 * 地址、Host 头仍按 URL 里的域名走、正文超上限会停、取消信号会掐掉请求。
 *
 * 用的是回环地址，但这个包里的「私网拦截」在 guard.ts，不在传输层：传输层只负责
 * 「连到给定的那个地址」，连不连得上由调用方校验过没有。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createPinnedFetch } from '../src/index.ts'

const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop()
    if (close !== undefined) await close()
  }
})

/** 起一个本地服务，回调自己处理请求。 */
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('拿不到本地端口')
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        // 光 close 不够：还挂着的连接会让它一直等。
        server.closeAllConnections()
        server.close(() => {
          resolve()
        })
      }),
  )
  return address.port
}

describe('取回器的真实链路', () => {
  it('GET：状态、头与正文都回来了', async () => {
    const port = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'x-custom': 'yes' })
      response.end('正文')
    })
    const fetcher = createPinnedFetch()
    const response = await fetcher(`http://127.0.0.1:${port}/a?b=1`, undefined, '127.0.0.1')
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('text/plain')
    expect(response.headers['x-custom']).toBe('yes')
    expect(response.body.toString('utf8')).toBe('正文')
    expect(response.truncated).toBe(false)
  })

  it('Host 头按 URL 里的域名走，不是钉住的那个地址', async () => {
    let host = ''
    const port = await serve((request, response) => {
      host = request.headers.host ?? ''
      response.end('ok')
    })
    const fetcher = createPinnedFetch()
    // 地址栏写的是 localhost，连的是钉住的 127.0.0.1：服务器看到的必须是前者。
    await fetcher(`http://localhost:${port}/`, undefined, '127.0.0.1')
    expect(host).toBe(`localhost:${port}`)
  })

  it('POST：请求体原样送到对端', async () => {
    let received = ''
    const port = await serve((request, response) => {
      request.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8')
      })
      request.on('end', () => {
        response.end('收到')
      })
    })
    const fetcher = createPinnedFetch()
    const response = await fetcher(
      `http://127.0.0.1:${port}/`,
      { method: 'POST', body: '{"q":"词"}', headers: { 'content-type': 'application/json' } },
      '127.0.0.1',
    )
    expect(received).toBe('{"q":"词"}')
    expect(response.body.toString('utf8')).toBe('收到')
  })

  it('正文超过字节上限就截断，并标记 truncated', async () => {
    const port = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('a'.repeat(100))
    })
    const fetcher = createPinnedFetch(32)
    const response = await fetcher(`http://127.0.0.1:${port}/`, undefined, '127.0.0.1')
    expect(response.truncated).toBe(true)
    expect(response.body.length).toBe(32)
  })

  it('取消信号会把请求掐掉', async () => {
    const port = await serve(() => {
      // 不回，让它挂着。
    })
    const controller = new AbortController()
    const fetcher = createPinnedFetch()
    const pending = fetcher(`http://127.0.0.1:${port}/`, { signal: controller.signal }, '127.0.0.1')
    controller.abort()
    await expect(pending).rejects.toThrow()
  })

  it('连不上时回一个错误，而不是挂住', async () => {
    const port = await serve(() => {})
    const fetcher = createPinnedFetch()
    // 先把服务关掉，再连：端口没人听。
    await closeAll()
    await expect(fetcher(`http://127.0.0.1:${port}/`, undefined, '127.0.0.1')).rejects.toThrow()
  })
})

/** 关掉所有本地服务。 */
async function closeAll(): Promise<void> {
  while (closers.length > 0) {
    const close = closers.pop()
    if (close !== undefined) await close()
  }
}
