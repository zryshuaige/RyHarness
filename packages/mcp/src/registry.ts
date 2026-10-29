/**
 * MCP 连接登记处：把一份配置变成一批可调用的工具。
 *
 * 这一层只管「谁连着、有什么工具」；工具怎么被模型用上、要不要过审批，由宿主
 * 决定——所以这里既不注册 cordis 服务，也不碰工具注册表：本包给的是数据与对象，
 * 装配留给上层。
 * @module @ryharness/mcp/registry
 */

import type { Tool } from '@ryharness/agent'
import { McpStdioClient } from './client.ts'
import { describeFailure, McpError } from './errors.ts'
import { assignMcpToolNames, type McpToolRef, mcpToolName, mcpToolRefKey } from './naming.ts'
import { createMcpTool } from './tools.ts'
import type {
  McpConfig,
  McpResourceContents,
  McpResourceDescriptor,
  McpServerConfig,
  McpServerInfo,
  McpToolDescriptor,
} from './types.ts'

/**
 * 一个 server 报了两个同名工具时，留第一个。
 *
 * 工具名是模型唯一能看见的标识：两个同名工具挑哪个全看运气，这次调了慢的那个、
 * 下次调了快的那个，回放出来就是两种行为。畸形数据，扔掉后来的。
 */
function dedupeDescriptors(descriptors: readonly McpToolDescriptor[]): McpToolDescriptor[] {
  const unique = new Map<string, McpToolDescriptor>()
  for (const descriptor of descriptors) {
    if (!unique.has(descriptor.name)) unique.set(descriptor.name, descriptor)
  }
  return [...unique.values()]
}

/** 登记处的构造选项。 */
export interface McpRegistryOptions {
  /** 单次请求超时（毫秒），默认 10000。 */
  timeoutMs?: number
  /** server 子进程的工作目录；缺省用宿主当前目录。 */
  cwd?: string
  /** initialize 时请求的协议版本。 */
  protocolVersion?: string
  /** initialize 里报给 server 的客户端名。 */
  clientName?: string
  /** initialize 里报给 server 的客户端版本。 */
  clientVersion?: string
  /** true = 把宿主环境变量整个传给 server（默认只给白名单）。 */
  inheritEnv?: boolean
  /** true = 每次调用 MCP 工具都要用户点头。 */
  requiresApproval?: boolean
  /** server 的 stderr 回调。 */
  onStderr?: (serverName: string, text: string) => void
}

/** 一次连接失败的记录。 */
export interface McpConnectFailure {
  server: string
  /** 人能读懂的失败原因。 */
  reason: string
}

/** 批量连接的结果。 */
export interface McpConnectReport {
  connected: string[]
  failed: McpConnectFailure[]
}

/** 一条资源，带上它来自哪个 server。 */
export interface McpResourceEntry {
  server: string
  resource: McpResourceDescriptor
}

/**
 * MCP server 的登记处。
 *
 * 一个 server 坏了不该连累其他：批量连接时每个 server 各自成败，失败原因被收
 * 进报告里，而不是把整个登记处拖下水。
 */
export class McpClientRegistry {
  private readonly options: McpRegistryOptions
  private readonly configs = new Map<string, McpServerConfig>()
  private readonly clients = new Map<string, McpStdioClient>()
  private readonly descriptors = new Map<string, McpToolDescriptor[]>()
  private cache: Tool[] | undefined

  constructor(options: McpRegistryOptions = {}) {
    this.options = options
  }

  /** 登记一个 server 的配置（不连接）。 */
  register(name: string, config: McpServerConfig): void {
    if (this.configs.has(name)) {
      throw new McpError('request', name, `MCP server「${name}」已经登记过了`)
    }
    this.configs.set(name, config)
  }

  /** 批量登记一份配置。 */
  registerAll(config: McpConfig): void {
    for (const [name, server] of Object.entries(config.servers)) {
      this.register(name, server)
    }
  }

  /** 已登记的 server 名（登记顺序）。 */
  serverNames(): string[] {
    return [...this.configs.keys()]
  }

  /** 某个 server 是否已经连上。 */
  isConnected(name: string): boolean {
    return this.clients.has(name)
  }

