import type { ChildProcess, SpawnOptions } from 'node:child_process'

/**
 * 子进程服务的类型契约。
 *
 * 这一族只回答三件事：**进程怎么被找到、怎么被启动、怎么被收掉**。它不回答
 * 「这个进程是什么意思」——命令语义、该不该给模型看超时、结果怎么排版，都归
 * 消费方（shell 工具、terminal、lsp 那些接缝）。两件事混在一起的后果很具体：
 * 一条超时说不清是谁的锅，最后谁都不敢超时。
 *
 * 三个角色分得清清楚楚：
 * - **provider**：真正把进程跑起来的那一层（本机、容器、别的宿主），负责找可执行、
 *   spawn、回收进程树，并**如实汇报自己做不到什么**。
 * - **service**：provider 之上的门面，负责默认值、进程登记与整体收尾。
 * - **process range**：一组进程归谁管，能整体查活、整体终止。
 * @module @ryharness/subprocess/types
 */

/** 一次子进程执行的结果状态。 */
export type SubprocessStatus =
  /** 正常退出（退出码 0）。 */
  | 'completed'
  /** 跑了但没成功：退出码非零，或者压根没启动起来。 */
  | 'failed'
  /** 到了时限被收掉。 */
  | 'timeout'
  /** 调用方主动取消（AbortSignal）。 */
  | 'aborted'
  /** 有人显式调用了 kill。 */
  | 'terminated'

/** 结构化错误码：机器看 code，人看 message。 */
export type SubprocessErrorCode =
  /** 按名字找不到可执行文件。 */
  | 'executable-not-found'
  /** 启动失败（ENOENT、EACCES 之类）。 */
  | 'spawn-failed'
  /** 进程跑了，但退出码不是 0。 */
  | 'non-zero-exit'
  /** 到了时限被收掉。 */
  | 'timeout'
  /** 被取消。 */
  | 'aborted'
  /** 被显式终止。 */
  | 'terminated'
  /** 该收没收掉（taskkill 被策略拦住、进程卡在内核态之类）。 */
  | 'kill-failed'

/** 结构化错误。 */
export interface SubprocessError {
  /** 错误码。 */
  readonly code: SubprocessErrorCode
  /** 一句能直接给人看的中文说明。 */
  readonly message: string
  /** 出错时的原始异常（如果有）。 */
  readonly cause?: unknown
}

/** 一次 spawn 的参数。 */
export interface SubprocessSpawnOptions {
  /** 要跑的命令：可执行文件名（会去找）或路径。 */
  readonly command: string
  /** 参数。 */
  readonly args?: readonly string[]
  /** 工作目录；缺省继承宿主当前目录。 */
  readonly cwd?: string
  /** 宿主明确要透传的环境变量（白名单之外的追加项）。 */
  readonly env?: Readonly<Record<string, string>>
  /** 覆盖默认的环境白名单。 */
  readonly envAllowlist?: readonly string[]
  /** 额外要拦掉的环境变量名（正则）。 */
  readonly envDeny?: readonly RegExp[]
  /** 是否继承宿主环境；false 表示只留追加的那几项。 */
  readonly inheritEnv?: boolean
  /** 时限（毫秒）；不填 = 不限时。 */
  readonly timeoutMs?: number
  /** 取消信号。 */
  readonly signal?: AbortSignal
  /** stdout 捕获上限（字节）；超出的部分丢弃并标记 truncated。 */
  readonly maxStdoutBytes?: number
  /** stderr 捕获上限（字节）。 */
  readonly maxStderrBytes?: number
  /** 要不要先找可执行文件；false 表示就按给的东西跑（路径一定是全的）。 */
  readonly resolve?: boolean
  /** 这个进程归哪一组（进程范围 id）。 */
  readonly rangeId?: string
  /** 这进程是干什么的（给人看的标签）。 */
  readonly label?: string
  /** stdout 增量回调：拿到的是实时到达的片段，不是最终截断后的全文。 */
  readonly onStdout?: (chunk: string) => void
  /** stderr 增量回调。 */
  readonly onStderr?: (chunk: string) => void
}

