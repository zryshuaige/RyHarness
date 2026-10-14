/**
 * 记忆管线的 LLM 接缝：事实抽取 + 四操作判定（ADD/UPDATE/DELETE/NOOP）。
 * 默认实现走 OpenAI 兼容 chat/completions + JSON 结构化输出；测试注入脚本化
 * mock。baseURL/key/model 全部来自调用方配置（providers.json），这里不内置
 * 任何供应商默认值——用户换供应商，记忆管线必须跟着换。
 * @module @ryagent/memory/llm
 */

import { HarnessError } from '@ryagent/llm'
import { ChatJsonClient } from '@ryagent/util-llm-json'

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

/** 抽取失败分类（稳定码，便于上层日志与重试策略路由）。 */
export const MEMORY_LLM_CODES = {
  config: 'MEMORY_LLM_CONFIG',
  http: 'MEMORY_LLM_HTTP',
  empty: 'MEMORY_LLM_EMPTY',
  json: 'MEMORY_LLM_JSON',
} as const

const EXTRACT_PROMPT = `你是记忆抽取器。从下面的对话中抽出值得长期记住的原子事实（每条一句、具体、自包含）。

规则：
1. 关于「用户自己」的事实（身份、生活、喜好、计划、宠物、工作……）→ scope=shared，kind 取 profile（稳定属性）/ preference（偏好）/ event（近期事件）。
2. 关于「与该 agent 的互动经验」（用户对该 agent 的指令风格、委托习惯、约定）→ scope=agent。
3. 闲聊寒暄、一次性任务细节、纯客套话 → 不抽。
4. 用户在闲聊中顺口表达的喜好/习惯，**要抽**：不要因为"没有正式提出要求"就放弃。

示例（对话 → 抽取结果）：
- 「我最喜欢吃川菜，越辣越好」→ {"text":"用户偏好川菜，喜欢辣","scope":"shared","kind":"preference"}
- 「以后给我发周报都用要点式的，别写长段落」→ {"text":"用户要求周报用要点式，不用长段落","scope":"shared","kind":"preference"}
- 「我养了一只橘猫叫布丁」→ {"text":"用户养了一只橘猫叫布丁","scope":"shared","kind":"profile"}
- 「下周要搬家到杭州」→ {"text":"用户下周要搬到杭州","scope":"shared","kind":"event"}
- 「把 src/a.ts 里的第 3 行改成 foo」→ 不抽（一次性任务细节）
- 「好的，谢谢你！」→ 不抽（寒暄）

只输出 JSON：{"facts": [{"text": "...", "scope": "shared|agent", "kind": "profile|preference|event|fact"}]}

对话：
`

const DECIDE_PROMPT = `你是记忆管理员。给定一条候选事实和若干条相似旧记忆，为每条旧记忆决定操作，也可新增：
- ADD：候选事实值得新增（与所有旧记忆都不重复，或补足了旧记忆没有的方面）。
- UPDATE：某旧记忆与候选互补/被细化 → 给出合并后的新文本。
- DELETE：候选事实与某旧记忆矛盾（取代它，如用户搬家、改计划）。
- NOOP：候选与某条旧记忆**含义几乎完全相同**（换个说法而已），不值得新增或改写。
同一候选只能产生一个写操作。默认倾向写入：只有确实重复时才用 NOOP，宁可重复也不要漏记用户明确说过的偏好。

只输出 JSON：{"operations": [{"action": "ADD|UPDATE|DELETE|NOOP", "memoryId": "...", "newText": "..."}]}
其中 ADD 不带 memoryId，NOOP 可以不带任何字段。

示例（候选 + 旧记忆 → 操作）：
- 候选「用户偏好川菜，喜欢辣」，旧记忆为 [] → [{"action":"ADD"}]
- 候选「用户偏好川菜，喜欢辣」，旧记忆「用户喜欢川菜」 → [{"action":"UPDATE","memoryId":"<id>","newText":"用户偏好川菜，喜欢辣"}]
- 候选「用户住在杭州」，旧记忆「用户住在北京」 → [{"action":"UPDATE","memoryId":"<id>","newText":"用户住在杭州"}]
- 候选「用户偏好川菜，喜欢辣」，旧记忆「用户偏好川菜，喜欢辣」 → [{"action":"NOOP"}]

候选事实：
`

/** OpenAI 兼容 chat/completions 的默认实现（配置驱动，无供应商默认值）。 */
export class ChatMemoryLlm implements MemoryLlm {
  private readonly client: ChatJsonClient

  constructor(config: {
    apiKey: string
    baseURL: string
    model: string
    fetchImpl?: typeof fetch
    /** 单次请求超时毫秒（默认 30s）。 */
    timeoutMs?: number
  }) {
    try {
      this.client = new ChatJsonClient({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        model: config.model,
        ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        codeNamespace: 'MEMORY_LLM',
      })
    } catch (error) {
      // 命名空间不合法之类的问题与缺配置同义：都还没到网络就注定失败。
      throw new HarnessError((error as Error).message, MEMORY_LLM_CODES.config, { cause: error })
    }
  }

  async extractFacts(input: { agentName: string; conversationText: string }): Promise<CandidateFact[]> {
    const parsed = (await this.client.chatJson({
      system: '你只输出合法 JSON。',
      user: `${EXTRACT_PROMPT}${input.conversationText}\n\n（agent：${input.agentName}）`,
    })) as { facts?: unknown }
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
    const parsed = (await this.client.chatJson({
      system: '你只输出合法 JSON。',
      user: `${DECIDE_PROMPT}${input.candidate.text}\n\n（scope=${input.candidate.scope}）\n\n相似旧记忆：\n${similarText}`,
    })) as { operations?: Record<string, unknown>[] }
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
