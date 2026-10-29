import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildChildEnv, type McpClientOptions, McpError, McpStdioClient } from '@ryharness/mcp'
import { afterEach, describe, expect, it } from 'vitest'

/** 假 server 的绝对路径：测试真的把它当子进程拉起来。 */
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))

const clients: McpStdioClient[] = []
const temps: string[] = []

afterEach(async () => {
  // 断言之外的无条件兜底：连接要是还活着，先收掉再走。
  // 一个孤儿进程会一直占着机器，红用例的代价远小于这个。
  while (clients.length > 0) {
    await clients.pop()?.close()
  }
  while (temps.length > 0) {
    const dir = temps.pop()
    if (dir === undefined) continue
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 被杀掉的子进程退出后，Windows 释放目录句柄会滞后一拍。
    }
  }
})

/** 起一条连着假 server 的连接。 */
function client(options: McpClientOptions = {}, env: Record<string, string> = {}): McpStdioClient {
  const created = new McpStdioClient('fake', { command: process.execPath, args: [FIXTURE], env }, options)
  clients.push(created)
  return created
}

/** 把失败原样抓下来，用来断言错误的种类与文案。 */
async function capture(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

/** 等日志文件里出现某段文字（子进程写文件与测试读之间有 race）。 */
async function waitForFile(path: string, needle: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (readFileSync(path, 'utf8').includes(needle)) return true
    } catch {
      // 文件还没建出来，继续等。
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
  }
  return false
}

