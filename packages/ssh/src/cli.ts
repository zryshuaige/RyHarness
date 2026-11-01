/**
 * SSH 命令行后端：用本机的 `ssh` 可执行文件跑远程命令。
 *
 * ## 为什么不引 ssh2
 *
 * ssh2 是原生模块（要编译、要按平台分发），对一个「多助理 agent 应用」来说代价不成比例。
 * 所以这里走命令行：绝大多数机器上都已经有 OpenSSH 客户端（Windows 10+ 自带，
 * Linux/macOS 本来就有），而且**用命令行反而更好审计**——跑什么、传什么，一眼看得见。
 *
 * ## 命令行长什么样
 *
 * `ssh [选项] 目标 -- 命令`。`--` 之后的一切都交给远端 shell，所以命令里带 `-` 开头的
 * 词不会被 ssh 当成自己的选项。目标串在 `--` **之前**，所以它必须先校验过（以 `-` 开头
 * 的目标会被 ssh 当成选项，那就是一条注入路径）——校验在 {@link buildSshTarget} 里。
 *
 * ## 三条硬规矩
 *
 * 1. **凭据不进 argv**。argv 在 Linux 上是全局可读的（`ps aux` 就能看见），密码塞进去
 *    等于公开。密码走 askpass 助手：助手路径进 argv，密码进子进程的环境（Linux 上
 *    `/proc/<pid>/environ` 只有属主能读）。私钥也只传**路径**（`-i`），不传密钥内容。
 * 2. **路径默认关在根目录里**。宿主给了 `root` 之后，`../` 跑不出去，越界报
 *    `PATH_OUTSIDE_ROOT`。
 * 3. **失败分得清**。连不上、认证失败、找不到命令、远端非零退出是四个不同的码；
 *    连接中途断了是第五个（`CONNECTION_LOST`）——断了的时候说「命令没输出」是误导。
 *
 * ## 已知限制
 *
 * - **没有长连接**：每次操作起一次 ssh 进程（命令行后端本来就是这个形态）。
 * - **没有端口转发、没有密钥管理**（凭据由宿主给）。
 * - **远端必须有 `base64`**（文件传输靠它）；macOS 自带的 base64 解码要用 `-D`，
 *   可以用 `base64DecodeFlag` 改。
 * - **超时杀的是本地 ssh 进程树**：远端那条命令不一定跟着死（ssh 被杀时远端命令通常
 *   会收到 SIGHUP，但没人保证），这是命令行走 ssh 的固有限制。
 * @module @ryharness/ssh/cli
 */

import type { ChildProcess } from 'node:child_process'
import { SshError } from './errors.ts'
import { buildSshTarget } from './host.ts'
import { resolveRemotePath } from './paths.ts'
import { defaultSpawn, killProcessTree, type SshSpawnFn } from './process.ts'
import {
  type Base64DecodeFlag,
  buildListCommand,
  buildReadCommand,
  buildWriteCommand,
  decodeBase64Payload,
  parseListOutput,
  shellQuote,
} from './remote.ts'
import type {
  SshCommandOptions,
  SshConnection,
  SshConnectionConfig,
  SshExecResult,
  SshFileEntry,
  SshReadOptions,
  SshWriteOptions,
} from './types.ts'

/** 输出的默认上限（字节）。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024

/**
 * 环境白名单：ssh 客户端自己要用到的那些。
 *
 * **刻意不含模型服务的 key**：ssh 进程是本地进程，但环境越少越好；远端命令继承的是
 * 远端登录环境，与这里无关，可我们本地这台机器上的东西没必要往外带。
 */
export const SSH_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SystemRoot',
  'SYSTEMROOT',
  'SystemDrive',
  'COMSPEC',
  'ComSpec',
  'TEMP',
  'TMP',
  'TMPDIR',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'USER',
  'LOGNAME',
  'SSH_AUTH_SOCK',
  'XDG_RUNTIME_DIR',
  'DISPLAY',
]

