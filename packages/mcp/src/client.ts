/**
 * MCP stdio 客户端：把一个外部 MCP server 变成一条能问能调的连接。
 *
 * 为什么自己写而不用官方 SDK：我们要的是「一条 stdio 连接 + 一句说得清的失败
 * 原因」——失败必须变成中文短句回给模型，而不是 SDK 抛出来的英文异常。能自己
 * 掌控的还有两件要紧的事：stderr 与 stdout 严格分开（server 打一行日志到 stdout
 * 就会把 JSON 解析带崩），以及关闭时把子进程连同它的子孙收干净。
 *
 * 协议层只做了 MCP 的 initialize / tools / resources / prompts 四组；分页、
 * 采样、roots 都不在射程内，见 README 的「没做的部分」。
 * @module @ryharness/mcp/client
 */

import type { ChildProcess } from 'node:child_process'
import { localProvider, type ManagedStreamProcess, scrubEnvironment, spawnManagedStream } from '@ryharness/subprocess'
import {
  readPromptDescriptors,
  readResourceContents,
  readResourceDescriptors,
  readServerInfo,
  readToolDescriptors,
  readToolResult,
} from './decode.ts'
import { McpError } from './errors.ts'
import { encodeLine, LineSplitter, parseLine } from './protocol.ts'
import type {
  McpPromptDescriptor,
  McpResourceContents,
  McpResourceDescriptor,
  McpServerConfig,
  McpServerInfo,
  McpToolDescriptor,
  McpToolResult,
} from './types.ts'

/** 单次请求的默认超时。 */
const DEFAULT_TIMEOUT_MS = 10_000

/** 请求的默认协议版本；server 不同意时会回它自己支持的版本，这里不较劲。 */
const DEFAULT_PROTOCOL_VERSION = '2024-11-05'

/** stderr 只留这么多字符——它只是失败时的佐证，不是日志存档。 */
const STDERR_KEEP_CHARS = 4_000

/** 客户端的构造选项。 */
export interface McpClientOptions {
  /** 单次请求超时（毫秒），默认 10000。 */
  timeoutMs?: number
  /** 子进程的工作目录；缺省用宿主当前目录。 */
  cwd?: string
  /** initialize 时请求的协议版本。 */
  protocolVersion?: string
  /** initialize 里报给 server 的客户端名。 */
  clientName?: string
  /** initialize 里报给 server 的客户端版本。 */
  clientVersion?: string
  /** true = 把宿主环境变量整个传给子进程（默认只给白名单）。 */
  inheritEnv?: boolean
  /** server 的 stderr 回调：日志不能混进协议流，但也不该全丢。 */
  onStderr?: (text: string) => void
}

/** 一个在途请求。 */
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: McpError) => void
  /** 清计时器、摘监听器。 */
  cleanup: () => void
}

/**
 * 组装子进程的环境变量。
 *
 * **两条路**：
 * - `inherit: true` → 宿主环境**整个**带过去（用户显式要求的，配置里写明了的）；
 * - `inherit: false`（缺省）→ 走 `@ryharness/subprocess` 的 `scrubEnvironment`：
 *   白名单之外的一律不传，名字像密钥的（`*_API_KEY` / `*_TOKEN` 之类）也不传。
 *
 * MCP 服务器是**模型能触发启动**的进程，宿主环境里的模型服务 key 不该跟着
 * 进去；但用户显式说「继承」时是他的选择，不替他做主。
 *
 * @param extra - 配置里显式写的环境变量（盖过一切）。
 * @param inherit - 是否把宿主环境变量整个带过去。
 */
export function buildChildEnv(
  extra: Record<string, string> | undefined,
  inherit: boolean,
): Record<string, string | undefined> {
  if (inherit) {
    const env: Record<string, string | undefined> = { ...process.env }
    for (const [key, value] of Object.entries(extra ?? {})) env[key] = value
    return env
  }
  const scrubbed = scrubEnvironment({
    base: process.env,
    ...(extra === undefined ? {} : { extra }),
  })
  return scrubbed.env
}

