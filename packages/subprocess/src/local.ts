/**
 * 本机 provider：把子进程真的跑在这台机器上。
 *
 * 这一层做四件事，每件都有个「不这么做会出什么事」的理由：
 *
 * 1. **输出有界**：stdout/stderr 各自设上限，超了就截断并标记。一个 `cat` 大文件
 *    或者一段刷屏的日志，不该把宿主内存吃穿——被吃穿的不是这个进程，是整个应用。
 * 2. **环境清洗**：子进程只拿到白名单里的那几项，模型服务的 key 不在里头。
 * 3. **进程树回收**：父进程被收掉时，它的子进程、孙子进程也得收掉，否则留下的是
 *    没人管的孤儿。Windows 用 `taskkill /T /F`，POSIX 用独立进程组的 kill。
 * 4. **超时与取消**：到点收掉进程，并且给出**结构化**的原因（不是一句超时了）。
 *
 * 做不到的事写在 `capabilities.notes` 里，不藏着：本轮**没有**原生绑定，
 * Windows 上没有 Job Object，POSIX 上没有 cgroup，所以「整组原子托管」这件事
 * 是模拟的（逐个记着、逐个收）。见 README 的「边界」。
 * @module @ryharness/subprocess/local
 */

import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'
import { DEFAULT_ENV_ALLOWLIST, scrubEnvironment } from './env.ts'
import { resolveExecutable } from './executable.ts'
import type {
  ExecutableResolution,
  ManagedProcess,
  ResolveExecutableOptions,
  SubprocessCapabilities,
  SubprocessError,
  SubprocessProvider,
  SubprocessRawSpawnOptions,
  SubprocessResult,
  SubprocessSpawnOptions,
  SubprocessStatus,
} from './types.ts'

/** stdout / stderr 各自的默认捕获上限（字节）。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

/**
 * 收不掉时的兜底时限（毫秒）。
 *
 * 到点就把结果交出去：调用方不能无限期地等一个收不掉的进程——那和挂死没区别。
 */
export const KILL_GRACE_MS = 2_000

/** 进程 id 计数器：同一进程里唯一就够，跨进程唯一没意义。 */
let sequence = 0

/** 下一个托管进程 id。 */
function nextId(): string {
  sequence += 1
  return `sp-${sequence}`
}

/** 有界的输出收集器：只留前 limit 个字节，但总字节数照实记。 */
interface BoundedSink {
  write(chunk: Buffer): void
  finish(): { text: string; bytes: number; truncated: boolean }
}

/**
 * 做一个有界的输出收集器。
 *
 * 「有界」指的是**留在结果里的字节数**有上限；总产出量照实记下来，否则调用方
 * 看到「输出被截断了」却不知道漏了多少。
 * @param limit - 最多留多少字节。
 * @param onChunk - 增量回调（拿到的是实时片段，不是截断后的全文）。
 * @returns 收集器。
 */
