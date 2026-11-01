/**
 * 进程外 SDK：真的起一个子进程，走完整一轮请求-响应。
 */
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { SdkClient } from '../src/index.ts'

/** 假宿主脚本的位置。 */
const FAKE_HOST = fileURLToPath(new URL('./fixtures/fake-host.mjs', import.meta.url))

/** 不肯自己退的假宿主。 */
const STUBBORN_HOST = fileURLToPath(new URL('./fixtures/stubborn-host.mjs', import.meta.url))

/** 已经起好的客户端，测完要收掉。 */
const opened: SdkClient[] = []

afterEach(async () => {
  while (opened.length > 0) {
    const client = opened.pop()
    await client?.close()
  }
})

/**
 * 起一个连着假宿主的客户端。
 * @param options - 额外选项。
 * @returns 客户端。
 */
function startFakeHost(options: { readonly timeoutMs?: number } = {}): SdkClient {
  const client = SdkClient.start({
    command: process.execPath,
    args: [FAKE_HOST],
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  opened.push(client)
  return client
}

describe('进程外 SDK', () => {
  it('起一个子进程，发一次请求，拿到回包', async () => {
    const client = startFakeHost()
    await expect(client.request('host/echo', { text: '你好' })).resolves.toEqual({ text: '你好' })
  })

  it('返回值原样回到客户端', async () => {
    const client = startFakeHost()
    await expect(client.request('host/sum', { a: 2, b: 3 })).resolves.toBe(5)
  })

  it('子进程回的错误带着机器码', async () => {
    const client = startFakeHost()
    await expect(client.request('host/boom')).rejects.toMatchObject({
      code: 'gateway/internal',
      message: '宿主炸了',
    })
  })

  it('宿主没有这个方法时回「方法不存在」', async () => {
    const client = startFakeHost()
    await expect(client.request('host/nope')).rejects.toMatchObject({ rpcCode: -32601 })
  })

  it('超时报 gateway/timeout', async () => {
    const client = startFakeHost({ timeoutMs: 80 })
    await expect(client.request('host/hang')).rejects.toMatchObject({ code: 'gateway/timeout' })
  })

  it('取消报 gateway/cancelled', async () => {
    const client = startFakeHost()
    const controller = new AbortController()
    const pending = client.request('host/hang', undefined, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'gateway/cancelled' })
  })

  it('子进程崩了：挂在半路的请求立刻失败', async () => {
    const client = startFakeHost()
    const pending = client.request('host/hang')
    await expect(client.request('host/crash')).rejects.toMatchObject({ code: 'sdk/process-exit' })
    await expect(pending).rejects.toMatchObject({ code: 'sdk/process-exit' })
  })

  it('子进程退出了之后请求立刻失败，不等超时', async () => {
    const client = startFakeHost()
    await expect(client.request('host/quit')).rejects.toMatchObject({ code: 'sdk/process-exit' })
  })

  it('收干净：close() 之后子进程真的没了', async () => {
    const client = startFakeHost()
    await client.request('host/echo', { text: '在' })
    const exit = await client.close()
    expect(exit.code).toBe(0)
    expect(client.isRunning).toBe(false)
  })

  it('子进程自己退出的退出信息也能拿到', async () => {
    const client = startFakeHost()
    await client.request('host/quit').catch(() => undefined)
    const exit = await client.exited
    expect(exit.code).toBe(0)
  })

  it('可执行文件不存在时报 sdk/spawn-failed', async () => {
    const client = SdkClient.start({ command: 'ryharness-不存在的可执行文件' })
    opened.push(client)
    await expect(client.request('host/echo')).rejects.toMatchObject({ code: 'sdk/spawn-failed' })
  })

  it('通知发出去不算数，不等回包', async () => {
    const client = startFakeHost()
    client.notify('host/echo', { text: '通知' })
    await expect(client.request('host/echo', { text: '请求' })).resolves.toEqual({ text: '请求' })
  })

  it('子进程写的 stderr 留一份', async () => {
    const client = SdkClient.start({ command: process.execPath, args: [STUBBORN_HOST], closeTimeoutMs: 200 })
    opened.push(client)
    await new Promise((resolve) => {
      setTimeout(resolve, 300)
    })
    expect(client.stderr).toContain('我不打算自己退')
  })

  it('赖着不走的子进程：收尾时自己把它收掉', async () => {
    const client = SdkClient.start({ command: process.execPath, args: [STUBBORN_HOST], closeTimeoutMs: 200 })
    opened.push(client)
    await new Promise((resolve) => {
      setTimeout(resolve, 200)
    })
    expect(client.isRunning).toBe(true)
    await client.close()
    expect(client.isRunning).toBe(false)
  })
})
