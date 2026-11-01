/**
 * 工具结果策略：太长的结果换成「一段预览 + 一个定位符」。
 *
 * 这一层是**纯函数**：存储从外面注入，判定过程不碰任何全局状态。宿主把它接到
 * 工具执行链路上（拿到工具结果之后、进模型历史之前），超限时模型看到的就是
 * 预览加取回方式，而不是几万字符的原文。
 *
 * 三条口径，都是有意这么定的：
 * 1. **只对纯文本生效**。JSON、二进制这类结构化结果不溢出——它们本来就不是
 *    「一大段给人看的文字」，压掉前缀等于把结果改坏了（上游 dsh 同一个口径）。
 * 2. **存不下就保留原文**。存失败时把原文原样还给模型：宁可让这一轮上下文撑爆，
 *    也不能让模型什么都拿不到——那才是真的丢数据。
 * 3. **阈值内原样返回**。不该碰的东西一个字都不改。
 * @module @ryharness/spill/policy
 */

import type { SpillRef, SpillStore } from './types.ts'

/** 缺省的内联上限（token）。 */
export const DEFAULT_MAX_INLINE_TOKENS = 2000
/** 一个 token 折算多少字符。中文大概 1.5 字/token，英文接近 4，取个中间值偏保守。 */
export const DEFAULT_CHARS_PER_TOKEN = 4
/** 缺省的预览长度（字符）。 */
export const DEFAULT_PREVIEW_CHARS = 2000

/** 一次要判定的工具结果。 */
export interface SpillCandidate {
  /** 结果正文。 */
  readonly text: string
  /**
   * 这个结果是不是纯文本。
   *
   * 缺省按内容自动判断（看着像 JSON 的按结构化处理）。宿主明确知道结果类型时
   * 直接给，比自动判断准。
   */
  readonly plainText?: boolean
  /** 是哪个工具产的（写进元信息，回头好找）。 */
  readonly tool?: string
}

/** 策略的构造参数。 */
export interface SpillPolicyOptions {
  /** 存哪：注入进来的，本包不自己建目录、不自己决定数据目录。 */
  readonly store: SpillStore
  /** 内联上限（token）。 */
  readonly maxInlineTokens?: number
  /** 内联上限（字符）。与 `maxInlineTokens` 同时给时取更小的那个。 */
  readonly maxInlineChars?: number
  /** 一个 token 折算多少字符。 */
  readonly charsPerToken?: number
  /** 预览长度（字符）。 */
  readonly previewChars?: number
  /** 会话 id：写进定位符，也决定这段文字归谁。 */
  readonly sessionId?: string
  /** 来源工具名（候选里没给时用这个）。 */
  readonly tool?: string
}

/** 单次判定的覆盖项。 */
export interface SpillApplyOverrides {
  /** 本次的会话 id（覆盖构造时的）。 */
  readonly sessionId?: string
  /** 本次的来源工具名（覆盖构造时的）。 */
  readonly tool?: string
}

/** 判定结果。 */
export interface SpillPolicyOutcome {
  /** 给模型看的正文：超限时是「预览 + 定位符 + 取回方式」，其余情况是原文。 */
  readonly content: string
  /** 原文有没有被换成预览。 */
  readonly spilled: boolean
  /** 定位符（溢出了才有）。 */
  readonly ref?: SpillRef
  /** 存不下时的原因（`spilled` 为 false 但这里有值，说明本该溢出却没溢成）。 */
  readonly failure?: string
  /** 原文长度（字符）。 */
  readonly chars: number
  /** 这次判定用的内联上限（字符）。 */
  readonly limitChars: number
}

/**
 * 这个结果是不是纯文本。
 *
 * 判据只有一条：**看着像 JSON 且确实能解析**，就算结构化结果，不溢出。
 * 只是碰巧以 `{` 开头但解析不了（普通文字里带了个括号），照样按纯文本处理。
 * @param text - 结果正文。
 * @returns 是纯文本返回 true。
 */
export function isPlainTextResult(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return true
  try {
    JSON.parse(trimmed)
    return false
  } catch {
    return true
  }
}

