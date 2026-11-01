/**
 * 终端能力家族的公共类型。
 *
 * 这一族分两个角色，说清职责差别是本文件的主要目的：
 *
 * - **会话服务**（{@link TerminalService}）管「会话归谁、别人能不能碰、关的时候
 *   有没有等干净」——它认识 owner、发不透明 id、围栏、等待式清理。
 * - **交互式后端**（{@link TerminalBackend}）管「怎么把一个交互式 shell 跑起来、
 *   怎么知道它真的能用了、怎么把输出读出来」——它不关心会话归谁。
 *
 * 之所以分成两个接口而不是一个大类：会话服务不该知道 shell 是 bash 还是 pwsh，
 * 后端也不该知道 owner 是谁。中间靠 {@link TerminalBackendSession} 这条契约接上，
 * 换后端（真 PTY、远端 shell、容器里的 shell）时服务那一侧一行不用改。
 *
 * 上游 dsh 的对应物是 `terminal`（服务）与 `terminal-bash`（后端）两个包；我们把
 * 两个包合成一个 `@ryharness/terminal`，公共面用同一个文件导出。
 * @module @ryharness/terminal/types
 */

/**
 * 会话的归属者。
 *
 * 通常是助理 id 或对话 id。**围栏按这个值精确比对**：`"agent-1"` 与
 * `"agent-1 "`、`"Agent-1"` 是三个不同的 owner——不做 trim、不做大小写折叠、
 * 不做前缀匹配。拿不准就当不是同一个。
 */
export type TerminalOwner = string

/** 会话的生命周期阶段。 */
export type TerminalSessionState =
  /** 已分配 id，但后端还没就绪（正等就绪探测）。 */
  | 'created'
  /** 后端就绪探测通过，能接收输入了。 */
  | 'ready'
  /** 已关闭；进程已退出、输出已收干净。 */
  | 'closed'

/** 一次读取结果的截断原因。 */
export type TerminalTruncationReason =
  /** 达到了本次读取的字节上限。 */
  | 'limit'
  /** 会话保留的输出总量超了上限，最旧的部分被丢掉。 */
  | 'retention'

/**
 * 一次输出的读取结果。
 *
 * **每次读取都有上限**：输出是无界的（一条 `yes` 就能刷出无限字节），所以读的时候
 * 必须能截断，而且必须说清「丢了多少、还剩多少」，否则调用方会以为屏幕上
 * 显示的就是全部。
 */
export interface TerminalReadResult {
  /** 读到的文本。 */
  readonly text: string
  /** 读到的字节数（按 UTF-8 计）。 */
  readonly bytes: number
  /** 这次读是否被截断了。 */
  readonly truncated: boolean
  /** 截断的原因；没截断时是 undefined。 */
  readonly truncationReason?: TerminalTruncationReason
  /**
   * 本次读取之后，缓冲区里还剩多少字节没被读走。
   *
   * 这是「还有话没说完」的量：调用方可以据此决定要不要接着读。
   */
  readonly remainingBytes: number
  /** 因为保留上限而被丢掉的字节数（累计）。 */
  readonly droppedBytes: number
}

/** 后端的能力声明。 */
export interface TerminalBackendCapabilities {
  /**
   * 是不是真 PTY。
   *
   * **本包默认的后端是 false**：Windows 上没有真 PTY 可用（node-pty 是原生模块，
   * 本项目不引），因此走管道模式。真 PTY 才能跑 vim/top 这类全屏交互程序。
   */
  readonly realPty: boolean
  /** 能不能在会话里跑全屏交互程序（vim、top）。管道模式下为 false。 */
  readonly fullScreenInteractive: boolean
  /** 一句话说明这个后端的能力边界，给界面与日志用。 */
  readonly notes: string
}

/** 后端会用到的一组 shell 方言。 */
export type TerminalShellDialect = 'bash' | 'pwsh'

/**
 * 后端的启动参数。
 *
 * 服务把它交给后端，后端据此决定起什么进程。
 */
export interface TerminalBackendSpec {
  /** 会话 id（服务发的，后端只当是个标识用）。 */
  readonly sessionId: string
  /** 初始工作目录。 */
  readonly cwd?: string
  /** 额外注入的环境变量。 */
  readonly env?: Readonly<Record<string, string>>
  /** 取消信号：用户中断了这一步就别再起进程了。 */
  readonly signal?: AbortSignal
}

