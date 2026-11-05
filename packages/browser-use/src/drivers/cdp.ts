/**
 * CDP 驱动：用本机已装的 Chromium 内核浏览器（Edge / Chrome）真正开页面。
 *
 * **为什么选 CDP 而不是 Playwright**：Playwright 要拖几百 MB 的浏览器二进制，
 * 装进包依赖里不成比例；而本机本来就装着 Edge / Chrome，用 CDP 连它既不用下载，
 * 也不用多一个依赖。本文件只用 Node 内置的 `WebSocket`（Node 22+ 自带）与
 * `node:child_process`，**零新增依赖**。
 *
 * **驱动模型**：`BrowserDriver` 的一个实例对应一个标签页（本包的既有约定，见
 * `types.ts`）。所以这里的结构是「一个浏览器进程 + 一个 CDP 连接 + 每个标签页
 * 一个 target」。浏览器进程由 {@link CdpBrowser} 持有，标签页关掉不影响它；
 * 整个浏览器进程的生命周期由宿主管（`close()`）。
 *
 * **每助理一个浏览器上下文**：CDP 的 `Target.createBrowserContext` 给出互相隔离
 * 的 cookie 与存储，两个助理不会串味。
 *
 * @module @ryharness/browser-use/drivers/cdp
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserUseError } from '../errors.ts'
import type { BrowserDriver, BrowserScreenshot } from '../types.ts'

/** 驱动名。 */
const DRIVER_NAME = 'cdp'

/** 等浏览器把 DevToolsActivePort 写出来的时限（毫秒）。 */
const DEFAULT_LAUNCH_TIMEOUT_MS = 20_000

/** 导航后等页面加载完成的时限（毫秒）。 */
const DEFAULT_NAVIGATE_TIMEOUT_MS = 20_000

/** 读正文时截断到多少字符（正文可以很长，全量塞给模型没意义）。 */
const MAX_TEXT_CHARS = 100_000

/** 一个 CDP 命令的回复。 */
interface CdpReply {
  readonly result?: Record<string, unknown>
  readonly error?: { readonly message?: string; readonly code?: number }
}

/**
 * 已知的浏览器可执行文件（按平台）。
 *
 * **不做自动下载**：找不到就如实报「没找到浏览器」，让用户自己装或者用
 * `RYHARNESS_BROWSER_PATH` 指一个。悄悄下载几百 MB 的东西不是宿主该替用户做的决定。
 */
function candidatePaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): readonly string[] {
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = env.LOCALAPPDATA ?? ''
    const out = [
      join(programFiles, 'Microsoft/Edge/Application/msedge.exe'),
      join(programFilesX86, 'Microsoft/Edge/Application/msedge.exe'),
      join(programFiles, 'Google/Chrome/Application/chrome.exe'),
      join(programFilesX86, 'Google/Chrome/Application/chrome.exe'),
    ]
    if (localAppData.length > 0) {
      out.push(join(localAppData, 'Google/Chrome/Application/chrome.exe'))
      out.push(join(localAppData, 'Microsoft/Edge/Application/msedge.exe'))
    }
    return out
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ]
}

/**
 * 找一个能用的浏览器可执行文件。
 *
 * 顺序：显式给的路径 → `RYHARNESS_BROWSER_PATH` 环境变量 → 平台默认候选。
 * @param options - 查找选项。
 * @returns 找到的路径；没找到是 undefined。
 */
