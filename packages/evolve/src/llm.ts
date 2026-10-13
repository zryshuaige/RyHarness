/**
 * 进化管线的 LLM 接缝：Curator（playbook delta）与 Reflector（教训生成）。
 *
 * baseURL/key/model 全部来自调用方配置（providers.json 的默认 provider），
 * 这里不内置任何供应商默认值。
 * @module @ryagent/evolve/llm
 */

import { HarnessError } from '@ryagent/llm'
import type { PlaybookSection } from './schema.ts'

/** 一轮对话的轨迹摘要（进化管线的输入）。 */
export interface TurnTrajectory {
  userText: string
  assistantText: string
  /** 本轮工具调用结果（成败）。 */
  toolResults: { name: string; isError: boolean }[]
  /** LLM 流是否以错误收尾。 */
  llmError: boolean
}

/**
 * 交给 Curator 的既有条目视图。没有它，模型只能产出 add——update/deprecate
 * 里的 entryId 是凭空捏的，必然被校验拒掉，playbook 于是"只会增不会改"。
 */
export interface CuratorEntryView {
  id: string
  section: PlaybookSection
  content: string
  helpful: number
  harmful: number
}

/** Curator 产出的增量操作（ACE 核心：只增删改条目，不整段重写）。 */
export type PlaybookDelta =
  | { op: 'add'; section: PlaybookSection; content: string }
  | { op: 'update'; entryId: string; content: string }
  | { op: 'deprecate'; entryId: string }

export interface EvolveLlm {
  proposeDeltas(input: {
    agentName: string
    trajectory: TurnTrajectory
    /** 既有 active 条目（供 update/deprecate 引用）。 */
    entries?: readonly CuratorEntryView[]
  }): Promise<PlaybookDelta[]>
  reflect(input: { agentName: string; trajectory: TurnTrajectory; reason: string }): Promise<string>
}

/** 用户负反馈信号词（触发即时反思）。 */
export const NEGATIVE_FEEDBACK_RE = /不对|错了|重来|搞错|不是这个|你胡说|重新来|答错|wrong|incorrect|that'?s not/i

/** Curator 可见的既有条目条数上限（prompt 预算）。 */
export const CURATOR_ENTRY_LIMIT = 20

/** 进化 LLM 的失败分类（稳定码）。 */
export const EVOLVE_LLM_CODES = {
  config: 'EVOLVE_LLM_CONFIG',
  http: 'EVOLVE_LLM_HTTP',
  empty: 'EVOLVE_LLM_EMPTY',
  json: 'EVOLVE_LLM_JSON',
} as const

const CURATOR_PROMPT = `你是经验手册的策展人（Curator）。给定一轮对话轨迹和该 agent 的既有手册条目，产出对经验手册的增量修改（delta）——只输出 add/update/deprecate 操作，绝不整段重写。
- add：本轮证明了某条可复用策略/坑/偏好（值得以后记住的具体做法）。
- update：既有条目被本轮经验细化或修正（entryId 必须取自下方既有条目列表）。
- deprecate：既有条目与本轮经验矛盾、已过时（entryId 必须取自下方既有条目列表）。
没有值得改的就说 NOOP。只输出 JSON：{"deltas": [{"op": "add|update|deprecate", "section": "strategy|pitfall|preference|tooling", "entryId": "...", "content": "..."}]}
add 不带 entryId；deprecate 只需要 entryId。

既有条目：
`

const REFLECT_PROMPT = `你是反思者。这轮对话出现了失败信号（原因见末尾）。用一两句简洁、可操作的话总结教训（"下次应该…因为…"式）。只输出 JSON：{"lesson": "..."}

轨迹：
`

/** OpenAI 兼容 chat/completions 默认实现（配置驱动）。 */
export class ChatEvolveLlm implements EvolveLlm {
  private readonly baseURL: string
  private readonly model: string

  constructor(
    private readonly config: {
      apiKey: string
      baseURL: string
      model: string
      fetchImpl?: typeof fetch
      /** 单次请求超时毫秒（默认 30s）。 */
      timeoutMs?: number
    },
  ) {
    if (config.apiKey.length === 0) {
      throw new HarnessError('@ryagent/evolve: evolve llm requires an api key', EVOLVE_LLM_CODES.config)
    }
    if (typeof config.baseURL !== 'string' || config.baseURL.length === 0) {
      throw new HarnessError('@ryagent/evolve: evolve llm requires a baseURL', EVOLVE_LLM_CODES.config)
    }
    if (typeof config.model !== 'string' || config.model.length === 0) {
      throw new HarnessError('@ryagent/evolve: evolve llm requires a model id', EVOLVE_LLM_CODES.config)
    }
    this.baseURL = config.baseURL.replace(/\/+$/, '')
    this.model = config.model
  }

