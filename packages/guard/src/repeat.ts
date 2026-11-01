/**
 * 重复工具调用提醒（循环卫生）。
 *
 * 模型把**完全相同**的工具调用反复发出来时，在工具结果里附一句提醒，让它换个做法或者
 * 收尾——卡住的循环烧的是时间和 token，而提醒比直接掐断温和：模型多半自己就换路了。
 *
 * 判定口径（三条同时成立才算「重复」）：
 *   1. 工具名相同；
 *   2. 参数**逐字节相同**。不做 JSON 归一化：`{"a":1}` 与 `{ "a": 1 }` 算不同的调用——
 *      模型确实又发了一遍，但它发的不是同一个东西，语义上值得单独看；
 *   3. **连续**：中间没有插入别的工具调用。插入一条别的调用就断链——模型换了做法再回到
 *      同一个调用，那是一次新的尝试，不该被当成卡住。
 *
 * 计数有两套，别混：
 *   - **重复次数**按「连续链」累加，链断一次归零——换了做法之后回到同一个调用是新的一次尝试；
 *   - **提醒次数是这台提醒器的总额**，只有 {@link RepeatToolReminder.reset} 才清零。防刷屏看的是
 *     总量：每换一条链就重新给额度，模型只要来回换着调就能一直收到提醒，等于没设上限。
 *
 * 每轮开始时宿主应当调一次 {@link RepeatToolReminder.reset}——两轮之间隔着用户的话，那不叫「连续」。
 * @module @ryharness/guard/repeat
 */

/** 一次工具调用的身份：工具名 + 参数原文。 */
export interface RepeatToolCall {
  /** 工具名。 */
  name: string
  /** 参数原文（模型给出的 JSON 字符串），逐字节比较。 */
  arguments: string
}

/** 提醒器的配置。 */
export interface RepeatToolReminderOptions {
  /**
   * 一条连续链上最多提醒几次。默认 {@link DEFAULT_MAX_REMINDERS}。
   * 超过之后不再提醒——但调用照常执行：提醒是建议，不是拦截。
   *
   * 这是**这台提醒器的总额**，不是每条链的额度：换条链就重新给额度的话，模型来回换着调
   * 就能一直收到提醒，等于没设上限。宿主想按轮重置就调 {@link RepeatToolReminder.reset}。
   */
  maxReminders?: number
  /** 提醒文案（可选，默认 {@link repeatReminderText}）。 */
  formatReminder?: (input: { name: string; repeatCount: number }) => string
}

/** 登记一次工具调用之后拿到的判定结果。 */
export interface RepeatVerdict {
  /** 是否要往工具结果里附提醒。 */
  remind: boolean
  /** 连续同参的次数（1 = 第一次出现这个调用）。 */
  repeatCount: number
  /** 这台提醒器已经发过的提醒总数（含本次）——总额口径，不按链重置。 */
  remindedCount: number
  /** 提醒正文（{@link RepeatVerdict.remind} 为 false 时是空串）。 */
  reminder: string
}

/** 默认提醒上限：一条链上提醒两次就够了，再多就是刷屏。 */
export const DEFAULT_MAX_REMINDERS = 2

/**
 * 默认提醒文案。
 *
 * 写清两件事：重复了几次、接下来该干什么。只说「你重复了」没用——模型不知道该换什么。
 */
export function repeatReminderText(input: { name: string; repeatCount: number }): string {
  return (
    `你刚才已经连续第 ${input.repeatCount} 次用完全相同的参数调用工具「${input.name}」。` +
    '不要再原样重试：换个做法（改参数、换工具、先看看目录），或者直接给出结论收尾。'
  )
}

/**
 * 重复调用提醒器。
 *
 * 宿主在**执行前**按模型给出的调用顺序逐条 {@link RepeatToolReminder.note}，
 * 拿到 `remind` 为真就把 {@link RepeatVerdict.reminder} 附到那条工具结果里。
 */
export class RepeatToolReminder {
  private readonly options: RepeatToolReminderOptions
  private readonly maxReminders: number
  /** 上一条调用：连续性的判据只有「上一条」。 */
  private last: RepeatToolCall | undefined
  private repeatCount = 0
  private remindedCount = 0

  constructor(options: RepeatToolReminderOptions = {}) {
    this.options = options
    const raw = options.maxReminders ?? DEFAULT_MAX_REMINDERS
    // NaN 会让「已达上限」永远不成立（比较恒为 false），于是提醒停不下来——按缺省值兜。
    this.maxReminders = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : DEFAULT_MAX_REMINDERS
  }

  /**
   * 登记一次工具调用。
   * @param call - 本次调用的工具名与参数原文。
   * @returns 该次调用要不要附提醒，以及提醒正文。
   */
  note(call: RepeatToolCall): RepeatVerdict {
    const repeated = this.last !== undefined && this.last.name === call.name && this.last.arguments === call.arguments
    // 链断一次就重新计数：换了做法之后回到同一个调用，是新的一次尝试。
    this.repeatCount = repeated ? this.repeatCount + 1 : 1
    this.last = { name: call.name, arguments: call.arguments }
    if (this.repeatCount < 2 || this.remindedCount >= this.maxReminders) {
      return { remind: false, repeatCount: this.repeatCount, remindedCount: this.remindedCount, reminder: '' }
    }
    this.remindedCount += 1
    const format = this.options.formatReminder ?? repeatReminderText
    return {
      remind: true,
      repeatCount: this.repeatCount,
      remindedCount: this.remindedCount,
      reminder: format({ name: call.name, repeatCount: this.repeatCount }),
    }
  }

  /** 清空连续链与提醒额度（换轮、换会话时调用）。 */
  reset(): void {
    this.last = undefined
    this.repeatCount = 0
    this.remindedCount = 0
  }
}
