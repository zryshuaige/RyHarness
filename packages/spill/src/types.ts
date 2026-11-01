/**
 * 溢出文本的契约：存哪、怎么取、谁能取。
 *
 * 这一族解决的是一个具体的麻烦：**工具结果太长会把模型上下文吃穿**。
 * 做法是让原文落到模型看不见的地方，模型只拿到一段预览加一个定位符——
 * 它想看全文时，自己拿着定位符分页取回来。
 *
 * 三个角色分开写：
 * - {@link SpillStore}：只管「存下这段文字」和「按定位符取回来」，不关心谁在用。
 * - {@link SpillRef}：定位符。**不是路径**，是「一段文字的地址」；路径只是给人排查看的。
 * - 策略（在 policy.ts）：判定结果要不要溢出，以及溢出后给模型看什么。
 *
 * 会话隔离是这一层的硬要求：溢出文本落在**会话私有目录**里，别的会话拿着同一个
 * 定位符也取不到。定位符本身是不可猜的随机串，但这不能替代隔离——泄露一个
 * 定位符不该等于泄露整段对话。
 * @module @ryharness/spill/types
 */

/**
 * 取回工具的名字。
 *
 * 放在契约文件里是因为**两处要用同一个名字**：存储层写「取回指引」时要提到它，
 * 工具注册时也要用它。名字对不上，模型照着指引去找一个不存在的工具。
 */
export const SPILL_READ_TOOL_NAME = 'spill_read'

/** 溢出文本的错误码。 */
export type SpillErrorCode =
  /** 找不到这段溢出文本（不存在，或已被清理）。 */
  | 'NOT_FOUND'
  /** 这段溢出文本不属于当前调用方（别的会话）。 */
  | 'FORBIDDEN'
  /** 存不下：单条太大，或总量超过容量上限。 */
  | 'CAPACITY_EXCEEDED'
  /** 参数不合法（正文不是字符串、定位符不合法等）。 */
  | 'INVALID_INPUT'
  /** 读文件时出的其它问题（磁盘坏了、权限不对）。 */
  | 'READ_FAILED'

/** 溢出这一族统一的错误：带机器可读的码，宿主据此映射 HTTP 状态。 */
export class SpillError extends Error {
  constructor(
    readonly code: SpillErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SpillError'
  }
}

/** 存进去时一起记下的元信息。 */
export interface SpillMeta {
  /**
   * 会话 id：决定这段文本归谁。
   *
   * 缺省表示「不归属任何会话」——那份文本谁都能取（靠定位符本身当钥匙）。
   * 正常路径上总有会话：工具执行上下文里带得到。
   */
  readonly sessionId?: string
  /** 是哪个工具的结果溢出了（回头好找）。 */
  readonly tool?: string
  /** 其它备注。 */
  readonly note?: string
}

/**
 * 定位符：一段溢出文本的地址。
 *
 * 刻意**不是**文件路径：路径拼错了会把模型引到工作区里的某个文件上，
 * 而定位符只能取回「当初存进去的那段文字」。
 */
export interface SpillRef {
  /** 稳定 id：取回时用它。 */
  readonly id: string
  /** 原文长度（字符）。 */
  readonly chars: number
  /** 落在私有目录里的相对路径：给人排查用的，不是给模型拼路径用的。 */
  readonly path: string
  /** 取回方式：一句可以直接照着做的话。 */
  readonly retrieval: string
  /** 写入时间（ISO 字符串）。 */
  readonly createdAt: string
  /** 归属的会话（没有归属时缺省）。 */
  readonly sessionId?: string
  /** 来源工具（没记时缺省）。 */
  readonly tool?: string
}

/** 取回时的参数。 */
export interface SpillReadOptions {
  /**
   * 取回者所属会话。
   *
   * 与存放时的会话不一致就拒——这是隔离的执行点。缺省表示「调用方没有会话归属」，
   * 此时只能取回不归属任何会话的那部分。
   */
  readonly sessionId?: string
  /** 从第几个字符开始（缺省从头）。 */
  readonly offset?: number
  /** 最多取多少字符（缺省一次取完）。 */
  readonly limit?: number
}

