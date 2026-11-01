/**
 * 一条到语言服务器的连接：子进程 + 帧协议 + JSON-RPC 2.0。
 *
 * 这一层只管「把字节变成请求与回包」，**不懂 LSP 语义**——`initialize` 是什么、
 * `textDocument/definition` 怎么拼参数，那是 provider 的事。分开是为了让协议层
 * 能被单独测：喂进半帧、乱帧、进程半路死，这些都能在不理解语义的情况下测。
 *
 * 失败的处理只有一个原则：**一条坏消息不要拖垮整条连接，但也不许装作没看见**。
 * - 帧解不出来（缺 Content-Length、正文不是 JSON）→ 这条连接已经不可信了，
 *   把它判死，在途请求全部以协议错误失败；
 * - 进程死了 → 在途请求全部以「服务器没了」失败；
 * - 服务器回了一个错误 → 只影响那一个请求。
 * @module @ryharness/lsp/connection
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { LspError } from './errors.ts'
import { encodeFrame, LspFrameDecoder } from './framing.ts'
import { planSpawn } from './spawn.ts'

/** 进程退出时带给外部的信息。 */
export interface LspExitInfo {
  /** 退出码；被信号杀掉时是 null。 */
  readonly code: number | null
  /** 结束它的信号；正常退出是 null。 */
  readonly signal: NodeJS.Signals | null
}

/** 一条连接的构造选项。 */
export interface LspConnectionOptions {
  /** 要跑的命令（语言服务器）。 */
  readonly command: string
  /** 命令的参数；不配就是空参数。 */
  readonly args?: readonly string[]
  /** 子进程的工作目录。 */
  readonly cwd?: string
  /** 追加的环境变量（同名的覆盖继承来的）。 */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** stderr 的回调：日志不能混进协议流，但也不该全丢。 */
  readonly onStderr?: (text: string) => void
  /** 进程退出时的回调。 */
  readonly onExit?: (info: LspExitInfo) => void
}

/**
 * 收尾时等进程自己退出的时限（毫秒）；到点就强杀。
 *
 * 强杀的时限必须**比**等待的时限短，否则两个计时器同一刻到点：等待的那个先把
 * 「关好了」交出去，强杀的那个还没来得及动手——于是「到点就强杀」这句话是假的，
 * 那个不退的进程会一直活着。两个时限差开半秒，强杀才真的发生。
 */
const CLOSE_GRACE_MS = 2_000

/** 等进程退出最多等这么久（比强杀晚半秒，给强杀留出动手的余地）。 */
const CLOSE_WAIT_MS = CLOSE_GRACE_MS + 500

/** 一个在途请求。 */
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: LspError) => void
  /** 清计时器。 */
  cleanup: () => void
}

/** 是不是一个普通对象（不是数组、不是 null）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读一个字符串；不是字符串就返回 undefined。 */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 把 spawn 的失败翻译成一句能给人看的话。
 *
 * 「命令不在 PATH 上」与「命令在但起不来」是两回事：前者是**没装**，后者是**装坏
 * 了**。混成一句话，用户就会去重装一个其实已经装好的东西。
 * @param command - 配置里写的命令。
 * @param code - 操作系统给的错误码（`ENOENT` 之类）。
 * @param message - 操作系统给的错误说明。
 * @returns 结构化失败。
 */
export function describeSpawnError(command: string, code: string | undefined, message: string): LspError {
  if (code === 'ENOENT') {
    return new LspError(
      'command-not-found',
      `找不到这个语言服务器命令：${command}。请先装上它，或者把配置里的命令改成实际可用的路径。`,
    )
  }
  return new LspError('server-unavailable', `语言服务器启动失败：${message}`)
}

/**
 * 一条到语言服务器的连接。
 *
 * 连接是**懒**的：构造它不会起进程，`start()` 才起。这样 provider 可以先把
 * 「配置对不对」与「服务器在不在」这两件事分开说。
 */
export class LspConnection {
  private readonly options: LspConnectionOptions
  private readonly decoder = new LspFrameDecoder()
  private readonly pending = new Map<number, PendingRequest>()
  private child: ChildProcess | undefined
  private nextId = 1
  /** 判死之后的错误：在途请求与后续请求都以它失败。 */
  private fatal: LspError | undefined
  /** 是不是我们主动关的：主动关的不算「崩了」。 */
  private closedByUs = false
  /** stderr 的尾巴：服务器突然没了时，这是唯一能说清「它临死前说了什么」的线索。 */
  private stderrTail = ''

  constructor(options: LspConnectionOptions) {
    this.options = options
  }

  /** 连接是不是已经判死（起不来、崩了、协议乱了）。 */
  get dead(): boolean {
    return this.fatal !== undefined
  }

  /** 判死的原因；没判死就是 undefined。 */
  get failure(): LspError | undefined {
    return this.fatal
  }

