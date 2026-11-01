/**
 * 一个 PTC 子进程会话：宿主这边跟子进程说话的地方。
 *
 * 会话负责三件事：
 * - **发执行请求**：把源码、模式与绑定名单发过去。
 * - **回绑定调用**：子进程要调绑定时把参数发过来，宿主这边执行完再把结果送回去。
 *   （绑定传不过去函数句柄，只有名字与说明；真正调用时是子进程回头问宿主。）
 * - **收结果**：程序跑完发结果或失败过来；子进程要是自己死了，这里的等待也要有个
 *   说法，不能让调用方干等。
 *
 * 同一会话里的执行是**串行**的：保留状态（REPL / scriptPersistence）本来就要求前一次
 * 跑完，后一次才能接着跑。
 * @module @ryharness/ptc/session
 */

import type { ChildProcess } from 'node:child_process'
import { PtcBindingError } from './errors.ts'
import { PTC_FAILURE_KINDS, type PtcBinding, type PtcFailureKind, type PtcMode } from './types.ts'
import { messageOf, toWire } from './wire.ts'

/** 子进程发来的消息。 */
export type ChildMessage = ChildOutcome | { type: 'call'; id: string; name: string; args: readonly unknown[] }

/** 一次执行的结果消息（宿主只关心这两种）。 */
export type ChildOutcome =
  | { type: 'result'; id: string; output: readonly string[]; value?: unknown }
  | { type: 'failure'; id: string; output: readonly string[]; kind: PtcFailureKind; message: string; detail?: string }

/** 一次绑定调用的答复。 */
type CallReply = { ok: true; value?: unknown } | { ok: false; kind: PtcFailureKind; message: string }

/** 诊断信息保留的最大长度（子进程自己打印的东西会进这里）。 */
const DIAGNOSTIC_LIMIT = 2000

/**
 * 子进程会话。
 *
 * 一次执行 = 一次「发请求 → 等结果」；保留状态时同一个会话被复用多次。
 */
export class PtcSession {
  /** 当前这次执行用的绑定（同一会话里的执行是串行的，所以只有一份）。 */
  bindings = new Map<string, PtcBinding>()

  /** 正在等结果的执行。 */
  private readonly waiting = new Map<string, (message: ChildOutcome) => void>()

  /** 串行链：后一次执行排在前一次后面。 */
  private chain: Promise<unknown> = Promise.resolve()

  /** 子进程自己打印出来的内容（诊断用）。 */
  private diagnostics = ''

  /** 会话是不是已经结束了。 */
  closed = false

  /**
   * @param child - 子进程。
   * @param mode - 这个会话按哪种模式跑（模式变了就得换会话：绑定放全局还是放参数，
   *   两者的上下文不是一回事）。
   * @param onDead - 子进程结束时的回调（宿主要在这里把会话从表里摘掉）。
   */
  constructor(
    readonly child: ChildProcess,
    readonly mode: PtcMode,
    private readonly onDead: (session: PtcSession) => void,
  ) {
    child.on('message', (raw: unknown) => {
      this.handleMessage(raw)
    })
    child.stdout?.on('data', (chunk: unknown) => {
      this.appendDiagnostic(String(chunk))
    })
    child.stderr?.on('data', (chunk: unknown) => {
      this.appendDiagnostic(String(chunk))
    })
    child.on('exit', (code, signal) => {
      this.closed = true
      const reason = `子进程提前退出了（code=${code === null ? 'null' : String(code)}，signal=${signal ?? 'null'}）`
      const tail = this.diagnostics.trim()
      this.failAll(reason + (tail.length === 0 ? '' : `：${tail}`))
      this.onDead(this)
    })
    child.on('error', (error) => {
      this.closed = true
      this.failAll(`子进程起不来：${messageOf(error)}`)
      this.onDead(this)
    })
  }

  /**
   * 把一次执行排进串行链。
   * @param task - 这一步要做的事。
   * @returns 这一步的结果。
   */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    this.chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * 登记一次执行，等它的结果。
   * @param id - 执行 id。
   * @param resolve - 收到结果时调用。
   */
  expect(id: string, resolve: (message: ChildOutcome) => void): void {
    this.waiting.set(id, resolve)
  }

  /** 忘掉一次执行（结果已经拿到了，或者这次执行被收掉了）。 */
  forget(id: string): void {
    this.waiting.delete(id)
  }

