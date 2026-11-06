/**
 * 会话服务：owner 隔离、有界、每步超时、失败结构化、用完能收干净。
 *
 * 与 browser-use 的会话服务是同一套骨架（归属、边界、生命周期），但**多了一
 * 层东西：高危动作要人点头**。理由写在 {@link ../types.ts} 里：桌面上没有
 * 「只允许 http/https、不去内网」这种天然边界，模型说「点 (800, 600)」，那就
 * 是在那个位置真的点一下。
 *
 * 确认的口径是「**宁可什么都不做，也不要自己替用户决定**」：
 * - 宿主没接确认回调 → 高危动作一律拒绝（不是默认放行）；
 * - 人拒绝了 → 动作不执行，模型拿到一句「人没点头」；
 * - 鼠标移动与滚动不算高危，不打扰人。
 *
 * 截图另有一条：它可能含个人信息，所以策略里能单独关掉；关掉之后调用方拿到
 * 的是结构化错误，而不是一张空图。
 *
 * @module @ryharness/computer-use/service
 */

import { randomBytes } from 'node:crypto'
import { describeComputerAction, isComputerActionKind, isDangerousComputerAction } from './dangerous.ts'
import { ComputerUseError } from './errors.ts'
import type {
  ComputerAction,
  ComputerApprover,
  ComputerDriver,
  ComputerDriverFactory,
  ComputerOwner,
  ComputerPolicy,
  ComputerScreenshot,
  ComputerSessionServiceOptions,
  ComputerSessionView,
} from './types.ts'

/** 一个会话的内部记录。 */
interface SessionRecord {
  /** 不透明会话 id。 */
  readonly id: string
  /** 归属者。 */
  readonly owner: ComputerOwner
  /** 这一台桌面的驱动。 */
  readonly driver: ComputerDriver
  /** 创建时刻（毫秒时间戳）。 */
  readonly createdAt: number
}

/** 默认每 owner 会话上限。 */
const DEFAULT_MAX_SESSIONS = 4
/** 默认单步时限（毫秒）。 */
const DEFAULT_STEP_TIMEOUT_MS = 15_000

/** 默认策略：高危动作要人点头、允许截图。 */
const DEFAULT_POLICY: ComputerPolicy = {
  requireApproval: true,
  allowScreenshot: true,
}

/** 把错误对象变成一句人话。 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 给一个 Promise 加时限。
 *
 * 超时之后不取消底层动作（驱动接口没有取消这一说），只是**不再等它**。
 * @param work - 要等的事。
 * @param timeoutMs - 时限（毫秒）。
 * @param label - 出错时说的动作名。
 * @returns 动作的结果。
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ComputerUseError('TIMEOUT', `computer-use: ${label}超过 ${timeoutMs} 毫秒没返回`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 会话服务。
 *
 * 一个实例服务一段宿主运行时：会话归谁、边界在哪、怎么清理都在这里。
 */
export class ComputerSessionService {
  /** 造桌面驱动的工厂；没给就是「没装桌面驱动」。 */
  readonly #driverFactory: ComputerDriverFactory | undefined
  /** 会话表。 */
  readonly #sessions = new Map<string, SessionRecord>()
  /** 每 owner 会话上限。 */
  readonly #maxSessions: number
  /** 单步时限。 */
  readonly #stepTimeoutMs: number
  /** 安全策略。 */
  readonly #policy: ComputerPolicy
  /** 确认回调。 */
  readonly #approver: ComputerApprover | undefined

  constructor(options: ComputerSessionServiceOptions = {}) {
    this.#driverFactory = options.driverFactory
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.#stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
    this.#policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) }
    this.#approver = options.approver
  }

