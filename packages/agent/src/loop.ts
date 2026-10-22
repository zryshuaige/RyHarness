/**
 * 精简 agent 消息循环。
 *
 * 每步：组装请求（systemPrompt + 历史 + 工具白名单）→ ctx.llm.stream() →
 * 边收 chunk 边发事件、边用 BlockAssembler 组装 → 若产出 tool_call 则并行
 * 调度执行（结果按 call 顺序回填）、把 tool 结果追加进历史、进入下一步；
 * 否则以 finish 终止。达到 maxSteps 仍有未决工具调用时以 error 事件终止
 * （防死循环）。
 *
 * 并发取舍：进化 compile 与记忆补正都不再进首 token 关键路径（记忆走同步
 * 召回，见 {@link AgentMemoryHooks.recallSync}）；同一条 assistant 消息里的
 * 多个工具调用有界并发执行（并发度见 {@link DEFAULT_TOOL_CONCURRENCY}），但
 * 事件与 tool 消息一律按模型给出的 call 顺序提交，
 * 保证历史确定。传入 `signal` 后，循环在每个边界检查取消，不再发起新的模型
 * 调用、不再执行后续工具：已推给前端的半截回复先以 done 收尾并落库（否则刷新
 * 即消失），随后以 {@link AbortedError} 结束。
 *
 * 上下文：入口历史按 {@link RequestBudget} 的 token 预算裁剪；本轮工具结果与
 * 入口历史共用同一个输入预算，超预算截断并标注——多步工具循环的回填量不受
 * 入口预算约束，不设上限必然把请求顶到几十万 token。预算口径是真 token
 * （{@link estimateTokens}，中文一字一 token），不是字符数：字符口径下中文
 * 实际超发 4 倍，而本项目的对话就是中文。预算仍然装不下时走压缩链路
 * （{@link compactHistory}：先预裁剪工具输出，再把窗口外那段历史摘要掉），
 * 而不是继续往下截。
 *
 * 配额：工具调用先过 {@link SessionQuota}（shell 次数 / 写入字节数）再落地，
 * 越限的调用变成错误结果回给模型并计入 rejected；同额度要跨轮共享由调用方把
 * 同一个 {@link createSessionQuota} 实例传进来。
 *
 * 与上游 dsh-agent-loop 的关系：只保留"循环 + 工具调度"内核，不带
 * session 发布、sandbox 执行器与审批生态（M0 决策：agent 循环自写精简版）。
 * 溢出重试对齐 dsh compaction-basic 的 context-overflow 恢复（agent/request-error
 * 瀑布里的 retry 动作）：供应商 400（CONTEXT_WINDOW_EXCEEDED）时激进压缩历史
 * 并重试一次，此处没有瀑布，直接在循环内实现。
 * @module @ryharness/agent/loop
 */

import type {
  AssistantMessage,
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmRuntime,
  Message,
  TokenUsage,
  ToolCallBlock,
  ToolCallId,
  ToolSchema,
} from '@ryharness/llm'
import {
  BlockAssembler,
  ReasoningEffortId as brandReasoningEffortId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  errorChain,
  estimateMessageTokens,
  estimateTokens,
  estimateToolsTokens,
  isHarnessError,
} from '@ryharness/llm'
import { ABORTED_CODE, abortedErrorOf, throwIfAborted } from './aborted.ts'
import type { RequestBudget } from './budget.ts'
import { MIN_OUTPUT_TOKENS, outputTokenCap, resolveRequestBudget } from './budget.ts'
import type { CompactionOptions, CompactSpec } from './compact.ts'
import { alignWindowStart, compactHistory, createLlmSummarizer, resolveCompactSpec } from './compact.ts'
import { resolveAllowedTools } from './tool-source.ts'
import type { AgentDefinition, AgentLoopEvent, Tool, ToolContext, ToolResult, ToolSource } from './types.ts'

