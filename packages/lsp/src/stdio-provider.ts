/**
 * 用一个本机的 stdio 语言服务器当 provider。
 *
 * 上游 dsh 把它单独拆成一个包（`lsp-stdio`），我们合在一个包里：对外是同一个
 * {@link LspProvider} 接口，分成两个包只是因为上游那边要挂到 cordis 的 ctx 上，
 * 而我们这边还没有那一层装配。
 *
 * 这一层做的事，按时间顺序：
 * 1. 按配置把语言服务器拉起来（`command` + `args` + `extensions`）；
 * 2. 走完整的 LSP 握手：`initialize` 请求 → 等回包 → 发 `initialized` 通知；
 * 3. 每次导航前发 `textDocument/didOpen`（服务器得先看见文件内容才能答）；
 * 4. 发四个只读请求之一，把回包翻译成归一化的形状。
 *
 * **不装语言服务器本体**：本包不含任何语言服务器，配置里写的命令不在 PATH 上时
 * 就如实说「找不到这个语言服务器命令」，不静默降级成 grep 之类的替代品——
 * 假装能导航比明说不能导航坏得多。
 * @module @ryharness/lsp/stdio-provider
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { LspConnection } from './connection.ts'
import { describeLspFailure, LspError } from './errors.ts'
import { normalizeHover, normalizeLocations } from './normalize.ts'
import type {
  LspHover,
  LspLocation,
  LspOperation,
  LspProvider,
  LspProviderCapabilities,
  LspSourcePosition,
} from './types.ts'
import { LSP_OPERATIONS } from './types.ts'
import { pathToUri } from './uri.ts'

/** 四个操作各自对应的 LSP 请求方法名。 */
const REQUEST_METHODS: Record<LspOperation, string> = {
  definition: 'textDocument/definition',
  references: 'textDocument/references',
  implementations: 'textDocument/implementation',
  hover: 'textDocument/hover',
}

/** 扩展名 → 语言服务器的 languageId。认不出来的就用扩展名本身。 */
const LANGUAGE_IDS: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.scala': 'scala',
  '.sh': 'shellscript',
  '.bash': 'shellscript',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.md': 'markdown',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.vue': 'vue',
  '.svelte': 'svelte',
}

/** 默认的单次请求时限（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 15_000

/** provider 的运行状态。 */
export type StdioLspProviderStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'unavailable'

