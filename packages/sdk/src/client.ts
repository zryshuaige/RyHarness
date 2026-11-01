/**
 * 进程外 SDK 的客户端：起一个子进程，用 JSON-RPC 跟它说话。
 *
 * 线协议与网关**同一套**（JSON-RPC 2.0 + 按行分帧），从 `@ryharness/api` 转出
 * 来的，不另写一份——这样「进程内的 Remote 层」与「进程外的 SDK」说的是同
 * 一种话。
 *
 * 三件容易被忽略的事，这里都管了：
 *
 * 1. **进程没了**：请求挂在半路时子进程退出，挂起的请求要立刻失败，不能等到
 *    超时。
 * 2. **收干净**：`close()` 会先请子进程自己收尾，等不到再杀——不留下孤儿进程。
 * 3. **stderr**：子进程写到 stderr 的东西留一份，失败时能看出它临死前说了什么。
 * @module @ryharness/sdk/client
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { JsonRpcPeer, type RpcTransport } from '@ryharness/api'
import { processExitFailure, spawnFailedFailure } from './errors.ts'

/** 子进程的退出信息。 */
export interface SdkExit {
  /** 退出码；被信号打死时是 null。 */
  readonly code: number | null
  /** 结束它的信号；正常退出时是 null。 */
  readonly signal: string | null
}

/** 客户端的构造选项。 */
export interface SdkClientOptions {
  /** 可执行文件。 */
  readonly command: string
  /** 参数。 */
  readonly args?: readonly string[]
  /** 工作目录。 */
  readonly cwd?: string
  /** 环境变量。**不给就继承当前进程的**；给了就是完整的一份（不继承）。 */
  readonly env?: Readonly<Record<string, string>>
  /** 单次请求的默认超时（毫秒）。不给就是没有超时。 */
  readonly timeoutMs?: number
  /** 收尾时等子进程自己退出的时间（毫秒）。 */
  readonly closeTimeoutMs?: number
}

/** 一次请求的附加选项。 */
export interface SdkRequestOptions {
  /** 这一次的超时（毫秒）。 */
  readonly timeoutMs?: number
  /** 取消信号。 */
  readonly signal?: AbortSignal
}

/**
 * 子进程的标准输入输出包成的传输。
 *
 * 数据可能在回调注册之前就到（子进程回话很快的时候），所以先存着，等回调来
 * 了再倒给它。
 */
class StdioTransport implements RpcTransport {
  private readonly child: ChildProcess
  private dataHandler: ((chunk: string) => void) | undefined
  private closeHandler: ((reason: string) => void) | undefined
  private closeReason: string | undefined
  private readonly buffered: string[] = []

  /**
   * @param child - 子进程。
   */
  constructor(child: ChildProcess) {
    this.child = child
    const stdout = child.stdout
    stdout?.setEncoding('utf8')
    stdout?.on('data', (chunk: string) => {
      if (this.dataHandler === undefined) {
        this.buffered.push(chunk)
        return
      }
      this.dataHandler(chunk)
    })
    child.on('error', (error: Error) => {
      this.finish(`子进程出错：${error.message}`)
    })
    child.on('exit', (code, signal) => {
      this.finish(`子进程已退出（${code ?? '未知'}${signal === null ? '' : `，信号 ${signal}`}）`)
    })
  }

  /**
   * 写出一段文本。
   * @param chunk - 文本。
   */
  write(chunk: string): void {
    if (this.closeReason !== undefined) return
    this.child.stdin?.write(chunk)
  }

  /**
   * 注册收数据的回调。
   * @param handler - 回调。
   */
  onData(handler: (chunk: string) => void): void {
    this.dataHandler = handler
    for (const chunk of this.buffered.splice(0)) handler(chunk)
  }

  /**
   * 注册连接断开的回调。
   * @param handler - 回调。
   */
  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler
    if (this.closeReason !== undefined) handler(this.closeReason)
  }

  /**
   * 收尾：把 stdin 关掉，请子进程自己结束。
   */
  close(): void {
    this.child.stdin?.end()
  }

  /**
   * 断开并记下原因。
   * @param reason - 断开原因。
   */
  private finish(reason: string): void {
    if (this.closeReason !== undefined) return
    this.closeReason = reason
    this.closeHandler?.(reason)
  }
}

/**
 * 判断一个失败是不是「连接断了」。
 * @param error - 任意异常。
 * @returns 是不是连接断了。
 */
function isDisconnected(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'gateway/disconnected'
}

/**
 * 进程外 SDK 的客户端。
 */
