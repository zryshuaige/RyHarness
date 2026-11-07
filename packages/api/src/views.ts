/**
 * RPC 线上视图：远程方法返回的 DTO，**契约的唯一真源**。
 *
 * 为什么放在这一层：这两个形状是「远程调用的返回体」，跟着线协议走——
 * 生产方（`@ryharness/server` 的 RPC 服务）和消费方（`@ryharness/sdk` 的
 * 进程外客户端）都从这里 `import type`，谁都不许再手抄一份。此前的教训是
 * 三处各写各的（服务端、SDK、selfcheck），字段一改就漂移。
 * @module @ryharness/api/views
 */

/** 一个会话的摘要（`listConversations` 的条目）。 */
export interface RemoteConversationView {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly memberAgentIds: readonly string[]
  readonly updatedAt: number
}

/** 一条消息的摘要（`listMessages` 的条目）。 */
export interface RemoteMessageView {
  readonly seq: number
  readonly senderType: string
  readonly content: string
  readonly createdAt: number
}

/** 一条被召回的记忆（`recallMemory` 的条目）：正文 + 「为什么是它」的元数据。 */
export interface RemoteMemoryHit {
  readonly id: string
  /** 记忆类别（fact/experience/…，存储层的 MemoryKind）。 */
  readonly kind: string
  readonly content: string
  /** 归属空间：agent id 或 `*shared*`。 */
  readonly agentId: string
  readonly createdAt: number
  readonly updatedAt: number
  /** 排序键：RRF × 时间衰减 × 访问增益（混合检索的最终得分）。 */
  readonly score: number
}
