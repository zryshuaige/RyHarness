/**
 * 记忆管线的 LLM 接缝：事实抽取 + 四操作判定（ADD/UPDATE/DELETE/NOOP）。
 * 默认实现走 OpenAI 兼容 chat/completions + JSON 结构化输出；
 * 测试注入脚本化 mock。结构化输出而非自由文本解析（调研 §1.2）。
 * @module @ryagent/memory/llm
 */

/** 候选事实（抽取阶段输出）：scope 决定写入共享画像还是 agent 私有空间。 */
export interface CandidateFact {
  text: string
  scope: 'shared' | 'agent'
  kind: 'profile' | 'fact' | 'preference' | 'event'
}

/** 四操作之一（判定阶段输出，对应 mem0 manage_memory schema）。 */
export type MemoryOperation =
  | { action: 'ADD'; text?: string }
  | { action: 'UPDATE'; memoryId: string; newText: string }
  | { action: 'DELETE'; memoryId: string }
  | { action: 'NOOP' }

/** 记忆管线需要的 LLM 能力（与具体供应商解耦）。 */
export interface MemoryLlm {
  extractFacts(input: { agentName: string; conversationText: string }): Promise<CandidateFact[]>
  decideOperations(input: {
    candidate: CandidateFact
    similar: { id: string; content: string }[]
  }): Promise<MemoryOperation[]>
}

const EXTRACT_PROMPT = `你是记忆抽取器。从下面的对话中抽出值得长期记住的原子事实（每条一句、具体、自包含）。
规则：
1. 关于「用户自己」的事实（身份、生活、喜好、计划、宠物、工作……）→ scope=shared，kind 取 profile（稳定属性）或 preference（偏好）或 event（近期事件）。
2. 关于「与该 agent 的互动经验」（用户对该 agent 的指令风格、委托习惯、约定）→ scope=agent。
3. 闲聊寒暄、一次性任务细节、已在相似列表出现的重复事实 → 不抽。
只输出 JSON：{"facts": [{"text": "...", "scope": "shared|agent", "kind": "profile|preference|event|fact"}]}

对话：
`

const DECIDE_PROMPT = `你是记忆管理员。给定一条候选事实和若干条相似旧记忆，为每条旧记忆决定操作，也可新增：
- ADD：候选事实值得新增（不与任何旧记忆重复）。
- UPDATE：某旧记忆与候选互补/被细化 → 给出合并后的新文本。
- DELETE：候选事实与某旧记忆矛盾（取代它，如用户搬家、改计划）。
- NOOP：无需变更。
同一候选只能产生一个写操作。只输出 JSON：{"operations": [{"action": "ADD|UPDATE|DELETE|NOOP", "memoryId": "...", "newText": "..."}]}
其中 ADD 不带 memoryId，NOOP 可以不带任何字段。

候选事实：
`

/** 基于 OpenAI 兼容 chat/completions 的默认实现。 */
export class ChatMemoryLlm implements MemoryLlm {
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
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
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
    if (!response.ok) throw new Error(`memory llm HTTP ${response.status}`)
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] }
    const content = body.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('memory llm: empty response')
    return JSON.parse(content) as unknown
  }

  async extractFacts(input: { agentName: string; conversationText: string }): Promise<CandidateFact[]> {
    const parsed = (await this.chatJson(
      '你只输出合法 JSON。',
      `${EXTRACT_PROMPT}${input.conversationText}\n\n（agent：${input.agentName}）`,
    )) as { facts?: unknown }
    if (!Array.isArray(parsed.facts)) return []
    const out: CandidateFact[] = []
    for (const item of parsed.facts as Record<string, unknown>[]) {
      if (typeof item?.text !== 'string' || item.text.trim().length === 0) continue
      const scope = item.scope === 'agent' ? 'agent' : 'shared'
      const kind = ['profile', 'preference', 'event', 'fact'].includes(String(item.kind))
        ? (String(item.kind) as CandidateFact['kind'])
        : 'fact'
      out.push({ text: item.text.trim().slice(0, 500), scope, kind })
    }
    return out
  }

  async decideOperations(input: {
    candidate: CandidateFact
    similar: { id: string; content: string }[]
  }): Promise<MemoryOperation[]> {
    const similarText =
      input.similar.length === 0
        ? '（无相似旧记忆）'
        : input.similar
            .map((memory, index) => {
              return `${index + 1}. [${memory.id}] ${memory.content}`
            })
            .join('\n')
    const parsed = (await this.chatJson(
      '你只输出合法 JSON。',
      `${DECIDE_PROMPT}${input.candidate.text}\n\n（scope=${input.candidate.scope}）\n\n相似旧记忆：\n${similarText}`,
    )) as { operations?: Record<string, unknown>[] }
    if (!Array.isArray(parsed.operations)) return [{ action: 'NOOP' }]
    return parsed.operations
      .map((op): MemoryOperation | undefined => {
        const action = String(op.action)
        if (action === 'ADD') return { action: 'ADD', text: typeof op.newText === 'string' ? op.newText : undefined }
        if (action === 'UPDATE' && typeof op.memoryId === 'string' && typeof op.newText === 'string') {
          return { action: 'UPDATE', memoryId: op.memoryId, newText: op.newText }
        }
        if (action === 'DELETE' && typeof op.memoryId === 'string') return { action: 'DELETE', memoryId: op.memoryId }
        if (action === 'NOOP') return { action: 'NOOP' }
        return undefined
      })
      .filter((op): op is MemoryOperation => {
        return op !== undefined
      })
  }
}