  /**
   * 起进程。
   *
   * 命令不存在时不会在这里抛——`spawn` 的失败是异步事件，真正的失败要等到
   * 第一个请求超时的瞬间才浮上来，那条路径会把 `command-not-found` 说清楚。
   */
  start(): void {
    if (this.child !== undefined) return
    const plan = planSpawn(this.options.command, this.options.args ?? [])
    const child = spawn(plan.command, plan.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => {
      this.onStdout(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.onStderr(chunk)
    })
    // 服务器先退时写 stdin 会 EPIPE：这条错误没有可恢复的动作，真正的失败原因
    // 会由 exit 事件给出，这里吞掉即可。
    /* v8 ignore next 2 -- 管道真的断掉时才会触发，测不准 */
    child.stdin?.on('error', () => undefined)
    child.on('error', (error: NodeJS.ErrnoException) => {
      this.fail(this.spawnFailure(error))
    })
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // 我们自己关的连接不算「崩了」：那句话说出去会让人以为语言服务器自己挂了。
      if (!this.closedByUs) {
        this.fail(
          new LspError('server-unavailable', `语言服务器进程已退出（退出码 ${code ?? '无'}，信号 ${signal ?? '无'}）`),
        )
      }
      this.options.onExit?.({ code, signal })
    })
  }

  /**
   * 发一个请求并等回包。
   *
   * @param method - 方法名，例如 `textDocument/definition`。
   * @param params - 参数。
   * @param timeoutMs - 等多久（毫秒）。
   * @returns 服务器回的 `result`。
   */
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.fatal !== undefined) return Promise.reject(this.fatal)
    if (this.child === undefined) {
      return Promise.reject(new LspError('server-unavailable', '语言服务器进程还没起来'))
    }
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new LspError('timeout', `语言服务器在 ${timeoutMs}ms 内没有响应（${method}）`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer)
        },
      })
      if (!this.write({ jsonrpc: '2.0', id, method, params })) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new LspError('server-unavailable', '语言服务器的输入管道已经关闭'))
      }
    })
  }

  /**
   * 发一个通知（没有 id，不等回包）。
   *
   * 写不进去就算了——通知都是「顺带告诉对方一声」，盖住真正的错误更糟。
   * @param method - 方法名。
   * @param params - 参数。
   */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  /**
   * 关掉连接：先关 stdin（多数服务器收到 EOF 就自己退），再等它退；到点就强杀。
   *
   * 这是**我们**关的连接，所以它不算「崩了」：在途请求以「连接已关闭」失败，
   * 而不是以「进程已退出」失败——后者会让人以为语言服务器自己挂了。
   */
  async close(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.closedByUs = true
    this.fail(new LspError('server-unavailable', '语言服务器连接已经关闭'))
    if (child === undefined) return
    try {
      child.stdin?.end()
    } catch {
      // 管道已经断了，关不上也无所谓——下面照样杀。
    }
    const closed = waitForClose(child, CLOSE_WAIT_MS)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, CLOSE_GRACE_MS)
    try {
      await closed
    } finally {
      clearTimeout(timer)
    }
  }

  /** stdout 上来了一段字节：拆帧、解析、分发。 */
  private onStdout(chunk: Buffer): void {
    let frames: string[]
    try {
      frames = this.decoder.push(chunk)
    } catch (error) {
      this.fail(error instanceof LspError ? error : new LspError('protocol-error', '帧解析失败'))
      return
    }
    for (const frame of frames) {
      let parsed: unknown
      try {
        parsed = JSON.parse(frame)
      } catch {
        this.fail(new LspError('protocol-error', '语言服务器发来的不是合法 JSON'))
        return
      }
      this.dispatch(parsed)
    }
  }

  /** stderr 只留尾巴备查，绝不混进协议流。 */
  private onStderr(chunk: Buffer): void {
    const text = chunk.toString('utf8')
    this.stderrTail = `${this.stderrTail}${text}`.slice(-4_000)
    this.options.onStderr?.(text)
  }

  /** 把一条消息交给在途请求。 */
  private dispatch(message: unknown): void {
    if (!isRecord(message)) return
    const id = message.id
    // 没有 id 的是通知：服务器主动发来的，我们用不上，忽略即可。
    if (typeof id !== 'number') return
    const request = this.pending.get(id)
    if (request === undefined) return
    this.pending.delete(id)
    request.cleanup()
    const rawError = message.error
    if (isRecord(rawError)) {
      const code = typeof rawError.code === 'number' ? rawError.code : undefined
      const detail = readString(rawError.message) ?? '服务器没有说明错误原因'
      request.reject(new LspError('request-failed', `语言服务器返回错误（代码 ${code ?? '未知'}）：${detail}`))
      return
    }
    request.resolve(message.result)
  }

  /** 往 stdin 写一帧；管道已经没了就返回 false。 */
  private write(payload: unknown): boolean {
    const child = this.child
    if (child === undefined || child.stdin === null || child.stdin.destroyed) return false
    child.stdin.write(encodeFrame(payload))
    return true
  }

  /** 把 spawn 的失败翻译成一句能给人看的话。 */
  private spawnFailure(error: NodeJS.ErrnoException): LspError {
    return describeSpawnError(this.options.command, error.code, error.message)
  }

  /** 连接判死：在途请求全部以同一句话失败。 */
  private fail(error: LspError): void {
    // 第一次失败才是原因：后面的失败（进程退出、管道关闭）都是它的后果。
    if (this.fatal !== undefined) return
    this.fatal = error
    const requests = [...this.pending.values()]
    this.pending.clear()
    for (const request of requests) {
      request.cleanup()
      request.reject(error)
    }
  }
}

/**
 * 等子进程真的退出，但只等到时限：收尾不能无限期挂着。
 * @param child - 子进程句柄。
 * @param timeoutMs - 最长等多久。
 * @returns 进程退出（或时限到）后 resolve。
 */
function waitForClose(child: ChildProcess, timeoutMs: number): Promise<void> {
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