export class SdkClient {
  private readonly child: ChildProcess
  private readonly peer: JsonRpcPeer
  private readonly transport: StdioTransport
  private readonly timeoutMs: number | undefined
  private readonly closeTimeoutMs: number
  private readonly exitPromise: Promise<SdkExit>
  private exitInfo: SdkExit | undefined
  private resolveExit: ((info: SdkExit) => void) | undefined
  private spawnError: Error | undefined
  private stderrText = ''

  /**
   * @param options - 构造选项。
   */
  private constructor(options: SdkClientOptions) {
    this.timeoutMs = options.timeoutMs
    this.closeTimeoutMs = options.closeTimeoutMs ?? 2000
    this.child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child.stderr?.setEncoding('utf8')
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderrText = `${this.stderrText}${chunk}`.slice(-4000)
    })
    this.child.on('error', (error: Error) => {
      this.spawnError = error
      // 进程压根没起来的时候不会触发 exit，但「它已经结束了」这件事得有人认。
      if (this.child.pid === undefined) this.markExited(null, null)
    })
    this.exitPromise = new Promise<SdkExit>((resolve) => {
      this.resolveExit = resolve
    })
    this.child.once('exit', (code, signal) => {
      this.markExited(code, signal)
    })
    this.transport = new StdioTransport(this.child)
    this.peer = new JsonRpcPeer(this.transport, { timeoutMs: options.timeoutMs })
  }

  /**
   * 起一个子进程并接上。
   * @param options - 构造选项。
   * @returns 客户端。
   */
  static start(options: SdkClientOptions): SdkClient {
    return new SdkClient(options)
  }

  /** 子进程是不是还在。 */
  get isRunning(): boolean {
    return this.exitInfo === undefined
  }

  /** 子进程写过的 stderr（最后 4000 个字符）。 */
  get stderr(): string {
    return this.stderrText
  }

  /** 子进程什么时候退出。 */
  get exited(): Promise<SdkExit> {
    return this.exitPromise
  }

  /**
   * 发一次请求并等回包。
   * @param method - 方法名。
   * @param params - 参数。
   * @param options - 超时与取消信号。
   * @returns 回包里的结果。
   */
  async request(method: string, params?: unknown, options: SdkRequestOptions = {}): Promise<unknown> {
    try {
      return await this.peer.request(method, params, {
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        signal: options.signal,
      })
    } catch (error) {
      throw this.explain(error)
    }
  }

  /**
   * 发一条通知（不回包）。
   * @param method - 方法名。
   * @param params - 参数。
   */
  notify(method: string, params?: unknown): void {
    this.peer.notify(method, params)
  }

  /**
   * 记下「进程已经结束了」。
   * @param code - 退出码。
   * @param signal - 结束它的信号。
   */
  private markExited(code: number | null, signal: string | null): void {
    if (this.exitInfo !== undefined) return
    const info: SdkExit = { code, signal }
    this.exitInfo = info
    this.resolveExit?.(info)
  }

  /**
   * 收干净：先请子进程自己退，等不到再杀。
   * @returns 子进程的退出信息。
   */
  async close(): Promise<SdkExit> {
    if (this.exitInfo !== undefined) return this.exitInfo
    this.transport.close()
    const exited = await this.waitForExit(this.closeTimeoutMs)
    if (exited !== undefined) return exited
    this.child.kill()
    const killed = await this.waitForExit(1000)
    if (killed !== undefined) return killed
    this.child.kill('SIGKILL')
    const forced = await this.waitForExit(1000)
    return forced ?? { code: null, signal: null }
  }

  /**
   * 把「连接断了」翻译成更准的说法。
   * @param error - 原始失败。
   * @returns 说得清的失败。
   */
  private explain(error: unknown): unknown {
    if (!isDisconnected(error)) return error
    if (this.spawnError !== undefined) {
      return spawnFailedFailure(this.child.spawnfile, this.spawnError)
    }
    const exit = this.exitInfo
    if (exit === undefined) return error
    return processExitFailure(exit.code, exit.signal)
  }

  /**
   * 等子进程退出。
   * @param timeoutMs - 等多久。
   * @returns 退出了就返回退出信息；没退出是 undefined。
   */
  private async waitForExit(timeoutMs: number): Promise<SdkExit | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        resolve(undefined)
      }, timeoutMs)
      timer.unref?.()
    })
    const result = await Promise.race([this.exitPromise, timeout])
    if (timer !== undefined) clearTimeout(timer)
    return result
  }
}
