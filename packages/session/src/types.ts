/**
 * Session 持久化类型：Agent 定义、会话、消息、群聊调度事件。
 * @module @ryharness/session/types
 */

import type { PermissionPreset } from '@ryharness/agent'
import type { AgentPersona } from './persona.ts'

/** 持久化的 Agent 定义（与 @ryharness/agent 的 AgentDefinition 同构，常用字段展开便于 SQL 查询）。 */
export interface StoredAgent {
  id: string
  name: string
  avatar?: string
  systemPrompt: string
  provider: string
  model: string
  temperature?: number
  /** 思考强度档位（low / medium / high）；缺省 = 模型自己的默认。 */
  reasoningEffort?: string
  /** 工具名白名单。 */
  tools: string[]
  /**
   * 权限档位（`read-only` / `workspace-write` / `full-access`）。
   *
   * 存的是用户**选过**的那一档，不是从工具清单反推的——用户手动改过工具之后反推
   * 就不成立了，那种情况下界面显示「自定义」更诚实。缺省 = 没选过档。
   */
  permissionPreset?: PermissionPreset
  /**
   * 人格（性格四维 / 生日 / 口头禅 / 形象 / 音色 / 亲密度）。
   * 读出来一定是完整的一份：存量 agent 的 persona 列是 NULL，存储层按默认值补齐。
   */
  persona: AgentPersona
  isBuiltin: boolean
  /**
   * 路由是否被用户手动锁住：true = 用户自己挑的这条 provider/model，服务器
   * 不再自动改（内置助理的供应商默认跟着用户刚配好的那家走，见 apps/server 的
   * provider-routing.ts）。没锁过时为 false。
   */
  routeLocked?: boolean
  createdAt: number
  updatedAt: number
}

/** 会话种类：单聊（direct）或群聊（group）。 */
export type ConversationKind = 'direct' | 'group'

/** 一个会话（单聊 = 用户与一个 agent；群聊 = 多个 agent + 调度员）。 */
export interface Conversation {
  id: string
  kind: ConversationKind
  title: string
  /** 群聊成员 agent id 列表（单聊为单元素）。 */
  memberAgentIds: string[]
  /** 群聊调度员 agent id：决定每条用户消息路由给谁；单聊为空。 */
  dispatcherAgentId?: string
  /** 用户已读到的消息序号（未读 = seq 更大且非本人发送的消息数）。 */
  lastReadSeq: number
  createdAt: number
  updatedAt: number
}

/** 消息发送者种类。 */
export type SenderType = 'user' | 'agent' | 'system'

/**
 * 一条 assistant 消息对应的模型调用 token 用量（供应商侧 usage 的归一形态）。
 * 缺失表示该消息没有关联的模型调用（用户/system/工具消息）或供应商未回报。
 */
export interface StoredUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** 会话级累计用量。 */
export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** 有 usage 记录的消息条数。 */
  messages: number
}

/** 一条消息携带的产物卡片：工具结果里的 ProduceCard 加上关联的工具调用 id，随消息落库。 */
export interface MessageArtifact {
  /** 产出该产物的工具调用 id。 */
  callId: string
  /** 展示名（含扩展名；中文名原样保留）。 */
  name: string
  /** 文件字节数。 */
  size: number
  /** MIME 类型。 */
  mime: string
}

/** 一条消息；contentBlocks 与 mentions 以 JSON 存储，保持 @ryharness/llm 的 ContentBlock 结构。 */
export interface StoredMessage {
  id: string
  /** 单调递增序号，分页游标。 */
  seq: number
  conversationId: string
  senderType: SenderType
  /** user/agent 时为对应 id；system 时为空。 */
  senderId?: string
  /** 内容块数组（@ryharness/llm 的 ContentBlock JSON）。 */
  contentBlocks: unknown[]
  /** 群聊 @提及的 agent id 列表。 */
  mentions: string[]
  /** 工具结果消息对应的 callId（其他消息为空）。 */
  toolCallId?: string
  /** 会话内的轮次序号（同一轮用户输入 + agent 回复 +工具结果共享）。 */
  turnIndex: number
  /** 关联模型调用的 token 用量（assistant 消息才有）。 */
  usage?: StoredUsage
  /** 工具结果消息携带的产物卡片（其他消息为空）。 */
  artifacts?: MessageArtifact[]
  createdAt: number
}

/** 群聊调度事件：调度员决定本条输入由哪个 agent 响应。 */
export interface DispatchEvent {
  id: string
  conversationId: string
  /** 发起调度的 agent（通常是调度员）；系统兜底时为空。 */
  fromAgent?: string
  toAgent: string
  reason: string
  turnIndex: number
  createdAt: number
}