describe('MCP stdio 客户端', () => {
  it('走完 initialize → tools/list → tools/call 一整条链路', async () => {
    const connection = client()
    const info = await connection.connect()
    expect(info.name).toBe('fake-mcp')
    expect(info.version).toBe('1.0.0')
    expect(info.protocolVersion).toBe('2024-11-05')
    expect(info.instructions).toBe('这是测试用的假 MCP server。')

    const tools = await connection.listTools()
    expect(tools.map((item) => item.name)).toContain('echo')
    expect(tools.find((item) => item.name === 'echo')?.inputSchema?.type).toBe('object')

    const result = await connection.callTool('echo', { text: '你好' })
    expect(result.isError).toBe(false)
    expect(result.content[0]?.text).toContain('你好')
  })

  it('server 自己报的失败，标记与内容都照收', async () => {
    const connection = client()
    await connection.connect()
    const result = await connection.callTool('boom', {})
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe('故意的失败原因')
  })

  it('不认识的工具拿到 JSON-RPC 错误，说法是人能读的', async () => {
    const connection = client()
    await connection.connect()
    const error = await capture(connection.callTool('nope', {}))
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ kind: 'request' })
    expect(error).toMatchObject({ message: expect.stringContaining('unknown tool: nope') })
  })

  it('超时报中文，不抛英文异常', async () => {
    const connection = client({ timeoutMs: 300 })
    await connection.connect()
    const error = await capture(connection.callTool('slow', {}))
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ kind: 'timeout' })
    expect(error).toMatchObject({ message: expect.stringContaining('300ms 内没有响应') })
  })

  it('超时会给 server 发取消通知', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ryharness-mcp-'))
    temps.push(dir)
    const log = join(dir, 'notify.log')
    const connection = client({ timeoutMs: 300 }, { MCP_FIXTURE_LOG: log })
    await connection.connect()
    await capture(connection.callTool('slow', {}))
    expect(await waitForFile(log, 'notifications/cancelled')).toBe(true)
  })

  it('调用方的取消信号能中断在途请求', async () => {
    const connection = client({ timeoutMs: 5_000 })
    await connection.connect()
    const controller = new AbortController()
    const pending = connection.callTool('slow', {}, { signal: controller.signal })
    setTimeout(() => {
      controller.abort()
    }, 50)
    const error = await capture(pending)
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ kind: 'cancelled' })
  })

  it('stdout 上出现非 JSON 就是协议违规', async () => {
    const connection = client({}, { MCP_FIXTURE_MODE: 'garbage' })
    const error = await capture(connection.connect())
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ kind: 'protocol' })
    expect(error).toMatchObject({ message: expect.stringContaining('协议出错') })
  })

  it('server 半路退出，连接以中文失败', async () => {
    const connection = client({}, { MCP_FIXTURE_MODE: 'exit' })
    const error = await capture(connection.connect())
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ kind: 'closed' })
  })

  it('命令不存在时说启动失败', async () => {
    const connection = new McpStdioClient('ghost', { command: 'ryharness-no-such-command-xyz' })
    clients.push(connection)
    const error = await capture(connection.connect())
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ kind: 'startup' })
  })

  it('stderr 的日志不混进协议流', async () => {
    const chunks: string[] = []
    const connection = client({
      onStderr: (text) => {
        chunks.push(text)
      },
    })
    const info = await connection.connect()
    expect(info.name).toBe('fake-mcp')
    expect(chunks.join('')).toContain('fake-mcp server 已启动')
    // 协议流照常可用：说明 stderr 没有污染 stdout。
    expect((await connection.listTools()).length).toBeGreaterThan(0)
  })

  it('资源与 prompt 都读得出来', async () => {
    const connection = client()
    await connection.connect()
    const resources = await connection.listResources()
    expect(resources[0]?.uri).toBe('file:///greeting.txt')
    const contents = await connection.readResource('file:///greeting.txt')
    expect(contents[0]?.text).toBe('资源正文')
    const prompts = await connection.listPrompts()
    expect(prompts[0]?.name).toBe('summarize')
  })

  it('关掉之后不再接受请求，重复关闭也没有副作用', async () => {
    const connection = client()
    await connection.connect()
    await connection.close()
    const error = await capture(connection.listTools())
    expect(error).toMatchObject({ kind: 'closed' })
    await connection.close()
  })

  it('握手拿到的身份与说明能从连接上读到', async () => {
    const connection = client()
    await connection.connect()
    expect(connection.serverInfo?.name).toBe('fake-mcp')
    expect(connection.instructions).toBe('这是测试用的假 MCP server。')
  })

  it('没连过就关掉也不报错', async () => {
    const connection = client()
    await connection.close()
  })

  it('关掉连接时，在途请求以「已关闭」失败', async () => {
    const connection = client({ timeoutMs: 5_000 })
    await connection.connect()
    const pending = connection.callTool('slow', {})
    // 先把处理器挂上再关：拒绝发生在 close() 里，晚一步挂就成了无人接管的 rejection。
    const captured = capture(pending)
    await connection.close()
    const error = await captured
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ kind: 'closed' })
  })

  it('连过一次之后再连就是错误', async () => {
    const connection = client()
    await connection.connect()
    const error = await capture(connection.connect())
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ kind: 'startup' })
  })

  it('关掉之后再连就是「已关闭」', async () => {
    const connection = client()
    await connection.connect()
    await connection.close()
    const error = await capture(connection.connect())
    expect(error).toMatchObject({ kind: 'closed' })
  })

  it('连接坏掉之后，后续请求直接吃同一个错', async () => {
    const connection = client({}, { MCP_FIXTURE_MODE: 'garbage' })
    await capture(connection.connect())
    const error = await capture(connection.listTools())
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ kind: 'protocol' })
  })

  it('信号已经取消的请求不发给 server', async () => {
    const connection = client()
    await connection.connect()
    const controller = new AbortController()
    controller.abort()
    const error = await capture(connection.callTool('echo', {}, { signal: controller.signal }))
    expect(error).toBeInstanceOf(McpError)
    expect(error).toMatchObject({ kind: 'cancelled' })
  })

  it('server 多发的空行、通知、陌生 id 都不影响正常回包', async () => {
    const connection = client()
    await connection.connect()
    // 假 server 在 tools/list 的回包前会掺三句噪音，这里确认它们被安静地忽略。
    const tools = await connection.listTools()
    expect(tools.map((item) => item.name)).toContain('echo')
  })
})

describe('子进程环境变量', () => {
  it('默认只给白名单里的，宿主私有的不外泄', () => {
    process.env.RYHARNESS_MCP_TEST_SECRET = 'leak-me'
    try {
      const env = buildChildEnv(undefined, false)
      const keys = Object.keys(env).map((key) => key.toUpperCase())
      expect(keys).toContain('PATH')
      expect(keys).not.toContain('RYHARNESS_MCP_TEST_SECRET')
    } finally {
      delete process.env.RYHARNESS_MCP_TEST_SECRET
    }
  })

  it('显式打开继承时宿主环境照传', () => {
    process.env.RYHARNESS_MCP_TEST_SECRET = 'leak-me'
    try {
      const env = buildChildEnv(undefined, true)
      expect(env.RYHARNESS_MCP_TEST_SECRET).toBe('leak-me')
    } finally {
      delete process.env.RYHARNESS_MCP_TEST_SECRET
    }
  })

  it('配置里写的环境变量盖过一切', () => {
    const env = buildChildEnv({ MCP_FIXTURE_MODE: 'normal' }, false)
    expect(env.MCP_FIXTURE_MODE).toBe('normal')
  })
})