  private async chatJson(system: string, user: string): Promise<unknown> {
    const fetchImpl = this.config.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0,
          response_format: { type: 'json_object' },
        }),
        ...(this.config.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(this.config.timeoutMs) }),
      })
    } catch (error) {
      throw new HarnessError(`@ryagent/evolve: evolve llm request failed: ${String(error)}`, EVOLVE_LLM_CODES.http, {
        cause: error,
      })
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new HarnessError(
        `@ryagent/evolve: evolve llm HTTP ${response.status} ${detail.slice(0, 400)}`.trimEnd(),
        EVOLVE_LLM_CODES.http,
      )
    }
    const body = (await response.json().catch(() => {
      return undefined
    })) as { choices?: { message?: { content?: unknown } }[] } | undefined
    const raw = body?.choices?.[0]?.message?.content
    const content = normalizeContent(raw)
    if (content === undefined || content.trim().length === 0) {
      throw new HarnessError('@ryagent/evolve: evolve llm returned an empty response', EVOLVE_LLM_CODES.empty)
    }
    try {
      return JSON.parse(stripCodeFence(content)) as unknown
    } catch (error) {
      throw new HarnessError(
        `@ryagent/evolve: evolve llm returned non-JSON content: ${content.slice(0, 200)}`,
        EVOLVE_LLM_CODES.json,
        { cause: error },
      )
    }
  }

  async proposeDeltas(input: {
    agentName: string
    trajectory: TurnTrajectory
    entries?: readonly CuratorEntryView[]
  }): Promise<PlaybookDelta[]> {
    const tools =
      input.trajectory.toolResults.length > 0
        ? input.trajectory.toolResults
            .map((t) => {
              return `${t.name}${t.isError ? '(失败)' : '(成功)'}`
            })
            .join('、')
        : '无'
    const entries = (input.entries ?? []).slice(0, CURATOR_ENTRY_LIMIT)
    const entryBlock =
      entries.length === 0
        ? '（无，这是该 agent 的第一本手册）'
        : entries
            .map((entry, index) => {
              return `${index + 1}. [${entry.id}] (${entry.section}, 得分 ${entry.helpful - entry.harmful}) ${entry.content}`
            })
            .join('\n')
    // 模型只允许引用我们真的给过的条目 id，幻觉 id 在这里就被丢掉。
    const knownIds = new Set(entries.map((entry) => {
      return entry.id
    }))
    const parsed = (await this.chatJson(
      '你只输出合法 JSON。',
      `${CURATOR_PROMPT}${entryBlock}\n\n（agent：${input.agentName}）\n\n用户：${input.trajectory.userText}\n${input.agentName}：${input.trajectory.assistantText.slice(0, 800)}\n工具：${tools}\n流错误：${input.trajectory.llmError ? '是' : '否'}`,
    )) as { deltas?: Record<string, unknown>[] }
    if (!Array.isArray(parsed.deltas)) return []
    const sections: PlaybookSection[] = ['strategy', 'pitfall', 'preference', 'tooling']
    return parsed.deltas
      .map((delta): PlaybookDelta | undefined => {
        const op = String(delta.op)
        if (op === 'add' && sections.includes(delta.section as PlaybookSection) && typeof delta.content === 'string') {
          return { op: 'add', section: delta.section as PlaybookSection, content: delta.content.trim().slice(0, 300) }
        }
        if (op === 'update' && typeof delta.entryId === 'string' && typeof delta.content === 'string') {
          return knownIds.has(delta.entryId)
            ? { op: 'update', entryId: delta.entryId, content: delta.content.trim().slice(0, 300) }
            : undefined
        }
        if (op === 'deprecate' && typeof delta.entryId === 'string') {
          return knownIds.has(delta.entryId) ? { op: 'deprecate', entryId: delta.entryId } : undefined
        }
        return undefined
      })
      .filter((d): d is PlaybookDelta => {
        return d !== undefined
      })
  }

  async reflect(input: { agentName: string; trajectory: TurnTrajectory; reason: string }): Promise<string> {
    const parsed = (await this.chatJson(
      '你只输出合法 JSON。',
      `${REFLECT_PROMPT}用户：${input.trajectory.userText}\n${input.agentName}：${input.trajectory.assistantText.slice(0, 800)}\n\n失败原因：${input.reason}`,
    )) as { lesson?: unknown }
    return typeof parsed.lesson === 'string' && parsed.lesson.trim().length > 0
      ? parsed.lesson.trim().slice(0, 300)
      : '本轮出现问题，下次先检查再行动。'
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