/** 一次执行的最终结果。 */
export interface SubprocessResult {
  /** 终态。 */
  readonly status: SubprocessStatus
  /** 实际跑的命令。 */
  readonly command: string
  /** 实际跑的参数。 */
  readonly args: readonly string[]
  /** 进程 id；压根没启动起来时没有。 */
  readonly pid: number | undefined
  /** 退出码；被信号打死时是 null。 */
  readonly exitCode: number | null
  /** 打死进程的信号。 */
  readonly signal: NodeJS.Signals | null
  /** stdout（已按上限截断）。 */
  readonly stdout: string
  /** stderr（已按上限截断）。 */
  readonly stderr: string
  /** stdout 实际产出的总字节数（不管有没有被截断）。 */
  readonly stdoutBytes: number
  /** stderr 实际产出的总字节数。 */
  readonly stderrBytes: number
  /** stdout 是不是被截断了。 */
  readonly stdoutTruncated: boolean
  /** stderr 是不是被截断了。 */
  readonly stderrTruncated: boolean
  /** 跑了多久（毫秒）。 */
  readonly durationMs: number
  /** 失败、超时、取消时的结构化原因。 */
  readonly error?: SubprocessError
}

/**
 * 一个被托管的进程句柄。
 *
 * 「托管」的意思是：这个进程归本服务管——它能被整棵树地收掉、超时会被自动收、
 * 输出会被有界地收着。句柄本身不代表它还活着，`finished` 说了算。
 */
export interface ManagedProcess {
  /** 本次 spawn 的 id（同一次服务内唯一）。 */
  readonly id: string
  /** 标签（给人看的）。 */
  readonly label: string
  /** 实际跑的命令。 */
  readonly command: string
  /** 实际跑的参数。 */
  readonly args: readonly string[]
  /** 进程 id；没启动起来时没有。 */
  readonly pid: number | undefined
  /** 什么时候启动的（毫秒时间戳）。 */
  readonly startedAt: number
  /** 结束了没有。 */
  readonly finished: boolean
  /** 结束后的结果；还没结束时不结算。 */
  readonly done: Promise<SubprocessResult>
  /**
   * 收掉这个进程**以及它的整棵子进程树**。
   * @param reason - 收掉的理由（写进错误信息，给人看）。
   */
  kill(reason?: string): Promise<void>
}

/** 进程树怎么收。 */
export type TreeKillStrategy =
  /** Windows：taskkill /T /F，按父子关系枚举。 */
  | 'taskkill'
  /** POSIX：进程组 kill（子进程单独成组）。 */
  | 'process-group'
  /** 收不了：只能杀直接子进程。 */
  | 'none'

/**
 * provider 的能力与**降级披露**。
 *
 * `notes` 不是装饰：上游 dsh 的规矩是「做不到什么要说出来」，因为宿主要拿这些
 * 说明决定能不能把「进程树已经收干净」这句话说出口。空数组 = 没有降级。
 */
export interface SubprocessCapabilities {
  /** provider id。 */
  readonly providerId: string
  /** 进程树怎么收。 */
  readonly treeKill: TreeKillStrategy
  /** 有没有原生的托管范围（Windows Job Object、Linux cgroup）。 */
  readonly nativeManagedRange: boolean
  /** 输出捕获是不是始终有上限。 */
  readonly boundedOutput: boolean
  /** 降级说明（中文，一句一条）。 */
  readonly notes: readonly string[]
}

/** provider 契约：把进程跑起来的那一层。 */
export interface SubprocessProvider {
  /** provider id（如 `local`）。 */
  readonly id: string
  /** 能力与降级说明。 */
  readonly capabilities: SubprocessCapabilities
  /**
   * 找可执行文件。
   * @param options - 命令名、候选目录与环境。
   * @returns 找到就给出路径，没找到给出结构化原因（不抛异常）。
   */
  resolveExecutable(options: ResolveExecutableOptions): ExecutableResolution
  /**
   * 托管启动一个进程。
   *
   * 实现必须做到：输出有界、超时与取消会收掉进程、进程树会被回收。
   * @param options - 启动参数。
   * @returns 进程句柄。
   */
  spawn(options: SubprocessSpawnOptions): ManagedProcess
  /**
   * 原始 spawn：不管输出、不管时限，只把进程跑起来。
   *
   * **给长驻服务用**（见 {@link SubprocessRawSpawnOptions}）：它们要自己管
   * stdin/stdout 的协议流，`ManagedProcess` 那套「跑完拿结果」的形状装不下。
   * 环境清洗由调用方做（用 `scrubEnvironment`）。
   *
   * **可选**：provider 不实现它时，长驻进程就起不来（报一条清楚的错误），而不是
   * 悄悄退回到「不管输出上限、不管树回收」的裸 spawn。
   * @param options - 启动参数。
   * @returns 子进程句柄。
   */
  spawnRaw?(options: SubprocessRawSpawnOptions): ChildProcess
}

