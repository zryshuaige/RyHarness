/**
 * 请求预算：把「模型上下文窗口」翻译成「输入能占多少 token」「输出预留多少」。
 *
 * 结构对齐 dsh compaction-basic 的 `resolveCompactSpec`（只读对标）：三段式
 * ——thresholdRatio 给输入定上限，headroom 留出工具结果继续回填的余量，
 * reservedCompletionTokens 是留给输出的预留。三者取最小而不是相加，是为了让
 * 小窗口模型（8k/16k）也拿得到一个正的预算，而不是被某个绝对值直接压成 0。
 *
 * @module @ryharness/agent/budget
 */

/**
 * 模型未回报上下文窗口时的兜底窗口（token）。
 *
 * 取 64k 而不是常见的大数：拿不到能力元数据时宁可就窄也不要假装宽——超窗口
 * 是供应商 400，而少送历史只是丢上下文。
 */
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 64_000

/** 输出的默认预留（token）。约等于一次较长的中文回复加工具参数回显。 */
export const DEFAULT_RESERVED_COMPLETION_TOKENS = 4_000

/** 输出预留的下限：低于这个量，一次正常回复都放不下。 */
export const MIN_OUTPUT_TOKENS = 512

/** 输入预算占上下文窗口的比例上限（dsh compaction-basic 的 thresholdRatio）。 */
const THRESHOLD_RATIO = 0.8

/** 留给本轮工具结果与供应商自身开销的余量比例（dsh 的 headroomTokens 相对化）。 */
const HEADROOM_RATIO = 0.15

/** 一次请求的三段式预算。 */
export interface RequestBudget {
  /** 模型上下文窗口（token）。 */
  contextWindowTokens: number
  /** 输出预留（token）。 */
  reservedCompletionTokens: number
  /** 输入侧可用预算（token）：系统提示 + 工具声明 + 历史 + 本轮工具结果。 */
  thresholdTokens: number
}

/** 合法化一个候选窗口：正有限数取整，其余（undefined / 0 / 负数 / NaN）回 undefined。 */
function pickWindow(candidate: number | undefined): number | undefined {
  return candidate !== undefined && Number.isFinite(candidate) && candidate > 0 ? Math.floor(candidate) : undefined
}

/**
 * 按上下文窗口解出三段式预算。
 *
 * 窗口取值优先级：**模型目录已知长度 > 用户覆盖值 > 保守默认**。`contextWindowTokens`
 * 是适配器 `resolveModelInfo` 回报的窗口——用户在设置页补录的长度经 providers.json
 * 进到适配器配置后，走的就是这一条，因此目录里已有值时以它为准；`userContextWindowTokens`
 * 是调用方显式给的覆盖值，只在目录没报窗口时兜底用（比如适配器不含能力元数据、但
 * 调用方手里有用户补录的那份）。两者都缺失或非法时退回
 * {@link FALLBACK_CONTEXT_WINDOW_TOKENS}。
 * @param contextWindowTokens - 模型目录 / 适配器自报的上下文窗口。
 * @param reservedCompletionTokens - 调用方指定的输出预留；缺省用
 *   {@link DEFAULT_RESERVED_COMPLETION_TOKENS}。
 * @param userContextWindowTokens - 用户补录 / 调用方持有的上下文窗口覆盖值。
 */
export function resolveRequestBudget(
  contextWindowTokens: number | undefined,
  reservedCompletionTokens?: number,
  userContextWindowTokens?: number,
): RequestBudget {
  const known = pickWindow(contextWindowTokens) ?? pickWindow(userContextWindowTokens)
  const contextWindow = known ?? FALLBACK_CONTEXT_WINDOW_TOKENS
  const reserved = Math.max(
    MIN_OUTPUT_TOKENS,
    Math.floor(
      reservedCompletionTokens !== undefined && Number.isFinite(reservedCompletionTokens)
        ? reservedCompletionTokens
        : DEFAULT_RESERVED_COMPLETION_TOKENS,
    ),
  )
  const messageBudget = Math.max(0, contextWindow - reserved)
  const thresholdTokens = Math.max(
    0,
    Math.floor(Math.min(contextWindow * THRESHOLD_RATIO, messageBudget - contextWindow * HEADROOM_RATIO)),
  )
  return { contextWindowTokens: contextWindow, reservedCompletionTokens: reserved, thresholdTokens }
}

/**
 * 本次请求的输出上限。
 *
 * 随 prompt 实际占用浮动：多步工具循环每一步都往历史里回填工具输出，固定值
 * 在最后一步会让「输入 + 输出」一起越过窗口——供应商按合计算，不按输入算。
 * @param budget - 三段式预算。
 * @param promptTokens - 本次请求输入侧的实际估算占用。
 */
export function outputTokenCap(budget: RequestBudget, promptTokens: number): number {
  const room = budget.contextWindowTokens - promptTokens
  if (room <= 0) return MIN_OUTPUT_TOKENS
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(budget.reservedCompletionTokens, room))
}
