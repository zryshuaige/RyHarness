/**
 * PTC 的服务契约：宿主把**一段程序**交给运行时，运行时在宿主提供的异步函数上把它跑起来，
 * 然后回报「打印了什么、返回了什么、或者怎么失败的」。
 *
 * PTC = Program To Call：模型不直接调工具，它写一小段程序，程序去调宿主给的函数。
 * 这样「先查三个地方、再把结果拼起来」这类多步逻辑由模型自己决定顺序，宿主只负责
 * 提供能力与边界。
 *
 * 三件事在这份契约里分得很清：
 * - **程序**（{@link PtcRequest.program}）与**模式**（{@link PtcMode}）：同一段源码，
 *   三种跑法，语义不同（见 {@link PtcMode} 的说明）。
 * - **绑定**（{@link PtcBinding}）：宿主给的异步函数，按名给程序用。绑定**不跨进程传函数
 *   句柄**，只传名字与说明，真正被调用时程序那边回头问宿主要结果。
 * - **失败**：失败是**结果的一部分**（{@link PtcResult.failure}），不是异常。调用方要能
 *   把失败原样呈现给模型看——「这段程序报错了，错误是……」比一句 500 有用得多。
 * @module @ryharness/ptc/types
 */

/**
 * 程序形态。
 *
 * - `function-body`：源码是**一个 async 函数体**（不含 `async (…) =>` 那段签名）。
 *   宿主把它包成 `async (bindings) => { … }` 再调用，绑定作为**唯一那个参数**（一个对象）
 *   传进去；返回值就是函数的 `return`。
 * - `script`：源码是**整段脚本**。绑定是**全局名**（脚本里直接 `readTextFile(…)` 就能用），
 *   宿主把脚本包成 async 函数体执行，顶层 `await` 与 `return` 都认。
 * - `repl`：源码是**一条语句**，逐条执行。绑定同样是全局名；每次执行返回这条语句的
 *   **完成值**（像 REPL 那样，`1 + 1` 得到 2）。配合保留状态，同一个 owner 的后续语句
 *   能看到前面留下的变量。
 */
export type PtcMode = 'function-body' | 'repl' | 'script'

/** 全部程序形态。 */
export const PTC_MODES: readonly PtcMode[] = ['function-body', 'repl', 'script']

/** 是不是一个合法的程序形态（接口入参要靠它收窄）。 */
export function isPtcMode(value: unknown): value is PtcMode {
  return typeof value === 'string' && (PTC_MODES as readonly string[]).includes(value)
}

/**
 * 失败分类。
 *
 * 分类是为了让调用方**能区别对待**：语法错是模型写错了（可以照着报错改），超时是
 * 跑太久（该拆小），`policy` 是越界（该换路径），`aborted` 是人叫停的（不用管）。
 */
export type PtcFailureKind = 'syntax' | 'runtime' | 'timeout' | 'policy' | 'aborted' | 'spawn' | 'limit'

/** 全部失败分类（跨进程传分类时按这份名单校验）。 */
export const PTC_FAILURE_KINDS: readonly PtcFailureKind[] = [
  'syntax',
  'runtime',
  'timeout',
  'policy',
  'aborted',
  'spawn',
  'limit',
]

/** 一次失败。 */
export interface PtcFailure {
  /** 失败分类。 */
  kind: PtcFailureKind
  /** 一句能直接给模型看的中文说明。 */
  message: string
  /** 原始错误信息（堆栈、引擎报错原文）。 */
  detail?: string
}

/**
 * 宿主提供的绑定：程序按名字调用它。
 *
 * 参数用一个数组装（`fn(args)`），因为绑定要**序列化**传给子进程——函数本身传不过去，
 * 传过去的只有名字与说明；程序真的调用时，子进程回头问宿主，宿主执行这个函数再把
 * 结果送回去。
 */
export interface PtcBinding {
  /** 绑定名：程序里按这个名字用。 */
  name: string
  /** 这个绑定是干什么的（给模型看的一句话）。 */
  description?: string
  /** 参数说明（JSON Schema 片段），给模型看。 */
  parameters?: Record<string, unknown>
  /** 宿主这边的实现。抛错就等于这次调用失败。 */
  fn: (args: readonly unknown[]) => unknown
}

/**
 * 文件策略：程序能碰哪些路径。
 *
 * 路径按 `cwd` 解析（相对路径相对于它），判定看**词法层 + 真实路径**两层：符号链接
 * 指向工作区外时，词法层看不出来，真实路径能看出来。
 */
export interface PtcFilePolicy {
  /** 允许读的工作区根；缺省 = `cwd`。 */
  readRoots?: readonly string[]
  /** 允许写的工作区根；缺省 = `readRoots`。 */
  writeRoots?: readonly string[]
  /** 相对路径的基准目录；缺省 = 宿主当前目录。 */
  cwd?: string
}

/**
 * 保留状态：同一 owner 的多次执行要不要共用一个进程。
 *
 * - `none`：每次执行起一个新进程，跑完就结束。
 * - `script`：同一个 owner 复用同一个进程（脚本之间能看到上一次留下的全局变量）。
 * - `repl`：同上，语义上按 REPL 逐条执行。
 */
export type PtcPersistence = 'none' | 'script' | 'repl'

/** 一次执行请求。 */
export interface PtcRequest {
  /** 程序源码。 */
  program: string
  /** 怎么跑这段源码。 */
  mode: PtcMode
  /** 宿主提供的绑定。 */
  bindings?: readonly PtcBinding[]
  /** 文件策略：程序能读哪些路径、能写哪些路径。 */
  filePolicy?: PtcFilePolicy
  /** 超时（毫秒）；到点终止进程并回一条结构化失败。 */
  timeoutMs?: number
  /** 保留状态；缺省时 `repl` 模式按 `repl` 保留，其余按 `none` 每次新进程。 */
  persistence?: PtcPersistence
  /** 状态归属者：同一 owner 的执行共用一个进程。缺省 = `default`。 */
  owner?: string
  /** 取消信号。 */
  signal?: AbortSignal
}

/** 一次执行的结果。 */
export interface PtcResult {
  /** 跑成了没有。失败时为 false，失败细节在 `failure` 里。 */
  ok: boolean
  /** 程序打印出来的内容（按顺序）。 */
  output: readonly string[]
  /** 程序的返回值；没有返回值时缺省。 */
  value?: unknown
  /** 失败信息；跑成了时缺省。 */
  failure?: PtcFailure
  /** 这次执行花了多久（毫秒）。 */
  durationMs: number
}

/**
 * PTC 运行时：宿主把程序交给它，它跑完回报结果。
 *
 * 这份契约不关心「在哪个进程里跑」「用什么引擎跑」——那是后端的事。上游 dsh 把这件事
 * 拆成「服务契约 + 平台后端」两层，我们照抄这个分层：契约在这里，Node 后端在
 * {@link NodePtcRuntime}。
 */
export interface PtcRuntime {
  /**
   * 跑一段程序。
   *
   * 实现**不许把失败抛给调用方**：语法错、运行时抛错、超时都要变成结果里的失败信息，
   * 调用方要能把它原样呈现给模型。
   * @param request - 程序、模式、绑定、文件策略与时限。
   * @returns 执行结果。
   */
  run(request: PtcRequest): Promise<PtcResult>
  /** 释放某个 owner 的保留进程（状态不再保留）。 */
  release(owner: string): Promise<void>
  /** 全部收尾：结束所有保留进程。 */
  dispose(): Promise<void>
}