  /**
   * 把执行请求发给子进程。
   * @param id - 执行 id。
   * @param mode - 跑法。
   * @param program - 源码。
   * @param bindings - 绑定名单（只有名字与说明，函数传不过去）。
   */
  start(id: string, mode: PtcMode, program: string, bindings: readonly PtcBinding[]): void {
    this.child.send({
      type: 'run',
      id,
      mode,
      program,
      bindings: bindings.map((binding) => {
        return {
          name: binding.name,
          ...(binding.description === undefined ? {} : { description: binding.description }),
        }
      }),
    })
  }

  /** 结束会话（终止子进程）。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.failAll('子进程被宿主结束了。')
    this.child.kill()
  }

  /** 子进程发来的消息。 */
  private handleMessage(raw: unknown): void {
    const message = parseChildMessage(raw)
    if (message === undefined) return
    if (message.type === 'call') {
      void this.handleCall(message)
      return
    }
    const waiting = this.waiting.get(message.id)
    if (waiting === undefined) return
    this.waiting.delete(message.id)
    waiting(message)
  }

  /** 子进程要调一个绑定：宿主这边执行，再把结果送回去。 */
  private async handleCall(message: Extract<ChildMessage, { type: 'call' }>): Promise<void> {
    const binding = this.bindings.get(message.name)
    if (binding === undefined) {
      this.reply(message.id, { ok: false, kind: 'runtime', message: `宿主没有提供 ${message.name} 这个绑定。` })
      return
    }
    let reply: CallReply
    try {
      const value = await binding.fn(message.args)
      reply = { ok: true, value: toWire(value) }
    } catch (error) {
      reply = { ok: false, kind: bindingKind(error), message: messageOf(error) }
    }
    this.reply(message.id, reply)
  }

  /** 把绑定调用的结果送回子进程。 */
  private reply(id: string, reply: CallReply): void {
    if (this.closed) return
    try {
      this.child.send({ type: 'callResult', id, ...reply })
    } catch {
      // 子进程已经走了：这个答复没人要，丢掉即可。
    }
  }

  /** 子进程死了：所有等着的执行都要有个说法。 */
  private failAll(reason: string): void {
    for (const [, resolve] of this.waiting) {
      resolve({ type: 'failure', id: '', output: [], kind: 'spawn', message: reason })
    }
    this.waiting.clear()
  }

  /** 记一段诊断信息（只留最后一截）。 */
  private appendDiagnostic(text: string): void {
    this.diagnostics = (this.diagnostics + text).slice(-DIAGNOSTIC_LIMIT)
  }
}

/** 绑定抛的错带分类就带分类，没带就按运行时错误算。 */
function bindingKind(error: unknown): PtcFailureKind {
  if (error instanceof PtcBindingError) return error.kind
  return 'runtime'
}

/** 把子进程发来的原始消息解析成已知形状。 */
function parseChildMessage(raw: unknown): ChildMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const type = readString(record, 'type')
  if (type === 'call') {
    const id = readString(record, 'id')
    const name = readString(record, 'name')
    if (id === undefined || name === undefined) return undefined
    const args = Array.isArray(record.args) ? record.args : []
    return { type: 'call', id, name, args }
  }
  if (type === 'result') {
    const id = readString(record, 'id')
    if (id === undefined) return undefined
    return { type: 'result', id, output: readStrings(record, 'output'), value: record.value }
  }
  if (type === 'failure') {
    const id = readString(record, 'id')
    const message = readString(record, 'message')
    if (id === undefined || message === undefined) return undefined
    const kind = readString(record, 'kind')
    const detail = readString(record, 'detail')
    return {
      type: 'failure',
      id,
      output: readStrings(record, 'output'),
      kind: isFailureKind(kind) ? kind : 'runtime',
      message,
      ...(detail === undefined ? {} : { detail }),
    }
  }
  return undefined
}

/** 读一个字符串字段。 */
function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/** 读一个字符串数组字段。 */
function readStrings(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => {
    return typeof item === 'string'
  })
}

/** 是不是一个已知的失败分类。 */
function isFailureKind(value: string | undefined): value is PtcFailureKind {
  return value !== undefined && (PTC_FAILURE_KINDS as readonly string[]).includes(value)
}
