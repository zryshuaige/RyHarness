/**
 * Session 持久化类型：Agent 定义、会话、消息、群聊调度事件。
 * @module @ryharness/session/types
 */

import type { PermissionPreset } from '@ryharness/agent'
import type { AgentPersona } from './persona.ts'

/**
 * Agent 跑在哪儿：本机（默认）还是 Kimi Hosted Agents 的云沙箱。
 *
 * 存成一列而不是另开一张表：通讯录、建群、@提及、调度器选人都按 `agents` 行认人，
 * 云成员只要还是这一行，那些流程一行都不用改。
 */
export type AgentRuntime = 'local' | 'hosted'

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
  /** 这个成员跑在本机还是云端。缺省（旧行/旧调用方）按本机算。 */
  runtime?: AgentRuntime
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
  /**
   * 这个会话归哪个工作区。
   *
   * 存的是**工作区 id**（`@ryharness/workspace` 的注册表里那条记录的 id），不是
   * 路径——路径会变（用户挪了目录），id 不会。没有就是「未归属」，工具读写文件
   * 落在默认工作区根目录。
   */
  workspaceId?: string
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

/** 云成员的来源：官方只读 agent，还是我们自己创建的可改 agent。 */
export type HostedMemberScope = 'official' | 'custom'

/** 雇佣状态：active 在用；archived 已解雇（远端已归档）；error 远端对不上。 */
export type HostedMemberStatus = 'active' | 'archived' | 'error'

/**
 * 一条雇佣契约：本地 agent ↔ 远端 agent。
 *
 * 远端 `agent_` 是"这个人"，`environment_id` 是它上班的环境。两者在雇佣时确定，
 * 之后只有"重新雇佣"才会换。会话（`hosted_sessions`）才是它每次上班的工位。
 */
export interface HostedMember {
  agentId: string
  remoteAgentId: string
  environmentId: string
  /** 钉住的远端版本；缺省 = 每次新建会话取最新版本。 */
  agentVersion?: string
  scope: HostedMemberScope
  status: HostedMemberStatus
  createdAt: number
  updatedAt: number
}

/** 云会话（工位）的生命周期；`lost` 表示远端查不到这个会话了。 */
export type HostedSessionStatus = 'idle' | 'running' | 'terminated' | 'lost'

/**
 * 一个成员在一个会话里的工位。
 *
 * 主键是 (conversationId, agentId)：群聊里可以同时有多位云成员，同一位成员也可以
 * 同时在多个会话里上班，各自是独立的远端会话（彼此不共享上下文）。
 */
export interface HostedSession {
  conversationId: string
  agentId: string
  sessionId: string
  /** SSE 恢复游标（不透明字符串，原样回传）。 */
  cursor?: string
  /** 最后处理过的 KHA 事件 id：重连会重投最后一帧，靠它去重。 */
  lastEventId?: string
  /** 最后处理过的事件的服务端时间（ISO）：事件 id 对不上时用它兜底对账。 */
  lastEventAt?: string
  status: HostedSessionStatus
  createdAt: number
  updatedAt: number
}