/** 一个 stdio 语言服务器的配置。 */
export interface StdioLspProviderConfig {
  /** 语言服务器的命令（例如 `typescript-language-server`）。 */
  readonly command: string
  /** 命令的参数（例如 `['--stdio']`）。 */
  readonly args?: readonly string[]
  /** 这个 provider 处理哪些扩展名（带点，例如 `['.ts', '.tsx']`）。 */
  readonly extensions: readonly string[]
  /** 工作区根目录：既当 `rootUri` 报给服务器，也当「文件在不在工作区」的边界。 */
  readonly rootPath?: string
  /** `initialize` 里的 `initializationOptions`，原样透传。 */
  readonly initOptions?: unknown
  /** 限定这个 provider 只做这几个操作；缺省是四个都做（再由服务器自述的能力收窄）。 */
  readonly operations?: readonly LspOperation[]
  /** 传给子进程的环境变量（同名的覆盖继承来的）。 */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** provider 的构造选项。 */
export interface StdioLspProviderOptions {
  /** provider 的标识；缺省用 `stdio:<命令>`。 */
  readonly id?: string
  /** 单次请求时限（毫秒）。 */
  readonly timeoutMs?: number
  /** 子进程的工作目录；缺省用工作区根目录。 */
  readonly cwd?: string
  /** 追加的环境变量（同名的覆盖继承来的）。 */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** stderr 的回调。 */
  readonly onStderr?: (text: string) => void
  /** 进程崩了之后要不要自动重起（缺省要）。 */
  readonly autoRestart?: boolean
}

/** 是不是一个普通对象（不是数组、不是 null）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 服务器自述支持某项能力吗。
 *
 * 协议里这些字段要么不出现（不支持），要么是 `true` 或一个选项对象。出现即为支持。
 * @param value - 能力字段的原始值。
 * @returns 支持就是 true。
 */
function serverSupports(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false
}

/**
 * 从 `initialize` 的回包里读出服务器支持哪些操作。
 *
 * 读不出来就当它一个都不支持——服务器连能力都不报，我们就没有依据去相信它会
 * 回答某个请求。与其打一发过去等超时，不如现在就说「它不支持」。
 * @param result - `initialize` 的 `result`。
 * @returns 支持的操作列表。
 */
export function readServerOperations(result: unknown): readonly LspOperation[] {
  if (!isRecord(result) || !isRecord(result.capabilities)) return []
  const capabilities = result.capabilities
  const operations: LspOperation[] = []
  if (serverSupports(capabilities.definitionProvider)) operations.push('definition')
  if (serverSupports(capabilities.referencesProvider)) operations.push('references')
  if (serverSupports(capabilities.implementationProvider)) operations.push('implementations')
  if (serverSupports(capabilities.hoverProvider)) operations.push('hover')
  return operations
}

/**
 * 猜一个文件在语言服务器那边叫什么语言。
 *
 * 猜错的后果不大（服务器多半会按后缀再判一次），但完全不给 languageId 有些服务器
 * 会直接不认这个文档。没有扩展名的文件按纯文本算——那是唯一说得过去的默认值。
 * @param filePath - 文件路径。
 * @returns languageId。
 */
export function languageIdFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  const known = LANGUAGE_IDS[extension]
  if (known !== undefined) return known
  if (extension.length === 0) return 'plaintext'
  return extension.slice(1)
}

/**
 * 一个用本机 stdio 语言服务器当后端的 provider。
 *
 * 生命周期是「懒起、可用、可能崩、能重起」：
 * - 第一次调用某个操作时才起进程并握手；
 * - 进程自己没了，provider 变成 `unavailable` 并记下原因；
 * - 下一次调用会尝试重起（`autoRestart` 关掉就不重起，直接报不可用）。
 */
export class StdioLspProvider implements LspProvider {
  readonly id: string
  readonly extensions: readonly string[]
  private readonly config: StdioLspProviderConfig
  private readonly options: StdioLspProviderOptions
  private connection: LspConnection | undefined
  private currentStatus: StdioLspProviderStatus = 'idle'
  private reason: string | undefined
  /** 握手之后才知道的服务器能力；没握手就是 undefined。 */
  private serverOperations: readonly LspOperation[] | undefined
  /** 已经 didOpen 过的文档 URI：同一个文件不用反复打开。 */
  private readonly opened = new Set<string>()
  /** 正在进行的握手；用来避免并发调用各起一个进程。 */
  private starting: Promise<void> | undefined
  /** 正在主动关闭：这时进程退出不算「崩了」。 */
  private stopping = false

  constructor(config: StdioLspProviderConfig, options: StdioLspProviderOptions = {}) {
    this.config = config
    this.options = options
    this.id = options.id ?? `stdio:${config.command}`
    this.extensions = config.extensions.map((extension) => extension.toLowerCase())
  }

  /** provider 支持哪些操作。 */
  get capabilities(): LspProviderCapabilities {
    const declared = this.config.operations ?? LSP_OPERATIONS
    const server = this.serverOperations
    if (server === undefined) return { operations: declared }
    // 配置限定的与服务器自述的取交集：两头都支持才算支持。
    return { operations: declared.filter((operation) => server.includes(operation)) }
  }

  /** 现在是什么状态。 */
  get status(): StdioLspProviderStatus {
    return this.currentStatus
  }

  /** 不可用的原因（没不可用就是 undefined）。 */
  get unavailableReason(): string | undefined {
    return this.reason
  }

