/**
 * 内核压缩链路：工具结果预裁剪（model-free）+ 阈值触发的摘要。
 *
 * 为什么两段（对齐 dsh 的 compaction-tool-result-pruner / compaction-basic，只读
 * 对标）：先做预裁剪是因为它不需要模型、可以在首 token 之前同步跑完，而且省下的
 * 是最肥的那部分——工具输出；只有预裁剪之后仍然超阈值，才值得为这一轮付一次
 * 摘要调用。顺序反过来就是拿一次模型往返去省几百 token。
 *
 * 与"直接裁掉最旧"的关系：{@link trimHistoryToBudget} 是保底的丢弃式裁剪，它把
 * 窗口外的历史整段扔掉；压缩链路的目标是那部分历史**别丢**——把它压成一段摘要
 * 留在最前面，逐字保留的只有最近 {@link CompactSpec.retainTokens} token。
 * 摘要不可用（没配 summarize、调用失败、返回空）时自动退回丢弃式裁剪，压缩链路
 * 永远不会让一轮对话比不压缩更糟。
 *
 * 摘要只活在**这一次请求**里，不落库：会话日志永远是原文（落库的也是原文，压缩
 * 只改"发给模型的那一份"）。代价要说清楚——超预算的长会话每轮都可能付一次摘要
 * 调用，而不是只付一次；换来的是摘要永远与当前日志一致，不会攒出一份越滚越偏的
 * 二手摘要。
 *
 * @module @ryharness/agent/compact
 */

import type { ContentBlock, GenerateOptions, LlmRuntime, Message, StreamChunk } from '@ryharness/llm'
import { BlockAssembler, createUserMessage, estimateMessageTokens, estimateTokens } from '@ryharness/llm'
import { MIN_OUTPUT_TOKENS, type RequestBudget } from './budget.ts'

/**
 * 预裁剪后替换被删中段的标记。
 *
 * 必须留痕：模型看到的工具输出是不完整的，不告诉它就会基于残缺内容给出自信的
 * 错误结论（dsh 用同一思路，只是文案不同）。
 */
export const PRUNE_MARKER = '\n\n…[工具输出中段已裁剪]\n\n'

/** 单条工具结果超过该 token 数才预裁剪：够小的结果留着，它们往往正是答案本身。 */
const DEFAULT_TOOL_RESULT_PRUNE_TOKENS = 2_000
/** 预裁剪保留的头部占比（其余中段删）。 */
const PRUNE_HEAD_RATIO = 0.5
/** 摘要后逐字保留的最近历史占输入阈值的比例（dsh 的 retainRatio）。 */
const DEFAULT_RETAIN_RATIO = 0.25
/** 摘要请求的输出上限（token）。 */
const DEFAULT_SUMMARY_MAX_TOKENS = 1_024
/** 摘要注入块的抬头：模型据此知道这段文本是压缩产物，不是用户原话。 */
const SUMMARY_HEADER = '[历史摘要] 以下是更早对话的压缩摘要（保留要点，措辞已失真）：\n'

/**
 * 摘要指令。
 *
 * 用中文而不是照搬 dsh 的英文模板：本项目的对话几乎全是中文，摘要的读者也是
 * 同一个模型，模板语言与对话语言一致时要点保真度更高。要求"只写要点、不要
 * 客套"是为了让摘要 token 可控——摘要自己要占输入预算。
 */
const SUMMARY_INSTRUCTION = [
  '请把上面这段对话压缩成一段不超过 12 行的要点摘要，供后续对话在看不到原文时继续。',
  '要求：保留用户的原始目标与偏好、已经做出的决定与结论、尚未完成的事项、关键的文件名/命令/报错原文；',
  '丢弃寒暄、重复与过程细节。只输出摘要正文，不要解释你在做什么。',
].join('\n')

/** 一轮压缩的三段式预算。 */
export interface CompactSpec {
  /** 触发压缩的输入阈值（token）：超过它就先预裁剪、再摘要。 */
  thresholdTokens: number
  /** 摘要后逐字保留的最近历史（token）。 */
  retainTokens: number
  /** 单条工具结果的预裁剪阈值（token）。 */
  toolResultPruneTokens: number
  /** 摘要调用的输出上限（token）。 */
  summaryMaxTokens: number
}

