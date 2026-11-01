/**
 * 会话服务：owner 隔离、不透明 id、精确 owner 围栏、等待式清理。
 *
 * 这一层**只管归属与生命周期**，不管 shell 怎么跑（那是后端的事）。它做四件事：
 *
 * 1. **发不透明 id**。id 是随机生成的十六进制串，不含 owner、不含时间戳、不含
 *    序号——能从 id 看出「这是谁的会话」本身就是一种泄露。猜 id 也没用，随机性
 *    足够高，猜不中。
 * 2. **精确 owner 围栏**。每个会话记着一个 owner，调用时逐字比对。`"a"` 与
 *    `"a "`、`"A"` 是三个不同的 owner：不做 trim、不做大小写折叠。宁可错杀，
 *    不可错放——错放的代价是别人的会话被改了。
 * 3. **等待式清理**。`close()` 要等进程**真的退出**才返回；`disposeAll()` 把所有
 *    会话都收干净。返回时进程还在，就是没关干净。
 * 4. **会话不跨重启存活**。会话活在内存里，进程重启就没了（上游 dsh 也是这样）。
 *
 * @module @ryharness/terminal/service
 */

import { randomBytes } from 'node:crypto'
import { TerminalError } from './errors.ts'
import type {
  TerminalBackend,
  TerminalCreateRequest,
  TerminalOwner,
  TerminalReadResult,
  TerminalSession,
  TerminalSessionState,
  TerminalShellDialect,
} from './types.ts'

/** 一次会话的内部记录。 */
interface SessionRecord {
  /** 不透明 id。 */
  readonly id: string
  /** 归属者。 */
  readonly owner: TerminalOwner
  /** 用的是哪个后端。 */
  readonly backend: string
  /** shell 方言。 */
  readonly dialect: TerminalShellDialect
  /** 生命周期阶段。 */
  state: TerminalSessionState
  /** 当前工作目录。 */
  cwd: string
  /** 额外注入的环境变量。 */
  readonly env: Readonly<Record<string, string>>
  /** 命令历史。 */
  readonly history: string[]
  /** 创建时刻（毫秒时间戳）。 */
  readonly createdAt: number
  /** 后端句柄。 */
  readonly backendSession: import('./types.ts').TerminalBackendSession
}

/** 会话服务的构造参数。 */
export interface TerminalServiceOptions {
  /** 可用的后端；第一个是默认后端。 */
  readonly backends?: readonly TerminalBackend[]
  /** 会话 id 的长度（字节）。 */
  readonly idBytes?: number
}

/** 默认的会话 id 长度（字节）。 */
const DEFAULT_ID_BYTES = 16

/**
 * 会话服务。
 *
 * 一个实例服务一段宿主运行时：会话归谁、怎么围栏、怎么清理都在这里。
 */
export class TerminalService {
  /** 后端表（按类型名索引）。 */
  readonly #backends = new Map<string, TerminalBackend>()
  /** 会话表。 */
  readonly #sessions = new Map<string, SessionRecord>()
  /** id 长度。 */
  readonly #idBytes: number

  constructor(options: TerminalServiceOptions = {}) {
    this.#idBytes = options.idBytes ?? DEFAULT_ID_BYTES
    for (const backend of options.backends ?? []) {
      this.#backends.set(backend.type, backend)
    }
  }

  /**
   * 注册一个后端。
   *
   * 同名覆盖是允许的：宿主重载插件时拿到的是新实例，旧的那份不该继续被选中。
   * @param backend - 后端实现。
   */
  registerBackend(backend: TerminalBackend): void {
    this.#backends.set(backend.type, backend)
  }