/** AgentLoop 构造参数。 */
export interface AgentLoopOptions {
  definition: AgentDefinition
  /** 挂载好的 LLM 运行时（cordis ctx.llm 或等价物）。 */
  llm: LlmRuntime
  /** 可用工具全集；循环按 definition.tools 白名单按名解析（数组或注册表）。 */
  tools: ToolSource
  /** 最大步数（模型调用次数），默认 16。 */
  maxSteps?: number
  /** 起始历史（从持久层恢复的消息），循环会按预算裁剪后复制追加。 */
  history?: readonly Message[]
  /**
   * 起始历史的 token 预算。缺省时按模型上下文窗口推（系统提示与工具声明先
   * 占掉各自的部分）；传 `Infinity` 关闭裁剪。本轮内新产生的消息不参与裁剪
   * ——中途丢历史会打断 tool_call/tool_result 的配对。
   */
  historyBudgetTokens?: number
  /**
   * 输出预留（token），缺省 4000。实际下发的 maxTokens 还要按本步 prompt 的
   * 实际占用再收一次，保证「输入 + 输出」不越过模型上下文窗口——多步工具
   * 循环的输入每步都在涨，固定 maxTokens 到最后一步就会被供应商按合计算拒。
   */
  maxOutputTokens?: number
  /**
   * 用户补录的模型上下文窗口（token），只在适配器没回报窗口时进预算——目录已知
   * 长度永远优先（用户在设置页填的值经 providers.json 进适配器配置后，走的就是
   * 目录那一路，这里兜的是不含能力元数据的运行时）。非法值与缺省一样退回保守
   * 默认窗口（见 {@link resolveRequestBudget} 的优先级约定）。
   */
  contextWindowTokens?: number
  /**
   * 每步组装出完整 assistant 消息时回调（群聊调度器据此持久化/解析 @提及）。
   * `usage` 是产出该消息的那次模型调用的用量（供应商未回报时为 undefined）：
   * 调用方在同一步把它落到该条消息上，成本才按消息可查。
   */
  onAssistantMessage?: (message: AssistantMessage, usage?: TokenUsage) => void
  /**
   * 长期记忆钩子（可选）：组装 prompt 前 recall 注入；每轮结束异步
   * enqueueExtraction（绝不阻塞回复）。记忆故障不得影响对话。
   */
  memory?: AgentMemoryHooks
  /**
   * 「你在跟谁说话」钩子（可选）：返回一句身份说明，排在系统提示最前面。
   *
   * 用户在「我的」页改的名字要真的被 agent 知道，否则那只是界面上的一行字——
   * 界面对了、内核不知道，是这类半成品最常见的一种。刻意做成回调而不是在这里
   * import 持久层：内核不认识 SQLite，也不该认识，装配时由服务端从自己的存储里取。
   * 返回 undefined / 空串 = 不注入。
   */
  identity?: () => string | undefined
  /**
   * 自我进化钩子（可选）：组装前 compile 注入 [经验手册]/[上次教训]；
   * 每轮结束异步 enqueueTurn（Reflector 计数 + Reflexion + Curator delta）。
   */
  evolution?: AgentEvolutionHooks
  /**
   * 会话级工具配额（shell 调用次数 / 写入字节数）。缺省时循环自建一个，
   * 只覆盖本次运行；同一会话要跨轮、跨群成员共享同一份额度，由调用方
   * {@link createSessionQuota} 建一次并传进来。
   */
  quota?: SessionQuota
  /**
   * 压缩链路（可选）：输入超过预算时先预裁剪工具输出，仍超再把窗口外的那段
   * 历史压成摘要。缺省时用同一个 {@link AgentLoopOptions.llm} 做摘要调用；
   * 给 `enabled: false` 或让摘要失败时退回原有的丢弃式裁剪（行为与本选项出现
   * 之前一致）。
   */
  compaction?: CompactionOptions
}

/** 记忆系统对运行时的最小接口（由 @ryharness/memory 的 MemoryService 实现）。 */
export interface AgentMemoryHooks {
  recall(agentId: string, inputText: string): Promise<string | undefined>
  /**
   * 首 token 路径上的**同步**召回（可选）：只用已落库的向量缓存 + FTS5，
   * 全程不 await。记忆按设计只是增强，让它排在第一个 `llm.stream()` 之前
   * await，等于把最坏 800ms 的 embedding 网络往返放进首 token 延迟里。
   *
   * 未实现时循环退回 {@link AgentMemoryHooks.recall}（该路径的延迟由记忆
   * 自己的 deadline 兜底）。
   */
  recallSync?(agentId: string, inputText: string): string | undefined
  /**
   * 首 token 之后的**补正**（可选）：等 embedding 落地，并据此算出语义通道
   * 命中留给下一轮的同步召回注入（只落缓存的话，同一句输入不会被说第二遍，
   * 语义通道在线上等于不存在）。不组装注入块、不重复记访问——那是
   * {@link recallSync} 已经做过的事。
   */
  recallRefine?(agentId: string, inputText: string, deadlineMs?: number): Promise<unknown>
  enqueueExtraction(agentId: string, agentName: string, conversationId: string, turnText: string): void
}

/** 一轮轨迹数据（进化管线的输入，由 @ryharness/evolve 消费）。 */
export interface EvolutionTurnData {
  userText: string
  assistantText: string
  toolResults: { name: string; isError: boolean }[]
  /** LLM 流是否以错误收尾。 */
  llmError: boolean
  /** 本轮注入的 playbook 条目 / 教训（归因计数用）。 */
  injectedPlaybookEntryIds: string[]
  injectedReflectionIds: string[]
}

/** 自我进化对运行时的最小接口（由 @ryharness/evolve 的 EvolveService 实现）。 */
export interface AgentEvolutionHooks {
  /**
   * 编译该 agent 的进化上下文。`inputText` 是本轮用户输入：教训注入靠它做
   * 相关性筛选，不传就只剩 playbook 条目（教训相关性形同虚设）。
   */
  compile(
    agentId: string,
    inputText: string,
  ): Promise<{ text: string; playbookEntryIds: string[]; reflectionIds: string[] } | undefined>
  enqueueTurn(agentId: string, agentName: string, conversationId: string, turn: EvolutionTurnData): void
}

const DEFAULT_MAX_STEPS = 16

/**
 * 供应商侧「请求超出上下文窗口」的统一错误码。
 *
 * 适配器已经把各家的 wording（context_length_exceeded / request too large …）
 * 归一到这个 code（见 @ryharness/llm openai 适配器的错误映射），循环按 code 路由，
 * 不解析 message。
 */
const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'

/**
 * 溢出重试时输入阈值的砍半比例。
 *
 * 供应商 400（CONTEXT_WINDOW_EXCEEDED）而本地估算没超，说明供应商口径比本地
 * 估算严；重试把本地阈值砍半留出余量，否则对同一估算出的同一历史再压一次
 * 只会空转（compactHistory 对阈值以内的历史是 no-op）。
 */
const OVERFLOW_RETRY_THRESHOLD_RATIO = 0.5

