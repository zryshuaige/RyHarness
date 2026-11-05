/**
 * 本地 shell 后端：用管道（pipe）起一个交互式 shell。
 *
 * ## 为什么是管道而不是 PTY
 *
 * 上游 dsh 的 `terminal-bash` 用的是真 PTY（`@xterm/headless` + node-pty），代价是
 * 引入原生模块。本项目不引 node-pty，于是走**管道模式**：shell 的 stdin/stdout 用
 * 普通管道接着。
 *
 * 管道模式能做什么、不能做什么，都是实测出来的，不是猜的：
 *
 * - **能**：跨多次调用保留工作目录与环境变量（`cd` 与 `export` 都留在那个 shell 里）。
 * - **能**：逐行执行命令、读回增量输出。
 * - **能**：用一条探针命令确认 shell 真的就绪了（见 {@link LocalShellSession.start}）。
 * - **不能**：跑全屏交互程序（vim/top 需要真 PTY）。
 * - **不能**：用 `\x03` 打断正在跑的命令。tty 的行规程（line discipline）负责把
 *   `\x03` 翻译成 SIGINT，管道没有行规程，于是这个字节只会变成 shell 的输入内容。
 *   实测：`ping -n 30 127.0.0.1` 运行时写入 `\x03`，命令照跑不误。**可靠的中断是
 *   终止前台那个命令进程**，见 {@link LocalShellSession.interrupt}。
 * - **不能**：用 `\x04` 表达 EOF。同理，真正的 EOF 是**关掉 stdin**。而且 `\x04`
 *   会留在 shell 的输入行里，把紧接着的那条命令弄坏（实测：下一条命令不报错，
 *   但也不执行）。
 *
 * 这些边界在 {@link TerminalBackendCapabilities} 里如实报给上层，README 也写清楚了。
 *
 * ## 方言差异
 *
 * 同一个后端要同时伺候 bash 与 pwsh，它们的命令行语法并不一样（`cd` 的写法、
 * 查当前目录的写法、报错的呈现方式都不同）。这些差异收在
 * {@link ShellDialect} 里，上层看不见。
 * @module @ryharness/terminal/local
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { localProvider, type ManagedStreamProcess, spawnManagedStream } from '@ryharness/subprocess'
import { TerminalBuffer } from './buffer.ts'
import {
  dialectOf,
  findDescendantPids,
  isBashStartupNoise,
  isConsoleHost,
  isInputEcho,
  type ShellDialect,
  stripAnsi,
} from './shell.ts'
import type {
  TerminalBackend,
  TerminalBackendCapabilities,
  TerminalBackendSession,
  TerminalBackendSpec,
  TerminalReadResult,
  TerminalShellDialect,
} from './types.ts'

/** 默认的就绪探测超时（毫秒）。 */
const DEFAULT_READY_TIMEOUT_MS = 15_000

/** 默认的目录切换超时（毫秒）。 */
const DEFAULT_CWD_TIMEOUT_MS = 10_000

/** 默认的单次读取上限（字节）。 */
const DEFAULT_MAX_READ_BYTES = 64 * 1024

/** 默认保留的输出总量上限（字节）。 */
const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024

/** 目录切换失败时 shell 打印的标记。 */
const CD_FAILED_MARKER = 'RY_CD_FAILED'

/**
 * 管道模式的能力声明。
 *
 * 三个字段都写死，不给上层留「以为能跑 vim」的余地。
 */
export const PIPE_MODE_CAPABILITIES: TerminalBackendCapabilities = {
  realPty: false,
  fullScreenInteractive: false,
  notes: '管道模式（非真 PTY）：跨调用保留 cwd 与环境变量；不能跑 vim/top 等全屏交互程序；中断靠终止前台命令进程实现。',
}

/** 一个可用的 shell 候选。 */
interface ShellCandidate {
  /** 可执行文件。 */
  readonly file: string
  /** 启动参数。 */
  readonly args: readonly string[]
}