  /**
   * 起进程并完成握手。
   *
   * 重复调用没有副作用：已经在跑就直接返回，正在握手就等那一次。
   * @returns 握手完成后 resolve。
   */
  async start(): Promise<void> {
    if (this.currentStatus === 'running') return
    const pending = this.starting
    if (pending !== undefined) {
      await pending
      return
    }
    const work = this.performHandshake()
    this.starting = work
    try {
      await work
    } finally {
      this.starting = undefined
    }
  }

  /**
   * 关掉语言服务器。
   *
   * 顺序是 LSP 规定的：先发 `shutdown` 请求并等回包，再发 `exit` 通知。服务器收到
   * `exit` 就自己退；不退的话我们等一会儿再强杀。
   */
  async stop(): Promise<void> {
    this.stopping = true
    try {
      const connection = this.connection
      this.connection = undefined
      this.opened.clear()
      this.serverOperations = undefined
      if (connection !== undefined) {
        try {
          await connection.request('shutdown', null, Math.min(this.timeoutMs, 2_000))
        } catch {
          // 服务器可能已经没了；shutdown 失败不影响收尾。
        }
        connection.notify('exit', null)
        await connection.close()
      }
      this.currentStatus = 'stopped'
      this.reason = undefined
    } finally {
      this.stopping = false
    }
  }

  /**
   * 重起：关掉再起一次。
   *
   * 崩溃之后用得上——进程自己没了、状态变成 `unavailable`，这里能手动把它拉回来。
   */
  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  /** 跳定义。 */
  async definition(filePath: string, position: LspSourcePosition): Promise<LspLocation[]> {
    return normalizeLocations(await this.call('definition', filePath, position))
  }

  /** 找引用。 */
  async references(filePath: string, position: LspSourcePosition): Promise<LspLocation[]> {
    return normalizeLocations(await this.call('references', filePath, position))
  }

  /** 找实现。 */
  async implementations(filePath: string, position: LspSourcePosition): Promise<LspLocation[]> {
    return normalizeLocations(await this.call('implementations', filePath, position))
  }

  /** 读 hover 文档；没有就返回 undefined。 */
  async hover(filePath: string, position: LspSourcePosition): Promise<LspHover | undefined> {
    return normalizeHover(await this.call('hover', filePath, position))
  }

  /** 收尾：关掉语言服务器。 */
  async dispose(): Promise<void> {
    await this.stop()
  }

  /** 单次请求的时限。 */
  private get timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * 真的走一遍握手。
   *
   * 握手失败时把 provider 标成 `unavailable` 并记下原因——这样界面与模型都能知道
   * 「它没起来」，而不是看到一句没头没尾的英文异常。
   */
  private async performHandshake(): Promise<void> {
    this.currentStatus = 'starting'
    this.reason = undefined
    const connection = new LspConnection({
      command: this.config.command,
      args: this.config.args,
      cwd: this.options.cwd ?? this.config.rootPath,
      env: { ...this.config.env, ...this.options.env },
      onStderr: this.options.onStderr,
      onExit: (info) => {
        this.handleExit(info)
      },
    })
    this.connection = connection
    connection.start()
    try {
      const result = await connection.request('initialize', this.initializeParams(), this.timeoutMs)
      this.serverOperations = readServerOperations(result)
      // 握手到这一步才算完：服务器回了 initialize 的结果，我们再告诉它「我准备好了」。
      connection.notify('initialized', {})
      this.currentStatus = 'running'
    } catch (error) {
      this.currentStatus = 'unavailable'
      this.reason = describeLspFailure(error)
      this.connection = undefined
      this.serverOperations = undefined
      // 收尾时进程退出是**我们**让它退的：这时「它退出了」不是更有用的原因，
      // 上面那句握手失败的原因才是。
      this.stopping = true
      try {
        await connection.close()
      } finally {
        this.stopping = false
      }
      throw error instanceof LspError ? error : new LspError('server-unavailable', this.reason)
    }
  }

