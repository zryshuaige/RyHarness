import { fileURLToPath } from 'node:url'
import { McpClientRegistry, McpError } from '@ryharness/mcp'
import { afterEach, describe, expect, it } from 'vitest'

/** 假 server 的绝对路径：登记处真的把它当子进程拉起来。 */
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))

const registries: McpClientRegistry[] = []

afterEach(async () => {
  while (registries.length > 0) {
    await registries.pop()?.close()
  }
})

/** 造一个登记处：连着假 server。 */
function registry(options: { requiresApproval?: boolean } = {}): McpClientRegistry {
  const created = new McpClientRegistry(options)
  registries.push(created)
  return created
}

/** 一个指向假 server 的配置。 */
function fixtureConfig(): { command: string; args: string[] } {
  return { command: process.execPath, args: [FIXTURE] }
}

describe('MCP 登记处', () => {
  it('登记 → 连接 → 拿到工具，名字按规则来', async () => {
    const mcp = registry()
    mcp.register('alpha', fixtureConfig())
    mcp.register('beta', fixtureConfig())
    const report = await mcp.connectAll()
    expect(report.connected).toEqual(['alpha', 'beta'])
    expect(report.failed).toEqual([])

    const names = mcp.tools().map((tool) => tool.name)
    expect(names).toContain('mcp__alpha__echo')
    expect(names).toContain('mcp__beta__echo')
    expect(names).toContain('mcp__alpha__weird_name_with_chars')
    expect(new Set(names).size).toBe(names.length)
  })

  it('两个 server 清洗后撞名时按序号分开', async () => {
    const mcp = registry()
    mcp.register('a b', fixtureConfig())
    mcp.register('a.b', fixtureConfig())
    await mcp.connectAll()
    const names = mcp.tools().map((tool) => tool.name)
    expect(names).toContain('mcp__a_b__echo')
    expect(names).toContain('mcp__a_b__echo__2')
    expect(new Set(names).size).toBe(names.length)
  })

  it('一个 server 起不来，不影响其他', async () => {
    const mcp = registry()
    mcp.register('good', fixtureConfig())
    mcp.register('bad', { command: 'ryharness-no-such-command-xyz' })
    const report = await mcp.connectAll()
    expect(report.connected).toEqual(['good'])
    expect(report.failed.map((item) => item.server)).toEqual(['bad'])
    expect(report.failed[0]?.reason).toContain('启动失败')
    expect(mcp.tools().length).toBeGreaterThan(0)
  })

  it('工具能真的调通，失败也是中文', async () => {
    const mcp = registry()
    mcp.register('alpha', fixtureConfig())
    await mcp.connectAll()
    const echo = mcp.tools().find((tool) => tool.name === 'mcp__alpha__echo')
    expect(echo).toBeDefined()
    const ok = await echo?.execute({ text: 'hi' }, { workspaceRoot: process.cwd() })
    expect(ok?.isError).toBeUndefined()
    expect(ok?.content).toContain('hi')

    const boom = mcp.tools().find((tool) => tool.name === 'mcp__alpha__boom')
    const failed = await boom?.execute({}, { workspaceRoot: process.cwd() })
    expect(failed?.isError).toBe(true)
    expect(failed?.content).toContain('MCP 工具「mcp__alpha__boom」执行失败')
  })

  it('审批开关由宿主决定', async () => {
    const mcp = registry({ requiresApproval: true })
    mcp.register('alpha', fixtureConfig())
    await mcp.connectAll()
    expect(mcp.tools().every((tool) => tool.requiresApproval === true)).toBe(true)
  })

  it('资源能列出来也能读成文本', async () => {
    const mcp = registry()
    mcp.register('alpha', fixtureConfig())
    await mcp.connectAll()
    const resources = await mcp.listResources()
    expect(resources[0]?.server).toBe('alpha')
    expect(resources[0]?.resource.uri).toBe('file:///greeting.txt')
    const text = await mcp.readResourceText('alpha', 'file:///greeting.txt')
    expect(text).toBe('资源正文')
  })

  it('二进制资源读成一句占位说明', async () => {
    const mcp = registry()
    mcp.register('alpha', fixtureConfig())
    await mcp.connectAll()
    const text = await mcp.readResourceText('alpha', 'file:///binary.bin')
    expect(text).toContain('[二进制资源 file:///binary.bin]')
  })

  it('server 报了两个同名工具时只暴露一个', async () => {
    const mcp = registry()
    mcp.register('alpha', { command: process.execPath, args: [FIXTURE], env: { MCP_FIXTURE_MODE: 'dupe' } })
    await mcp.connectAll()
    const names = mcp.tools().map((tool) => tool.name)
    expect(names.filter((name) => name === 'mcp__alpha__echo')).toHaveLength(1)
  })

  it('server 的 stderr 转给宿主', async () => {
    const chunks: string[] = []
    const mcp = new McpClientRegistry({
      onStderr: (server, text) => {
        chunks.push(`${server}:${text}`)
      },
    })
    registries.push(mcp)
    mcp.register('alpha', fixtureConfig())
    await mcp.connectAll()
    expect(chunks.join('')).toContain('alpha:')
  })

  it('没连接的 server 不能列资源', async () => {
    const mcp = registry()
    mcp.register('alpha', fixtureConfig())
    await expect(mcp.listResources('alpha')).rejects.toThrow(/没有连接/)
  })

  it('没连接的 server 不能读资源', async () => {
    const mcp = registry()
    mcp.register('alpha', fixtureConfig())
    await expect(mcp.readResource('alpha', 'file:///a')).rejects.toThrow(/没有连接/)
  })

  it('重复登记同一个 server 直接报错', () => {
    const mcp = registry()
    mcp.register('alpha', fixtureConfig())
    expect(() => mcp.register('alpha', fixtureConfig())).toThrow(McpError)
    expect(() => mcp.register('alpha', fixtureConfig())).toThrow(/已经登记过了/)
  })

  it('registerAll 能批量登记，没登记的连不了', async () => {
    const mcp = registry()
    mcp.registerAll({ servers: { a: fixtureConfig(), b: fixtureConfig() } })
    expect(mcp.serverNames()).toEqual(['a', 'b'])
    await expect(mcp.connect('c')).rejects.toThrow(/没有登记/)
  })

  it('关掉之后工具清空', async () => {
    const mcp = registry()
    mcp.register('alpha', fixtureConfig())
    await mcp.connectAll()
    expect(mcp.tools().length).toBeGreaterThan(0)
    await mcp.close()
    expect(mcp.tools()).toEqual([])
    expect(mcp.isConnected('alpha')).toBe(false)
  })
})