/**
 * 某个方言下可用的 shell 候选（按优先级）。
 *
 * bash 一律带 `-i`：不带的话一条语法错就能让 shell 退出（实测退出码 2），会话就没了。
 * `--noediting` 关掉行编辑，连带**输入回显**也没有了（实测带 `-i` 不带它时，
 * 敲进去的命令会被原样写回 stderr）。
 * @param dialect - 方言。
 * @returns 候选列表。
 */
export function shellCandidates(dialect: TerminalShellDialect): readonly ShellCandidate[] {
  if (dialect === 'pwsh') {
    return [
      { file: 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'] },
      { file: 'powershell', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'] },
    ]
  }
  return [
    { file: 'C:/Program Files/Git/bin/bash.exe', args: ['--noprofile', '--norc', '--noediting', '-i'] },
    { file: 'C:/Program Files (x86)/Git/bin/bash.exe', args: ['--noprofile', '--norc', '--noediting', '-i'] },
    { file: '/bin/bash', args: ['--noprofile', '--norc', '--noediting', '-i'] },
    { file: '/usr/bin/bash', args: ['--noprofile', '--norc', '--noediting', '-i'] },
  ]
}

/** 判断某个候选在这台机器上是否存在。 */
function candidateExists(file: string): boolean {
  if (file.includes('/') || file.includes('\\')) return existsSync(file)
  // 纯命令名：交给 spawn 去试，找不到会报 ENOENT。
  return true
}

/** 生成一个不会被用户输出撞上的探针标记。 */
function probeToken(): string {
  return `__RY_TERMINAL_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}__`
}

/** 本地 shell 后端的构造参数。 */
export interface LocalShellBackendOptions {
  /** 用哪个方言。 */
  readonly dialect?: TerminalShellDialect
  /** 显式指定可执行文件（给了就只用它）。 */
  readonly shellPath?: string
  /** 单次读取上限。 */
  readonly maxReadBytes?: number
  /** 保留的输出总量上限。 */
  readonly maxBufferBytes?: number
}

/**
 * 本地 shell 后端。
 *
 * 一个实例可以开多个会话；每个会话一个 shell 进程。
 */
export class LocalShellBackend implements TerminalBackend {
  /** 后端类型名。 */
  readonly type = 'local'
  /** 能力声明。 */
  readonly capabilities = PIPE_MODE_CAPABILITIES
  /** 用哪个方言。 */
  readonly dialect: TerminalShellDialect
  /** 显式指定的可执行文件。 */
  readonly #shellPath: string | undefined
  /** 单次读取上限。 */
  readonly #maxReadBytes: number
  /** 保留上限。 */
  readonly #maxBufferBytes: number

  constructor(options: LocalShellBackendOptions = {}) {
    this.dialect = options.dialect ?? (process.platform === 'win32' ? 'pwsh' : 'bash')
    this.#shellPath = options.shellPath
    this.#maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES
    this.#maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES
  }

  /**
   * 起一个会话并等它就绪。
   *
   * 就绪探测没过就 reject，并且**把已经起来的进程收干净**——起了一半的 shell 留在
   * 机器上是最难查的一种泄漏。
   * @param spec - 启动参数。
   * @returns 就绪的会话句柄。
   */
  async open(spec: TerminalBackendSpec): Promise<TerminalBackendSession> {
    const candidates =
      this.#shellPath === undefined ? shellCandidates(this.dialect) : [{ file: this.#shellPath, args: [] }]
    const usable = candidates.filter((candidate) => candidateExists(candidate.file))
    if (usable.length === 0) {
      throw new Error(`terminal: 找不到可用的 ${this.dialect} shell`)
    }

    let lastError: unknown
    for (const candidate of usable) {
      const session = new LocalShellSession({
        dialect: this.dialect,
        file: candidate.file,
        args: candidate.args,
        cwd: spec.cwd,
        env: spec.env,
        maxReadBytes: this.#maxReadBytes,
        maxBufferBytes: this.#maxBufferBytes,
      })
      try {
        await session.start(spec.signal)
        return session
      } catch (error) {
        lastError = error
        await session.close().catch(() => undefined)
      }
    }
    throw new Error(`terminal: 起 ${this.dialect} shell 失败：${describeError(lastError)}`)
  }
}

/** 把错误对象变成一句人话。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 本地 shell 会话的构造参数。 */
interface LocalShellSessionOptions {
  readonly dialect: TerminalShellDialect
  readonly file: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly maxReadBytes: number
  readonly maxBufferBytes: number
}

/** 一次探针：等一个标记出现在输出里，同时把标记之前的输出攒下来。 */
interface Probe {
  /** 唯一标记。 */
  readonly token: string
  /** 标记出现之前攒到的 stdout。 */
  readonly captured: string[]
  /** 标记被读到时 resolve。 */
  readonly done: Promise<void>
  /** 标记被读到时的回调。 */
  readonly resolve: () => void
  /** 要写进 stdin 的完整命令（含标记）。 */
  command: string
}
/** 本地 shell 会话。 */
class LocalShellSession implements TerminalBackendSession {
  /** 方言。 */
  readonly dialect: TerminalShellDialect
  /** 能力声明。 */
  readonly capabilities = PIPE_MODE_CAPABILITIES
  /** 方言的命令写法。 */
  readonly #dialect: ShellDialect
  /** 顶层进程。 */
  #child: ChildProcess | undefined
  /** 托管句柄：起进程走 `@ryharness/subprocess`（环境与启动只有那一处实现）。 */
  #managed: ManagedStreamProcess | undefined
  /** 输出缓冲。 */
  readonly #buffer: TerminalBuffer
  /** 已退出。 */
  #exited = false
  /** 最近发出去的命令（用来认输入回显）。 */
  readonly #sent: string[] = []
  /** 正在等的探针。 */
  #probe: Probe | undefined
  /** 还没交出去的 stdout（可能含半个标记）。 */
  #stdoutPending = ''
  /** 还没成行的 stderr。 */
  #stderrPending = ''
  /** 当前工作目录。 */
  #cwd = ''

  constructor(options: LocalShellSessionOptions) {
    this.dialect = options.dialect
    this.#dialect = dialectOf(options.dialect)
    this.#cwd = options.cwd ?? process.cwd()
    this.#buffer = new TerminalBuffer({ maxBytes: options.maxBufferBytes, maxReadBytes: options.maxReadBytes })
    this.#envOverrides = { ...options.env }
    this.#file = options.file
    this.#args = options.args
  }

  /** 额外注入的环境变量。 */
  readonly #envOverrides: Record<string, string>
  /** 可执行文件。 */
  readonly #file: string
  /** 启动参数。 */
  readonly #args: readonly string[]

  /** 顶层进程 pid。 */
  get pid(): number | undefined {
    return this.#child?.pid
  }

  /**
   * 起进程并等就绪。
   *
   * 顺序是硬要求：**先确认进程活着，再发探针**。反过来的话，探针会写进一个还没
   * 起来的 shell 的 stdin 里，然后永远等不到回声。
   * @param signal - 取消信号。
   */
  async start(signal?: AbortSignal): Promise<void> {
    const managed = spawnManagedStream(localProvider, {
      command: this.#file,
      args: [...this.#args],
      cwd: this.#cwd,
      // 终端就是**用户自己的 shell**：他要的是自己的完整环境（`JAVA_HOME`、
      // `GOPATH`、各种 profile 都不在白名单里）。这一层的边界由沙箱管
      // （`packages/sandbox` 有自己的一份环境清洗）。
      inheritEnv: true,
      env: this.#envOverrides,
      label: `terminal:${this.#file}`,
    })
    const child = managed.child
    this.#child = child
    this.#managed = managed

    const spawnFailure = new Promise<never>((_resolve, reject) => {
      child.once('error', (error) => {
        reject(new Error(`terminal: 起 shell 失败：${describeError(error)}`))
      })
    })

    const stdout = child.stdout
    if (stdout !== null) {
      stdout.setEncoding('utf8')
      stdout.on('data', (chunk: string) => this.#onStdout(chunk))
    }
    const stderr = child.stderr
    if (stderr !== null) {
      stderr.setEncoding('utf8')
      stderr.on('data', (chunk: string) => this.#onStderr(chunk))
    }
    child.once('exit', () => {
      this.#exited = true
    })

    await Promise.race([spawnFailure, new Promise<void>((resolve) => child.once('spawn', resolve))])

    if (signal?.aborted === true) {
      throw new Error('terminal: 起 shell 被取消')
    }

    // 就绪探测：发一条打印标记的命令，等它的回声。
    // 只发标记（`null`）：标记之前不能有任何别的输出，否则那些输出会被当成
    // 「就绪之前 shell 说的话」留在缓冲里。
    const probe = this.#armProbe(null)
    this.#writeCommand(probe.command)

    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('terminal: shell 就绪探测超时'))
      }, DEFAULT_READY_TIMEOUT_MS)
      timer.unref?.()
    })
    await Promise.race([probe.done, timeout])
  }

  /** 等 shell 就绪（公开接口）。 */
  async waitReady(timeoutMs: number): Promise<void> {
    const probe = this.#probe
    if (probe === undefined) return
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`terminal: shell 就绪探测超时（${timeoutMs}ms）`))
      }, timeoutMs)
      timer.unref?.()
    })
    await Promise.race([probe.done, timeout])
  }

  /**
   * 往 shell 写一段输入。
   *
   * `submit` 为 true 时补一个换行，让 shell 真正执行这一行。
   *
   * **这里刻意不追加任何标记**：管道模式下 shell 是从 stdin 逐行读命令的，往里塞
   * 标记会混进 REPL（比如 python）的输入里，把会话弄坏。要确认「跑完了」就用
   * {@link read} 读输出。
   * @param text - 要写入的文本。
   * @param options - 是否补换行。
   */
  async send(text: string, options?: { readonly submit?: boolean }): Promise<void> {
    if (options?.submit === false) {
      this.#write(text)
      return
    }
    this.#writeCommand(text)
  }

  /**
   * 读一段增量输出。
   *
   * `waitMs` 是「等一会儿再读」：命令刚发出去时输出还没到，立刻读会读到空。
   * @param options - 上限与等待时长。
   * @returns 读取结果。
   */
  async read(options?: { readonly maxBytes?: number; readonly waitMs?: number }): Promise<TerminalReadResult> {
    const waitMs = options?.waitMs ?? 0
    if (waitMs > 0) {
      const deadline = Date.now() + waitMs
      while (this.#buffer.retainedBytes === 0 && !this.#exited && Date.now() < deadline) {
        await sleep(10)
      }
    }
    return this.#buffer.read(options?.maxBytes)
  }

  /**
   * 切工作目录并确认结果。
   *
   * 发完 `cd` 还要读回当前目录：**目录不存在时 shell 会报错但会话还活着**，调用方
   * 必须知道到底成没成。只发不管的话，调用方会以为已经切过去了。
   * @param path - 目标目录。
   * @param options - 等待时长。
   * @returns 改完之后 shell 报告的当前目录。
   */
  async changeDirectory(path: string, options?: { readonly timeoutMs?: number }): Promise<string> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_CWD_TIMEOUT_MS
    const probe = this.#armProbe(this.#dialect.cdCommand(path))
    this.#writeCommand(probe.command)

    const captured = await this.#waitProbe(probe, timeoutMs)
    const result = captured.trim()
    if (result.length === 0 || result === CD_FAILED_MARKER) {
      throw new Error(`terminal: 切目录失败（${path}）`)
    }
    this.#cwd = result
    return result
  }

  /**
   * 中断当前正在跑的命令。
   *
   * 管道模式下不能靠写 `\x03`（没有行规程，shell 只会把它当输入收下）。可靠的办法
   * 是**终止前台那个命令进程**：命令进程被杀掉，shell 回到读输入的状态，会话继续活着。
   *
   * **只杀最深的那一层**：Git Bash 会为每条命令再 fork 一个 `bash.exe`（实测进程树是
   * `bash.exe → bash.exe → PING.EXE`），杀掉中间那层会**把 shell 自己也带走**
   * （实测 shell 退出码 1）；只杀最深的叶子（`PING.EXE`）时 shell 活着，而且下一条
   * 命令照常执行。
   *
   * **控制台宿主不算命令**：Windows 上 `conhost.exe` 也是 shell 的子进程、也是叶子，
   * 但它不是命令——杀掉它 pwsh 会直接退出（连下一条命令的输出都收不到），Git Bash
   * 会变成收不到任何输出的空壳。所以叶子还要再筛一遍，见 {@link isConsoleHost}。
   */
  async interrupt(): Promise<void> {
    const pid = this.#child?.pid
    if (pid === undefined || this.#exited) return
    const tree = await findDescendantPids(pid)
    if (tree.all.length === 0) return
    const leaves = tree.leaves
    for (const leaf of leaves) {
      // 控制台宿主不是命令：杀了它 shell 自己也会跟着没。
      if (isConsoleHost(tree.names.get(leaf) ?? '')) continue
      await killProcess(leaf)
    }
  }

  /** 结束输入流（真 EOF）。 */
  async closeInput(): Promise<void> {
    const child = this.#child
    if (child === undefined || this.#exited) return
    const stdin = child.stdin
    if (stdin === null) return
    stdin.end()
  }

  /**
   * 关掉会话：杀掉整棵进程树，并等它真的退出。
   *
   * 「等它真的退出」是硬要求：返回时进程必须已经不在了。杀不掉时要如实报错，
   * 不能假装关好了。
   */
  async close(): Promise<void> {
    const child = this.#child
    const managed = this.#managed
    this.#child = undefined
    this.#managed = undefined
    if (child === undefined) return
    if (!this.#exited) {
      // 树回收走托管句柄（`@ryharness/subprocess` 那一处实现）：shell 自己起的
      // 子进程要一起收掉，只杀直接子进程会留下还在跑的孙进程。
      if (managed !== undefined) {
        await managed.kill('终端会话关闭')
      } else {
        const pid = child.pid
        if (pid !== undefined) await killProcessTree(pid)
      }
      // 等进程真正退出，最多 5 秒。超了就再上 SIGKILL——还不行就如实报错。
      const exited = await this.#waitExit(5_000)
      if (!exited) {
        child.kill('SIGKILL')
        const forced = await this.#waitExit(2_000)
        if (!forced) {
          throw new Error('terminal: shell 进程没能退出')
        }
      }
    }
    this.#buffer.clear()
  }

  /** 等进程退出。 */
  async #waitExit(timeoutMs: number): Promise<boolean> {
    if (this.#exited) return true
    const child = this.#child
    if (child === undefined) return true
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.off('exit', onExit)
        resolve(false)
      }, timeoutMs)
      const onExit = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      child.once('exit', onExit)
    })
  }

  /**
   * 准备一个探针。
   *
   * 探针命令与标记拼在一起发出：标记在命令**之后**，所以标记出现就说明前面那条
   * 命令跑完了。
   * @param command - 不含标记的命令；给 null 表示「只发标记」。
   * @returns 探针句柄。
   */
  #armProbe(command: string | null): Probe {
    const token = probeToken()
    const captured: string[] = []
    let resolveFn: () => void = () => undefined
    const done = new Promise<void>((resolve) => {
      resolveFn = resolve
    })
    const marker = this.#dialect.echo(token)
    const probe: Probe = {
      token,
      captured,
      done,
      resolve: resolveFn,
      command: command === null ? marker : `${command}; ${marker}`,
    }
    this.#probe = probe
    return probe
  }

  /**
   * 等探针结束并把它攒到的输出交回来。
   * @param probe - 探针句柄。
   * @param timeoutMs - 超时。
   * @returns 标记之前的 stdout。
   */
  async #waitProbe(probe: Probe, timeoutMs: number): Promise<string> {
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`terminal: 等待 shell 输出超时（${timeoutMs}ms）`))
      }, timeoutMs)
      timer.unref?.()
    })
    await Promise.race([probe.done, timeout])
    return probe.captured.join('')
  }

  /** 往 stdin 写一段原始文本。 */
  #write(text: string): void {
    const child = this.#child
    if (child === undefined || this.#exited) return
    const stdin = child.stdin
    if (stdin === null) return
    stdin.write(text)
  }

  /** 往 stdin 写一条命令（补换行，并记下来以便认输入回显）。 */
  #writeCommand(command: string): void {
    this.#sent.push(command)
    // 只留最近若干条：认回显用不到更早的了，留着白占内存。
    while (this.#sent.length > 32) this.#sent.shift()
    this.#write(`${command}\n`)
  }

  /**
   * 收到 stdout。
   *
   * stdout 里可能夹着半个探针标记（分块到达），所以先攒着，等确认不是标记再交出去。
   */
  #onStdout(chunk: string): void {
    this.#stdoutPending += stripAnsi(chunk)
    const probe = this.#probe
    if (probe === undefined) {
      this.#buffer.push(this.#stdoutPending)
      this.#stdoutPending = ''
      return
    }
    const index = this.#stdoutPending.indexOf(probe.token)
    if (index < 0) {
      // 还没看到完整标记：留一个「可能是标记开头」的尾巴，其余先交出去。
      const keep = Math.min(probe.token.length - 1, this.#stdoutPending.length)
      const head = this.#stdoutPending.slice(0, this.#stdoutPending.length - keep)
      this.#stdoutPending = this.#stdoutPending.slice(this.#stdoutPending.length - keep)
      probe.captured.push(head)
      this.#buffer.push(head)
      return
    }
    const before = this.#stdoutPending.slice(0, index)
    probe.captured.push(before)
    this.#buffer.push(before)
    // 标记后面紧跟的是它自己那一行的换行符：那是探针的，不该混进用户的输出。
    let rest = this.#stdoutPending.slice(index + probe.token.length)
    if (rest.startsWith('\r\n')) rest = rest.slice(2)
    else if (rest.startsWith('\n')) rest = rest.slice(1)
    this.#stdoutPending = rest
    this.#probe = undefined
    probe.resolve()
  }

  /**
   * 收到 stderr。
   *
   * stderr 里有两类要处理的东西：bash 交互模式的启动噪声，以及**输入回显**
   * （`bash -i` 会把敲进去的命令原样写回 stderr）。两者都要滤掉，否则读回来的
   * 输出里会混着重复的命令和看不懂的抱怨。
   */
  #onStderr(chunk: string): void {
    this.#stderrPending += stripAnsi(chunk)
    const lines = this.#stderrPending.split(/\r?\n/)
    // 最后一段还没成行，留着等下一块。
    this.#stderrPending = lines.pop() ?? ''
    for (const line of lines) {
      if (this.#isNoise(line)) continue
      this.#buffer.push(`${line}\n`)
    }
  }

  /** 一行 stderr 是不是噪声（启动抱怨或输入回显）。 */
  #isNoise(line: string): boolean {
    if (line.trim().length === 0) return true
    if (isBashStartupNoise(line)) return true
    return isInputEcho(line, this.#sent)
  }
}

