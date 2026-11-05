/**
 * SDK 客户端的用例：起一个子进程，用 JSON-RPC 跟它说话。
 *
 * 这一族盯的是「进程没了怎么办」：请求挂在半路时子进程退出，挂起的请求要立刻
 * 失败，不能等到超时；收尾要干净，不留孤儿进程。
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SdkClient } from '../src/index.ts'

describe('SDK 客户端', () => {
  it('起一个子进程并调通一个方法', async () => {
    const script = fileURLToPath(new URL('./fake-server.mjs', import.meta.url))
    const client = SdkClient.start({
      command: process.execPath,
      args: [script],
      timeoutMs: 5000,
    })
    try {
      const result = (await client.request('some/method', { hello: '世界' })) as {
        echo: string
        params: { hello: string }
      }
      expect(result.echo).toBe('some/method')
      expect(result.params.hello).toBe('世界')
    } finally {
      await client.close()
    }
  }, 30_000)

  it('子进程没了：挂着的请求立刻失败，不等到超时', async () => {
    const script = fileURLToPath(new URL('./exit-immediately.mjs', import.meta.url))
    const client = SdkClient.start({
      command: process.execPath,
      args: [script],
      // 超时给得很长：要是靠超时收口，这条用例就会挂住。
      timeoutMs: 60_000,
    })
    const started = Date.now()
    await expect(client.request('some/method')).rejects.toThrow()
    // 立刻失败（不是 60 秒后）。
    expect(Date.now() - started).toBeLessThan(20_000)
    await client.close()
  }, 30_000)

  it('收尾之后子进程真的不在了', async () => {
    const script = fileURLToPath(new URL('./fake-server.mjs', import.meta.url))
    const client = SdkClient.start({
      command: process.execPath,
      args: [script],
      timeoutMs: 5000,
    })
    await client.request('some/method')
    const exit = await client.close()
    expect(exit).toBeDefined()
    expect(client.isRunning).toBe(false)
  }, 30_000)
})