/**
 * 历史增量读的默认窗口（token）。
 *
 * 内核里唯一的「从库里取多少行」默认值：@ryharness/session 的
 * {@link HISTORY_BUDGET_TOKENS} 与 @ryharness/group 的
 * {@link DEFAULT_HISTORY_BUDGET_TOKENS} 都取这个数，三处口径必须同时是 token——
 * 任一处退回字符（4 字符 ≈ 1 token 的近似）就会在 ASCII 文本上再收一刀、在中文
 * 上放行四倍。三段式预算（按模型上下文窗口算的输入上限）仍由
 * {@link resolveRequestBudget} 负责，这里是它之外的固定读取窗口。
 */
export const DEFAULT_HISTORY_BUDGET_TOKENS = 15_000

/**
 * 本轮循环内工具结果的累计 token 上限。
 *
 * {@link trimHistoryToBudget} 只作用于入口历史，本轮每一步的工具结果却是原样
 * 回填：`shell_exec` 单条就给到 32k 字符，16 步 × 2–3 个调用足以把请求顶到
 * 几十万 token，供应商一律 400。它与入口历史共用一个输入预算（见 {@link
 * AgentLoop.run}），这个上限只保证「即使输入预算很宽，单轮工具回填也不会
 * 吃掉全部」——30k token 是旧口径 120k 字符的同量级换算，ASCII 下与此前一致。
 */
export const MAX_LOOP_CONTEXT_TOKENS = 30_000

/**
 * 本轮工具结果的下限（token）：入口历史已把输入预算吃满时仍留出的回填额度。
 * 低于这个量，模型看到的工具结果只有「已截断」标注，多步工具循环等于白跑。
 */
const MIN_LOOP_CONTEXT_TOKENS = 8_000

/** 截断标注预留的 token 数（标注里带数字，长度有浮动）。 */
const TRUNCATION_NOTE_RESERVE = 96

/** 预算耗尽后每条工具结果只剩这条标注：tool_call 与 tool_result 必须配对。 */
const CONTEXT_EXHAUSTED_NOTE = '…[已截断：本轮工具输出已用满上下文预算]'

/**
 * 循环内上下文的 token 预算（只管工具结果）。
 *
 * assistant 侧不必计入：它受供应商 max_tokens 约束，量级固定；工具输出才是
 * 唯一由工作区文件大小决定、模型与调用方都控制不住的部分。
 *
 * 上界：预算耗尽后每条结果只贡献一条约 24 字符的标注，所以进历史的工具结果
 * 合计不会超过 {@link MAX_LOOP_CONTEXT_TOKENS} + 一条标注；条数又被 maxSteps
 * 与每条消息的调用数封顶。
 */
class LoopContextBudget {
  private used = 0

  constructor(private readonly limit: number) {}

  /**
   * 回填前的裁剪：超预算只留前段并追加「已截断」标注，让模型知道自己看到的
   * 是不完整输出（否则它会基于残缺内容给出自信的错误结论）。
   */
  admit(text: string): string {
    const room = this.limit - this.used
    const cost = estimateTokens(text)
    if (cost <= room) {
      this.used += cost
      return text
    }
    const kept = Math.max(0, room - TRUNCATION_NOTE_RESERVE)
    if (kept === 0) {
      this.used += estimateTokens(CONTEXT_EXHAUSTED_NOTE)
      return CONTEXT_EXHAUSTED_NOTE
    }
    // 按 token 预算截字符数：中文与英文的 token/字符比不同，用字符数切会把
    // 中文正文多留一倍不止。
    const keptChars = charCountWithinBudget(text, kept)
    const note = `\n…[已截断：工具输出超出本轮 ${this.limit} token 上下文预算，省略 ${text.length - keptChars} 字符]`
    this.used += kept + estimateTokens(note)
    return text.slice(0, keptChars) + note
  }
}

