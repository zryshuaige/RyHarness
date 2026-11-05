/**
 * 带原始流的托管进程：给「长驻服务」用。
 *
 * ## 为什么另起一套
 *
 * {@link ManagedProcess} 那一套是为「跑一条命令、拿结果」设计的：输出被有界地收
 * 起来，进程结束就结算。语言服务器、MCP 服务器、持久终端、子代理后端这四类**不
 * 是**这种形态——它们要一直活着，要往 stdin 写东西、要从 stdout 逐帧读协议消息、
 * 还要在退出时把整棵进程树收掉。
 *
 * 硬把它们塞进 `ManagedProcess` 会丢东西（原始流、IPC 通道），所以这里给一套
 * **形状不同但归属相同**的句柄：
 *
 * - **原始流不丢**：stdin 可写、stdout/stderr 可读，调用方按自己的协议处理；
 * - **输出仍然有界**：只是**不在这里截断**——截断会破坏协议流。改成「超过上限
 *   就把进程收掉并报出来」，那才是对的处置（一台疯狂刷日志的服务器本来就该被
 *   收掉，而不是让宿主吃它的内存）；
 * - **环境仍然清洗**：白名单之外的不传，密钥不进子进程；
 * - **进程树仍然收得干净**：Windows 走 `taskkill /T /F`，POSIX 走进程组 kill；
 * - **登记仍然归服务**：服务下线时统一收，不留孤儿。
 *
 * ## 与 provider 的关系
 *
 * 这一层的**启动**仍走 provider（{@link SubprocessProvider.spawnRaw}），所以
 * 「怎么把进程跑起来」只有一处实现；这里只补上「跑起来之后怎么管」的那部分。
 *
 * @module @ryharness/subprocess/stream
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { scrubEnvironment } from './env.ts'
import type { RangeMember, SubprocessProvider } from './types.ts'

/** 带原始流的托管进程。 */
export interface ManagedStreamProcess {
  /** 本次 spawn 的 id（同一次服务内唯一）。 */
  readonly id: string
  /** 标签（给人看的）。 */
  readonly label: string
  /** 实际跑的命令。 */
  readonly command: string
  /** 实际跑的参数。 */
  readonly args: readonly string[]
  /** 进程 id；压根没启动起来时没有。 */
  readonly pid: number | undefined
  /** 什么时候启动的（毫秒时间戳）。 */
  readonly startedAt: number
  /** 结束了没有。 */
  readonly finished: boolean
  /** 结束后的结果；还没结束时不结算。 */
  readonly done: Promise<void>
  /** 原始子进程句柄（要写 stdin、听 exit 事件就靠它）。 */
  readonly child: ChildProcess
  /**
   * 收掉这个进程**以及它的整棵子进程树**。
   * @param reason - 收掉的理由（写进错误信息，给人看）。
   */
  kill(reason?: string): Promise<void>
}

/** 启动带原始流的托管进程的参数。 */
export interface SpawnStreamOptions {
  /** 要跑的命令。 */
  readonly command: string
  /** 参数。 */
  readonly args?: readonly string[]
  /** 工作目录。 */
  readonly cwd?: string
  /** 环境白名单；缺省用默认那一份。 */
  readonly envAllowlist?: readonly string[]
  /** 额外要拦掉的环境变量名（正则）。 */
  readonly envDeny?: readonly RegExp[]
  /** 宿主明确要透传的环境变量（白名单之外的追加项）。 */
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * 是不是把宿主环境**整个**带过去（不做白名单清洗）。
   *
   * **默认 false**：白名单之外的不传、名字像密钥的不传——子进程多半是模型能触发
   * 启动的，宿主环境里的模型服务 key 不该跟着进去。
   *
   * **什么时候该开**：子进程就是**用户自己的 shell**（终端会话）。用户在那条
   * shell 里跑 `npm` / `java` / `ssh`，需要的是他自己的完整环境（`JAVA_HOME`、
   * `GOPATH`、各种 profile 都不在白名单里）。这类场景的边界由**沙箱**管
   * （`packages/sandbox` 有自己的一份环境清洗），不由这一层管。
   */
  readonly inheritEnv?: boolean
  /** stdio 配置；缺省 `['pipe', 'pipe', 'pipe']`。 */
  readonly stdio?: SpawnOptions['stdio']
  /** stdout/stderr 各自的捕获上限（字节）；超了就把进程收掉。默认 4MB。 */
  readonly maxOutputBytes?: number
  /** 这个进程归哪一组（进程范围 id）。 */
  readonly rangeId?: string
  /** 这进程是干什么的（给人看的标签）。 */
  readonly label?: string
}