/** 后端起来之后交给服务的那一份句柄。 */
export interface TerminalBackendSession {
  /** 后端类型（`'bash'`、`'pwsh'` 等）。 */
  readonly dialect: TerminalShellDialect
  /** 顶层进程的 pid；后端没有就报 undefined。 */
  readonly pid?: number
  /** 后端的能力声明。 */
  readonly capabilities: TerminalBackendCapabilities

  /**
   * 等到 shell 真的能用了再 resolve。
   *
   * 这一步是**就绪探测**：发一条探针命令，等它的回声回来。发完就当 ready 是错的——
   * 进程刚 fork 出来时 stdin 还没被 shell 读走，这时候写进去的东西可能丢。
   * @param timeoutMs - 等多久算超时。
   */
  waitReady(timeoutMs: number): Promise<void>

  /**
   * 往 shell 发一段输入。
   *
   * `submit` 为 true 时补一个换行，让 shell 真正执行这一行。
   * @param text - 要写入的文本。
   * @param options - 是否补换行。
   */
  send(text: string, options?: { readonly submit?: boolean }): Promise<void>

  /**
   * 读一段新输出。
   *
   * 返回的是**增量**：上一次 read 之后新产生的部分。调用方拿到
   * {@link TerminalReadResult.remainingBytes} 就知道还有没有下文。
   * @param options - 单次上限与等待时长。
   */
  read(options?: { readonly maxBytes?: number; readonly waitMs?: number }): Promise<TerminalReadResult>

  /**
   * 改工作目录。
   *
   * 实现要**发 `cd` 并确认**（读回新目录），不能只发不管——目录不存在时 shell
   * 会报错但会话还活着，调用方需要知道到底成没成。
   * @param path - 目标目录。
   * @param options - 等待时长。
   * @returns 改完之后 shell 自己报告的当前目录。
   */
  changeDirectory(path: string, options?: { readonly timeoutMs?: number }): Promise<string>

  /**
   * 中断当前正在跑的命令。
   *
   * 管道模式下没有 tty 的行规程，`\x03` 写进去 shell 不会当 SIGINT 处理，
   * 所以实现必须去动前台子进程，而不是写控制字符（见 README 的边界一节）。
   */
  interrupt(): Promise<void>

  /**
   * 结束输入流（相当于 Ctrl-D）。
   *
   * 管道模式下真正的 EOF 是**关掉 stdin**，不是写 `\x04`。
   */
  closeInput(): Promise<void>

  /**
   * 关掉会话：杀掉整棵进程树，并等它真的退出。
   *
   * 返回时进程必须已经不在了——这是「等待式清理」的硬要求。
   */
  close(): Promise<void>
}

/**
 * 一个后端实现。
 *
 * 后端只管「怎么把 shell 跑起来」，不管会话归谁、发什么 id、怎么清理。
 */
export interface TerminalBackend {
  /** 后端类型名，创建会话时按它选后端。 */
  readonly type: string
  /** 能力声明。 */
  readonly capabilities: TerminalBackendCapabilities
  /** 起一个会话；就绪探测没过就 reject。 */
  open(spec: TerminalBackendSpec): Promise<TerminalBackendSession>
}

/** 创建会话时的请求。 */
export interface TerminalCreateRequest {
  /** 用哪个后端；不给就用服务默认的那个。 */
  readonly backend?: string
  /** 初始工作目录。 */
  readonly cwd?: string
  /** 额外注入的环境变量。 */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * 一个会话的对外视图。
 *
 * 这是**快照**，不是活对象：调用方拿到的 `state` 是那一刻的状态。
 */
export interface TerminalSession {
  /** 不透明会话 id。 */
  readonly id: string
  /** 会话归属者。 */
  readonly owner: TerminalOwner
  /** 生命周期阶段。 */
  readonly state: TerminalSessionState
  /** 用的是哪个后端。 */
  readonly backend: string
  /** shell 方言。 */
  readonly dialect: TerminalShellDialect
  /** 当前工作目录。 */
  readonly cwd: string
  /** 这个会话额外注入的环境变量（不含继承自宿主进程的）。 */
  readonly env: Readonly<Record<string, string>>
  /** 已发出的命令历史（按时间顺序）。 */
  readonly history: readonly string[]
  /** 顶层进程 pid。 */
  readonly pid?: number
  /** 创建时刻（毫秒时间戳）。 */
  readonly createdAt: number
}