/** 取前缀里不超过 `budgetTokens` 的最长字符数。 */
function charCountWithinBudget(text: string, budgetTokens: number): number {
  if (estimateTokens(text) <= budgetTokens) return text.length
  // 二分：估算口径对字符数单调，长度减半总能收敛且不必逐字累加。
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
 * 同一批工具调用的默认并发上限。
 *
 * 裸 `Promise.all(map)` 会把一批十几个调用同时砸下去（每个都可能是 shell 或
 * 网络请求），供应商与工作区都吃不消；封顶后并发可控，吞吐对批量调用仍远好于串行。
 */
export const DEFAULT_TOOL_CONCURRENCY = 4

/**
 * 有界并发地执行一批任务：同时存活的任务数封顶，结果按下标与入参同序回填。
 *
 * 与裸 `Promise.all(items.map(task))` 的区别只在并发度。任务自身的失败处理交给
 * 调用方（本项目的工具调用早已各自兜成错误结果），这里不做额外捕获——失败
 * 语义与全并行时完全一致。
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await task(items[index] as T)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => {
      return worker()
    }),
  )
  return results
}

/** 会话级工具配额的默认上限（`Infinity` 表示不设该项）。 */
export const DEFAULT_SESSION_QUOTA_LIMITS = {
  /** 每个会话允许的 shell_exec 调用次数。 */
  maxShellCalls: 40,
  /** 每个会话允许的写入字节数（fs_write / file_produce）。 */
  maxWriteBytes: 2 * 1024 * 1024,
}

/** 配额上限；缺省项取 {@link DEFAULT_SESSION_QUOTA_LIMITS}，传 `Infinity` 关闭该项。 */
export interface SessionQuotaLimits {
  maxShellCalls?: number
  maxWriteBytes?: number
}

/** 配额用量：只增不减，由闸自己记账，调用方只读。 */
export interface SessionQuotaUsage {
  shellCalls: number
  writeBytes: number
  /** 被闸拦下的调用次数。 */
  rejected: number
}

/**
 * 会话级工具配额闸。
 *
 * shell_exec 与写文件都能在几分钟里烧掉一台机器（死循环、`curl | sh`、往工作区
 * 灌 GB 级文件），而 maxSteps 只管步数、管不住单步的代价。闸按"次数"和"字节"
 * 两种口径记账，超限的调用变成错误结果回给模型——不静默丢，模型看得见并可以改口。
 */
export interface SessionQuota {
  readonly limits: Required<SessionQuotaLimits>
  readonly usage: SessionQuotaUsage
  /**
   * 记账并判定：越限返回拒绝理由（不计入用量，另计 rejected），未越限返回 undefined。
   * 计入在真正执行之前——执行失败也算用掉的额度。
   * @param toolName - 被调用的工具名。
   * @param args - 已解析的工具参数（写类工具按 content 字节数计）。
   */
  charge(toolName: string, args: unknown): string | undefined
}

/** 哪些工具吃哪种配额：shell 按次数，写类工具按写入字节数；其余工具不计。 */
function quotaCost(toolName: string, args: unknown): { calls: number; bytes: number } | undefined {
  if (toolName === 'shell_exec') return { calls: 1, bytes: 0 }
  if (toolName !== 'fs_write' && toolName !== 'file_produce') return undefined
  const content = typeof args === 'object' && args !== null ? (args as Record<string, unknown>).content : undefined
  return { calls: 0, bytes: typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : 0 }
}

/**
 * 建一个会话配额闸。同一个对象要在该会话的每轮、每个 agent 上共用，额度才是
 * "每会话"而不是"每轮"。
 * @param limits - 上限覆盖项。
 * @returns 可变的配额闸（usage 只增不减）。
 */
export function createSessionQuota(limits: SessionQuotaLimits = {}): SessionQuota {
  const resolved: Required<SessionQuotaLimits> = {
    maxShellCalls: limits.maxShellCalls ?? DEFAULT_SESSION_QUOTA_LIMITS.maxShellCalls,
    maxWriteBytes: limits.maxWriteBytes ?? DEFAULT_SESSION_QUOTA_LIMITS.maxWriteBytes,
  }
  const usage: SessionQuotaUsage = { shellCalls: 0, writeBytes: 0, rejected: 0 }
  return {
    limits: resolved,
    usage,
    charge(toolName: string, args: unknown): string | undefined {
      const cost = quotaCost(toolName, args)
      if (cost === undefined) return undefined
      if (usage.shellCalls + cost.calls > resolved.maxShellCalls) {
        usage.rejected++
        return `quota exceeded: shell_exec calls ${usage.shellCalls}/${resolved.maxShellCalls} for this session`
      }
      if (usage.writeBytes + cost.bytes > resolved.maxWriteBytes) {
        usage.rejected++
        return `quota exceeded: write ${usage.writeBytes + cost.bytes}/${resolved.maxWriteBytes} bytes for this session`
      }
      usage.shellCalls += cost.calls
      usage.writeBytes += cost.bytes
      return undefined
    },
  }
}

/** 把任意 thrown value 归一为事件用的 { message, code }。 */
function failureOf(error: unknown): { message: string; code: string } {
  return {
    message: errorChain(error),
    code: isHarnessError(error) ? error.code : 'UNKNOWN',
  }
}

/** 内容块里的纯文本（tool_call 的参数 JSON 不计入回复文本）。 */
function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => {
      return block.type === 'text'
    })
    .map((block) => {
      return block.type === 'text' ? block.text : ''
    })
    .join('\n')
}

/** 一轮运行的调用方选项。 */
export interface AgentRunOptions {
  /**
   * 调用方取消信号。取消后循环不再发起新的模型调用、不再执行后续工具，
   * 并以 {@link AbortedError} 结束；缺省时沿用 ToolContext.signal。
   */
  signal?: AbortSignal
}

/** 估算一条消息的 token 权重（含 role 与块结构开销）。 */
function messageWeight(message: Message): number {
  return estimateMessageTokens(message)
}

/**
 * 按 token 预算从最旧开始裁剪起始历史（思路与群聊的 buildGroupContext 对齐）。
 *
 * 口径是真 token 而不是字符：字符口径（4 字符 ≈ 1 token）只对英文成立，中文
 * 一字一 token，同一份预算在中文对话里实际超发 4 倍。
 * @param history - 待裁剪的历史消息。
 * @param budgetTokens - token 预算；非有限值（`Infinity`）表示不裁剪。
 * @returns 预算内的历史窗口；窗口首条不会是孤立的 tool 结果（其 tool_call 已被
 *   裁掉，供应商会拒绝这种序列）。窗口**可能是空的**——只有当历史最后一条是
 *   tool 结果、且它所在的整组（assistant + 它的全部结果）都落在窗口外时才会
 *   发生；此时调用方会补上这一轮的用户消息或摘要块，请求里至少有一条消息。
 */