export function findBrowserExecutable(options: CdpBrowserOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const explicit = options.executablePath ?? env.RYHARNESS_BROWSER_PATH
  if (explicit !== undefined && explicit.length > 0) {
    return existsSync(explicit) ? explicit : undefined
  }
  for (const candidate of candidatePaths(env, platform)) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** CDP 浏览器与驱动的构造参数。 */
export interface CdpBrowserOptions {
  /** 浏览器可执行文件路径；缺省按平台找，也认 `RYHARNESS_BROWSER_PATH`。 */
  readonly executablePath?: string
  /** 宿主环境；缺省用 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv
  /** 平台；缺省当前平台。 */
  readonly platform?: NodeJS.Platform
  /** 要不要开无头窗口。默认 true。 */
  readonly headless?: boolean
  /** 等浏览器起来的时限（毫秒）。默认 20000。 */
  readonly launchTimeoutMs?: number
  /** 导航后等页面加载的时限（毫秒）。默认 20000。 */
  readonly navigateTimeoutMs?: number
  /** 浏览器用户数据目录；缺省在临时目录里建一个。 */
  readonly userDataDir?: string
}

/** 一个 CDP 标签页的连接。 */
interface CdpTab {
  readonly targetId: string
  readonly sessionId: string
}

/**
 * CDP 连接：把「发命令、等回复」这件事收在一处。
 *
 * CDP 的消息按 `id` 对应请求与回复，事件没有 `id`——事件由 `onEvent` 的回调接走。
 */
class CdpConnection {
  #socket: WebSocket
  #nextId = 0
  #pending = new Map<number, { resolve: (value: CdpReply) => void; reject: (error: Error) => void }>()
  #onEvent: (method: string, params: Record<string, unknown>, sessionId?: string) => void

  constructor(socket: WebSocket, onEvent: (method: string, params: Record<string, unknown>, sessionId?: string) => void) {
    this.#socket = socket
    this.#onEvent = onEvent
    this.#socket.addEventListener('message', (event: MessageEvent) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data)
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        return
      }
      if (typeof parsed !== 'object' || parsed === null) return
      const message = parsed as {
        id?: number
        method?: string
        params?: Record<string, unknown>
        sessionId?: string
        result?: Record<string, unknown>
        error?: { readonly message?: string; readonly code?: number }
      }
      if (typeof message.id === 'number') {
        const pending = this.#pending.get(message.id)
        if (pending === undefined) return
        this.#pending.delete(message.id)
        pending.resolve({ result: message.result, error: message.error })
        return
      }
      if (typeof message.method === 'string') {
        this.#onEvent(message.method, message.params ?? {}, message.sessionId)
      }
    })
  }

  /** 发一条命令并等它的回复。 */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpReply> {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BrowserUseError('DRIVER_FAILED', `browser-use: CDP 连接已断开（${method}）`))
    }
    const id = (this.#nextId += 1)
    return new Promise<CdpReply>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    }).then((reply) => {
      if (reply.error !== undefined) {
        const message = reply.error.message ?? '未知错误'
        throw new BrowserUseError('DRIVER_FAILED', `browser-use: CDP 命令 ${method} 失败：${message}`)
      }
      return reply
    })
  }

  /** 关掉连接。 */
  close(): void {
    try {
      this.#socket.close()
    } catch {
      // 关不上就当它关了；连接已经在错误路径上，不值得在这里再抛。
    }
  }
}

/**
 * 一个 CDP 浏览器：进程 + 连接 + 标签页管理。
 *
 * 宿主持有一个它，在插件卸载时 {@link close} 掉——**浏览器进程必须被收掉**，
 * 否则用户机器上会留一堆 headless 浏览器。
 */
export class CdpBrowser {
  #process: ChildProcess
  #connection: CdpConnection
  #contextId: string
  #userDataDir: string
  #ownsUserDataDir: boolean
  #tabs = new Set<string>()

  private constructor(init: {
    process: ChildProcess
    connection: CdpConnection
    contextId: string
    userDataDir: string
    ownsUserDataDir: boolean
  }) {
    this.#process = init.process
    this.#connection = init.connection
    this.#contextId = init.contextId
    this.#userDataDir = init.userDataDir
    this.#ownsUserDataDir = init.ownsUserDataDir
  }

