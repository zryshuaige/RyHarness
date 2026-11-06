/**
 * 进程外 RPC 服务：把 RyHarness 的能力挂成远程方法，让外部程序调。
 *
 * ## 形态
 *
 * 外部程序把本进程当子进程拉起来（`ryharness --rpc`），往 stdin 写 JSON-RPC
 * 帧、从 stdout 读帧。**没有端口、没有令牌**——进程起来了就是连上了。
 *
 * ## 挂了哪些能力
 *
 * 一组「远程看这个应用」的方法：列会话、发消息、列工具、读记忆、写设置。
 * 方法名带 `ryharness.` 前缀，挂在 `ryharness` 这个命名空间下。
 *
 * ## 与 ACP 的关系
 *
 * **两套协议，两个用途**：
 * - 这一套（`@ryharness/api` 的 Remote 层）是**给程序调的**：程序要「列出会话、
 *   发一条消息」，走这里。
 * - ACP（`@ryharness/acp`）是**给编辑器用的**：编辑器要「把 RyHarness 当 agent
 *   用」，走那条路——它说的是 agent 的话（会话、提示、流式事件），不是「管理
 *   这个应用」的话。
 *
 * @module @ryharness/server/rpc/service
 */

import type { SessionStore } from '@ryharness/session'
import { Remote } from '@ryharness/typert-protocol'

/** 一个会话的摘要。 */
export interface RemoteConversationView {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly memberAgentIds: readonly string[]
  readonly updatedAt: number
}

/** 一条消息的摘要。 */
export interface RemoteMessageView {
  readonly seq: number
  readonly senderType: string
  readonly content: string
  readonly createdAt: number
}

/**
 * 从内容块里取出正文。
 *
 * 存储层存的是内容块数组（`@ryharness/llm` 的 ContentBlock JSON），文本块是
 * `type: 'text'`。别的块（推理、工具结果）不是正文，不要混进来。
 * @param blocks - 内容块数组。
 * @returns 正文（可能为空串）。
 */
function textOf(blocks: readonly unknown[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const raw of blocks) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as { type?: unknown; text?: unknown }
    if (block.type !== 'text') continue
    if (typeof block.text !== 'string') continue
    parts.push(block.text)
  }
  return parts.join('')
}

/**
 * 远程服务：给外部程序看这个应用。
 *
 * 挂在 `ryharness` 命名空间下，方法名带 `ryharness.` 前缀——外部程序看到的是
 * `ryharness.listConversations` 这样的名字，一眼知道这是 RyHarness 的能力。
 */
export class RyHarnessRemoteService {
  #store: SessionStore
  #listTools: () => readonly { name: string; description: string }[]
  #recallMemory: (agentId: string, query: string) => Promise<readonly string[]>
  #writeSetting: (key: string, value: string) => Promise<void>

  /**
   * @param options - 依赖。
   */
  constructor(options: {
    store: SessionStore
    listTools: () => readonly { name: string; description: string }[]
    recallMemory: (agentId: string, query: string) => Promise<readonly string[]>
    writeSetting: (key: string, value: string) => Promise<void>
  }) {
    this.#store = options.store
    this.#listTools = options.listTools
    this.#recallMemory = options.recallMemory
    this.#writeSetting = options.writeSetting
  }

  /**
   * 列出最近的会话。
   *
   * @param limit - 最多几个（默认 20，上限 200）。
   * @returns 会话摘要列表。
   */
  @Remote
  async listConversations(limit = 20): Promise<RemoteConversationView[]> {
    const capped = Math.max(1, Math.min(200, Math.trunc(limit)))
    return this.#store.listConversations(capped).map((conversation) => {
      return {
        id: conversation.id,
        kind: conversation.kind,
        title: conversation.title,
        memberAgentIds: [...conversation.memberAgentIds],
        updatedAt: conversation.updatedAt,
      }
    })
  }

  /**
   * 读一个会话的消息。
   *
   * @param conversationId - 会话 id。
   * @param limit - 最多几条（默认 50，上限 500）。
   * @returns 消息摘要列表。
   */
  @Remote
  async listMessages(conversationId: string, limit = 50): Promise<RemoteMessageView[]> {
    const capped = Math.max(1, Math.min(500, Math.trunc(limit)))
    const messages = this.#store.listMessages(conversationId, { limit: capped })
    return messages.map((message) => {
      return {
        seq: message.seq,
        senderType: message.senderType,
        content: textOf(message.contentBlocks),
        createdAt: message.createdAt,
      }
    })
  }

  /**
   * 列出当前注册着的工具。
   *
   * @returns 工具名与说明。
   */
  @Remote
  listTools(): { name: string; description: string }[] {
    return this.#listTools().map((tool) => {
      return { name: tool.name, description: tool.description }
    })
  }

  /**
   * 召回一位助理的长期记忆。
   *
   * @param agentId - 助理 id。
   * @param query - 查什么。
   * @returns 召回的条目。
   */
  @Remote
  async recallMemory(agentId: string, query: string): Promise<string[]> {
    return [...(await this.#recallMemory(agentId, query))]
  }

  /**
   * 写一条应用设置。
   *
   * @param key - 设置键。
   * @param value - 设置值。
   */
  @Remote
  async writeSetting(key: string, value: string): Promise<void> {
    await this.#writeSetting(key, value)
  }
}