function createBoundedSink(limit: number, onChunk?: (chunk: string) => void): BoundedSink {
  const chunks: Buffer[] = []
  const decoder = new TextDecoder('utf-8')
  let kept = 0
  let bytes = 0
  let truncated = false
  return {
    write(chunk: Buffer) {
      bytes += chunk.length
      if (onChunk !== undefined) onChunk(decoder.decode(chunk, { stream: true }))
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

/**
 * Windows 上怎么把一个批处理脚本跑起来。
 *
 * `.cmd` / `.bat` **不能**直接 spawn：Node 为了防注入，要求这类文件必须经过
 * shell，直接 spawn 会报 EINVAL。这里显式走 `cmd.exe /d /s /c`，参数自己加引号。
 *
 * `/s` 会把整串命令的首尾引号剥掉，所以最外层补的那对引号正好被它吃掉，剩下的
 * 就是我们真正要执行的命令行；参数自己的引号留在里面。
 */
interface SpawnPlan {
  readonly command: string
  readonly args: string[]
  /** 参数要不要原样传给 CreateProcess（cmd 的引号规则不能被 libuv 再改一遍）。 */
  readonly verbatim: boolean
}

/** 给 cmd 的参数加引号：带空格或元字符就包起来，里面的引号按 cmd 的规矩翻倍。 */
function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && !/[\s"^&|<>()]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

/** PowerShell 宿主路径。 */
function powershellPath(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/** 决定 Windows 上到底跑什么：直接跑 exe，还是包一层 cmd / powershell。 */
function windowsSpawnPlan(target: string, args: readonly string[], env: NodeJS.ProcessEnv): SpawnPlan {
  const lower = target.toLowerCase()
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const comspec = env.COMSPEC ?? env.ComSpec ?? 'cmd.exe'
    const line = [quoteWindowsArg(target), ...args.map(quoteWindowsArg)].join(' ')
    return { command: comspec, args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
  }
  if (lower.endsWith('.ps1')) {
    return {
      command: powershellPath(env),
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', target, ...args],
      verbatim: false,
    }
  }
  return { command: target, args: [...args], verbatim: false }
}

/** 启动参数 + 平台私有的一项（verbatim 参数）。 */
type SpawnOptionsWithVerbatim = SpawnOptions & { windowsVerbatimArguments?: boolean }

/**
 * Windows 上按父子关系强杀整棵树。
 *
 * `taskkill /T /F` 是唯一能按父子关系枚举的现成手段；它自己被策略拦住或者卡住，
 * 都算失败——失败了就退回只杀直接子进程（由调用方决定要不要接受这个降级）。
 * @param pid - 根进程 id。
 * @param timeoutMs - taskkill 自己的时限。
 * @returns 树是不是被收掉了。
 */
function taskkillTree(pid: number, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    let timer: NodeJS.Timeout | undefined
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(ok)
    }
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => finish(false))
    killer.on('close', (code) => finish(code === 0))
    timer = setTimeout(() => {
      killer.kill('SIGKILL')
      finish(false)
    }, timeoutMs)
  })
}

/**
 * POSIX 上按进程组杀整棵树。
 *
 * 子进程是被 `detached: true` 起的，所以它自己是进程组长，孙进程默认还在组里，
 * `kill(-pgid)` 一下就都收了。组已经没了（进程早退）就退回只杀直接子进程。
 * @param pid - 进程组长 id。
 * @param child - 子进程句柄。
 * @returns 树是不是被收掉了。
 */
function killProcessGroup(pid: number, child: ChildProcess): boolean {
  try {
    process.kill(-pid, 'SIGKILL')
    return true
  } catch {
    try {
      child.kill('SIGKILL')
      return true
    } catch {
      return false
    }
  }
}

/** provider 的内部依赖：宿主环境、平台与各项默认值。 */
interface LocalDeps {
  readonly platform: NodeJS.Platform
  readonly hostEnv: NodeJS.ProcessEnv
  readonly envAllowlist: readonly string[]
  readonly defaultTimeoutMs: number | undefined
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
}

/**
 * 本机 provider 的能力与降级说明。
 *
 * 说明写在这里而不是散在代码注释里，是因为宿主要拿它决定能不能把
 * 「进程树已经收干净」这句话说出口。
 * @param platform - 平台；缺省当前平台。
 * @returns 能力与降级说明。
 */
export function localCapabilities(platform: NodeJS.Platform = process.platform): SubprocessCapabilities {
  if (platform === 'win32') {
    return {
      providerId: 'local',
      treeKill: 'taskkill',
      nativeManagedRange: false,
      boundedOutput: true,
      notes: [
        'Windows 上没有用 Job Object 托管整组进程（那需要原生绑定，本轮不做）：进程树靠 taskkill /T /F 按父子关系枚举回收。',
        'taskkill 只能收它还认得出的父子关系：父进程先死、或子进程被挂到别的父进程下时，那部分收不到。',
      ],
    }
  }
  return {
    providerId: 'local',
    treeKill: 'process-group',
    nativeManagedRange: false,
    boundedOutput: true,
    notes: [
      'POSIX 上没有用 cgroup 托管整组进程（那需要额外权限，本轮不做）：进程树靠独立进程组的 kill(-pgid) 回收。',
      '子进程自己 setsid 脱离进程组之后，就不在回收范围里了。',
    ],
  }
}

/**
 * 启动一个被托管的进程。
 *
 * 这是本包最核心的一段：输出有界、环境干净、树能收干净、超时与取消会真的收进程。
 * @param options - 启动参数。
 * @param deps - 平台、宿主环境与默认值。
 * @returns 进程句柄。
 */
function startManagedProcess(options: SubprocessSpawnOptions, deps: LocalDeps): ManagedProcess {
  const id = nextId()
  const startedAt = Date.now()
  const args = [...(options.args ?? [])]
  const label = options.label ?? options.command

  /** 没启动起来时的结果：把「失败」也做成结构化的。 */
  const notStarted = (status: SubprocessStatus, error: SubprocessError): ManagedProcess => {
    const result: SubprocessResult = {
      status,
      command: options.command,
      args,
      pid: undefined,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: Date.now() - startedAt,
      error,
    }
    return {
      id,
      label,
      command: options.command,
      args,
      pid: undefined,
      startedAt,
      finished: true,
      done: Promise.resolve(result),
      kill: async () => undefined,
    }
  }

  // 启动前就被取消了：那就不该启动。
  if (options.signal?.aborted === true) {
    return notStarted('aborted', { code: 'aborted', message: '进程在启动前就被取消了。' })
  }

  // 先找可执行文件：找不到的话给一句能直接给人看的话，而不是一个 ENOENT。
  let target = options.command
  if (options.resolve !== false) {
    const resolution = resolveExecutable({
      name: options.command,
      env: deps.hostEnv,
      platform: deps.platform,
    })
    if (!resolution.found) {
      return notStarted('failed', { code: 'executable-not-found', message: resolution.message })
    }
    target = resolution.path
  }

  // 环境清洗：白名单之外的一律不传，追加项原样传。
  const scrubbed = scrubEnvironment({
    base: options.inheritEnv === false ? {} : deps.hostEnv,
    allowlist: options.envAllowlist ?? deps.envAllowlist,
    deny: options.envDeny,
    extra: options.env,
    platform: deps.platform,
  })

  const isWindows = deps.platform === 'win32'
  const plan = isWindows ? windowsSpawnPlan(target, args, scrubbed.env) : { command: target, args, verbatim: false }
  const spawnOptions: SpawnOptionsWithVerbatim = {
    cwd: options.cwd,
    env: scrubbed.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // POSIX 上让子进程自己当进程组长：这样 kill(-pgid) 才能把孙子一起收掉。
    detached: !isWindows,
    ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
  }
  const child = spawn(plan.command, plan.args, spawnOptions)

  const stdout = createBoundedSink(options.maxStdoutBytes ?? deps.maxStdoutBytes, options.onStdout)
  const stderr = createBoundedSink(options.maxStderrBytes ?? deps.maxStderrBytes, options.onStderr)
  child.stdout?.on('data', (chunk: Buffer) => stdout.write(chunk))
  child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk))

  let settled = false
  let termination: { status: SubprocessStatus; error: SubprocessError } | undefined
  let killPromise: Promise<boolean> | undefined
  let timeoutTimer: NodeJS.Timeout | undefined
  let graceTimer: NodeJS.Timeout | undefined
  let resolveDone: (result: SubprocessResult) => void = () => undefined
  const done = new Promise<SubprocessResult>((resolve) => {
    resolveDone = resolve
  })

  /** 组最终结果：状态、退出码、截断后的输出都在这儿定下来。 */
  const buildResult = (exitCode: number | null, signal: NodeJS.Signals | null): SubprocessResult => {
    const out = stdout.finish()
    const err = stderr.finish()
    const status: SubprocessStatus = termination?.status ?? (exitCode === 0 ? 'completed' : 'failed')
    let error: SubprocessError | undefined = termination?.error
    if (error === undefined && status === 'failed') {
      error = { code: 'non-zero-exit', message: `命令以退出码 ${exitCode ?? '未知'} 结束。` }
    }
    return {
      status,
      command: options.command,
      args,
      pid: child.pid,
      exitCode,
      signal,
      stdout: out.text,
      stderr: err.text,
      stdoutBytes: out.bytes,
      stderrBytes: err.bytes,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
      durationMs: Date.now() - startedAt,
      ...(error === undefined ? {} : { error }),
    }
  }

  /** 取消信号来了：收掉进程。 */
  const onAbort = (): void => {
    void requestTermination('aborted', { code: 'aborted', message: `子进程被取消：${options.command}。` })
  }

  /** 结算：只算一次。 */
  const settle = (result: SubprocessResult): void => {
    if (settled) return
    settled = true
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    if (graceTimer !== undefined) clearTimeout(graceTimer)
    options.signal?.removeEventListener('abort', onAbort)
    resolveDone(result)
  }

  /** 收整棵树。 */
  const killTree = async (): Promise<boolean> => {
    const pid = child.pid
    if (pid === undefined) return false
    if (isWindows) return await taskkillTree(pid)
    return killProcessGroup(pid, child)
  }

  /** 请求终止（超时、取消、显式 kill 都走这里）。 */
  const requestTermination = (status: SubprocessStatus, error: SubprocessError): Promise<boolean> => {
    if (termination === undefined) {
      termination = { status, error }
      killPromise = killTree().catch(() => false)
      // 兜底：收不掉也得把结果交出去，否则调用方会一直等一个收不掉的进程。
      graceTimer = setTimeout(() => settle(buildResult(null, null)), KILL_GRACE_MS)
    }
    return killPromise ?? Promise.resolve(false)
  }

  const timeoutMs = options.timeoutMs ?? deps.defaultTimeoutMs
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      void requestTermination('timeout', {
        code: 'timeout',
        message: `子进程超时（${timeoutMs} 毫秒）：${options.command}。`,
      })
    }, timeoutMs)
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  child.on('error', (error: Error) => {
    // 启动失败是一次性的：别把已经定下来的终止原因（超时、取消）改写成失败。
    if (termination === undefined) {
      termination = {
        status: 'failed',
        error: { code: 'spawn-failed', message: `启动失败：${error.message}`, cause: error },
      }
    }
    settle(buildResult(null, null))
  })
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    settle(buildResult(code, signal))
  })

  return {
    id,
    label,
    command: options.command,
    args,
    pid: child.pid,
    startedAt,
    get finished() {
      return settled
    },
    done,
    kill: async (reason?: string): Promise<void> => {
      await requestTermination('terminated', {
        code: 'terminated',
        message: `子进程被终止${reason === undefined ? '' : `：${reason}`}。`,
      })
    },
  }
}