  /**
   * 起一个浏览器并连上它。
   *
   * 找不到浏览器就报 `NO_DRIVER`——**不假装成功**。
   * @param options - 构造参数。
   * @returns 连好的浏览器。
   */
  static async launch(options: CdpBrowserOptions = {}): Promise<CdpBrowser> {
    const env = options.env ?? process.env
    const executable = findBrowserExecutable(options)
    if (executable === undefined) {
      throw new BrowserUseError(
        'NO_DRIVER',
        'browser-use: 本机没找到 Edge 或 Chrome。装一个，或者用 RYHARNESS_BROWSER_PATH 指一个可执行文件。',
      )
    }
    const ownsUserDataDir = options.userDataDir === undefined
    const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'ryharness-browser-'))
    const headless = options.headless ?? true
    const args = [
      `--user-data-dir=${userDataDir}`,
      // 端口 0：让浏览器自己挑一个空闲端口，然后把端口写进 DevToolsActivePort。
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-extensions',
      '--disable-gpu',
      'about:blank',
    ]
    if (headless) args.unshift('--headless=new')

    const child = spawn(executable, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout?.resume()
    child.stderr?.resume()

    const timeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS
    const port = await waitForDevToolsPort(userDataDir, timeoutMs, child)
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`)
    const webSocketDebuggerUrl = version.webSocketDebuggerUrl
    if (typeof webSocketDebuggerUrl !== 'string') {
      child.kill()
      throw new BrowserUseError('DRIVER_FAILED', 'browser-use: 浏览器起来了，但没给出调试地址。')
    }

    const socket = await openWebSocket(webSocketDebuggerUrl)
    const connection = new CdpConnection(socket, () => undefined)
    const contextReply = await connection.send('Target.createBrowserContext', { disposeOnDetach: true })
    const contextId = contextReply.result?.browserContextId
    if (typeof contextId !== 'string') {
      connection.close()
      child.kill()
      throw new BrowserUseError('DRIVER_FAILED', 'browser-use: 建不出独立的浏览器上下文。')
    }
    return new CdpBrowser({ process: child, connection, contextId, userDataDir, ownsUserDataDir })
  }

  /**
   * 开一个新标签页。
   * @returns 标签页句柄。
   */
  async newTab(): Promise<CdpTab> {
    const reply = await this.#connection.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId: this.#contextId,
    })
    const targetId = reply.result?.targetId
    if (typeof targetId !== 'string') {
      throw new BrowserUseError('DRIVER_FAILED', 'browser-use: 开不出标签页。')
    }
    const attach = await this.#connection.send('Target.attachToTarget', { targetId, flatten: true })
    const sessionId = attach.result?.sessionId
    if (typeof sessionId !== 'string') {
      throw new BrowserUseError('DRIVER_FAILED', 'browser-use: 连不上新标签页。')
    }
    await this.#connection.send('Page.enable', {}, sessionId)
    await this.#connection.send('Runtime.enable', {}, sessionId)
    this.#tabs.add(targetId)
    return { targetId, sessionId }
  }

  /** 关掉一个标签页。 */
  async closeTab(tab: CdpTab): Promise<void> {
    this.#tabs.delete(tab.targetId)
    try {
      await this.#connection.send('Target.closeTarget', { targetId: tab.targetId })
    } catch {
      // 关不掉就如实当它关了：这个标签页的进程由浏览器进程一起收。
    }
  }

  /** 发一条 CDP 命令。 */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpReply> {
    return this.#connection.send(method, params, sessionId)
  }

  /**
   * 关掉整个浏览器：连接、进程、临时目录都收掉。
   *
   * **顺序有讲究**：先断连接（浏览器会自己退），再杀进程（兜底），最后删临时目录。
   */
  async close(): Promise<void> {
    this.#connection.close()
    // 浏览器进程连着它的标签页：杀掉进程，标签页跟着没。
    // （#tabs 只是登记，关连接时浏览器自己会收掉那些标签页。）
    this.#tabs.clear()
    if (!this.#process.killed) {
      try {
        this.#process.kill()
      } catch {
        // 进程已经退了。
      }
    }
    // **等进程真的退了再删目录**：Windows 上浏览器还在收尾时，它的工作目录句柄
    // 挂着，这时候 rmSync 会报 EPERM——目录删不掉，就会在系统临时目录里攒下
    // 一堆几 MB 的浏览器配置目录（跑一轮测试能攒几十个）。
    await waitForExit(this.#process, 3_000)
    if (this.#ownsUserDataDir) {
      try {
        rmSync(this.#userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      } catch {
        // 删不掉就留着；它落在系统临时目录里，下次开机自己会清。
      }
    }
  }
}

/**
 * 等一个子进程退出。
 *
 * **退出码不参与判断**：浏览器被 kill 时退出码非零，那是「按要求退的」，不是失败。
 * @param child - 子进程。
 * @param timeoutMs - 等多久。
 */
async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      resolve()
    }, timeoutMs)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * 等浏览器把调试端口写出来。
 *
 * 浏览器启动后会在用户数据目录里写一个 `DevToolsActivePort` 文件，第一行是端口。
 * @param userDataDir - 用户数据目录。
 * @param timeoutMs - 时限。
 * @param child - 浏览器进程（用来判断它是不是已经死了）。
 * @returns 端口号。
 */
async function waitForDevToolsPort(userDataDir: string, timeoutMs: number, child: ChildProcess): Promise<number> {
  const portFile = join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new BrowserUseError('DRIVER_FAILED', `browser-use: 浏览器进程自己退了（退出码 ${child.exitCode}）。`)
    }
    if (existsSync(portFile)) {
      const text = readFileSync(portFile, 'utf8')
      const first = text.split('\n')[0]?.trim()
      const port = Number.parseInt(first ?? '', 10)
      if (Number.isInteger(port) && port > 0) return port
    }
    await delay(100)
  }
  throw new BrowserUseError('DRIVER_FAILED', `browser-use: 浏览器 ${timeoutMs} 毫秒内没起来。`)
}

/** 读一个 JSON 接口。 */
async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new BrowserUseError('DRIVER_FAILED', `browser-use: 浏览器调试接口返回 ${response.status}。`)
  }
  return (await response.json()) as Record<string, unknown>
}

/** 开一个 WebSocket。 */
function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url)
    const onError = (): void => {
      reject(new BrowserUseError('DRIVER_FAILED', 'browser-use: 连不上浏览器的调试端口。'))
    }
    socket.addEventListener('open', () => {
      socket.removeEventListener('error', onError)
      resolve(socket)
    })
    socket.addEventListener('error', onError)
  })
}

/** 睡一会儿。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 一个 CDP 标签页驱动的构造参数。
 */
export interface CdpDriverOptions extends CdpBrowserOptions {
  /** 驱动用的浏览器。 */
  readonly browser: CdpBrowser
  /** 要操作的标签页。 */
  readonly tab: CdpTab
}

/**
 * 一个标签页上的 CDP 驱动。
 *
 * 形状与 `BrowserDriver` 一一对应：导航、点元素、打字、截图、读正文、关掉。
 */
export class CdpTabDriver implements BrowserDriver {
  readonly name = DRIVER_NAME

  #browser: CdpBrowser
  #tab: CdpTab
  #navigateTimeoutMs: number

  constructor(options: CdpDriverOptions) {
    this.#browser = options.browser
    this.#tab = options.tab
    this.#navigateTimeoutMs = options.navigateTimeoutMs ?? DEFAULT_NAVIGATE_TIMEOUT_MS
  }

  /** 导航到某个地址并等页面加载完。 */
  async open(url: string): Promise<void> {
    const reply = await this.#browser.send('Page.navigate', { url }, this.#tab.sessionId)
    const errorText = reply.result?.errorText
    if (typeof errorText === 'string') {
      throw new BrowserUseError('DRIVER_FAILED', `browser-use: 页面打不开：${errorText}`)
    }
    await this.#waitForLoad()
  }

  /** 点一个元素：先问出它的位置，再发真的鼠标事件。 */
  async click(selector: string): Promise<void> {
    const box = await this.#elementBox(selector)
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await this.#browser.send(
        'Input.dispatchMouseEvent',
        { type, x, y, button: 'left', clickCount: 1 },
        this.#tab.sessionId,
      )
    }
  }

  /** 在当前焦点位置打字。 */
  async type(text: string): Promise<void> {
    await this.#browser.send('Input.insertText', { text }, this.#tab.sessionId)
  }

  /** 截当前页面的图。 */
  async screenshot(): Promise<BrowserScreenshot> {
    const reply = await this.#browser.send('Page.captureScreenshot', { format: 'png' }, this.#tab.sessionId)
    const data = reply.result?.data
    if (typeof data !== 'string') {
      throw new BrowserUseError('DRIVER_FAILED', 'browser-use: 截图没拿到数据。')
    }
    return { bytes: Buffer.from(data, 'base64'), mimeType: 'image/png' }
  }

  /** 读当前页面的正文文本。 */
  async readText(): Promise<string> {
    const reply = await this.#browser.send(
      'Runtime.evaluate',
      {
        expression: 'document.body ? document.body.innerText : ""',
        returnByValue: true,
      },
      this.#tab.sessionId,
    )
    const value = reply.result?.result
    const text =
      typeof value === 'object' && value !== null
        ? (value as { value?: unknown }).value
        : undefined
    if (typeof text !== 'string') return ''
    return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text
  }

  /** 关掉这个标签页。 */
  async close(): Promise<void> {
    await this.#browser.closeTab(this.#tab)
  }

  /** 等页面加载完（`document.readyState` 到 complete）。 */
  async #waitForLoad(): Promise<void> {
    const deadline = Date.now() + this.#navigateTimeoutMs
    while (Date.now() < deadline) {
      const reply = await this.#browser.send(
        'Runtime.evaluate',
        { expression: 'document.readyState', returnByValue: true },
        this.#tab.sessionId,
      )
      const value = reply.result?.result
      const state =
        typeof value === 'object' && value !== null ? (value as { value?: unknown }).value : undefined
      if (state === 'complete') return
      await delay(150)
    }
    throw new BrowserUseError('TIMEOUT', `browser-use: 页面 ${this.#navigateTimeoutMs} 毫秒内没加载完。`)
  }

  /** 问出某个元素在视口里的位置。 */
  async #elementBox(selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
    const reply = await this.#browser.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()`,
        returnByValue: true,
      },
      this.#tab.sessionId,
    )
    const value = reply.result?.result
    const box = typeof value === 'object' && value !== null ? (value as { value?: unknown }).value : undefined
    if (typeof box !== 'object' || box === null) {
      throw new BrowserUseError('DRIVER_FAILED', `browser-use: 页面上找不到元素「${selector}」。`)
    }
    const record = box as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
    const x = typeof record.x === 'number' ? record.x : 0
    const y = typeof record.y === 'number' ? record.y : 0
    const width = typeof record.width === 'number' ? record.width : 0
    const height = typeof record.height === 'number' ? record.height : 0
    if (width === 0 || height === 0) {
      throw new BrowserUseError('DRIVER_FAILED', `browser-use: 元素「${selector}」没有可见区域（宽 ${width}、高 ${height}）。`)
    }
    return { x, y, width, height }
  }
}

