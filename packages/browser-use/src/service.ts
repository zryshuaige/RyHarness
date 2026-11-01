/**
 * 会话服务：owner 隔离、有界、每步超时、失败结构化、用完能收干净。
 *
 * 这一层**只管归属、边界与生命周期**，不管浏览器怎么开——那是驱动的事。分开的
 * 好处：换驱动（Playwright / CDP / 远端浏览器）时这一层一行不用改，而「谁能让
 * 哪个会话动」这条口径始终只有一份。
 *
 * 它做五件事：
 *
 * 1. **owner 隔离**。每个会话记着一个 owner，调用时逐字比对；`"a"`、`"a "`、
 *    `"A"` 是三个不同的 owner。不存在的会话与别人的会话对外是同一句「没有这个
 *    会话」——不然就成了一个探测 id 是否存在的侧信道。
 * 2. **有界**。一个会话最多几个标签页（默认 4）、一个 owner 最多几个会话
 *    （默认 8）。不设上限的话，模型可以在一个会话里开出一堆标签页把内存吃光。
 * 3. **每步超时**。驱动卡住时不能让整轮对话跟着挂住——超时按结构化错误报回去，
 *    模型看得见「这一步没成」，而不是等。
 * 4. **失败结构化**。所有失败都是 {@link BrowserUseError}：稳定的码 + 中文原因。
 * 5. **用完能收干净**。`close()` 把会话里所有标签页的驱动都关掉；`disposeAll()`
 *    把所有会话收掉，一个失败不影响别的。
 *
 * 安全边界在这一层统一执行，模型工具与宿主直接调用走的是同一条路：
 * - 只允许 http/https；
 * - 默认不去本机与内网；
 * - 默认不自动提交表单、不自动下载文件（这两类要显式放行）。
 *
 * @module @ryharness/browser-use/service
 */

import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { BrowserUseError } from './errors.ts'
import { assertNavigableUrl } from './guard.ts'
import type {
  BrowserAction,
  BrowserDownloader,
  BrowserDriver,
  BrowserDriverFactory,
  BrowserFormSubmitter,
  BrowserOwner,
  BrowserPolicy,
  BrowserReadResult,
  BrowserSessionServiceOptions,
  BrowserSessionView,
  BrowserTabView,
  BrowserToolSession,
  HostResolver,
} from './types.ts'

/** 一个标签页的内部记录。 */
interface TabRecord {
  /** 标签页 id。 */
  readonly id: string
  /** 这一页的驱动。 */
  readonly driver: BrowserDriver
  /** 当前地址。 */
  url: string
}

/** 一个会话的内部记录。 */
interface SessionRecord {
  /** 不透明会话 id。 */
  readonly id: string
  /** 归属者。 */
  readonly owner: BrowserOwner
  /** 标签页表。 */
  readonly tabs: Map<string, TabRecord>
  /** 当前正在操作的标签页。 */
  activeTabId: string
  /** 创建时刻（毫秒时间戳）。 */
  readonly createdAt: number
}

/** 默认标签页上限。 */
const DEFAULT_MAX_TABS = 4
/** 默认每 owner 会话上限。 */
const DEFAULT_MAX_SESSIONS = 8
/** 默认单步时限（毫秒）。 */
const DEFAULT_STEP_TIMEOUT_MS = 15_000

/** 默认策略：三条全关。 */
const DEFAULT_POLICY: BrowserPolicy = {
  allowPrivateNetwork: false,
  allowFormSubmit: false,
  allowDownload: false,
}

/**
 * 默认的主机名解析器。
 *
 * 用 `all: true` 一次拿全，是为了让「某条记录落在内网」在同一次判定里就能发现；
 * 只取第一条等于把「连哪个地址」的选择权交给了 DNS。
 */
export const defaultResolveHost: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