/** 本机 provider 的构造参数。 */
export interface LocalSubprocessProviderOptions {
  /** 宿主环境；缺省用 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv
  /** 平台；缺省当前平台。 */
  readonly platform?: NodeJS.Platform
  /** 环境白名单；缺省用默认那一份。 */
  readonly envAllowlist?: readonly string[]
  /** 默认时限（毫秒）。 */
  readonly defaultTimeoutMs?: number
  /** stdout 默认上限（字节）。 */
  readonly maxStdoutBytes?: number
  /** stderr 默认上限（字节）。 */
  readonly maxStderrBytes?: number
}

/**
 * 本机 provider：在宿主机上真的把进程跑起来。
 *
 * 它的 `capabilities.notes` 里写着降级说明——上游 dsh 的规矩是「做不到什么要
 * 说出来」，因为宿主界面要据此决定能不能把「已经收干净」说出口。
 */
export class LocalSubprocessProvider implements SubprocessProvider {
  /** provider id。 */
  readonly id = 'local'
  /** 能力与降级说明。 */
  readonly capabilities: SubprocessCapabilities
  private readonly deps: LocalDeps

  constructor(options: LocalSubprocessProviderOptions = {}) {
    this.deps = {
      platform: options.platform ?? process.platform,
      hostEnv: options.env ?? process.env,
      envAllowlist: options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST,
      defaultTimeoutMs: options.defaultTimeoutMs,
      maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    }
    this.capabilities = localCapabilities(this.deps.platform)
  }