/** 一条 MCP stdio 连接。 */
export class McpStdioClient {
  readonly serverName: string
  private readonly config: McpServerConfig
  private readonly options: McpClientOptions
  private readonly pending = new Map<number, PendingRequest>()
  private readonly splitter = new LineSplitter()
  private child: ChildProcess | undefined
  /** 托管句柄：关连接时用它把整棵进程树收掉。 */
  private managed: ManagedStreamProcess | undefined
  private nextId = 1
  private info: McpServerInfo | undefined
  private closed = false
  private fatal: McpError | undefined
  /** stderr 的尾巴：server 突然没了时，这是唯一能说清「它临死前说了什么」的线索。 */
  private stderrTail = ''

  constructor(serverName: string, config: McpServerConfig, options: McpClientOptions = {}) {
    this.serverName = serverName
    this.config = config
    this.options = options
  }

  /** initialize 拿到的服务端信息；没连上就是 undefined。 */
  get serverInfo(): McpServerInfo | undefined {
    return this.info
  }

  /** server 自述的使用说明（initialize 结果里的 instructions）。 */
  get instructions(): string | undefined {
    return this.info?.instructions
  }

  /**
   * 起进程并完成 initialize 握手。
   *
   * 握手失败会抛 {@link McpError}，而不是把英文异常原样带出去——这条消息最后
   * 会进模型上下文。
   */
  async connect(): Promise<McpServerInfo> {
    if (this.closed) {
      throw new McpError('closed', this.serverName, `MCP 服务器「${this.serverName}」的连接已关闭`)
    }
    if (this.child !== undefined) {
      throw new McpError('startup', this.serverName, `MCP 服务器「${this.serverName}」已经连接过了`)
    }
    const managed = spawnManagedStream(localProvider, {
      command: this.config.command,
      args: this.config.args ?? [],
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      env: buildChildEnv(this.config.env, this.options.inheritEnv === true),
      label: `mcp:${this.config.command}`,
    })
    const child = managed.child
    this.child = child
    this.managed = managed
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      this.onStdout(chunk)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.onStderr(chunk)
    })
    // server 先退时写 stdin 会 EPIPE：这条错误没有可恢复的动作，吞掉即可，
    // 真正的失败原因会由 exit 事件给出。
    /* v8 ignore next -- 管道真的断掉时才会触发，测不准 */
    child.stdin?.on('error', () => undefined)
    child.on('error', (error: Error) => {
      this.failAll(
        new McpError('startup', this.serverName, `MCP 服务器「${this.serverName}」启动失败：${error.message}`),
      )
    })
    child.on('exit', (code, signal) => {
      const tail = this.stderrTail.trim()
      const detail = tail.length === 0 ? '' : `；它最后说了：${tail}`
      this.failAll(
        new McpError(
          'closed',
          this.serverName,
          `MCP 服务器「${this.serverName}」已经退出（退出码 ${code ?? '无'}，信号 ${signal ?? '无'}）${detail}`,
        ),
      )
    })

    const result = await this.request('initialize', {
      protocolVersion: this.options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: this.options.clientName ?? 'ryharness',
        version: this.options.clientVersion ?? '0.2.0',
      },
    })
    this.notify('notifications/initialized', {})
    this.info = readServerInfo(result, this.serverName)
    return this.info
  }

  /** 列出 server 提供的工具。 */
  async listTools(): Promise<McpToolDescriptor[]> {
    return readToolDescriptors(await this.request('tools/list', {}))
  }

  /** 调用一个工具。 */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<McpToolResult> {
    const result = await this.request('tools/call', { name, arguments: args }, options?.signal)
    return readToolResult(result, this.serverName)
  }

  /** 列出 server 提供的资源。 */
  async listResources(): Promise<McpResourceDescriptor[]> {
    return readResourceDescriptors(await this.request('resources/list', {}))
  }

  /** 读一个资源。 */
  async readResource(uri: string): Promise<McpResourceContents[]> {
    return readResourceContents(await this.request('resources/read', { uri }))
  }

  /** 列出 server 提供的 prompt。 */
  async listPrompts(): Promise<McpPromptDescriptor[]> {
    return readPromptDescriptors(await this.request('prompts/list', {}))
  }

  /** 断开连接并收掉子进程。重复调用没有副作用。 */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const requests = [...this.pending.values()]
    this.pending.clear()
    for (const request of requests) {
      request.cleanup()
      request.reject(new McpError('closed', this.serverName, `MCP 服务器「${this.serverName}」的连接已关闭`))
    }
    const child = this.child
    const managed = this.managed
    this.child = undefined
    this.managed = undefined
    if (child === undefined) return
    child.stdout?.removeAllListeners('data')
    child.stderr?.removeAllListeners('data')
    child.removeAllListeners('exit')
    child.removeAllListeners('error')
    // 先关 stdin：多数 MCP server 收到 EOF 就自己退，干净。
    try {
      child.stdin?.end()
    } catch {
      // 管道已经断了，关不上也无所谓——下面照样杀。
    }
    // 收整棵树：server 自己会拉起子进程，只杀直接子进程会留下它们继续跑。
    // 树回收交给 `@ryharness/subprocess`（全仓库只有那一处实现）。
    await managed?.kill('MCP 连接关闭')
  }

  /** stdout 上的一行到了：要么是回包，要么是协议违规。 */
  private onStdout(chunk: string): void {
    for (const line of this.splitter.push(chunk)) {
      if (line.trim().length === 0) continue
      const parsed = parseLine(line)
      if (!parsed.ok) {
        // stdout 上只允许 JSON-RPC 消息：这里出现别的东西就是协议违规。
        // 继续猜下去只会让每个请求都超时，不如立刻把话说清楚。
        this.failAll(
          new McpError('protocol', this.serverName, `MCP 服务器「${this.serverName}」协议出错：${parsed.reason}`),
        )
        continue
      }
      this.dispatch(parsed.message)
    }
  }

  /** stderr 只留尾巴备查，绝不混进协议流。 */
  private onStderr(chunk: string): void {
    this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_KEEP_CHARS)
    this.options.onStderr?.(chunk)
  }

  /** 把一条回包交给在途请求。 */
  private dispatch(message: {
    id: number | string | null
    result?: unknown
    error?: { code: number; message: string }
  }): void {
    if (typeof message.id !== 'number') return
    const request = this.pending.get(message.id)
    if (request === undefined) return
    this.pending.delete(message.id)
    request.cleanup()
    if (message.error !== undefined) {
      request.reject(
        new McpError(
          'request',
          this.serverName,
          `MCP 服务器「${this.serverName}」返回错误（代码 ${message.error.code}）：${message.error.message}`,
        ),
      )
      return
    }
    request.resolve(message.result)
  }

  /** 连接彻底坏了：在途请求全部以同一句话失败。 */
  private failAll(error: McpError): void {
    this.fatal = error
    const requests = [...this.pending.values()]
    this.pending.clear()
    for (const request of requests) {
      request.cleanup()
      request.reject(error)
    }
  }

  /** 发一个请求并等回包。 */
  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new McpError('closed', this.serverName, `MCP 服务器「${this.serverName}」的连接已关闭`))
    }
    if (this.fatal !== undefined) return Promise.reject(this.fatal)
    if (signal?.aborted === true) {
      return Promise.reject(new McpError('cancelled', this.serverName, `MCP 服务器「${this.serverName}」的调用被取消`))
    }
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.notify('notifications/cancelled', { requestId: id, reason: 'timeout' })
        reject(
          new McpError(
            'timeout',
            this.serverName,
            `MCP 服务器「${this.serverName}」在 ${timeoutMs}ms 内没有响应（${method}）`,
          ),
        )
      }, timeoutMs)
      const onAbort = (): void => {
        this.pending.delete(id)
        this.notify('notifications/cancelled', { requestId: id, reason: 'cancelled' })
        reject(new McpError('cancelled', this.serverName, `MCP 服务器「${this.serverName}」的调用被取消（${method}）`))
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { resolve, reject, cleanup })
      // 管道已经没了的话，写下去只会换来一个 EPIPE；这时说清楚比事后报错强。
      /* v8 ignore next 3 -- 只在进程刚死的那一瞬发生，测不准 */
      if (!this.write({ jsonrpc: '2.0', id, method, params })) {
        this.pending.delete(id)
        cleanup()
        reject(new McpError('closed', this.serverName, `MCP 服务器「${this.serverName}」的输入管道已经关闭`))
      }
    })
  }

  /** 发一个通知（没有 id，不等回包）。写不进去就算了，不该盖住真正的错误。 */
  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** 往 stdin 写一行；管道已经没了就返回 false。 */
  private write(payload: unknown): boolean {
    const child = this.child
    if (child === undefined || child.stdin === null || child.stdin.destroyed) return false
    child.stdin.write(encodeLine(payload))
    return true
  }
}
