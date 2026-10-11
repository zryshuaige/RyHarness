/**
 * 渲染层 API 客户端：REST + WS，契约对齐 apps/server/README。
 * API 地址从窗口 URL query（?api=...，主进程注入）读取。
 */

// ---- 服务端形状 ----

export interface AgentDef {
  id: string
  name: string
  avatar?: string
  systemPrompt: string
  provider: string
  model: string
  temperature?: number
  tools: string[]
  isBuiltin: boolean
}

export interface AgentTemplate {
  key: string
  name: string
  description: string
  suggestedSystemPrompt: string
  defaultTools: string[]
  defaultModel: string
  avatar?: string
}

export interface ProviderInfo {
  id: string
  displayName: string
  apiKeyConfigured: boolean
  models: { id: string; name?: string; contextWindow?: number }[]
}

export interface Conversation {
  id: string
  kind: 'direct' | 'group'
  title: string
  memberAgentIds: string[]
  dispatcherAgentId?: string
  lastReadSeq: number
  createdAt: number
  updatedAt: number
  lastMessagePreview?: string
  unreadCount?: number
}

export interface MessageRow {
  id: string
  seq: number
  conversationId: string
  senderType: 'user' | 'agent' | 'system'
  senderId?: string
  contentBlocks: { type: string; text?: string }[]
  mentions: string[]
  toolCallId?: string
  turnIndex: number
  createdAt: number
}

/** WS 事件（apps/server README 契约）。 */
export type WsEvent =
  | { type: 'message-start'; conversationId: string; senderId: string; senderName: string; turnIndex: number }
  | { type: 'text-delta'; conversationId: string; senderId: string; text: string }
  | { type: 'tool-call-start'; conversationId: string; senderId: string; callId: string; name: string; arguments: string }
  | { type: 'tool-result'; conversationId: string; senderId: string; callId: string; name: string; isError: boolean; content: string }
  | { type: 'produce-card'; conversationId: string; senderId: string; callId: string; card: { path: string; name: string; size: number; mime: string } }
  | { type: 'dispatch'; conversationId: string; fromAgent?: string; toAgent: string; reason: string; turnIndex: number }
  | { type: 'message-done'; conversationId: string; senderId: string; turnIndex: number }
  | { type: 'error'; conversationId: string; message: string; code: string }
  | { type: 'queued'; conversationId: string; senderId: 'user'; turnIndex: number }

// ---- 客户端 ----

/** 从窗口 URL 读 API 地址（Electron 主进程注入 ?api=）。 */
export function resolveApiBase(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('api')
  if (fromQuery !== null && fromQuery.length > 0) return fromQuery
  // 浏览器直连开发：回退到本机默认端口。
  return 'http://127.0.0.1:32100'
}

export class ApiClient {
  constructor(readonly base: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    })
    const body = await response.json().catch(() => { return {} }) as T & { error?: string }
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
    return body
  }

  listAgents(): Promise<{ agents: AgentDef[] }> {
    return this.request('/api/agents')
  }

  createAgent(input: Record<string, unknown>): Promise<{ agent: AgentDef }> {
    return this.request('/api/agents', { method: 'POST', body: JSON.stringify(input) })
  }

  patchAgent(id: string, patch: Record<string, unknown>): Promise<{ agent: AgentDef }> {
    return this.request(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
  }

  templates(): Promise<{ templates: AgentTemplate[] }> {
    return this.request('/api/agent-templates')
  }

  providers(): Promise<{ providers: ProviderInfo[] }> {
    return this.request('/api/providers')
  }

  conversations(): Promise<{ conversations: Conversation[] }> {
    return this.request('/api/conversations')
  }

  createConversation(input: { kind: 'direct'; agentId: string } | { kind: 'group'; memberAgentIds: string[]; dispatcherAgentId?: string; title?: string }): Promise<{ conversation: Conversation }> {
    return this.request('/api/conversations', { method: 'POST', body: JSON.stringify(input) })
  }

  messages(conversationId: string, limit = 50): Promise<{ messages: MessageRow[] }> {
    return this.request(`/api/conversations/${conversationId}/messages?limit=${limit}`)
  }

  postMessage(conversationId: string, text: string): Promise<{ accepted: boolean }> {
    return this.request(`/api/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ text }) })
  }

  /** 标记会话已读（未读徽标归零）。 */
  markRead(conversationId: string): Promise<{ conversationId: string; lastReadSeq: number }> {
    return this.request(`/api/conversations/${conversationId}/read`, { method: 'POST', body: '{}' })
  }

  /** 调度事件历史。 */
  listDispatchEvents(conversationId: string): Promise<{ events: { fromAgent?: string; toAgent: string; reason: string; turnIndex: number }[] }> {
    return this.request(`/api/conversations/${conversationId}/dispatch`)
  }

  fileUrl(name: string): string {
    return `${this.base}/api/files/${encodeURIComponent(name)}`
  }

  /** 订阅会话事件；返回退订函数。 */
  subscribe(conversationId: string, onEvent: (event: WsEvent) => void): () => void {
    const ws = new WebSocket(`${this.base.replace('http', 'ws')}/ws?conversationId=${conversationId}`)
    ws.onmessage = (message) => {
      onEvent(JSON.parse(String(message.data)) as WsEvent)
    }
    return () => { ws.close() }
  }
}

/** 从消息行提取展示文本。 */
export function messageText(row: MessageRow): string {
  return row.contentBlocks
    .filter((block) => { return block.type === 'text' && typeof block.text === 'string' })
    .map((block) => { return block.text ?? '' })
    .join('\n')
}
