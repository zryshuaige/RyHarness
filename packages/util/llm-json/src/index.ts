/**
 * OpenAI 兼容 chat/completions 的 JSON 结构化输出客户端。
 *
 * 记忆管线与进化管线的 prompt 与结果校验各不相同，但「发一次请求、把回复解成
 * JSON、失败时给出可路由的稳定错误码」这一段此前是逐字重复的两份实现；这里只
 * 保留一份，两条管线各自传入自己的 `codeNamespace` 区分错误前缀与错误码。
 *
 * 刻意不内置任何供应商默认值：baseURL / apiKey / model 全部由调用方从
 * providers.json 传入，用户换供应商时管线必须跟着换。
 *
 * @module @ryharness/util-llm-json
 */

import { HarnessError } from '@ryharness/llm'

/** 一次结构化输出请求的失败分类后缀（拼在 `${codeNamespace}_` 之后）。 */
export type ChatJsonFailureKind = 'CONFIG' | 'HTTP' | 'EMPTY' | 'JSON'

/** 客户端配置。字段名与调用方存储的 provider profile 一一对应。 */
export interface ChatJsonConfig {
  /** 调用方配置的凭据；空串在构造期即判为配置错误。 */
  apiKey: string
  /** OpenAI 兼容端点根地址；尾部斜杠会被去掉。 */
  baseURL: string
  /** 模型 id。 */
  model: string
  /** 注入的 fetch（测试脚本化 mock 用）；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 单次请求超时毫秒；缺省不设 deadline。 */
  timeoutMs?: number
  /** 错误码命名空间，例如 `'MEMORY_LLM'`；错误码形如 `MEMORY_LLM_HTTP`。 */
  codeNamespace: string
}

/** 一轮 system/user 对话。 */
export interface ChatJsonTurn {
  system: string
  user: string
}

/**
 * 一次结构化输出请求的客户端。构造即校验配置，调用即返回解析后的 JSON。
 */
export class ChatJsonClient {
  private readonly baseURL: string
  private readonly model: string
  private readonly codes: Record<ChatJsonFailureKind, string>
  private readonly label: string

  constructor(private readonly config: ChatJsonConfig) {
    const label = config.codeNamespace
    this.label = label
    this.codes = {
      CONFIG: `${label}_CONFIG`,
      HTTP: `${label}_HTTP`,
      EMPTY: `${label}_EMPTY`,
      JSON: `${label}_JSON`,
    }
    if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
      throw new HarnessError(`${label}: requires an api key`, this.codes.CONFIG)
    }
    if (typeof config.baseURL !== 'string' || config.baseURL.length === 0) {
      throw new HarnessError(`${label}: requires a baseURL`, this.codes.CONFIG)
    }
    if (typeof config.model !== 'string' || config.model.length === 0) {
      throw new HarnessError(`${label}: requires a model id`, this.codes.CONFIG)
    }
    this.baseURL = config.baseURL.replace(/\/+$/, '')
    this.model = config.model
  }

  /**
   * 发一次请求并返回回复解析出的 JSON 值。
   * @param turn - 本次调用的 system 与 user 文本。
   * @returns 供应商回复解析后的 JSON；形状由调用方自行校验。
   * @throws HarnessError 分类码 `CONFIG` / `HTTP` / `EMPTY` / `JSON`。
   */
  async chatJson(turn: ChatJsonTurn): Promise<unknown> {
    const fetchImpl = this.config.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: turn.system },
            { role: 'user', content: turn.user },
          ],
          temperature: 0,
          response_format: { type: 'json_object' },
        }),
        ...(this.config.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(this.config.timeoutMs) }),
      })
    } catch (error) {
      throw new HarnessError(`${this.label}: request failed: ${String(error)}`, this.codes.HTTP, { cause: error })
    }
    if (!response.ok) {
      // 带上供应商原文：401/404/429 的处置方式完全不同，只报状态码没法排障。
      const detail = await response.text().catch(() => '')
      throw new HarnessError(
        `${this.label}: HTTP ${response.status} ${detail.slice(0, 400)}`.trimEnd(),
        this.codes.HTTP,
      )
    }
    const body = (await response.json().catch(() => undefined)) as
      | { choices?: { message?: { content?: unknown } }[] }
      | undefined
    const content = normalizeContent(body?.choices?.[0]?.message?.content)
    if (content === undefined || content.trim().length === 0) {
      throw new HarnessError(`${this.label}: returned an empty response`, this.codes.EMPTY)
    }
    try {
      return JSON.parse(stripCodeFence(content)) as unknown
    } catch (error) {
      throw new HarnessError(`${this.label}: returned non-JSON content: ${content.slice(0, 200)}`, this.codes.JSON, {
        cause: error,
      })
    }
  }
}

/** 供应商可能返回字符串或分段数组；统一取文本。 */
function normalizeContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((part) => {
      if (typeof part === 'string') return part
      const text = (part as { text?: unknown })?.text
      return typeof text === 'string' ? text : ''
    })
    .join('')
  return text.length === 0 ? undefined : text
}

/** 部分供应商即使被要求 JSON 也会裹 ```json 围栏。 */
function stripCodeFence(content: string): string {
  const trimmed = content.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
}