/**
 * 原始 spawn 的参数。
 *
 * **这条口子只给「长驻服务」用**（语言服务器、MCP 服务器、持久终端、子代理
 * 后端）。普通命令走 {@link SubprocessSpawnOptions}。
 */
export interface SubprocessRawSpawnOptions {
  /** 要跑的命令（路径或名字）。 */
  readonly command: string
  /** 参数。 */
  readonly args?: readonly string[]
  /** 工作目录。 */
  readonly cwd?: string
  /** 子进程的环境（已经清过）。 */
  readonly env?: NodeJS.ProcessEnv
  /** stdio 配置。 */
  readonly stdio?: SpawnOptions['stdio']
}

/** 找可执行文件的参数。 */
export interface ResolveExecutableOptions {
  /** 命令名或路径。 */
  readonly name: string
  /** 额外候选目录；排在 PATH 前面。 */
  readonly candidates?: readonly string[]
  /** 从哪取 PATH；缺省用宿主环境。 */
  readonly env?: NodeJS.ProcessEnv
  /** 按哪个平台找；缺省用当前平台。 */
  readonly platform?: NodeJS.Platform
}

/** 找可执行文件的结果。 */
export type ExecutableResolution =
  | {
      readonly found: true
      /** 找到的完整路径。 */
      readonly path: string
      /** 从哪儿找到的：`direct` 是调用方直接给了路径。 */
      readonly source: 'direct' | 'candidate' | 'path'
    }
  | {
      readonly found: false
      /** 没找到的原因。 */
      readonly reason: 'not-found' | 'invalid-name'
      /** 找过哪些路径（给排障用）。 */
      readonly searched: readonly string[]
      /** 一句能直接给人看的中文说明。 */
      readonly message: string
    }

/** 进程范围的托管档位。 */
export type ManagedRangeSupport =
  /** 原生托管（Job Object / cgroup）：整组一起管。 */
  | 'native'
  /** 模拟：逐个记着，终止时一个一个收。 */
  | 'emulated'
  /** 管不了：只能各管各的。 */
  | 'none'

/**
 * 进程范围里的一员。
 *
 * **只要「能查活、能终止」**：范围提供的是整体动作，不需要知道每个进程是
 * 「跑完拿结果」那种（{@link ManagedProcess}）还是「一直活着自己管协议流」那种
 * （`ManagedStreamProcess`）。两者都满足这一条，所以都能进同一个范围。
 */
export interface RangeMember {
  /** 本次 spawn 的 id。 */
  readonly id: string
  /** 标签（给人看的）。 */
  readonly label: string
  /** 进程 id；压根没启动起来时没有。 */
  readonly pid: number | undefined
  /** 结束了没有。 */
  readonly finished: boolean
  /**
   * 收掉这个进程**以及它的整棵子进程树**。
   * @param reason - 收掉的理由（写进错误信息，给人看）。
   */
  kill(reason?: string): Promise<void>
}

/** 进程范围：一组进程归谁管。 */
export interface ProcessRange {
  /** 范围 id。 */
  readonly id: string
  /** 范围的名字（给人看的）。 */
  readonly label: string
  /** 这个范围的托管档位。 */
  readonly support: ManagedRangeSupport
  /** 降级说明（中文）；没有降级就是空数组。 */
  readonly notes: readonly string[]
  /** 登记一个进程。 */
  add(process: RangeMember): void
  /** 移出一个进程。 */
  remove(process: RangeMember): void
  /** 组里的全部进程。 */
  list(): readonly RangeMember[]
  /** 组里还活着的进程。 */
  alive(): readonly RangeMember[]
  /**
   * 整组终止。
   * @param reason - 终止理由（写进每个进程的错误信息）。
   */
  terminate(reason?: string): Promise<void>
}