export function trimHistoryToBudget(history: readonly Message[], budgetTokens: number): Message[] {
  if (!Number.isFinite(budgetTokens)) return [...history]
  const weights = history.map(messageWeight)
  let total = weights.reduce((sum, weight) => {
    return sum + weight
  }, 0)
  let start = 0
  while (total > budgetTokens && start < history.length - 1) {
    total -= weights[start] as number
    start++
  }
  // 切点可能落在 tool 结果上（历史最后一条恰好是工具结果时）：那条 assistant
  // 已经被裁到窗口外，窗口首条就成了断掉配对的 tool 结果——供应商会拒掉整个
  // 请求。修正方式见 alignWindowStart：把切点推到整段 tool 结果之后。
  return history.slice(alignWindowStart(history, start))
}

/** 一组消息的 token 权重合计。 */
function totalTokensOf(messages: readonly Message[]): number {
  let total = 0
  for (const message of messages) total += estimateMessageTokens(message)
  return total
}

/** 精简 agent 消息循环。一个实例可反复 run；每次 run 从初始 history 派生。 */
export class AgentLoop {
  private readonly allowedTools: Map<string, Tool>
  private readonly quota: SessionQuota

  constructor(private readonly options: AgentLoopOptions) {
    // 白名单是名字，工具实例每轮现查：插件热重挂之后同名工具可能已经换成新实例，
    // 构造协调器时缓存下来的数组会让模型继续调到旧的那一个。
    this.allowedTools = resolveAllowedTools(options.tools, options.definition.tools)
    this.quota = options.quota ?? createSessionQuota()
  }