/**
 * 这次判定的内联上限（字符）。
 * @param options - 策略参数。
 * @returns 上限（字符）。
 */
export function inlineLimitChars(options: SpillPolicyOptions): number {
  const charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  const limits: number[] = []
  if (options.maxInlineTokens !== undefined) {
    limits.push(Math.max(0, Math.floor(options.maxInlineTokens * charsPerToken)))
  }
  if (options.maxInlineChars !== undefined) {
    limits.push(Math.max(0, Math.floor(options.maxInlineChars)))
  }
  if (limits.length === 0) return DEFAULT_MAX_INLINE_TOKENS * charsPerToken
  return Math.min(...limits)
}

/**
 * 溢出的那段提示：模型看到的就是它。
 *
 * 三件事说清楚：**原文有多长**、**现在看到的是开头多少**、**完整原文怎么取回**。
 * 第三件最重要——不给取回方式，预览就只是一段没头没尾的碎片。
 * @param text - 原文。
 * @param ref - 定位符。
 * @param previewChars - 预览长度（字符）。
 * @returns 给模型看的正文。
 */
export function formatSpillNotice(text: string, ref: SpillRef, previewChars: number = DEFAULT_PREVIEW_CHARS): string {
  const preview = text.slice(0, Math.max(0, previewChars))
  return [
    `[工具结果过长，已溢出] 原文共 ${ref.chars} 字，下面是前 ${preview.length} 字预览：`,
    '',
    preview,
    '',
    `完整原文已存下（定位符 ${ref.id}）。取回：${ref.retrieval}`,
  ].join('\n')
}

/**
 * 对一个工具结果跑一遍溢出判定。
 *
 * 纯函数：存储是注入进来的，判定过程不改任何外部状态。
 * @param candidate - 要判定的结果。
 * @param options - 策略参数（存储、阈值、预览长度、会话归属）。
 * @returns 判定结果（给模型看的正文 + 溢出情况）。
 */
export function applySpillPolicy(candidate: SpillCandidate, options: SpillPolicyOptions): SpillPolicyOutcome {
  const text = typeof candidate.text === 'string' ? candidate.text : ''
  const chars = text.length
  const limitChars = inlineLimitChars(options)
  const plainText = candidate.plainText ?? isPlainTextResult(text)
  // 结构化结果不溢出：压掉前缀等于把结果改坏了。
  if (!plainText) {
    return { content: text, spilled: false, chars, limitChars }
  }
  // 阈值内原样返回：一个字都不改。
  if (chars <= limitChars) {
    return { content: text, spilled: false, chars, limitChars }
  }
  const tool = candidate.tool ?? options.tool
  try {
    const ref = options.store.store(text, {
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(tool === undefined ? {} : { tool }),
    })
    return {
      content: formatSpillNotice(text, ref, options.previewChars ?? DEFAULT_PREVIEW_CHARS),
      spilled: true,
      ref,
      chars,
      limitChars,
    }
  } catch (error) {
    // 存不下就保留原文：宁可这一轮把上下文撑爆，也不能让模型什么都拿不到。
    return {
      content: text,
      spilled: false,
      failure: error instanceof Error ? error.message : String(error),
      chars,
      limitChars,
    }
  }
}

/**
 * 带默认值的策略。
 *
 * 想直接用函数的话用 {@link applySpillPolicy}；这个类只是把「存储 + 阈值」先
 * 存下来，之后每次判定少传一遍。
 */
export class SpillPolicy {
  private readonly options: SpillPolicyOptions

  constructor(options: SpillPolicyOptions) {
    this.options = options
  }

  /**
   * 判定一次工具结果。
   * @param candidate - 要判定的结果。
   * @param overrides - 本次的覆盖项（会话、来源工具）。
   * @returns 判定结果。
   */
  apply(candidate: SpillCandidate, overrides?: SpillApplyOverrides): SpillPolicyOutcome {
    return applySpillPolicy(candidate, {
      ...this.options,
      ...(overrides?.sessionId === undefined ? {} : { sessionId: overrides.sessionId }),
      ...(overrides?.tool === undefined ? {} : { tool: overrides.tool }),
    })
  }
}