/** 睡一会儿。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 杀掉一个进程（不追杀它的子孙）。
 *
 * 中断前台命令时要用这个：连着子孙一起杀会把 shell 自己带走（见
 * {@link LocalShellSession.interrupt} 的说明）。
 * @param pid - 进程 pid。
 */
async function killProcess(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await runCommand('taskkill', ['/pid', String(pid), '/F'])
    return
  }
  try {
    process.kill(pid, 'SIGINT')
  } catch {
    // 进程已经不在了：这就是我们要的结果。
  }
}

/**
 * 杀掉一棵进程树。
 *
 * Windows 上 `taskkill /T /F` 从父进程往下枚举整棵树：只杀直接子进程的话，孙进程
 * 会漏掉，变成无主孤儿继续跑——用户机器 CPU 被 `while true; do :; done` 吃满就是
 * 这么来的。
 * @param pid - 根进程 pid。
 */
async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await runCommand('taskkill', ['/pid', String(pid), '/T', '/F'])
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 进程已经不在了：这就是我们要的结果。
    }
  }
}

/** 跑一条辅助命令并等它结束。 */
async function runCommand(file: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(file, [...args], { stdio: 'ignore', windowsHide: true })
    } catch {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 5_000)
    child.once('error', () => {
      clearTimeout(timer)
      resolve()
    })
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