/** 压缩链路配置。 */
export interface CompactionOptions {
  /**
   * 把一段历史压成一段文本。返回 undefined / 空串表示"这次不摘要"——调用方退回
   * 丢弃式裁剪，而不是让一轮对话卡在这里。
   */
  summarize?(messages: readonly Message[]): Promise<string | undefined>
  /** 逐字保留的最近历史（token）；缺省取输入阈值的 1/4。 */
  retainTokens?: number
  /** 单条工具结果的预裁剪阈值（token）；缺省 2000。 */
  toolResultPruneTokens?: number
  /** 摘要调用输出上限（token）；缺省 1024。 */
  summaryMaxTokens?: number
  /** 压缩是否关闭。关掉后循环只走原有的丢弃式裁剪。 */
  enabled?: boolean
}

/** 一轮压缩的结果。 */
export interface CompactResult {
  /** 压缩后的消息（未触发压缩时就是入参本身）。 */
  messages: Message[]
  /** 是否真的发生了什么（预裁剪或摘要）。 */
  compacted: boolean
  /** 被预裁剪的工具结果条数。 */
  prunedToolResults: number
  /** 预裁剪省下的 token。 */
  prunedTokens: number
  /** 摘要是否成功落地。 */
  summarized: boolean
}

/**
 * 解出压缩的三段式预算。
 *
 * 阈值直接复用 {@link resolveRequestBudget} 的输入上限（它已经扣掉了输出预留与
 * headroom），这里只补 dsh 的 retainRatio 与两条预裁剪/摘要的默认值——三处各有
 * 一个独立含义的量，而不是把一个比例反复乘。
 */
export function resolveCompactSpec(budget: RequestBudget, options: CompactionOptions = {}): CompactSpec {
  const retainTokens = Math.min(
    options.retainTokens ?? Math.floor(budget.thresholdTokens * DEFAULT_RETAIN_RATIO),
    Math.max(0, budget.thresholdTokens - MIN_OUTPUT_TOKENS),
  )
  return {
    thresholdTokens: budget.thresholdTokens,
    retainTokens: Math.max(0, retainTokens),
    toolResultPruneTokens: Math.max(1, options.toolResultPruneTokens ?? DEFAULT_TOOL_RESULT_PRUNE_TOKENS),
    summaryMaxTokens: Math.max(
      MIN_OUTPUT_TOKENS,
      Math.min(options.summaryMaxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS, budget.reservedCompletionTokens),
    ),
  }
}

/**
 * 预裁剪超阈值的工具结果：head + 标记 + tail。
 *
 * 不走"只留头"的粗暴截断：工具输出的关键信息经常在结尾（报错栈、命令 exit code），
 * 只留头等于把模型骗进"看到的是全部输出"的错误结论。
 * @param messages - 待处理的历史（不改入参）。
 * @param spec - 预裁剪阈值。
 * @returns 预裁剪结果；没有超阈值的工具结果时 compacted 为 false。
 */
export function pruneToolResults(messages: readonly Message[], spec: CompactSpec): CompactResult {
  let prunedToolResults = 0
  let prunedTokens = 0
  const out = messages.map((message) => {
    if (message.role !== 'tool') return message
    const cost = estimateMessageTokens(message)
    if (cost <= spec.toolResultPruneTokens) return message
    const content: ContentBlock[] = []
    let emitted = 0
    for (const block of message.content) {
      if (block.type !== 'text') {
        content.push(block)
        continue
      }
      const text = pruneText(block.text, spec.toolResultPruneTokens)
      if (text === block.text) {
        content.push(block)
        continue
      }
      emitted += 1
      if (text.length > 0) content.push({ ...block, text })
    }
    if (emitted === 0) return message
    prunedToolResults += 1
    const next = { ...message, content }
    prunedTokens += cost - estimateMessageTokens(next)
    return next
  })
  return {
    messages: out,
    compacted: prunedToolResults > 0,
    prunedToolResults,
    prunedTokens,
    summarized: false,
  }
}

/**
 * 一段文本的 head + 标记 + tail 版本（不超过 `budgetTokens`，且一定比原文短）。
 *
 * 按 token 而不是字符切：中文与英文的 token/字符比不同，用字符数切会在中文工具
 * 输出上多留一倍不止。
 */
function pruneText(text: string, budgetTokens: number): string {
  const total = estimateTokens(text)
  if (total <= budgetTokens) return text
  // 标记自身的开销从额度里先扣掉，否则"裁剪后仍超预算"会自我循环。
  const room = Math.max(0, budgetTokens - estimateTokens(PRUNE_MARKER))
  const headTokens = Math.floor(room * PRUNE_HEAD_RATIO)
  const tailTokens = room - headTokens
  const head = text.slice(0, charCountWithin(text, headTokens))
  const tail = tailTokens === 0 ? '' : text.slice(charCountWithin(text, total - tailTokens))
  return `${head}${PRUNE_MARKER}${tail}`
}