/** 默认输出上限（字节）：4MB。长驻服务的正常日志量远小于它。 */
export const DEFAULT_MAX_STREAM_OUTPUT_BYTES = 4 * 1024 * 1024

/** 进程 id 计数器：同一进程里唯一就够，跨进程唯一没意义。 */
let streamSequence = 0

/**
 * 启动一个带原始流的托管进程。
 *
 * @param provider - provider（启动这一步走它）。
 * @param options - 启动参数。
 * @returns 托管句柄。
 */
export function spawnManagedStream(provider: SubprocessProvider, options: SpawnStreamOptions): ManagedStreamProcess {
  streamSequence += 1
  const id = `sp-stream-${streamSequence}`
  const args = [...(options.args ?? [])]
  const label = options.label ?? options.command
  const scrubbed =
    options.inheritEnv === true
      ? { env: { ...process.env } }
      : scrubEnvironment({
          base: process.env,
          ...(options.envAllowlist === undefined ? {} : { allowlist: options.envAllowlist }),
          ...(options.envDeny === undefined ? {} : { deny: options.envDeny }),
          ...(options.env === undefined ? {} : { extra: options.env }),
        })
  if (options.inheritEnv === true && options.env !== undefined) {
    // 整体继承时，追加项照样覆盖同名的那几项。
    for (const [key, value] of Object.entries(options.env)) {
      if (value !== undefined) scrubbed.env[key] = value
    }
  }
  const child = provider.spawnRaw?.({
    command: options.command,
    args,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: scrubbed.env,
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
  })
  if (child === undefined) {
    throw new Error(
      `subprocess: provider「${provider.id}」不支持起长驻进程（没有 spawnRaw）：语言服务器、MCP 服务器、持久终端这类需要自己管协议流的进程起不来。`,
    )
  }

  const limit = options.maxOutputBytes ?? DEFAULT_MAX_STREAM_OUTPUT_BYTES
  let stdoutBytes = 0
  let stderrBytes = 0
  let overflowed = false

  /**
   * 输出超限：把进程收掉。
   *
   * **不截断**：截断会破坏协议流（语言服务器与 MCP 都不是纯文本）。收了进程并
   * 如实报出来，调用方才知道「它吐太多了」而不是「它说了一半」。
   */
  const onOverflow = (): void => {
    if (overflowed) return
    overflowed = true
    void killTree(child, '输出超过上限')
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength
    if (stdoutBytes > limit) onOverflow()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.byteLength
    if (stderrBytes > limit) onOverflow()
  })

  let settled = false
  let resolveDone: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const settle = (): void => {
    if (settled) return
    settled = true
    resolveDone()
  }
  child.on('close', settle)
  child.on('error', settle)

  return {
    id,
    label,
    command: options.command,
    args,
    pid: child.pid,
    startedAt: Date.now(),
    get finished() {
      return settled
    },
    done,
    child,
    kill: async (reason?: string): Promise<void> => {
      await killTree(child, reason)
      settle()
    },
  }
}

/**
 * 按父子关系强杀整棵树。
 *
 * Windows 上 `taskkill /T /F` 是唯一能按父子关系枚举的现成手段；POSIX 上子进程
 * 是被 `detached: true` 起的，所以 `kill(-pgid)` 一下就都收了。
 * @param child - 子进程句柄。
 * @param reason - 收掉的理由。
 */
async function killTree(child: ChildProcess, reason?: string): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    const { spawn } = await import('node:child_process')
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => resolve())
      killer.on('close', () => resolve())
    })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // 已经退了。
    }
  }
  void reason
}

/**
 * 把一个带原始流的进程登记进进程范围。
 * @param range - 进程范围。
 * @param process - 托管句柄。
 */
export function addStreamToRange(range: { add: (process: RangeMember) => void }, process: ManagedStreamProcess): void {
  range.add(process)
}