  /**
   * 连接一个 server 并取回它的工具清单。
   *
   * 失败时会把刚起的进程收掉再把错误抛出去——连接失败最常见的形态就是「进程
   * 起来了但握手没成」，不收就留了个孤儿在那儿占着端口。
   */
  async connect(name: string): Promise<McpServerInfo> {
    const config = this.configs.get(name)
    if (config === undefined) {
      throw new McpError('request', name, `MCP server「${name}」没有登记`)
    }
    const client = new McpStdioClient(name, config, {
      timeoutMs: this.options.timeoutMs,
      cwd: this.options.cwd,
      protocolVersion: this.options.protocolVersion,
      clientName: this.options.clientName,
      clientVersion: this.options.clientVersion,
      inheritEnv: this.options.inheritEnv,
      onStderr:
        this.options.onStderr === undefined
          ? undefined
          : (text) => {
              this.options.onStderr?.(name, text)
            },
    })
    try {
      const info = await client.connect()
      const descriptors = await client.listTools()
      this.clients.set(name, client)
      this.descriptors.set(name, dedupeDescriptors(descriptors))
      this.cache = undefined
      return info
    } catch (error) {
      await client.close()
      throw error
    }
  }

  /**
   * 连接全部已登记的 server。
   *
   * 每个 server 各自成败：一个 MCP server 挂了（比如命令写错、没装），其余
   * server 的工具照常可用，失败原因进报告里给宿主看。
   */
  async connectAll(): Promise<McpConnectReport> {
    const names = this.serverNames()
    const results = await Promise.all(
      names.map(async (name) => {
        try {
          await this.connect(name)
          return { ok: true as const, name }
        } catch (error) {
          return { ok: false as const, name, reason: describeFailure(error) }
        }
      }),
    )
    const connected: string[] = []
    const failed: McpConnectFailure[] = []
    for (const result of results) {
      if (result.ok) connected.push(result.name)
      else failed.push({ server: result.name, reason: result.reason })
    }
    return { connected, failed }
  }

  /**
   * 所有已连接 server 的工具。
   *
   * 名字按命名规则生成并跨 server 去重，所以这一批名字全局唯一；同一个 server
   * 连两次不会产生两份工具。
   */
  tools(): Tool[] {
    if (this.cache !== undefined) return [...this.cache]
    const refs: McpToolRef[] = []
    for (const [server, list] of this.descriptors) {
      for (const descriptor of list) {
        refs.push({ server, tool: descriptor.name })
      }
    }
    const names = assignMcpToolNames(refs)
    const tools: Tool[] = []
    for (const [server, list] of this.descriptors) {
      const client = this.clients.get(server)
      /* v8 ignore next -- descriptors 与 clients 同进同出，这条分支走不到 */
      if (client === undefined) continue
      for (const descriptor of list) {
        const name = names.get(mcpToolRefKey({ server, tool: descriptor.name })) ?? mcpToolName(server, descriptor.name)
        tools.push(
          createMcpTool({
            name,
            server,
            remoteName: descriptor.name,
            descriptor,
            requiresApproval: this.options.requiresApproval,
            invoke: (args, ctx) => client.callTool(descriptor.name, args, { signal: ctx.signal }),
          }),
        )
      }
    }
    this.cache = tools
    return [...tools]
  }

  /**
   * 列出资源；不给 server 名就是全部已连接的。
   *
   * 资源不进模型的工具列表：资源是「按需读」的东西，全塞进工具描述会让每次
   * 调用的提示词都长一截，而模型通常只用到其中一两个。
   */
  async listResources(serverName?: string): Promise<McpResourceEntry[]> {
    const names = serverName === undefined ? [...this.clients.keys()] : [serverName]
    const entries: McpResourceEntry[] = []
    for (const name of names) {
      const client = this.clients.get(name)
      if (client === undefined) {
        throw new McpError('closed', name, `MCP server「${name}」没有连接`)
      }
      for (const resource of await client.listResources()) {
        entries.push({ server: name, resource })
      }
    }
    return entries
  }

  /** 读一个资源。 */
  async readResource(serverName: string, uri: string): Promise<McpResourceContents[]> {
    const client = this.clients.get(serverName)
    if (client === undefined) {
      throw new McpError('closed', serverName, `MCP server「${serverName}」没有连接`)
    }
    return client.readResource(uri)
  }

  /** 把一个资源读成一段文本；二进制资源只留一句占位说明。 */
  async readResourceText(serverName: string, uri: string): Promise<string> {
    const contents = await this.readResource(serverName, uri)
    const parts = contents.map((item) => {
      if (item.text !== undefined) return item.text
      const mime = item.mimeType === undefined ? '' : `（${item.mimeType}）`
      return `[二进制资源 ${item.uri}${mime}]`
    })
    return parts.join('\n')
  }

  /** 关掉全部连接并收掉子进程。 */
  async close(): Promise<void> {
    const clients = [...this.clients.values()]
    this.clients.clear()
    this.descriptors.clear()
    this.cache = undefined
    await Promise.all(clients.map((client) => client.close()))
  }
}