/** 取前缀里不超过 `budgetTokens` 的最长字符数（估算口径对字符数单调，二分收敛）。 */
function charCountWithin(text: string, budgetTokens: number): number {
  if (estimateTokens(text) <= budgetTokens) return text.length
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (estimateTokens(text.slice(0, mid)) <= budgetTokens) low = mid
    else high = mid - 1
  }
  return low
}

/**
 * 阈值触发的一次压缩：先预裁剪，仍超预算再摘要。
 *
 * 摘要只覆盖"逐字保留窗口之外"的那一段，且切点保证窗口首条不是孤立的工具结果
 * ——切在 tool_call 与 tool_result 之间会让供应商拒绝整个请求（同一约束见
 * {@link trimHistoryToBudget}）。
 * @param messages - 待压缩的历史（不改入参）。
 * @param spec - 三段式预算。
 * @param summarize - 摘要实现；缺省时只预裁剪（model-free 那一半仍然有效）。
 */
export async function compactHistory(
  messages: readonly Message[],
  spec: CompactSpec,
  summarize?: (messages: readonly Message[]) => Promise<string | undefined>,
): Promise<CompactResult> {
  const before = totalTokens(messages)
  if (before <= spec.thresholdTokens) {
    return { messages: [...messages], compacted: false, prunedToolResults: 0, prunedTokens: 0, summarized: false }
  }
  const pruned = pruneToolResults(messages, spec)
  const afterPrune = totalTokens(pruned.messages)
  // 预算装不下摘要时不做摘要：把最旧的逐字内容换成一段同样装不下的文本，只是
  // 白花一次模型往返，还会让调用方的兜底裁剪把摘要先裁掉（净效果 = 多跑一趟）。
  const summaryReserve = estimateTokens(SUMMARY_HEADER) + spec.summaryMaxTokens
  if (afterPrune <= spec.thresholdTokens || summarize === undefined || spec.thresholdTokens <= summaryReserve) {
    return { ...pruned, prunedTokens: pruned.compacted ? before - afterPrune : 0 }
  }

  const split = retainSplit(pruned.messages, retainBudget(pruned.messages, spec))
  if (split.start <= 0) {
    // 逐字窗口已经装得下全部历史：预裁剪就是这一轮的全部压缩，摘要无处可放。
    return { ...pruned, prunedTokens: before - afterPrune }
  }
  let summary: string | undefined
  try {
    summary = await summarize(pruned.messages.slice(0, split.start))
  } catch {
    summary = undefined
  }
  const text = summary?.trim()
  if (text === undefined || text.length === 0) {
    return { ...pruned, prunedTokens: before - afterPrune }
  }
  const summaryMessage = createUserMessage({
    content: [{ type: 'text', text: `${SUMMARY_HEADER}${text}` }],
    source: { kind: 'user' },
  })
  return {
    messages: [summaryMessage, ...pruned.messages.slice(split.start)],
    compacted: true,
    prunedToolResults: pruned.prunedToolResults,
    prunedTokens: before - afterPrune,
    summarized: true,
  }
}

/**
 * 逐字保留窗口的额度：既受配置约束，也要给摘要本身让出位置。
 *
 * 摘要块是这轮压缩后新增的消息，它自己的 token 也从同一个输入预算里出——不预留
 * 的话，"摘要 + 逐字窗口"会超预算，调用方只能再裁一刀，而那一刀会先把摘要丢掉，
 * 压缩就白做了。
 */
function retainBudget(messages: readonly Message[], spec: CompactSpec): number {
  const reserve = estimateTokens(SUMMARY_HEADER) + spec.summaryMaxTokens
  const room = Math.max(0, spec.thresholdTokens - reserve)
  const newest = messages.length === 0 ? 0 : estimateMessageTokens(messages[messages.length - 1] as Message)
  return Math.max(newest, Math.min(spec.retainTokens, room))
}