/**
 * 一次远端调用的原始结果（还没分类）。
 *
 * 暴露出来是为了让调用方能自己分类（比如宿主想按自己的口径决定哪些失败算「没关系」）。
 */
export interface SshRawRun {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly signal: NodeJS.Signals | null
  readonly durationMs: number
}

/** 有界的输出收集器：只留前 limit 个字节，但总字节数照实记。 */
interface BoundedSink {
  write(chunk: Buffer): void
  finish(): { text: string; bytes: number; truncated: boolean }
}

/** 做一个有界的输出收集器。 */
function createBoundedSink(limit: number): BoundedSink {
  const chunks: Buffer[] = []
  let kept = 0
  let bytes = 0
  let truncated = false
  return {
    write(chunk: Buffer) {
      bytes += chunk.length
      if (kept < limit) {
        const room = limit - kept
        const slice = chunk.length <= room ? chunk : chunk.subarray(0, room)
        chunks.push(slice)
        kept += slice.length
        if (slice.length < chunk.length) truncated = true
        return
      }
      if (chunk.length > 0) truncated = true
    },
    finish() {
      return { text: Buffer.concat(chunks, kept).toString('utf8'), bytes, truncated }
    },
  }
}

/** 把错误对象变成一句人话。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 管道上的错误一律忽略。
 *
 * 远端提前退出时，往 stdin 写东西会 EPIPE；这个错误没人接就会变成**未捕获异常**，
 * 把整个进程带崩。管道断了本来就要靠 'close' 事件收口，这里不用管。
 * @param _error - 管道错误（故意不看）。
 */
export function ignoreStreamError(_error?: unknown): void {
  // 故意什么都不做：见上面的说明。
}

/**
 * 读一个错误对象上的 `code`（Node 的系统错误都有这个字段）。
 *
 * 用 `in` 判断而不是断言：错误对象的形状来自 Node，不是一开始就确定有 `code` 的。
 * @param error - 待读的错误。
 * @returns code 字符串；没有就 undefined。
 */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}

/** stderr 的第一行有内容的部分（远端的报错通常就在第一行）。 */
function firstMeaningfulLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed
  }
  return '（远端没有给出更多说明）'
}

/**
 * 把一次远端调用的失败分类成**带机器码**的错误。
 *
 * 分类顺序有讲究：认证失败与连接失败都可能是 255，所以先看 stderr 里的特征串，
 * 最后才拿退出码兜底。
 * @param raw - 原始结果。
 * @param command - 跑的命令（写进文案里，让人知道是哪条命令出的事）。
 * @param destination - 目标串。
 * @returns 分类好的错误。
 */
export function classifyRemoteFailure(raw: SshRawRun, command: string, destination: string): SshError {
  const stderr = raw.stderr
  const hint = firstMeaningfulLine(stderr)
  const extra = { exitCode: raw.exitCode, stderr }
  if (raw.signal !== null) {
    return new SshError(
      'CONNECTION_LOST',
      `连接断了（${destination}），远端命令没跑完（本地 ssh 被 ${raw.signal} 打断）：${command}`,
      extra,
    )
  }
  if (/permission denied/i.test(stderr)) {
    return new SshError('AUTH_FAILED', `认证没过（${destination}）：${hint}`, extra)
  }
  if (
    /could not resolve hostname|no route to host|connection refused|network is unreachable|name or service not known|connection timed out/i.test(
      stderr,
    )
  ) {
    return new SshError('CONNECT_FAILED', `连不上 ${destination}：${hint}`, extra)
  }
  if (
    /connection (closed|reset)|broken pipe|lost connection|remote host closed|connection to .* closed/i.test(stderr)
  ) {
    return new SshError('CONNECTION_LOST', `连接断了（${destination}），远端命令没跑完：${command}`, extra)
  }
  if (raw.exitCode === 127) {
    return new SshError('COMMAND_NOT_FOUND', `远端没有这个命令：${command}`, extra)
  }
  if (raw.exitCode === 66) {
    return new SshError('REMOTE_NOT_FOUND', `远端目录不存在：${command}`, extra)
  }
  if (raw.exitCode === 255) {
    return new SshError('CONNECT_FAILED', `ssh 自己失败了（${destination}）：${hint}`, extra)
  }
  return new SshError('REMOTE_FAILED', `远端命令以退出码 ${raw.exitCode} 结束：${command}（${hint}）`, extra)
}