  /**
   * 跑一轮用户输入。
   * @param input - 用户文本。
   * @param context - 工具执行上下文（工作区根目录等）。
   * @param options - 调用方取消信号（缺省沿用 context.signal）。
   * @returns 事件异步流：text-delta / tool-call-start / tool-result / done / error。
   * @throws AbortedError - 调用方取消。
   */
  async *run(input: { text: string }, context: ToolContext, options?: AgentRunOptions): AsyncGenerator<AgentLoopEvent> {
    const { definition, llm } = this.options
    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS
    const signal = options?.signal ?? context.signal
    // agentId 由循环写下而不是要求调用方传：群聊里同一份工具上下文会交给多个
    // 成员，只有定义知道此刻是谁在调用工具（ask_user 靠它把答案交回问的人）。
    const toolContext: ToolContext = {
      ...context,
      agentId: definition.id,
      ...(signal === undefined || signal === context.signal ? {} : { signal }),
    }
    throwIfAborted(signal)

    const toolSchemas: ToolSchema[] = [...this.allowedTools.values()].map((tool) => {
      return { name: tool.name, description: tool.description, parameters: tool.parameters }
    })

    // 记忆不再排在首 token 之前 await：同步召回（落库向量缓存 + FTS5 + 上一轮
    // 回灌的语义命中）拿到一版注入块就开流，embedding 由后台补正落缓存并算出
    // 语义命中，下一轮并进融合。旧的绑定对象（没有 recallSync）退回 await，
    // 此时延迟由记忆自己的 deadline 兜底。
    const sync = this.recallMemorySync(definition.id, input.text)
    // 能力元数据与进化编译并行取，都不进首 token 前的串行等待。
    const [budget, compiled] = await Promise.all([
      this.resolveBudget(definition, signal),
      this.compileEvolution(definition.id, input.text),
    ])
    const memoryBlock = sync.used ? sync.text : await this.recallMemory(definition.id, input.text)
    // 补正只要走过同步路径就发：同步召回返回空块往往正是词法通道没命中，
    // 而救它的是语义通道——那正是这次补正要等的东西。
    if (sync.used) this.refineMemory(definition.id, input.text)
    throwIfAborted(signal)
    const evolutionBlock = compiled.text
    const injectedPlaybookEntryIds = compiled.playbookEntryIds
    const injectedReflectionIds = compiled.reflectionIds
    const identity = this.options.identity?.()
    const systemPrompt = [identity, definition.systemPrompt, memoryBlock, evolutionBlock]
      .filter((part): part is string => {
        return part !== undefined && part.length > 0
      })
      .join('\n\n')

    // 输入预算的分配：系统提示与工具声明每轮都原样上送，先把它们各自的
    // 估算占掉，剩下的才分给历史与本轮工具结果——工具 schema 不计预算时，
    // 一套十几件工具的声明就能把窗口悄悄吃掉几万 token。
    const fixedTokens = estimateTokens(systemPrompt) + estimateToolsTokens(toolSchemas)
    const promptBudget = budget.thresholdTokens
    const historyBudget = this.options.historyBudgetTokens ?? Math.max(0, promptBudget - fixedTokens)
    const compactSpec = resolveCompactSpec(budget, this.options.compaction ?? {})
    // 入口历史先压一次再送：超预算的那部分摘要掉，而不是静默丢弃——长会话丢掉的
    // 恰恰是"三天前说过要什么"。压缩拿的是**未经丢弃式裁剪**的原始历史：先裁再压
    // 等于让丢弃先动手，压出来的摘要里什么都没有。
    let history = await this.compactHistory(
      this.options.history ?? [],
      { ...compactSpec, thresholdTokens: historyBudget },
      definition,
      signal,
    )
    history.push(createUserMessage({ content: [{ type: 'text', text: input.text }], source: { kind: 'user' } }))
    // 工具结果与入口历史共用输入预算；但两头都不能把对方饿死：历史被裁到只剩
    // 最后一条时，本轮工具输出是唯一的增量信息，所以留一个下限；反过来，窗口
    // 很宽时也不能让单条 shell 输出把整个预算吃掉，所以留一个上限。
    const toolBudget = Math.min(
      MAX_LOOP_CONTEXT_TOKENS,
      Math.max(MIN_LOOP_CONTEXT_TOKENS, promptBudget - fixedTokens - totalTokensOf(history)),
    )

    let steps = 0
    let assistantText = ''
    let llmError = false
    const toolResults: { name: string; isError: boolean }[] = []
    const contextBudget = new LoopContextBudget(toolBudget)
    try {
      while (steps < maxSteps) {
        steps++
        throwIfAborted(signal)
        // 每步都复查一次：入口历史装得下，不代表加上本轮回填的工具结果还装得下。
        // 超了就压（预裁剪工具输出 → 摘要窗口外的历史），而不是让请求一路顶到
        // 供应商窗口之外等一个 400。
        //
        // room ≤ 0（系统提示与工具声明自己就吃满了窗口）时不动历史：这时连
        // "预算内保留最新一条"都做不到，再裁一轮等于把入口历史的最后一条也扔掉，
        // 而那正是 trimHistoryToBudget 的既有约定（系统提示超窗是另一个问题）。
        const room = promptBudget - fixedTokens
        if (room > 0 && fixedTokens + totalTokensOf(history) > promptBudget) {
          history = await this.compactHistory(history, { ...compactSpec, thresholdTokens: room }, definition, signal)
        }
        // 供应商 400（CONTEXT_WINDOW_EXCEEDED）而本地估算没超：供应商口径比本地
        // 估算严（计数方式、system 计费、图片块都会让两边对不上）。这时用激进规格
        // 强制压一次历史（阈值砍半留余量、retainTokens=0 只保最新一条）再重试一次；
        // 第二次仍失败就走下面的常规失败收尾——每步至多一次，绝不死循环。
        const overflowRetryThreshold = Math.max(MIN_OUTPUT_TOKENS, Math.floor(room * OVERFLOW_RETRY_THRESHOLD_RATIO))
        let assembler = new BlockAssembler()
        let failure: { message: string; code: string } | undefined
        for (let attempt = 0; ; attempt++) {
          const request: GenerateOptions = {
            provider: definition.provider,
            model: definition.model,
            system: systemPrompt,
            messages: history,
            ...(toolSchemas.length === 0 ? {} : { tools: toolSchemas }),
            // 输出预留按本步 prompt 的实际占用收口：不设 maxTokens 时预留是 0，
            // 输出就会一路顶到窗口边缘；固定值又会在多步工具循环的最后一步
            // 让「输入 + 输出」一起越界。
            maxTokens: outputTokenCap(budget, fixedTokens + totalTokensOf(history)),
            ...(definition.temperature === undefined ? {} : { temperature: definition.temperature }),
            // 档位留空就不发：运行时会按模型自己声明的档位表校验，发一个不支持的
            // 值换来的是 UNSUPPORTED_REASONING_EFFORT 整轮失败，而不是「忽略」。
            ...(definition.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: brandReasoningEffortId(definition.reasoningEffort) }),
            ...(signal === undefined ? {} : { signal }),
          }

          try {
            for await (const chunk of llm.stream(request)) {
              assembler.push(chunk)
              if (chunk.type === 'text-delta') {
                yield { type: 'text-delta', text: chunk.text }
              } else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
                yield {
                  type: 'tool-call-start',
                  callId: chunk.block.id,
                  name: chunk.block.name,
                  arguments: chunk.block.arguments,
                }
              }
            }
          } catch (error) {
            // 取消不按失败处理：留给下面的统一中断收尾（先固化半截回复）。
            if (signal?.aborted !== true) failure = failureOf(error)
          }

          const attemptFinish: FinishReason = assembler.finish
          const overflowed =
            (failure?.code ??
              (attemptFinish.kind === 'error' || attemptFinish.kind === 'aborted'
                ? attemptFinish.failure.code
                : undefined)) === CONTEXT_WINDOW_EXCEEDED_CODE
          // room ≤ 0 时连「预算内保留最新一条」都做不到，压无可压，直接失败收尾。
          if (attempt > 0 || !overflowed || room <= 0) break
          history = await this.compactHistory(
            history,
            { ...compactSpec, thresholdTokens: overflowRetryThreshold, retainTokens: 0 },
            definition,
            signal,
          )
          // 上一次尝试的半截输出全部作废：重试用干净 assembler 重新组装，失败
          // 信息也要清掉，否则重试成功也会被下面的失败收尾误杀。
          assembler = new BlockAssembler()
          failure = undefined
        }

        const finish: FinishReason = assembler.finish
        if (signal?.aborted === true || failure !== undefined || finish.kind === 'error' || finish.kind === 'aborted') {
          const partial = this.commitInterrupted(assembler, definition)
          assistantText += partial.text
          if (signal?.aborted === true) {
            // 半截回复已经推给前端：先以 done 收尾（协调器落库、服务器推
            // message-done），再抛 AbortedError。否则这段内容刷新后就消失。
            if (partial.blocks.length > 0) yield { type: 'done', finish, steps }
            throw abortedErrorOf(signal)
          }
          llmError = true
          const terminal = finish.kind === 'error' || finish.kind === 'aborted' ? finish.failure : undefined
          yield {
            type: 'error',
            message: terminal?.message ?? failure?.message ?? 'llm stream failed',
            code: terminal?.code ?? failure?.code ?? 'UNKNOWN',
          }
          return
        }

        const message = assembler.message({ provider: definition.provider, model: definition.model })
        this.options.onAssistantMessage?.(message, assembler.usage)
        history.push(message)
        assistantText += textOf(message.content)
        const calls = message.content.filter((block): block is ToolCallBlock => {
          return block.type === 'tool-call'
        })

        if (calls.length === 0) {
          yield { type: 'done', finish, steps }
          return
        }
        if (finish.kind !== 'tool-calls' && finish.kind !== 'stop') {
          yield { type: 'done', finish, steps }
          return
        }

        // 同一批工具调用有界并发执行（默认策略，对齐上游的 toolExecution:
        // "parallel"，但并发度封顶，见 {@link DEFAULT_TOOL_CONCURRENCY}）；任一
        // 工具声明 sequential 时整批退回串行，避免有副作用的工具互相踩踏。结果
        // 按 call 顺序回填，事件与历史顺序不随完成先后变化，历史保持确定。
        throwIfAborted(signal)
        const results = await this.executeCalls(calls, toolContext)
        throwIfAborted(signal)
        for (const [index, call] of calls.entries()) {
          const result = results[index] as ToolResult
          toolResults.push({ name: call.name, isError: result.isError === true })
          yield {
            type: 'tool-result',
            callId: call.id,
            name: call.name,
            isError: result.isError === true,
            result,
          }
          // 事件给 UI 的是完整结果（落库、展开都靠它），进历史的是受预算约束
          // 的副本：模型看不到的那部分留在这里只会挤爆下一轮请求。
          history.push(
            createToolResultMessage({
              callId: call.id as ToolCallId,
              content: [{ type: 'text', text: contextBudget.admit(result.content) }],
              isError: result.isError === true,
            }),
          )
        }
      }