  /**
   * 已注册的后端类型名。
   * @returns 类型名列表。
   */
  listBackends(): readonly string[] {
    return [...this.#backends.keys()]
  }

  /**
   * 开一个会话。
   *
   * 后端起不来或就绪探测没过就 reject，**不会留下半个会话**：起了一半的 shell
   * 留在机器上是最难查的一种泄漏。
   * @param owner - 会话归属者。
   * @param request - 创建请求。
   * @returns 建好的会话。
   */
  async open(owner: TerminalOwner, request: TerminalCreateRequest = {}): Promise<TerminalSession> {
    const backendType = request.backend ?? this.#backends.keys().next().value
    if (backendType === undefined) {
      throw new TerminalError('NO_BACKEND', 'terminal: 没有可用的后端')
    }
    const backend = this.#backends.get(backendType)
    if (backend === undefined) {
      throw new TerminalError('NO_BACKEND', `terminal: 没有类型为「${backendType}」的后端`)
    }

    const id = this.#mintId()
    const createdAt = Date.now()
    const env = { ...(request.env ?? {}) }

    let backendSession: import('./types.ts').TerminalBackendSession
    try {
      backendSession = await backend.open({
        sessionId: id,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        env,
      })
    } catch (error) {
      throw new TerminalError('BACKEND_FAILED', `terminal: 起会话失败：${describe(error)}`)
    }

    const record: SessionRecord = {
      id,
      owner,
      backend: backendType,
      dialect: backendSession.dialect,
      state: 'created',
      cwd: request.cwd ?? process.cwd(),
      env,
      history: [],
      createdAt,
      backendSession,
    }
    this.#sessions.set(id, record)

    // 就绪探测过了才算 ready。探测由后端在 open 里做，这里只把状态落定。
    record.state = 'ready'
    return this.#view(record)
  }

  /**
   * 取一个会话。
   *
   * **围栏在这里**：owner 不逐字相同就是别人的会话，一律拒绝。分不清「不存在」
   * 与「不是你的」——对外是同一句「没有这个会话」，免得变成一个探测 id 是否存在的
   * 侧信道。
   * @param owner - 调用者。
   * @param id - 会话 id。
   * @returns 会话视图。
   */
  get(owner: TerminalOwner, id: string): TerminalSession {
    const record = this.#sessions.get(id)
    if (record === undefined || record.owner !== owner) {
      throw new TerminalError('NO_SESSION', 'terminal: 没有这个会话')
    }
    return this.#view(record)
  }

  /**
   * 列某个 owner 的会话。
   *
   * **只列自己的**：别人的会话连 id 都不该出现在列表里。
   * @param owner - 调用者。
   * @returns 会话视图列表。
   */
  list(owner: TerminalOwner): readonly TerminalSession[] {
    const views: TerminalSession[] = []
    for (const record of this.#sessions.values()) {
      if (record.owner === owner) views.push(this.#view(record))
    }
    return views
  }

  /**
   * 往会话里发一条命令。
   *
   * 同一个会话上**同时只允许一次发送**：两次并发写进同一条 stdin，输出会交错，
   * 谁是谁的输出就分不清了。第二次调用直接报错。
   * @param owner - 调用者。
   * @param id - 会话 id。
   * @param text - 命令文本。
   * @param options - 是否补换行。
   */
  async send(owner: TerminalOwner, id: string, text: string, options?: { readonly submit?: boolean }): Promise<void> {
    const record = this.#require(owner, id)
    if (record.state === 'closed') {
      throw new TerminalError('SESSION_CLOSED', 'terminal: 会话已经关了')
    }
    if (this.#sending.has(id)) {
      throw new TerminalError('SEND_ACTIVE', 'terminal: 这个会话上已经有一次发送在进行')
    }
    this.#sending.add(id)
    try {
      record.history.push(text)
      await record.backendSession.send(text, options)
    } finally {
      this.#sending.delete(id)
    }
  }

  /**
   * 读一段输出。
   * @param owner - 调用者。
   * @param id - 会话 id。
   * @param options - 单次上限与等待时长。
   * @returns 读取结果。
   */
  async read(
    owner: TerminalOwner,
    id: string,
    options?: { readonly maxBytes?: number; readonly waitMs?: number },
  ): Promise<TerminalReadResult> {
    const record = this.#require(owner, id)
    if (record.state === 'closed') {
      throw new TerminalError('SESSION_CLOSED', 'terminal: 会话已经关了')
    }
    return record.backendSession.read(options)
  }

  /**
   * 改工作目录。
   * @param owner - 调用者。
   * @param id - 会话 id。
   * @param path - 目标目录。
   * @returns 改完之后 shell 报告的当前目录。
   */
  async changeDirectory(owner: TerminalOwner, id: string, path: string): Promise<string> {
    const record = this.#require(owner, id)
    if (record.state === 'closed') {
      throw new TerminalError('SESSION_CLOSED', 'terminal: 会话已经关了')
    }
    const cwd = await record.backendSession.changeDirectory(path)
    record.cwd = cwd
    return cwd
  }

  /**
   * 中断正在跑的命令。
   * @param owner - 调用者。
   * @param id - 会话 id。
   */
  async interrupt(owner: TerminalOwner, id: string): Promise<void> {
    const record = this.#require(owner, id)
    if (record.state === 'closed') {
      throw new TerminalError('SESSION_CLOSED', 'terminal: 会话已经关了')
    }
    await record.backendSession.interrupt()
  }

  /**
   * 关掉一个会话。
   *
   * **等进程真的退出**：返回时 shell 必须已经不在了。清理失败要报错，不能假装
   * 关好了——「以为关了其实还在跑」比「明确报失败」难查得多。
   * @param owner - 调用者。
   * @param id - 会话 id。
   */
  async close(owner: TerminalOwner, id: string): Promise<void> {
    const record = this.#require(owner, id)
    await this.#closeRecord(record)
  }

  /**
   * 关掉所有会话。
   *
   * 宿主下线时调它。**一个失败不影响别的**：每个会话各自收，收不干净的记下来，
   * 最后一起报。
   */
  async disposeAll(): Promise<void> {
    const failures: string[] = []
    for (const record of [...this.#sessions.values()]) {
      try {
        await this.#closeRecord(record)
      } catch (error) {
        failures.push(`${record.id}: ${describe(error)}`)
      }
    }
    if (failures.length > 0) {
      throw new TerminalError('CLEANUP_FAILED', `terminal: 有会话没关干净：${failures.join('；')}`)
    }
  }

  /** 正在进行的发送（按会话 id）。 */
  readonly #sending = new Set<string>()

  /**
   * 关掉一个会话并把它从表里摘掉。
   * @param record - 会话记录。
   */
  async #closeRecord(record: SessionRecord): Promise<void> {
    try {
      await record.backendSession.close()
      record.state = 'closed'
      this.#sessions.delete(record.id)
    } catch (error) {
      // 关不掉就不从表里删：删了这个会话就再也没法收它了，进程还在跑。
      record.state = 'closed'
      throw new TerminalError('CLEANUP_FAILED', `terminal: 会话 ${record.id} 没关干净：${describe(error)}`)
    }
  }

  /**
   * 取一个属于该 owner 的会话。
   * @param owner - 调用者。
   * @param id - 会话 id。
   * @returns 会话记录。
   */
  #require(owner: TerminalOwner, id: string): SessionRecord {
    const record = this.#sessions.get(id)
    if (record === undefined || record.owner !== owner) {
      throw new TerminalError('NO_SESSION', 'terminal: 没有这个会话')
    }
    return record
  }

  /**
   * 造一个不透明 id。
   *
   * 纯随机，不掺 owner、时间戳、序号——从 id 看不出任何事。
   * @returns id 字符串。
   */
  #mintId(): string {
    return randomBytes(this.#idBytes).toString('hex')
  }

  /**
   * 会话的对外视图。
   *
   * 返回的是**快照**，不是活对象：调用方拿到的 `state` 是那一刻的状态。
   * @param record - 会话记录。
   * @returns 会话视图。
   */
  #view(record: SessionRecord): TerminalSession {
    const pid = record.backendSession.pid
    return {
      id: record.id,
      owner: record.owner,
      state: record.state,
      backend: record.backend,
      dialect: record.dialect,
      cwd: record.cwd,
      env: { ...record.env },
      history: [...record.history],
      createdAt: record.createdAt,
      ...(pid === undefined ? {} : { pid }),
    }
  }
}

/** 把错误对象变成一句人话。 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
