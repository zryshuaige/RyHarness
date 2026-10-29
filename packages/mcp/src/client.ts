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

import { type ChildProcess, spawn } from 'node:child_process'
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

/**
 * 子进程默认能看到的宿主环境变量白名单。
 *
 * 为什么不把 process.env 整个递过去：MCP server 是外部程序，它能读到哪些环境
 * 变量，就等于我们把哪些凭据递到了它手上（代理、token、云厂商的 key 都在里面）。
 * 白名单里的这几个是「跑起一个普通进程」真正需要的；其余要用的，由宿主在配置
 * 的 env 里显式写出来——显式写出来的东西，是人看过之后决定给的。
 */
const ENV_ALLOWLIST = new Set([
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SHELL',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TMPDIR',
  'TMP',
  'TEMP',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'LANG',
  'LC_ALL',
  'TZ',
  'NODE_PATH',
])

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
 * @param extra - 配置里显式写的环境变量（盖过一切）。
 * @param inherit - 是否把宿主环境变量整个带过去。
 */
export function buildChildEnv(
  extra: Record<string, string> | undefined,
  inherit: boolean,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  if (inherit) {
    Object.assign(env, process.env)
  } else {
    for (const [key, value] of Object.entries(process.env)) {
      // Windows 的环境变量名大小写不敏感，所以比对用大写形式。
      if (value === undefined || !ENV_ALLOWLIST.has(key.toUpperCase())) continue
      env[key] = value
    }
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    env[key] = value
  }
  return env
}

/** 一条 MCP stdio 连接。 */
export class McpStdioClient {
  readonly serverName: string
  private readonly config: McpServerConfig
  private readonly options: McpClientOptions
  private readonly pending = new Map<number, PendingRequest>()
  private readonly splitter = new LineSplitter()
  private child: ChildProcess | undefined
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
    const child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.options.cwd,
      env: buildChildEnv(this.config.env, this.options.inheritEnv === true),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // POSIX 下开新进程组：关连接时能一次把 server 及其子孙一起收掉，
      // 而不是只杀直接子进程、留下一堆还在跑的孙进程。
      detached: process.platform !== 'win32',
    })
    this.child = child
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
    this.child = undefined
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
    await terminateMcpProcess(child)
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

/**
 * 把 server 进程连同它的子孙收干净。
 *
 * 「收干净再返回」是硬要求：Windows 的 taskkill /T 是从父进程往下枚举的，父进程
 * 一先死，这棵树就再也拼不出来，里面的孙进程会以孤儿身份继续跑（用户机器 CPU
 * 被吃满就是这么来的）。POSIX 侧靠 spawn 时开出的进程组，一次带走整组。
 */
async function terminateMcpProcess(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  // 先把等待挂上再杀：'close' 事件是子进程退出后才发的，等杀完再挂就永远等不到。
  const closed = waitForChildClose(child)
  /* v8 ignore start -- 两个平台各走一条，只有当前平台那条会被跑到 */
  if (process.platform === 'win32') {
    const killed = await taskkillTree(pid)
    if (!killed) child.kill('SIGKILL')
    await closed
    return
  }
  try {
    // 负号表示整个进程组：server 自己拉起的子进程一起收掉。
    process.kill(-pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
  await closed
  /* v8 ignore stop */
}

/** Windows 上按父子关系强杀整棵树；进程已经不在、taskkill 自己卡住，都算失败。 */
function taskkillTree(pid: number, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    /* v8 ignore next 3 -- taskkill 不会卡住，这是兜底 */
    timer = setTimeout(() => {
      killer.kill('SIGKILL')
      resolve(false)
    }, timeoutMs)
    /* v8 ignore next -- taskkill 自己起不来时的兜底 */
    killer.on('error', () => {
      if (timer !== undefined) clearTimeout(timer)
      resolve(false)
    })
    killer.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

/** 等子进程的 'close'，但只等到时限：收尾不能无限期挂着。 */
function waitForChildClose(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(undefined)
    }, timeoutMs)
    child.once('close', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
}