/** 把错误对象变成一句人话。 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 给一个 Promise 加时限。
 *
 * 超时之后不取消底层动作（驱动接口没有取消这一说），只是**不再等它**——调用方
 * 拿到一个明确的超时错误，模型可以换个做法。底层动作晚到时的失败会被吞掉，
 * 否则会变成一个没人接的 promise 拒绝。
 * @param work - 要等的事。
 * @param timeoutMs - 时限（毫秒）。
 * @param label - 出错时说的动作名。
 * @returns 动作的结果。
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new BrowserUseError('TIMEOUT', `browser-use: ${label}超过 ${timeoutMs} 毫秒没返回`))
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
export class BrowserSessionService implements BrowserToolSession {
  /** 造标签页驱动的工厂；没给就是「没装浏览器驱动」。 */
  readonly #driverFactory: BrowserDriverFactory | undefined
  /** 会话表。 */
  readonly #sessions = new Map<string, SessionRecord>()
  /** 标签页上限。 */
  readonly #maxTabs: number
  /** 每 owner 会话上限。 */
  readonly #maxSessions: number
  /** 单步时限。 */
  readonly #stepTimeoutMs: number
  /** 安全策略。 */
  readonly #policy: BrowserPolicy
  /** 主机名解析器。 */
  readonly #resolveHost: HostResolver

  constructor(options: BrowserSessionServiceOptions = {}) {
    this.#driverFactory = options.driverFactory
    this.#maxTabs = options.maxTabs ?? DEFAULT_MAX_TABS
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.#stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
    this.#policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) }
    this.#resolveHost = options.resolveHost ?? defaultResolveHost
  }

  /** 当前的安全策略（副本，改它不影响服务）。 */
  get policy(): BrowserPolicy {
    return { ...this.#policy }
  }

  /**
   * 开一个会话并在里面打开第一个标签页。
   *
   * 驱动起不来或导航失败就**不留半个会话**：留一个开了一半的浏览器是最难查的
   * 一种泄漏。
   * @param owner - 会话归属者。
   * @param url - 第一个标签页要去的地址。
   * @returns 建好的会话。
   */
  async open(owner: BrowserOwner, url: string): Promise<BrowserSessionView> {
    const factory = this.#requireFactory()
    const owned = this.#countOwned(owner)
    if (owned >= this.#maxSessions) {
      throw new BrowserUseError('SESSION_LIMIT', `browser-use: 这个 owner 的会话数已达上限（${this.#maxSessions}）`)
    }
    const id = this.#mintId()
    const record: SessionRecord = {
      id,
      owner,
      tabs: new Map(),
      activeTabId: '',
      createdAt: Date.now(),
    }
    this.#sessions.set(id, record)
    try {
      const tab = await this.#openTab(record, url, factory)
      record.activeTabId = tab.id
    } catch (error) {
      // 开到一半就废掉整个会话，别留半个浏览器在外面跑。
      this.#sessions.delete(id)
      throw error
    }
    return this.#view(record)
  }

  /**
   * 在已有会话里再开一个标签页。
   * @param owner - 会话归属者。
   * @param sessionId - 会话 id。
   * @param url - 新标签页要去的地址。
   * @returns 新标签页。
   */
  async openTab(owner: BrowserOwner, sessionId: string, url: string): Promise<BrowserTabView> {
    const factory = this.#requireFactory()
    const record = this.#require(owner, sessionId)
    if (record.tabs.size >= this.#maxTabs) {
      throw new BrowserUseError('TAB_LIMIT', `browser-use: 这个会话的标签页数已达上限（${this.#maxTabs}）`)
    }
    const tab = await this.#openTab(record, url, factory)
    record.activeTabId = tab.id
    return { id: tab.id, url: tab.url }
  }

  /**
   * 做一次动作。
   *
   * **危险动作在这里被拦**：`submit`（提交表单）与 `download`（下载文件）默认
   * 不放行，除非宿主显式开了对应策略。放行之后仍然走驱动，只是不再拦。
   * @param owner - 会话归属者。
   * @param sessionId - 会话 id。
   * @param action - 动作请求。
   */
  async act(owner: BrowserOwner, sessionId: string, action: BrowserAction): Promise<void> {
    const record = this.#require(owner, sessionId)
    const tab = this.#activeTab(record)
    switch (action.kind) {
      case 'click': {
        const selector = action.selector
        if (selector === undefined || selector.length === 0) {
          throw new BrowserUseError('INVALID_ARGUMENT', 'browser-use: click 需要一个选择器')
        }
        await this.#drive('点击', () => tab.driver.click(selector))
        return
      }
      case 'type': {
        const text = action.text
        if (text === undefined) {
          throw new BrowserUseError('INVALID_ARGUMENT', 'browser-use: type 需要一段文字')
        }
        await this.#drive('输入', () => tab.driver.type(text))
        return
      }
      case 'submit': {
        if (!this.#policy.allowFormSubmit) {
          throw new BrowserUseError(
            'ACTION_NOT_ALLOWED',
            'browser-use: 提交表单默认是关着的，需要宿主显式放行（allowFormSubmit）',
          )
        }
        const submitter = tab.driver
        if (!isFormSubmitter(submitter)) {
          throw new BrowserUseError('UNSUPPORTED_ACTION', 'browser-use: 这个驱动不会提交表单')
        }
        const selector = action.selector
        await this.#drive('提交表单', () => (selector === undefined ? submitter.submit() : submitter.submit(selector)))
        return
      }
      case 'download': {
        if (!this.#policy.allowDownload) {
          throw new BrowserUseError(
            'ACTION_NOT_ALLOWED',
            'browser-use: 下载文件默认是关着的，需要宿主显式放行（allowDownload）',
          )
        }
        const downloader = tab.driver
        if (!isDownloader(downloader)) {
          throw new BrowserUseError('UNSUPPORTED_ACTION', 'browser-use: 这个驱动不会下载文件')
        }
        const selector = action.selector
        if (selector === undefined || selector.length === 0) {
          throw new BrowserUseError('INVALID_ARGUMENT', 'browser-use: download 需要一个选择器')
        }
        await this.#drive('下载文件', () => downloader.download(selector))
        return
      }
    }
  }

  /**
   * 读当前标签页的正文或截图。
   * @param owner - 会话归属者。
   * @param sessionId - 会话 id。
   * @param kind - 读正文还是读截图。
   * @returns 读到的内容。
   */
  async read(owner: BrowserOwner, sessionId: string, kind: 'text' | 'screenshot'): Promise<BrowserReadResult> {
    const record = this.#require(owner, sessionId)
    const tab = this.#activeTab(record)
    if (kind === 'text') {
      const text = await this.#drive('读页面正文', () => tab.driver.readText())
      return { kind: 'text', text }
    }
    const shot = await this.#drive('截图', () => tab.driver.screenshot())
    return { kind: 'screenshot', bytes: shot.bytes, mimeType: shot.mimeType }
  }

  /**
   * 取一个会话。
   * @param owner - 调用者。
   * @param sessionId - 会话 id。
   * @returns 会话视图。
   */
  get(owner: BrowserOwner, sessionId: string): BrowserSessionView {
    return this.#view(this.#require(owner, sessionId))
  }

  /**
   * 列某个 owner 的会话。
   *
   * **只列自己的**：别人的会话连 id 都不该出现在列表里。
   * @param owner - 调用者。
   * @returns 会话视图列表。
   */
  list(owner: BrowserOwner): readonly BrowserSessionView[] {
    const views: BrowserSessionView[] = []
    for (const record of this.#sessions.values()) {
      if (record.owner === owner) views.push(this.#view(record))
    }
    return views
  }

  /**
   * 关掉一个会话，连同它里面所有标签页。
   *
   * 关不掉就如实报错，不能假装关好了——「以为关了其实还在跑」比「明确报失败」
   * 难查得多。关不掉的会话仍然留在表里，还能再收一次。
   * @param owner - 会话归属者。
   * @param sessionId - 会话 id。
   */
  async close(owner: BrowserOwner, sessionId: string): Promise<void> {
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
      throw new BrowserUseError('CLEANUP_FAILED', `browser-use: 有会话没关干净：${failures.join('；')}`)
    }
  }

  /**
   * 取一个属于该 owner 的会话。
   * @param owner - 调用者。
   * @param sessionId - 会话 id。
   * @returns 会话记录。
   */
  #require(owner: BrowserOwner, sessionId: string): SessionRecord {
    const record = this.#sessions.get(sessionId)
    if (record === undefined || record.owner !== owner) {
      throw new BrowserUseError('NO_SESSION', 'browser-use: 没有这个会话')
    }
    return record
  }

  /** 当前正在操作的标签页。 */
  #activeTab(record: SessionRecord): TabRecord {
    const tab = record.tabs.get(record.activeTabId)
    if (tab === undefined) {
      throw new BrowserUseError('NO_SESSION', 'browser-use: 这个会话里没有标签页')
    }
    return tab
  }

  /** 这个 owner 现在有几个会话。 */
  #countOwned(owner: BrowserOwner): number {
    let count = 0
    for (const record of this.#sessions.values()) {
      if (record.owner === owner) count += 1
    }
    return count
  }

  /**
   * 取出驱动工厂；没装浏览器就说清楚，不假装能做。
   * @returns 驱动工厂。
   */
  #requireFactory(): BrowserDriverFactory {
    const factory = this.#driverFactory
    if (factory === undefined) {
      throw new BrowserUseError('NO_DRIVER', 'browser-use: 没装浏览器驱动，这个包不自带浏览器')
    }
    return factory
  }

  /**
   * 开一个标签页：校验地址、造驱动、导航。
   * @param record - 所属会话。
   * @param url - 要去的地址。
   * @param factory - 驱动工厂。
   * @returns 标签页记录。
   */
  async #openTab(
    record: SessionRecord,
    url: string,
    factory: BrowserDriverFactory,
  ): Promise<TabRecord> {
    const target = await assertNavigableUrl(url, {
      allowPrivateNetwork: this.#policy.allowPrivateNetwork,
      resolveHost: this.#resolveHost,
    })
    const driver = await factory()
    const tab: TabRecord = { id: this.#mintId(), driver, url: target.toString() }
    try {
      await this.#drive('打开页面', () => driver.open(target.toString()))
    } catch (error) {
      // 页面没打开成功，这个标签页不算数：把驱动收掉，别留半个浏览器。
      await this.#closeDriver(driver)
      throw error
    }
    record.tabs.set(tab.id, tab)
    return tab
  }

  /**
   * 跑一步驱动动作：带时限，失败结构化。
   * @param label - 动作名（出错时进消息）。
   * @param work - 要做的事。
   */
  async #drive<T>(label: string, work: () => Promise<T>): Promise<T> {
    try {
      return await withTimeout(work(), this.#stepTimeoutMs, label)
    } catch (error) {
      if (error instanceof BrowserUseError) throw error
      throw new BrowserUseError('DRIVER_FAILED', `browser-use: ${label}失败：${describe(error)}`)
    }
  }

  /**
   * 关掉一个标签页的驱动；关不掉就记下来，不当没发生。
   * @param driver - 驱动。
   */
  async #closeDriver(driver: BrowserDriver): Promise<void> {
    try {
      await driver.close()
    } catch {
      // 收尾失败没有更好的去处：往上抛会让「会话已经关好了」这句话变成假的。
    }
  }

  /**
   * 关掉一个会话并把它从表里摘掉。
   * @param record - 会话记录。
   */
  async #closeRecord(record: SessionRecord): Promise<void> {
    const failures: string[] = []
    for (const tab of record.tabs.values()) {
      try {
        await tab.driver.close()
      } catch (error) {
        failures.push(`${tab.id}: ${describe(error)}`)
      }
    }
    if (failures.length > 0) {
      // 关不干净就不从表里删：删了这个会话就再也没法收它了。
      throw new BrowserUseError('CLEANUP_FAILED', `browser-use: 会话 ${record.id} 没关干净：${failures.join('；')}`)
    }
    record.tabs.clear()
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
  #view(record: SessionRecord): BrowserSessionView {
    const tabs: BrowserTabView[] = []
    for (const tab of record.tabs.values()) {
      tabs.push({ id: tab.id, url: tab.url })
    }
    return {
      id: record.id,
      owner: record.owner,
      tabs,
      activeTabId: record.activeTabId,
      createdAt: record.createdAt,
    }
  }
}

/** 驱动会不会提交表单。 */
function isFormSubmitter(driver: BrowserDriver): driver is BrowserDriver & BrowserFormSubmitter {
  return typeof (driver as Partial<BrowserFormSubmitter>).submit === 'function'
}

/** 驱动会不会下载文件。 */
function isDownloader(driver: BrowserDriver): driver is BrowserDriver & BrowserDownloader {
  return typeof (driver as Partial<BrowserDownloader>).download === 'function'
}