  /**
   * 找可执行文件。
   * @param options - 命令名与候选目录。
   * @returns 找到就给出路径，没找到给出结构化原因。
   */
  resolveExecutable(options: ResolveExecutableOptions): ExecutableResolution {
    return resolveExecutable({
      name: options.name,
      candidates: options.candidates ?? [],
      env: options.env ?? this.deps.hostEnv,
      platform: options.platform ?? this.deps.platform,
    })
  }

  /**
   * 托管启动一个进程。
   * @param options - 启动参数。
   * @returns 进程句柄。
   */
  spawn(options: SubprocessSpawnOptions): ManagedProcess {
    return startManagedProcess(options, this.deps)
  }

  /**
   * 原始 spawn：只把进程跑起来。
   *
   * **POSIX 上开新进程组**：这样关它的时候 `kill(-pgid)` 能把孙子进程一起收掉。
   * Windows 上没有 Job Object（见 `capabilities.notes`），树回收靠 `taskkill /T /F`。
   * @param options - 启动参数。
   * @returns 子进程句柄。
   */
  spawnRaw(options: SubprocessRawSpawnOptions): ChildProcess {
    const isWindows = this.deps.platform === 'win32'
    return spawn(options.command, [...(options.args ?? [])], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env ?? this.deps.hostEnv,
      stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !isWindows,
    })
  }
}

/** 本机 provider 的默认实例：直接用本包的人拿它就行。 */
export const localProvider: LocalSubprocessProvider = new LocalSubprocessProvider()

/**
 * 托管启动一个进程（走默认的本机 provider）。
 *
 * 想要别的 provider（容器、远端）就自己建 {@link SubprocessService}。
 * @param options - 启动参数。
 * @returns 进程句柄。
 */
export function spawnManaged(options: SubprocessSpawnOptions): ManagedProcess {
  return localProvider.spawn(options)
}
