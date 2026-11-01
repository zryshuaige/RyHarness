/**
 * 连接层：JSON-RPC over 帧协议，出错时怎么说。
 *
 * provider 那层把连接包起来了，于是有些失败路径在那里看不见：请求还没发出去就
 * 被拒、服务器回了一个明确的错误、管道已经关了还在写。这一组用例直接对着
 * {@link LspConnection} 说话，把这些路径一条条钉住。
 */
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { describeSpawnError, LspConnection, LspError } from '../src/index.ts'

/** 假 server 的绝对路径。 */
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url))

const connections: LspConnection[] = []

afterEach(async () => {
  // 断言之外的无条件兜底：连接要是还活着，先收掉再走。
  while (connections.length > 0) {
    await connections.pop()?.close()
  }
})

/**
 * 起一条连着假 server 的连接。
 * @param env - 传给子进程的环境变量。
 * @returns 连接。
 */
function connection(env: Record<string, string> = {}): LspConnection {
  const created = new LspConnection({ command: process.execPath, args: [FIXTURE], env })
  connections.push(created)
  return created
}

/**
 * 把失败原样抓下来。
 * @param promise - 会失败的 promise。
 * @returns 抛出来的东西。
 */
async function capture(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

describe('LSP 连接', () => {
  it('还没起进程就发请求：说进程还没起来', async () => {
    const link = connection()

    const error = await capture(link.request('initialize', {}, 1_000))

    expect(error).toBeInstanceOf(LspError)
    expect((error as LspError).code).toBe('server-unavailable')
    expect((error as LspError).message).toContain('还没起来')
  })

  it('起两次不会起两个进程', async () => {
    const link = connection()
    link.start()
    link.start()

    const result = await link.request('initialize', {}, 5_000)

    expect((result as { serverInfo: { name: string } }).serverInfo.name).toBe('fake-lsp')
  })

  it('服务器主动发的通知被当作没看见，请求照常回包', async () => {
    const link = connection()
    link.start()

    const result = await link.request('initialize', {}, 5_000)

    // 假服务器在握手后发了一条 window/logMessage 通知，它不该影响回包。
    expect((result as { serverInfo: { version: string } }).serverInfo.version).toBe('1.0.0')
    expect(link.dead).toBe(false)
  })

  it('服务器明确回了错误：说清楚错误码与内容', async () => {
    const link = connection()
    link.start()
    await link.request('initialize', {}, 5_000)

    const error = await capture(link.request('textDocument/没有这个方法', {}, 5_000))

    expect(error).toBeInstanceOf(LspError)
    expect((error as LspError).code).toBe('request-failed')
    expect((error as LspError).message).toContain('-32601')
    expect((error as LspError).message).toContain('method not found')
  })

  it('连接关了之后发请求：说连接已经关了，不说「进程崩了」', async () => {
    const link = connection()
    link.start()
    await link.request('initialize', {}, 5_000)
    await link.close()

    const error = await capture(link.request('textDocument/hover', {}, 5_000))

    expect(error).toBeInstanceOf(LspError)
    expect((error as LspError).code).toBe('server-unavailable')
    // 主动关的连接不算「崩了」——那句话会让人以为语言服务器自己挂了。
    expect((error as LspError).message).toContain('已经关闭')
    expect((error as LspError).message).not.toContain('进程已退出')
  })

  it('没起过进程的连接也能关，不报错', async () => {
    const link = connection()

    await expect(link.close()).resolves.toBeUndefined()
  })

  it('关掉之后再发通知：写不进去就算了，不能炸', async () => {
    const link = connection()
    link.start()
    await link.request('initialize', {}, 5_000)
    await link.close()

    expect(() => link.notify('textDocument/didClose', {})).not.toThrow()
  })

  it('进程死了之后连接判死，并记下原因', async () => {
    const link = connection({ LSP_FIXTURE_MODE: 'exit-on-init' })
    link.start()

    await capture(link.request('initialize', {}, 5_000))
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })

    expect(link.dead).toBe(true)
    expect(link.failure?.code).toBe('server-unavailable')
    expect(link.failure?.message).toContain('退出码 3')
  })

  it('帧头没问题但正文不是 JSON：报协议错误', async () => {
    const link = connection({ LSP_FIXTURE_MODE: 'bad-json' })
    link.start()

    const error = await capture(link.request('initialize', {}, 5_000))

    expect(error).toBeInstanceOf(LspError)
    expect((error as LspError).code).toBe('protocol-error')
    expect((error as LspError).message).toContain('不是合法 JSON')
  })

  it('服务器发来不是对象的东西与没人要的回包：都当作没看见', async () => {
    const link = connection({ LSP_FIXTURE_MODE: 'noisy' })
    link.start()

    const result = await link.request('initialize', {}, 5_000)

    // 假服务器在握手后发了一条不是对象的帧与一条 id 对不上的回包，它们都不该影响回包。
    expect((result as { serverInfo: { name: string } }).serverInfo.name).toBe('fake-lsp')
    expect(link.dead).toBe(false)
  })

  it('服务器的错误对象既没有 code 也没有 message：自己补一句能看的话', async () => {
    const link = connection({ LSP_FIXTURE_MODE: 'weird-error' })
    link.start()
    await link.request('initialize', {}, 5_000)

    const error = await capture(link.request('textDocument/没有这个方法', {}, 5_000))

    expect(error).toBeInstanceOf(LspError)
    expect((error as LspError).code).toBe('request-failed')
    expect((error as LspError).message).toContain('代码 未知')
    expect((error as LspError).message).toContain('服务器没有说明错误原因')
  })

  it('命令没配参数时也照常起', async () => {
    const created = new LspConnection({ command: process.execPath })
    connections.push(created)
    created.start()

    expect(created.dead).toBe(false)
    await created.close()
  })

  it('命令不在 PATH 上：说找不到这个语言服务器命令', () => {
    const error = describeSpawnError('typescript-language-server', 'ENOENT', 'spawn ENOENT')

    expect(error.code).toBe('command-not-found')
    expect(error.message).toContain('typescript-language-server')
  })

  it('命令在但起不来：说启动失败，不让人去重装一个装好的东西', () => {
    const error = describeSpawnError('typescript-language-server', 'EACCES', 'permission denied')

    expect(error.code).toBe('server-unavailable')
    expect(error.message).toContain('启动失败')
    expect(error.message).toContain('permission denied')
  })

  it('服务器不退：等一会儿就强杀，close 照样返回', async () => {
    const link = connection({ LSP_FIXTURE_MODE: 'ignore-exit' })
    link.start()
    await link.request('initialize', {}, 5_000)

    const started = Date.now()
    await link.close()

    // 强杀的兜底时限是 2 秒：服务器赖着不走，我们也不能一直等。
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500)
  }, 15_000)
})
