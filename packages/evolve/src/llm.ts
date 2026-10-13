/**
 * 进化管线的 LLM 接缝：Curator（playbook delta）与 Reflector（教训生成）。
 * @module @ryagent/evolve/llm
 */

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

/** Curator 产出的增量操作（ACE 核心：只增删改条目，不整段重写）。 */
export type PlaybookDelta =
  | { op: 'add'; section: PlaybookSection; content: string }
  | { op: 'update'; entryId: string; content: string }
  | { op: 'deprecate'; entryId: string }

export interface EvolveLlm {
  proposeDeltas(input: { agentName: string; trajectory: TurnTrajectory }): Promise<PlaybookDelta[]>
  reflect(input: { agentName: string; trajectory: TurnTrajectory; reason: string }): Promise<string>
}

/** 用户负反馈信号词（触发即时反思）。 */
export const NEGATIVE_FEEDBACK_RE = /不对|错了|重来|搞错|不是这个|你胡说|重新来|答错|wrong|incorrect|that'?s not/i

const CURATOR_PROMPT = `你是经验手册的策展人（Curator）。给定一轮对话轨迹，产出对经验手册的增量修改（delta）——只输出 add/update/deprecate 操作，绝不整段重写。
- add：本轮证明了某条可复用策略/坑/偏好（值得以后记住的具体做法）。
- update：某条既有条目被本轮经验细化或修正。
- deprecate：某条既有条目与本轮经验矛盾、已过时。
没有值得改的就说 NOOP。只输出 JSON：{"deltas": [{"op": "add|update|deprecate", "section": "strategy|pitfall|preference|tooling", "entryId": "...", "content": "..."}]}
add 不带 entryId；deprecate 只需要 entryId。

既有条目：
`

const REFLECT_PROMPT = `你是反思者。这轮对话出现了失败信号（原因见末尾）。用一两句简洁、可操作的话总结教训（"下次应该…因为…"式）。只输出 JSON：{"lesson": "..."}

轨迹：
`

/** OpenAI 兼容 chat/completions 默认实现。 */
export class ChatEvolveLlm implements EvolveLlm {
  constructor(
    private readonly config: {
      apiKey: string
      baseURL?: string
      model?: string
      fetchImpl?: typeof fetch
    },
  ) {}

  private async chatJson(system: string, user: string): Promise<unknown> {
    const fetchImpl = this.config.fetchImpl ?? fetch
    const base = (this.config.baseURL ?? 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
    const response = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify({
        model: this.config.model ?? 'deepseek-ai/DeepSeek-V3',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    })
    if (!response.ok) throw new Error(`evolve llm HTTP ${response.status}`)
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] }
    const content = body.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('evolve llm: empty response')
    return JSON.parse(content) as unknown
  }

  async proposeDeltas(input: { agentName: string; trajectory: TurnTrajectory }): Promise<PlaybookDelta[]> {
    const tools =
      input.trajectory.toolResults.length > 0
        ? input.trajectory.toolResults
            .map((t) => {
              return `${t.name}${t.isError ? '(失败)' : '(成功)'}`
            })
            .join('、')
        : '无'
    const parsed = (await this.chatJson(
      '你只输出合法 JSON。',
      `${CURATOR_PROMPT}（agent：${input.agentName}）\n\n用户：${input.trajectory.userText}\n${input.agentName}：${input.trajectory.assistantText.slice(0, 800)}\n工具：${tools}\n流错误：${input.trajectory.llmError ? '是' : '否'}`,
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
          return { op: 'update', entryId: delta.entryId, content: delta.content.trim().slice(0, 300) }
        }
        if (op === 'deprecate' && typeof delta.entryId === 'string') {
          return { op: 'deprecate', entryId: delta.entryId }
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