/** 取回的结果。 */
export interface SpillReadResult {
  /** 定位符 id。 */
  readonly id: string
  /** 这次取回的那一段。 */
  readonly text: string
  /** 原文总长度（字符）。 */
  readonly chars: number
  /** 这次从第几个字符开始。 */
  readonly offset: number
  /** 下一段的起点；没有下一段时缺省。 */
  readonly nextOffset?: number
  /** 后面还有没有。 */
  readonly hasMore: boolean
  /** 写入时间（ISO 字符串）。 */
  readonly createdAt: string
  /** 这段文字的元信息。 */
  readonly meta?: SpillMeta
}

/** 清理时的参数。 */
export interface SpillCleanupOptions {
  /** 只清这个会话的（缺省清所有会话的）。 */
  readonly sessionId?: string
  /**
   * 只清比这更老的（毫秒）。
   *
   * 缺省用构造存储时的过期年龄；传 0 表示「符合条件的一律清掉」。
   */
  readonly olderThanMs?: number
}

/** 清理的结果。 */
export interface SpillCleanupResult {
  /** 清掉了几条。 */
  readonly removed: number
  /** 腾出多少字节。 */
  readonly freedBytes: number
}

/**
 * 溢出存储：存下一段文字，给一个定位符；按定位符取回来。
 *
 * 实现方（本仓提供 {@link LocalSpillStore}）要满足三条：
 * 1. **存不下要报错**，不能悄悄吞掉——上层据此决定「保留原文还是换预览」。
 * 2. **按会话隔离**：别的会话拿着同一个定位符取不到。
 * 3. **能清理**：溢出文件是实打实占着磁盘的，得有办法收。
 */
export interface SpillStore {
  /**
   * 存下一段文字。
   * @param text - 要存的正文（就是工具结果那一份，不做改写）。
   * @param meta - 元信息（会话归属、来源工具等）。
   * @returns 定位符。
   * @throws SpillError - 存不下时抛（`CAPACITY_EXCEEDED` 等）。
   */
  store(text: string, meta?: SpillMeta): SpillRef
  /**
   * 按定位符取回原文。
   * @param locator - 定位符（id 或 {@link SpillRef} 都行）。
   * @param options - 取回参数（会话归属、分页位置）。
   * @returns 取回的那一段。
   * @throws SpillError - 找不到（`NOT_FOUND`）或不属于调用方（`FORBIDDEN`）。
   */
  read(locator: string | SpillRef, options?: SpillReadOptions): SpillReadResult
  /**
   * 删掉一条。
   * @param locator - 定位符。
   * @returns 删掉了返回 true，本来就没有返回 false。
   */
  remove(locator: string | SpillRef): boolean
  /**
   * 清理（过期或指定会话的）。
   * @param options - 清理条件。
   * @returns 清掉几条、腾出多少字节。
   */
  cleanup(options?: SpillCleanupOptions): SpillCleanupResult
  /**
   * 列出现有的溢出文本（新到旧）。
   * @param sessionId - 只列这个会话的（缺省列全部）。
   * @returns 定位符列表。
   */
  list(sessionId?: string): SpillRef[]
}

/** 一次工具执行里，这一族关心的上下文。 */
export interface SpillToolContext {
  /** 当前会话 id：取回工具靠它确认「这段文本是不是我的」。 */
  readonly conversationId?: string
  /** 取消信号。 */
  readonly signal?: AbortSignal
}

/** 工具结果。 */
export interface SpillToolResult {
  /** 正文，作为 tool 消息进模型历史。 */
  readonly content: string
  /** 是不是错误结果。 */
  readonly isError?: boolean
}

/**
 * 一个可注册的工具。
 *
 * 形状上与宿主（`@ryharness/agent`）的 Tool 契约一致，所以宿主可以直接把它注册进
 * 工具表；本包不 import 那个包——工具契约会变，这个包不该被它拖着走。
 */
export interface SpillTool {
  /** 工具名（注册进工具表时用它）。 */
  readonly name: string
  /** 给模型看的一句话说明。 */
  readonly description: string
  /** JSON Schema（对象）。 */
  readonly parameters: Record<string, unknown>
  /** 执行。 */
  execute(args: unknown, ctx: SpillToolContext): Promise<SpillToolResult>
}