/**
 * 造一个用 CDP 的驱动工厂。
 *
 * 给 {@link BrowserSessionService} 用：它每开一个标签页就调一次工厂。
 * 浏览器进程是**懒起**的（第一次调用才起），起好了就复用；`close()` 收掉整个浏览器。
 * @param options - 构造参数。
 * @returns 驱动工厂，带一个 `close`。
 */
export function createCdpDriverFactory(options: CdpBrowserOptions = {}): {
  driverFactory: () => Promise<BrowserDriver>
  close: () => Promise<void>
} {
  let browser: CdpBrowser | undefined
  let starting: Promise<CdpBrowser> | undefined

  /** 拿到浏览器（没起就起，起的过程中只起一次）。 */
  const ensureBrowser = async (): Promise<CdpBrowser> => {
    if (browser !== undefined) return browser
    if (starting === undefined) {
      starting = CdpBrowser.launch(options).then(
        (started) => {
          browser = started
          starting = undefined
          return started
        },
        (error: unknown) => {
          starting = undefined
          throw error
        },
      )
    }
    return starting
  }

  return {
    driverFactory: async () => {
      const started = await ensureBrowser()
      const tab = await started.newTab()
      return new CdpTabDriver({ browser: started, tab, ...options })
    },
    close: async () => {
      const started = browser
      browser = undefined
      if (started !== undefined) await started.close()
    },
  }
}