  /**
   * 进程自己走了。
   *
   * 主动 `stop()` 引起的退出不算意外——那是我们让它退的。
   */
  private handleExit(info: { code: number | null; signal: NodeJS.Signals | null }): void {
    if (this.stopping) return
    this.currentStatus = 'unavailable'
    this.reason = `语言服务器进程已退出（退出码 ${info.code ?? '无'}，信号 ${info.signal ?? '无'}）`
    this.serverOperations = undefined
    this.opened.clear()
    this.connection = undefined
  }

  /**
   * 保证有一个能用的连接。
   *
   * 崩过之后默认自动重起：语言服务器崩了多半是它自己某个文件解析炸了，重起一次
   * 通常就好了。`autoRestart: false` 时不重起，直接报不可用。
   */
  private async ensureReady(): Promise<void> {
    if (this.currentStatus === 'running' && this.connection !== undefined) return
    if (this.currentStatus === 'unavailable' && this.options.autoRestart === false) {
      throw new LspError('server-unavailable', this.reason ?? '语言服务器不可用')
    }
    await this.start()
  }

  /** 这个操作不支持就说清楚，不去打服务器。 */
  private requireOperation(operation: LspOperation): void {
    if (this.capabilities.operations.includes(operation)) return
    throw new LspError('unsupported-operation', `这个语言服务器（${this.id}）不支持 ${operation} 操作`)
  }

  /**
   * 发一次请求。
   *
   * 顺序不能错：先确保服务器在跑，再确认它支持这个操作，然后打开文档，最后才问。
   */
  private async call(operation: LspOperation, filePath: string, position: LspSourcePosition): Promise<unknown> {
    await this.ensureReady()
    this.requireOperation(operation)
    const connection = this.connection
    if (connection === undefined) {
      throw new LspError('server-unavailable', this.reason ?? '语言服务器连接已经没了')
    }
    const uri = await this.openDocument(filePath)
    const params: Record<string, unknown> = {
      textDocument: { uri },
      position: { line: position.line, character: position.character },
    }
    if (operation === 'references') {
      params.context = { includeDeclaration: true }
    }
    return await connection.request(REQUEST_METHODS[operation], params, this.timeoutMs)
  }

  /**
   * 打开文档（发 `textDocument/didOpen`）。
   *
   * 少了这一步，服务器根本没见过这个文件的内容——它答「没有定义」不是因为真没有，
   * 而是因为它压根没读过这个文件。这是语言服务器集成里最常见的哑巴失败。
   */
  private async openDocument(filePath: string): Promise<string> {
    const absolute = path.resolve(filePath)
    this.requireInWorkspace(absolute)
    const uri = pathToUri(absolute)
    if (this.opened.has(uri)) return uri
    let text: string
    try {
      text = await readFile(absolute, 'utf8')
    } catch {
      throw new LspError('file-not-found', `读不到这个文件：${filePath}`)
    }
    const connection = this.connection
    if (connection === undefined) {
      throw new LspError('server-unavailable', this.reason ?? '语言服务器连接已经没了')
    }
    connection.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: languageIdFor(absolute), version: 1, text },
    })
    this.opened.add(uri)
    return uri
  }

  /** 文件在工作区外就说清楚——服务器也答不了它。 */
  private requireInWorkspace(absolutePath: string): void {
    const root = this.config.rootPath
    if (root === undefined) return
    const rootAbsolute = path.resolve(root)
    const relative = path.relative(rootAbsolute, absolutePath)
    if (relative.length === 0) return
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new LspError('file-not-in-workspace', `这个文件不在工作区里：${absolutePath}（工作区是 ${rootAbsolute}）`)
    }
  }

  /** `initialize` 的参数。 */
  private initializeParams(): Record<string, unknown> {
    const root = this.config.rootPath
    const rootUri = root === undefined ? null : pathToUri(root)
    return {
      processId: process.pid,
      clientInfo: { name: 'ryharness-lsp', version: '0.3.0' },
      rootPath: root ?? null,
      rootUri,
      workspaceFolders: root === undefined ? null : [{ uri: rootUri, name: path.basename(path.resolve(root)) }],
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          references: {},
          implementation: { linkSupport: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
        },
      },
      initializationOptions: this.config.initOptions ?? null,
    }
  }
}