      yield {
        type: 'error',
        message: `agent loop exceeded maxSteps=${maxSteps} with pending tool calls`,
        code: 'MAX_STEPS',
      }
    } finally {
      // 自我进化：每轮轨迹入队（Reflector/Reflexion/Curator，异步）。
      // 无 assistant 文本但发生错误/工具调用的轮次也要入队（反思需要失败信号）。
      if (
        this.options.evolution !== undefined &&
        (assistantText.trim().length > 0 || llmError || toolResults.length > 0)
      ) {
        try {
          this.options.evolution.enqueueTurn(definition.id, definition.name, '', {
            userText: input.text,
            assistantText: assistantText.trim(),
            toolResults,
            llmError,
            injectedPlaybookEntryIds,
            injectedReflectionIds,
          })
        } catch {
          // 进化入队故障不影响对话。
        }
      }
      // 长期记忆抽取（异步管线，绝不阻塞回复）；至少要有 assistant 内容才入队。
      if (this.options.memory !== undefined && assistantText.trim().length > 0) {
        try {
          this.options.memory.enqueueExtraction(
            definition.id,
            definition.name,
            '',
            `用户：${input.text}
${definition.name}：${assistantText.trim()}`,
          )
        } catch {
          // 记忆入队故障不影响对话。
        }
      }
    }
  }

  /**
   * 执行一批 tool_call。默认有界并发（{@link DEFAULT_TOOL_CONCURRENCY} 个工作
   * 线程轮转调度）；批次里任一工具声明 `executionMode: 'sequential'` 时整批
   * 串行（工具的副作用可能互相排斥）。结果按 call 顺序回填，事件与历史顺序
   * 不随完成先后变化，历史保持确定。
   * @returns 与 calls 同序的结果数组。
   */
  private async executeCalls(calls: readonly ToolCallBlock[], context: ToolContext): Promise<ToolResult[]> {
    const sequential = calls.some((call) => {
      return this.allowedTools.get(call.name)?.executionMode === 'sequential'
    })
    if (sequential || calls.length === 1) {
      const results: ToolResult[] = []
      for (const call of calls) {
        results.push(await this.executeCall(call, context))
      }
      return results
    }
    return await mapWithConcurrency(calls, DEFAULT_TOOL_CONCURRENCY, (call) => this.executeCall(call, context))
  }

  /** 长期记忆召回（故障静默降级为无人设增强）。 */
  private async recallMemory(agentId: string, inputText: string): Promise<string | undefined> {
    if (this.options.memory === undefined) return undefined
    try {
      return await this.options.memory.recall(agentId, inputText)
    } catch {
      return undefined
    }
  }

  /**
   * 首 token 路径上的同步召回。
   *
   * `used` 区分「走了同步路径」与「同步路径没返回块」：前者才需要发补正，
   * 后者该退回 await。实现缺失或抛错时 `used` 为 false，由调用方退回 await
   * 路径——故障永远不该让对话变慢。
   */
  private recallMemorySync(agentId: string, inputText: string): { used: boolean; text?: string } {
    const memory = this.options.memory
    if (memory?.recallSync === undefined) return { used: false }
    try {
      const text = memory.recallSync(agentId, inputText)
      return { used: true, ...(text === undefined ? {} : { text }) }
    } catch {
      return { used: false }
    }
  }

  /**
   * 首 token 之后的**补正**：等 embedding 落地，把这一轮真算出来的语义命中
   * 留给下一轮的同步召回（下一轮才真的注入，回灌的是语义通道而不是查询缓存）。
   *
   * 刻意 fire-and-forget：这一次请求的 system 已经定稿并开流，事后补正只能
   * 惠及下一轮，而把它留在链上就等于把 embedding 的网络往返放回首 token。
   */
  private refineMemory(agentId: string, inputText: string): void {
    const memory = this.options.memory
    const refine = memory?.recallRefine
    if (memory === undefined || refine === undefined) return
    try {
      void Promise.resolve(refine.call(memory, agentId, inputText)).catch(() => {
        // 补正失败不影响本轮对话（它本来就只是增强）。
      })
    } catch {
      // 同步抛出的实现同样吞掉。
    }
  }

  /**
   * 按预算压历史：压缩链路优先，摘要不可用/失败时退回丢弃式裁剪。
   *
   * 退回不是兜底的装饰：摘要要真发一次模型请求（网络、限流、供应商故障都可能让它
   * 拿不到），一条对话不该因为压缩而失败，所以拿不到摘要时一律用与"本选项出现
   * 之前"完全一致的行为继续。
   * @param history - 已按丢弃式口径裁过的历史。
   * @param spec - 三段式预算（thresholdTokens 由调用方按本次可用额度覆盖）。
   */
  private async compactHistory(
    history: readonly Message[],
    spec: CompactSpec,
    definition: AgentDefinition,
    signal?: AbortSignal,
  ): Promise<Message[]> {
    const compaction = this.options.compaction
    if (compaction?.enabled === false || spec.thresholdTokens <= 0) {
      return trimHistoryToBudget(history, spec.thresholdTokens)
    }
    const summarize =
      compaction?.summarize ??
      createLlmSummarizer(this.options.llm, { provider: definition.provider, model: definition.model }, spec)
    const result = await compactHistory(history, spec, summarize)
    throwIfAborted(signal)
    const compacted = result.messages as Message[]
    // 摘要自己也要占预算：它写长了就得再收一道，否则"压缩后仍然超预算"会变成
    // 下一轮再压一遍的死循环。
    return totalTokensOf(compacted) > spec.thresholdTokens
      ? trimHistoryToBudget(compacted, spec.thresholdTokens)
      : compacted
  }

  /**
   * 解析本轮的三段式请求预算。
   *
   * 能力元数据来自适配器（`resolveModelInfo`）；测试替身与未回报窗口的模型退回
   * 调用方给的 {@link AgentLoopOptions.contextWindowTokens}（用户补录值），再退
   * 兜底窗口——任何失败都不得让一轮对话起不来。
   */
  private async resolveBudget(definition: AgentDefinition, signal?: AbortSignal): Promise<RequestBudget> {
    const llm = this.options.llm
    const override = this.options.contextWindowTokens
    try {
      if (typeof llm.resolveModelInfo !== 'function') {
        return resolveRequestBudget(undefined, this.options.maxOutputTokens, override)
      }
      const info = await llm.resolveModelInfo(definition.provider, definition.model, signal)
      return resolveRequestBudget(
        info.context?.contextWindow,
        this.options.maxOutputTokens ?? info.defaultMaxTokens,
        override,
      )
    } catch {
      return resolveRequestBudget(undefined, this.options.maxOutputTokens, override)
    }
  }

  /**
   * 固化被中断的一步（取消 / 流异常 / 终态 error）：只保留已经收到的文本与
   * 思考块——未执行的 tool_call 落库后，下一轮重建历史会缺少配对的 tool
   * 结果消息，供应商会直接拒绝整个请求。
   * @returns 固化的内容块与其中的文本；空数组表示没有可保留的内容。
   */
  private commitInterrupted(
    assembler: BlockAssembler,
    definition: AgentDefinition,
  ): { blocks: ContentBlock[]; text: string } {
    const blocks = assembler.interruptedBlocks()
    if (blocks.length === 0) return { blocks, text: '' }
    this.options.onAssistantMessage?.(
      createAssistantMessage({
        content: blocks,
        source: { provider: definition.provider, model: definition.model },
      }),
      assembler.usage,
    )
    return { blocks, text: textOf(blocks) }
  }

  /** 自我进化编译（playbook + 相关教训；故障静默降级）。 */
  private async compileEvolution(
    agentId: string,
    inputText: string,
  ): Promise<{
    text?: string
    playbookEntryIds: string[]
    reflectionIds: string[]
  }> {
    if (this.options.evolution === undefined) {
      return { playbookEntryIds: [], reflectionIds: [] }
    }
    try {
      const compiled = await this.options.evolution.compile(agentId, inputText)
      return {
        ...(compiled?.text === undefined ? {} : { text: compiled.text }),
        playbookEntryIds: compiled?.playbookEntryIds ?? [],
        reflectionIds: compiled?.reflectionIds ?? [],
      }
    } catch {
      return { playbookEntryIds: [], reflectionIds: [] }
    }
  }

  /** 执行一个 tool_call：未知工具、参数解析失败与配额越限都转化为错误结果而非抛异常。 */
  private async executeCall(call: ToolCallBlock, context: ToolContext): Promise<ToolResult> {
    const tool = this.allowedTools.get(call.name)
    if (tool === undefined) {
      return { content: `unknown tool "${call.name}"`, isError: true }
    }
    let args: unknown
    try {
      args = JSON.parse(call.arguments)
    } catch {
      return { content: `invalid tool arguments JSON: ${call.arguments}`, isError: true }
    }
    // 记账在执行之前：工具没跑成也用掉了额度，超限的调用压根不落地。
    const denial = this.quota.charge(call.name, args)
    if (denial !== undefined) {
      return { content: denial, isError: true }
    }
    try {
      return await tool.execute(args, context)
    } catch (error) {
      return { content: `tool "${call.name}" failed: ${errorChain(error)}`, isError: true }
    }
  }
}