/** 命令行后端的构造参数。 */
export interface CliSshConnectionOptions extends SshConnectionConfig {
  /** 注入起进程的方式（测试用假的 ssh）；缺省用 node 的 spawn。 */
  readonly spawn?: SshSpawnFn
  /** 宿主环境；缺省用 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv
  /** base64 解码开关：GNU 是 `-d`，BSD/macOS 是 `-D`；缺省 `-d`。 */
  readonly base64DecodeFlag?: Base64DecodeFlag
}

/**
 * 用本机 `ssh` 可执行文件实现的远程连接。
 *
 * 实例是**无状态的**（除了「关没关」）：每次操作起一个 ssh 进程，用完就退。
 * 这样做的代价是没有连接复用，好处是没有「连接悄悄挂死」这种难查的问题。
 */
export class CliSshConnection implements SshConnection {
  /** 这条连接的标识。 */
  readonly id: string
  /** 目标串。 */
  readonly #target: ReturnType<typeof buildSshTarget>
  /** 配置。 */
  readonly #config: CliSshConnectionOptions
  /** 起进程的方式。 */
  readonly #spawn: SshSpawnFn
  /** 当前在跑的 ssh 进程（关连接时要收掉）。 */
  #child: ChildProcess | undefined
  /** 关没关。 */
  #closed = false

  constructor(options: CliSshConnectionOptions) {
    this.#target = buildSshTarget({ host: options.host, ...(options.user === undefined ? {} : { user: options.user }) })
    this.#config = options
    this.#spawn = options.spawn ?? defaultSpawn
    this.id = `ssh:${this.#target.destination}`
  }

  /**
   * 在远端跑一条命令。
   * @param command - 命令文本（交给远端 shell 解释）。
   * @param options - 执行选项。
   * @returns 执行结果。
   */
  async exec(command: string, options: SshCommandOptions = {}): Promise<SshExecResult> {
    return await this.#execute(this.#withCwd(command, options.cwd), options)
  }

  /**
   * 写一个远端文件。
   * @param path - 远端路径（相对路径按根目录解析）。
   * @param data - 文件内容。
   * @param options - 写入选项。
   */
  async writeFile(path: string, data: Uint8Array | string, options: SshWriteOptions = {}): Promise<void> {
    const target = resolveRemotePath(this.#config.root, path)
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    const payload = bytes.toString('base64')
    const command = buildWriteCommand(target, options.mode, this.#config.base64DecodeFlag ?? '-d')
    await this.#execute(command, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      stdin: payload,
      rejectOnNonZeroExit: true,
    })
  }