/**
 * 把一个切点修正成「合法请求」的起点。
 *
 * 合法 = 窗口首条**不是** tool 结果消息。
 *
 * 为什么这条是硬约束：tool 结果消息的配对方是它前面那条带 tool_calls 的
 * assistant 消息。切点落在 tool 结果上时，那条 assistant 已经被切到窗口外
 * （要么被丢掉，要么被摘要成一段文字），窗口首条就成了一条**断掉配对**的
 * tool 结果——OpenAI 兼容供应商会直接 400（"messages with role 'tool' must
 * be a response to a preceding message with 'tool_calls'"），整轮对话就此失败：
 * 用户的消息已经落库，回复却永远不来。
 *
 * 把切点往前挪（挪到那条 assistant 之前）只是把问题往后推：assistant 声明了
 * 几个 tool_calls，就必须有几个 tool 结果跟着，挪到一半仍然是断配对。**唯一
 * 安全的走法是把切点推到整段 tool 结果之后**：那一组（assistant + 它的全部
 * 结果）要么整段留在窗口里（配对完整），要么整段落在窗口外（被摘要覆盖），
 * 不会只丢一半。
 *
 * 窗口被推空是合法结果，不是退化事故：调用方随后会补上这一轮的用户消息
 * （入口裁剪路径）或摘要块（压缩链路），请求里至少有一条消息。宁可少一条，
 * 也不要一条断配对——后者会让整轮直接失败。
 *
 * @param messages - 完整历史（不改入参）。
 * @param start - 原始切点（消息下标）。
 * @returns 修正后的切点；等于 `messages.length` 表示窗口为空。
 */
export function alignWindowStart(messages: readonly Message[], start: number): number {
  let index = Math.max(0, Math.min(start, messages.length))
  while (index < messages.length && (messages[index] as Message).role === 'tool') index += 1
  return index
}

/**
 * 逐字保留窗口的起点（消息下标）。
 *
 * 从最新一条往回累加到 {@link CompactSpec.retainTokens} 为止，再把切点修正成
 * 合法起点（见 {@link alignWindowStart}）：窗口首条必须是 user/assistant，
 * 落一条 tool 结果在头上就是断掉的配对。
 */
function retainSplit(messages: readonly Message[], retainTokens: number): { start: number } {
  let used = 0
  let start = messages.length
  for (let index = messages.length - 1; index >= 0; index--) {
    const cost = estimateMessageTokens(messages[index] as Message)
    if (start < messages.length && used + cost > retainTokens) break
    used += cost
    start = index
  }
  return { start: alignWindowStart(messages, start) }
}

/** 一组消息的 token 合计。 */
function totalTokens(messages: readonly Message[]): number {
  let total = 0
  for (const message of messages) total += estimateMessageTokens(message)
  return total
}

/**
 * 用现有 LLM 运行时做摘要的一次性调用（dsh compaction-basic 的 summarizer 口径）。
 *
 * 摘要指令作为**最后一条 user 消息**跟在待摘要历史之后，理由有两条，都与缓存无关：
 * 1. 形状合法。OpenAI 兼容适配器按每条消息自己的 role 序列化，system 只允许领衔；
 *    在历史中间再插一段 system 要么被拒，要么把整条请求的重排风险推给供应商。
 * 2. 近因优先。指令落在最后一轮，它对模型就是"现在该做什么"；压在前面的 system 里
 *    则要被几千 token 的原话稀释。
 *
 * 这里**没有**供应商侧的 KV cache 收益（原注释曾这么写，是错的）：前缀缓存要求从
 * 第一条消息起逐字节相同，而压缩恰好把"窗口外那段历史"换成了摘要、这次请求的 system
 * 又是压缩器自己的提示，与上一轮请求的 system 完全不同——两处各自就足以让命中归零。
 * 真要吃到前缀缓存，得让摘要调用与 agent 调用共用 system 且消息序列是它的前缀，
 * 代价是摘要器要拿到 agent 的系统提示、并且只在"逐字窗口一字未动"时才成立；当前的
 * 收益（首 token 前少等一次网络）与这条无关，别把它算进压缩的成本里。
 */
export function createLlmSummarizer(
  llm: LlmRuntime,
  route: { provider: string; model: string },
  spec: Pick<CompactSpec, 'summaryMaxTokens'>,
): (messages: readonly Message[]) => Promise<string | undefined> {
  return async (messages) => {
    const request: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      system: '你是一个对话压缩器。',
      messages: [
        ...messages,
        createUserMessage({ content: [{ type: 'text', text: SUMMARY_INSTRUCTION }], source: { kind: 'user' } }),
      ],
      maxTokens: spec.summaryMaxTokens,
    }
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of llm.stream(request)) {
        assembler.push(chunk as StreamChunk)
      }
    } catch {
      return undefined
    }
    // fail-closed：只有完整收尾（stop）的摘要才可用。max-tokens 截断的半截摘要
    // 注入后上下文被静默截短且看起来正常——比没有摘要更糟（与上游 dsh
    // compaction-basic 的 finishError 同款约束）。
    const text =
      assembler.finish.kind !== 'stop'
        ? ''
        : assembler
            .message({ provider: route.provider, model: route.model })
            .content.map((block) => {
              return block.type === 'text' ? block.text : ''
            })
            .join('')
    return text.trim().length === 0 ? undefined : text
  }
}