  /** 当前的安全策略（副本，改它不影响服务）。 */
  get policy(): ComputerPolicy {
    return { ...this.#policy }
  }

  /**
   * 开一个会话。
   *
   * 驱动起不来就**不留半个会话**：留一个开了一半的桌面连接是最难查的一种泄漏。
   * @param owner - 会话归属者。
   * @returns 建好的会话。
   */
  async open(owner: ComputerOwner): Promise<ComputerSessionView> {
    const factory = this.#driverFactory
    if (factory === undefined) {
      throw new ComputerUseError('NO_DRIVER', 'computer-use: 没装桌面驱动，这个包不自带桌面自动化')
    }
    if (this.#countOwned(owner) >= this.#maxSessions) {
      throw new ComputerUseError('SESSION_LIMIT', `computer-use: 这个 owner 的会话数已达上限（${this.#maxSessions}）`)
    }
    let driver: ComputerDriver
    try {
      driver = await factory()
    } catch (error) {
      throw new ComputerUseError('DRIVER_FAILED', `computer-use: 起桌面驱动失败：${describe(error)}`)
    }
    const record: SessionRecord = {
      id: this.#mintId(),
      owner,
      driver,
      createdAt: Date.now(),
    }
    this.#sessions.set(record.id, record)
    return this.#view(record)
  }

  /**
   * 做一次动作。
   *
   * **高危动作在这里被拦**：click / type / key 默认要人点头。宿主没接确认
   * 回调时一律拒绝——桌面上点错地方的后果比点错网页严重得多。
   * @param owner - 会话归属者。
   * @param sessionId - 会话 id。
   * @param action - 动作请求。
   */
  async act(owner: ComputerOwner, sessionId: string, action: ComputerAction): Promise<void> {
    const record = this.#require(owner, sessionId)
    // kind 的类型是联合类型，但这个值**可能来自宿主解析出来的 JSON**（配置、
    // HTTP 请求体、别的进程发过来的消息）——编译期管不到的那些路径上，
    // 运行时要自己把关。
    //
    // 不把关的后果很具体：下面那个 switch 没有 default 分支，认不出来的 kind
    // 会**什么都不做就返回**，调用方以为动作执行成功了——点了个寂寞。
    const kind: unknown = action.kind
    if (typeof kind !== 'string' || !isComputerActionKind(kind)) {
      throw new ComputerUseError('INVALID_ARGUMENT', `computer-use: 不认识的动作种类「${String(kind)}」`)
    }
    await this.#ensureApproved(action)
    switch (action.kind) {
      case 'click': {
        const { x, y } = this.#readPoint(action)
        await this.#drive('点击', () => record.driver.click(x, y))
        return
      }
      case 'type': {
        const text = action.text
        if (text === undefined) {
          throw new ComputerUseError('INVALID_ARGUMENT', 'computer-use: type 需要一段文字')
        }
        await this.#drive('输入', () => record.driver.type(text))
        return
      }
      case 'key': {
        const key = action.key
        if (key === undefined || key.length === 0) {
          throw new ComputerUseError('INVALID_ARGUMENT', 'computer-use: key 需要一个键名')
        }
        await this.#drive('按键', () => record.driver.key(key))
        return
      }
      case 'move': {
        const { x, y } = this.#readPoint(action)
        await this.#drive('移动鼠标', () => record.driver.move(x, y))
        return
      }
      case 'scroll': {
        const dx = action.dx
        const dy = action.dy
        if (dx === undefined || dy === undefined) {
          throw new ComputerUseError('INVALID_ARGUMENT', 'computer-use: scroll 需要 dx 与 dy')
        }
        await this.#drive('滚动', () => record.driver.scroll(dx, dy))
        return
      }
    }
  }

  /**
   * 截当前屏幕。
   *
   * **这张图可能含个人信息**（邮件、聊天记录、密码提示）。策略关掉截图时，
   * 调用方拿到的是结构化错误，而不是一张空图。
   * @param owner - 会话归属者。
   * @param sessionId - 会话 id。
   * @returns 截图。
   */
  async screenshot(owner: ComputerOwner, sessionId: string): Promise<ComputerScreenshot> {
    const record = this.#require(owner, sessionId)
    if (!this.#policy.allowScreenshot) {
      throw new ComputerUseError('SCREENSHOT_NOT_ALLOWED', 'computer-use: 截图被策略关掉了')
    }
    return await this.#drive('截图', () => record.driver.screenshot())
  }

  /**
   * 取一个会话。
   * @param owner - 调用者。
   * @param sessionId - 会话 id。
   * @returns 会话视图。
   */
  get(owner: ComputerOwner, sessionId: string): ComputerSessionView {
    return this.#view(this.#require(owner, sessionId))
  }

  /**
   * 列某个 owner 的会话。
   *
   * **只列自己的**：别人的会话连 id 都不该出现在列表里。
   * @param owner - 调用者。
   * @returns 会话视图列表。
   */
  list(owner: ComputerOwner): readonly ComputerSessionView[] {
    const views: ComputerSessionView[] = []
    for (const record of this.#sessions.values()) {
      if (record.owner === owner) views.push(this.#view(record))
    }
    return views
  }

  /**
   * 关掉一个会话。
   *
   * 关不掉就如实报错，不能假装关好了。
   * @param owner - 会话归属者。
   * @param sessionId - 会话 id。
   */
  async close(owner: ComputerOwner, sessionId: string): Promise<void> {
    const record = this.#require(owner, sessionId)
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
      throw new ComputerUseError('CLEANUP_FAILED', `computer-use: 有会话没关干净：${failures.join('；')}`)
    }
  }

  /**
   * 高危动作问人：没点头就不做。
   *
   * 三种结果：
   * - 动作不高危（移动鼠标、滚动）→ 直接放行，不打扰人；
   * - 高危但宿主没接确认回调 → 拒绝（宁可什么都不做）；
   * - 高危且人拒绝了 → 拒绝。
   * @param action - 动作请求。
   */
  async #ensureApproved(action: ComputerAction): Promise<void> {
    if (!this.#policy.requireApproval) return
    if (!isDangerousComputerAction(action.kind)) return
    const approver = this.#approver
    if (approver === undefined) {
      throw new ComputerUseError(
        'APPROVAL_REQUIRED',
        'computer-use: 这个动作需要人确认，但宿主没有接确认回调，已拒绝执行',
      )
    }
    const request = {
      kind: action.kind,
      description: '',
      ...(action.x === undefined ? {} : { x: action.x }),
      ...(action.y === undefined ? {} : { y: action.y }),
      ...(action.text === undefined ? {} : { text: action.text }),
      ...(action.key === undefined ? {} : { key: action.key }),
      ...(action.dx === undefined ? {} : { dx: action.dx }),
      ...(action.dy === undefined ? {} : { dy: action.dy }),
    }
    const approved = await approver({
      ...request,
      description: describeComputerAction(request),
    })
    if (!approved) {
      throw new ComputerUseError('APPROVAL_REQUIRED', 'computer-use: 这次操作没有获得确认，已拒绝执行')
    }
  }

  /**
   * 读一个坐标；缺了或不是整数就报参数不对。
   * @param action - 动作请求。
   * @returns 坐标。
   */
  #readPoint(action: ComputerAction): { x: number; y: number } {
    const x = action.x
    const y = action.y
    if (x === undefined || y === undefined) {
      throw new ComputerUseError('INVALID_ARGUMENT', 'computer-use: 这个动作需要 x 与 y 坐标')
    }
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new ComputerUseError('INVALID_ARGUMENT', 'computer-use: 坐标必须是整数像素')
    }
    if (x < 0 || y < 0) {
      throw new ComputerUseError('INVALID_ARGUMENT', 'computer-use: 坐标不能是负数')
    }
    return { x, y }
  }

  /**
   * 取一个属于该 owner 的会话。
   * @param owner - 调用者。
   * @param sessionId - 会话 id。
   * @returns 会话记录。
   */
  #require(owner: ComputerOwner, sessionId: string): SessionRecord {
    const record = this.#sessions.get(sessionId)
    if (record === undefined || record.owner !== owner) {
      throw new ComputerUseError('NO_SESSION', 'computer-use: 没有这个会话')
    }
    return record
  }

  /** 这个 owner 现在有几个会话。 */
  #countOwned(owner: ComputerOwner): number {
    let count = 0
    for (const record of this.#sessions.values()) {
      if (record.owner === owner) count += 1
    }
    return count
  }

  /**
   * 跑一步驱动动作：带时限，失败结构化。
   * @param record - 会话记录。
   * @param label - 动作名（出错时进消息）。
   * @param work - 要做的事。
   */
  async #drive<T>(label: string, work: () => Promise<T>): Promise<T> {
    try {
      return await withTimeout(work(), this.#stepTimeoutMs, label)
    } catch (error) {
      if (error instanceof ComputerUseError) throw error
      throw new ComputerUseError('DRIVER_FAILED', `computer-use: ${label}失败：${describe(error)}`)
    }
  }

  /**
   * 关掉一个会话并把它从表里摘掉。
   * @param record - 会话记录。
   */
  async #closeRecord(record: SessionRecord): Promise<void> {
    try {
      await record.driver.close()
    } catch (error) {
      // 关不干净就不从表里删：删了这个会话就再也没法收它了。
      throw new ComputerUseError('CLEANUP_FAILED', `computer-use: 会话 ${record.id} 没关干净：${describe(error)}`)
    }
    this.#sessions.delete(record.id)
  }

  /**
   * 造一个不透明 id。
   *
   * 纯随机，不掺 owner、时间戳、序号——从 id 看不出任何事。
   * @returns id 字符串。
   */
  #mintId(): string {
    return randomBytes(12).toString('hex')
  }

  /**
   * 会话的对外视图（快照）。
   * @param record - 会话记录。
   * @returns 会话视图。
   */
  #view(record: SessionRecord): ComputerSessionView {
    return {
      id: record.id,
      owner: record.owner,
      driver: record.driver.name,
      createdAt: record.createdAt,
    }
  }
}