  /**
   * 读一个远端文件。
   * @param path - 远端路径。
   * @param options - 读取选项。
   * @returns 文件内容。
   */
  async readFile(path: string, options: SshReadOptions = {}): Promise<Uint8Array> {
    const target = resolveRemotePath(this.#config.root, path)
    const maxBytes = options.maxBytes ?? this.#config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const result = await this.#execute(buildReadCommand(target), {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      maxOutputBytes: Math.ceil((maxBytes * 4) / 3) + 16,
      rejectOnNonZeroExit: true,
    })
    if (result.stdoutTruncated) {
      throw new SshError('REMOTE_FAILED', `远端文件比读取上限还大（上限 ${maxBytes} 字节），没读全：${target}`)
    }
    return decodeBase64Payload(result.stdout)
  }

  /**
   * 列一个远端目录。
   * @param path - 远端目录。
   * @param options - 执行选项。
   * @returns 目录条目。
   */
  async list(path: string, options: SshCommandOptions = {}): Promise<SshFileEntry[]> {
    const dir = resolveRemotePath(this.#config.root, path)
    const result = await this.#execute(buildListCommand(dir), {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      rejectOnNonZeroExit: true,
    })
    return parseListOutput(result.stdout, dir)
  }

  /** 关掉这条连接：在跑的 ssh 进程会被收掉。 */
  async close(): Promise<void> {
    this.#closed = true
    const child = this.#child
    if (child === undefined) return
    this.#child = undefined
    await killProcessTree(child)
  }

  /**
   * 跑一条命令并按失败类型收口。
   *
   * 只有「远端非零退出」这一类可以被 `rejectOnNonZeroExit: false` 放过去；连不上、
   * 认证失败、找不到命令、连接断了这些不是「命令跑出了别的结果」，而是「这次没跑成」。
   */
  async #execute(command: string, options: SshCommandOptions): Promise<SshExecResult> {
    const raw = await this.#run(command, options)
    const result: SshExecResult = {
      exitCode: raw.exitCode,
      stdout: raw.stdout,
      stderr: raw.stderr,
      stdoutTruncated: raw.stdoutTruncated,
      stderrTruncated: raw.stderrTruncated,
      durationMs: raw.durationMs,
    }
    if (raw.exitCode !== 0) {
      const failure = classifyRemoteFailure(raw, command, this.#target.destination)
      const reject = options.rejectOnNonZeroExit ?? true
      if (failure.code !== 'REMOTE_FAILED' || reject) throw failure
    }
    return result
  }

  /** 给命令加上工作目录（远端 cd 失败用退出码 66 表示）。 */
  #withCwd(command: string, cwd: string | undefined): string {
    if (cwd === undefined || cwd.length === 0) return command
    const dir = resolveRemotePath(this.#config.root, cwd)
    return `cd ${shellQuote(dir)} || exit 66; ${command}`
  }

  /** 拼 ssh 的参数：选项 + 目标 + `--` + 命令。 */
  #buildArgs(command: string): string[] {
    const args: string[] = []
    const port = this.#config.port
    if (port !== undefined) args.push('-p', String(port))
    const credential = this.#config.credential
    if (credential?.kind === 'key') args.push('-i', credential.identityFile)
    const policy = this.#config.hostKeyPolicy === 'accept-new' ? 'accept-new' : 'yes'
    args.push('-o', `StrictHostKeyChecking=${policy}`)
    if (credential?.kind === 'password') {
      // 密码认证：关掉公钥，免得它先拿密钥去试；只问一次，别在无人值守时卡住。
      args.push('-o', 'PreferredAuthentications=password')
      args.push('-o', 'PubkeyAuthentication=no')
      args.push('-o', 'NumberOfPasswordPrompts=1')
    } else {
      // 其余情况一律 BatchMode：没有交互终端，卡在密码提示上比失败还糟。
      args.push('-o', 'BatchMode=yes')
    }
    const timeoutMs = this.#config.defaultTimeoutMs
    if (timeoutMs !== undefined && timeoutMs > 0) {
      args.push('-o', `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`)
    }
    args.push(this.#target.destination, '--', command)
    return args
  }

  /** 拼子进程的环境（白名单 + 密码 askpass 相关的那几项）。 */
  #buildEnv(): NodeJS.ProcessEnv {
    const base = this.#config.env ?? process.env
    const env: NodeJS.ProcessEnv = {}
    for (const key of SSH_ENV_ALLOWLIST) {
      const value = base[key]
      if (value !== undefined) env[key] = value
    }
    const credential = this.#config.credential
    if (credential?.kind === 'password') {
      // 助手路径进 argv（路径不是秘密），密码进环境（只有属主读得到）。
      env.SSH_ASKPASS = credential.askpass
      env.SSH_ASKPASS_REQUIRE = 'force'
      env[credential.passwordEnv ?? 'RY_SSH_PASSWORD'] = credential.password
    }
    return env
  }

  /** 真正起 ssh、收输出、按失败类型收口。 */
  #run(command: string, options: SshCommandOptions): Promise<SshRawRun> {
    if (this.#closed) {
      return Promise.reject(new SshError('CONNECTION_CLOSED', '这条连接已经关了，不能再操作。'))
    }
    const signal = options.signal
    if (signal?.aborted === true) {
      return Promise.reject(new SshError('CANCELLED', '这次操作在开始前就被取消了。'))
    }

    const maxBytes = options.maxOutputBytes ?? this.#config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const timeoutMs = options.timeoutMs ?? this.#config.defaultTimeoutMs
    const startedAt = Date.now()

    return new Promise<SshRawRun>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = this.#spawn(this.#config.sshPath ?? 'ssh', this.#buildArgs(command), {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: this.#buildEnv(),
          windowsHide: true,
          // POSIX 上让 ssh 自己当进程组长：超时收进程树时 kill(-pgid) 才收得干净。
          detached: process.platform !== 'win32',
        })
      } catch (error) {
        reject(new SshError('SSH_CLIENT_MISSING', `起 ssh 失败：${describeError(error)}`, { cause: error }))
        return
      }
      this.#child = child

      const stdout = createBoundedSink(maxBytes)
      const stderr = createBoundedSink(maxBytes)
      child.stdout?.on('data', (chunk: Buffer) => stdout.write(chunk))
      child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk))
      // 管道上的错误没人接就会变成未捕获异常（远端提前退出时写 stdin 会 EPIPE）。
      child.stdout?.on('error', ignoreStreamError)
      child.stderr?.on('error', ignoreStreamError)
      child.stdin?.on('error', ignoreStreamError)

      const stdin = child.stdin
      if (stdin !== null) {
        // 没有内容也要关掉 stdin：远端命令读 stdin 时得收到 EOF，不能干等着。
        if (options.stdin === undefined) stdin.end()
        else stdin.end(options.stdin, 'utf8')
      }

      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
        if (this.#child === child) this.#child = undefined
      }
      const succeed = (raw: SshRawRun): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(raw)
      }
      const fail = (error: SshError, killTree: boolean): void => {
        if (settled) return
        settled = true
        cleanup()
        if (!killTree) {
          reject(error)
          return
        }
        // 先把进程树收掉再报结果：超时/取消的语义是「这次已经停了」，
        // 不是「我们不等了，远端还在跑」。
        void killProcessTree(child).finally(() => reject(error))
      }
      onAbort = (): void => {
        fail(new SshError('CANCELLED', '这次操作被取消了，远端命令已经收掉。'), true)
      }

      if (signal !== undefined && onAbort !== undefined) signal.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          fail(new SshError('TIMEOUT', `远端操作超时（上限 ${timeoutMs} 毫秒），命令已经收掉。`), true)
        }, timeoutMs)
        timer.unref?.()
      }

      child.on('error', (error: Error) => {
        const missing = errorCode(error) === 'ENOENT'
        fail(
          new SshError(
            missing ? 'SSH_CLIENT_MISSING' : 'CONNECT_FAILED',
            missing
              ? `本机找不到 ssh 可执行文件（${this.#config.sshPath ?? 'ssh'}），装个 OpenSSH 客户端或者换个路径。`
              : `起 ssh 失败：${error.message}`,
            { cause: error },
          ),
          false,
        )
      })

      child.on('close', (code: number | null, sig: NodeJS.Signals | null) => {
        const out = stdout.finish()
        const err = stderr.finish()
        // 连接在这期间被关掉了：这次调用没跑完，原因是「连接关了」而不是「远端命令失败」。
        if (this.#closed) {
          fail(new SshError('CONNECTION_CLOSED', '连接在这次调用期间被关掉了，这次命令没跑完。'), false)
          return
        }
        succeed({
          exitCode: code ?? -1,
          stdout: out.text,
          stderr: err.text,
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
          signal: sig,
          durationMs: Date.now() - startedAt,
        })
      })
    })
  }
}
