/**
 * 单次工具调用超时。
 *
 * 我们有「整轮取消」与「会话配额」，但没有**单次调用**的时限：工具不返回就永远挂着，
 * 这一轮就停在那儿，模型什么都看不到。现在补上——工具自己声明 `timeoutMs` 时，宿主在这个
 * 时限内把它收掉，把一条可读的中文错误结果回给模型，让它换条路。
 *
 * 「收掉」的实际含义（JS 里没有强杀）：宿主给工具派发自己的 AbortSignal，到点 abort 掉，
 * 并**立刻**把超时结果回给模型；工具自己收不收得住由工具决定（`shell_exec` 已经在用
 * `ctx.signal` 杀进程树）。宿主不等待工具的收尾——等它就等于把超时又拖回成挂起。
 * @module @ryharness/guard/timeout
 */

/** 工具执行结果（最小形状）：guard 只关心文本与是否出错，别的由工具自己定。 */
export interface GuardToolResult {
  /** 文本内容，作为 tool 消息进模型历史。 */
  content: string
  /** 是否是错误结果（超时、被拒、工具自己报的错）。 */
  isError?: boolean
}

/** 一次工具调用的收口方式。 */
export type TimeoutStatus = 'completed' | 'timeout' | 'aborted'

/** {@link runToolWithTimeout} 的入参。 */
export interface TimeoutRunOptions<T> {
  /** 工具名（写进错误文案，模型才知道是哪一步超时了）。 */
  name: string
  /**
   * 工具自己声明的单次调用时限（毫秒）。
   * 缺省 / 非法（<=0 / 非有限）= 不设限——宿主不替工具编一个上限。
   */
  timeoutMs?: number
  /** 外层取消信号（整轮取消）：到点直接结束这次调用，并把取消传给工具。 */
  signal?: AbortSignal
  /** 执行体。收到的 signal 是宿主派发的——超时或取消时它会被 abort。 */
  execute: (signal: AbortSignal) => Promise<T>
}

/** {@link runToolWithTimeout} 的结果。 */
export interface TimeoutOutcome<T> {
  /** 收口方式。 */
  status: TimeoutStatus
  /** 工具返回值（仅 {@link TimeoutStatus.completed}）。 */
  value?: T
  /** 可读的说明（仅 timeout / aborted）。 */
  message?: string
  /** 可直接回给模型的错误结果（仅 timeout / aborted）。 */
  result?: GuardToolResult
}

/** 超时文案：说清是哪一步、过了多久、接下来该干什么。 */
export function toolTimeoutMessage(name: string, limitMs: number): string {
  return (
    `工具「${name}」超时（上限 ${limitMs}ms），这次调用已被中止。` +
    '换个更小的做法（缩短参数、缩小范围、换工具），或者直接收尾；不要原样重试同样的调用。'
  )
}

/** 取消文案。 */
export function toolAbortedMessage(name: string): string {
  return `工具「${name}」被取消（整轮已取消或会话已结束），这次调用没有跑完。`
}

/** 把不合法的时限归一成「没有上限」。 */
function normalizeTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined
  if (!Number.isFinite(value) || value <= 0) return undefined
  return value
}

/** 工具是否声明了 `timeoutMs`（用类型守卫而不是断言，见 {@link resolveToolTimeoutMs}）。 */
function declaresTimeout(value: object): value is object & { timeoutMs: unknown } {
  return 'timeoutMs' in value
}

/**
 * 从工具对象上读它自己声明的时限。
 *
 * 工具的 `timeoutMs` 是**可选声明**：没声明就是没有上限，宿主不替它编一个。这里用
 * 类型守卫而不是断言——工具对象来自各处（注册表、数组、测试替身），声明形状还没统一到
 * 类型上，断言会把这份不确定性藏起来。
 */
export function resolveToolTimeoutMs(tool: unknown): number | undefined {
  if (typeof tool !== 'object' || tool === null) return undefined
  if (!declaresTimeout(tool)) return undefined
  return normalizeTimeoutMs(tool.timeoutMs)
}

/** 起跑：执行体同步抛错也变成 rejected promise，让两条失败路径长得一样。 */
function startWork<T>(execute: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return Promise.resolve(execute(signal))
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * 在时限内跑完一次工具调用。
 *
 * - 工具正常返回 → `completed`；
 * - 超过工具自己声明的时限 → `timeout`，并把一条中文错误结果交给宿主回给模型；
 * - 外层取消 → `aborted`（宿主可以当整轮取消处理）。
 *
 * 工具抛错时**原样抛出**：错误文案怎么写是宿主的既有语义，guard 不越权改写它。
 */
export async function runToolWithTimeout<T>(options: TimeoutRunOptions<T>): Promise<TimeoutOutcome<T>> {
  const limit = normalizeTimeoutMs(options.timeoutMs)
  const external = options.signal
  // 外层已经取消就别开跑了：工具再跑一遍只会白等。
  if (external?.aborted === true) {
    const message = toolAbortedMessage(options.name)
    return { status: 'aborted', message, result: { content: message, isError: true } }
  }

  const controller = new AbortController()
  const cleanups: (() => void)[] = []
  const onExternalAbort = (): void => {
    controller.abort(external?.reason)
  }
  if (external !== undefined) {
    external.addEventListener('abort', onExternalAbort, { once: true })
    cleanups.push(() => external.removeEventListener('abort', onExternalAbort))
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const work = startWork(options.execute, controller.signal)
    return await new Promise<TimeoutOutcome<T>>((resolve, reject) => {
      let settled = false
      const finish = (outcome: TimeoutOutcome<T>): void => {
        if (settled) return
        settled = true
        resolve(outcome)
      }
      work.then(
        (value) => {
          finish({ status: 'completed', value })
        },
        (error: unknown) => {
          // 超时之后工具才报错：那条错误已经没有读者了，吞掉即可，
          // 但错误处理器必须挂上，否则这条 rejection 变成 unhandledRejection。
          if (settled) return
          settled = true
          reject(error)
        },
      )
      if (limit !== undefined) {
        timer = setTimeout(() => {
          // 先 abort 再收口：订阅了 signal 的工具能立刻收尾，而我们不等它。
          controller.abort(new Error(`tool "${options.name}" timed out after ${limit}ms`))
          const message = toolTimeoutMessage(options.name, limit)
          finish({ status: 'timeout', message, result: { content: message, isError: true } })
        }, limit)
      }
      if (external !== undefined) {
        const onAbort = (): void => {
          const message = toolAbortedMessage(options.name)
          finish({ status: 'aborted', message, result: { content: message, isError: true } })
        }
        external.addEventListener('abort', onAbort, { once: true })
        cleanups.push(() => external.removeEventListener('abort', onAbort))
      }
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    for (const cleanup of cleanups) cleanup()
  }
}
