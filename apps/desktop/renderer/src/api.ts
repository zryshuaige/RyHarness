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

/** 长期记忆行。 */
export interface MemoryRow {
  id: string
  agentId: string
  kind: 'profile' | 'fact' | 'preference' | 'event'
  content: string
  createdAt: number
  updatedAt: number
  accessCount: number
  sourceConversationId?: string
}

/** 经验手册条目。 */
export interface PlaybookEntryRow {
  id: string
  agentId: string
  section: 'strategy' | 'pitfall' | 'preference' | 'tooling'
  content: string
  helpful: number
  harmful: number
  status: 'active' | 'deprecated'
  createdAt: number
  updatedAt: number
  source: 'curator' | 'reflection' | 'seed' | 'manual'
}

/** 待验证的反思教训。 */
export interface ReflectionRow {
  id: string
  agentId: string
  lesson: string
  hitCount: number
  createdAt: number
}

/** WS 事件（apps/server README 契约）；服务端为每个事件附每会话单调递增 seq。 */
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

/** 服务端实际下发的事件：带每会话单调递增 seq（客户端用于缺口检测）。 */
export type StampedWsEvent = WsEvent & { seq?: number }

/** WS 连接状态（断线重连提示用）。 */
export type WsConnectionStatus = 'open' | 'reconnecting'

export interface SubscribeOptions {
  /** 连接状态变化（断线 → reconnecting，恢复 → open）。 */
  onStatus?: (status: WsConnectionStatus) => void
  /** 检测到事件 seq 缺口或断线重连成功：调用方应重拉历史补齐。 */
  onGap?: () => void
  /** 重连退避序列（ms），超过末尾值后循环使用末值；默认 1s/2s/5s/10s 封顶。 */
  reconnectDelays?: number[]
}

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

  messages(conversationId: string, opts: { limit?: number; before?: number } = {}): Promise<{ messages: MessageRow[] }> {
    const params = new URLSearchParams()
    params.set('limit', String(opts.limit ?? 50))
    if (opts.before !== undefined) params.set('before', String(opts.before))
    return this.request(`/api/conversations/${conversationId}/messages?${params.toString()}`)
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

  /** 某 agent 的记忆（私有空间 + 共享画像）。 */
  listAgentMemories(agentId: string): Promise<{ agent: MemoryRow[]; shared: MemoryRow[] }> {
    return this.request(`/api/agents/${agentId}/memories`)
  }

  /** 软删一条记忆。 */
  deleteMemory(id: string): Promise<{ deleted: string }> {
    return this.request(`/api/memories/${id}`, { method: 'DELETE' })
  }

  /** 用户反馈：👎 即时反思；👍 归因 helpful。 */
  sendFeedback(input: {
    conversationId: string
    agentId: string
    signal: 'thumb_up' | 'thumb_down'
    userText?: string
    assistantText?: string
  }): Promise<{ recorded: boolean }> {
    return this.request('/api/feedback', { method: 'POST', body: JSON.stringify(input) })
  }

  /** 某 agent 的经验手册。 */
  getPlaybook(agentId: string): Promise<{ entries: PlaybookEntryRow[]; reflections: ReflectionRow[] }> {
    return this.request(`/api/agents/${agentId}/playbook`)
  }

  /** 手动 deprecate / 恢复手册条目。 */
  setPlaybookStatus(id: string, status: 'active' | 'deprecated'): Promise<{ id: string; status: string }> {
    return this.request(`/api/playbook/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) })
  }

  fileUrl(name: string): string {
    return `${this.base}/api/files/${encodeURIComponent(name)}`
  }

  /**
   * 订阅会话事件；返回退订函数。
   * 断线自动指数退避重连（默认 1s/2s/5s/10s 封顶）；事件 seq 出现缺口或
   * 重连成功时回调 onGap（调用方重拉历史补齐，断线期间的事件服务器不重放）。
   */
  subscribe(conversationId: string, onEvent: (event: StampedWsEvent) => void, opts: SubscribeOptions = {}): () => void {
    const delays = opts.reconnectDelays ?? [1000, 2000, 5000, 10000]
    const url = `${this.base.replace('http', 'ws')}/ws?conversationId=${conversationId}`
    let closed = false
    let attempts = 0
    let lastSeq: number | undefined
    let reconnecting = false
    let socket: WebSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const setReconnecting = (value: boolean): void => {
      if (reconnecting === value) return
      reconnecting = value
      opts.onStatus?.(value ? 'reconnecting' : 'open')
    }

    const connect = (): void => {
      if (closed) return
      const ws = new WebSocket(url)
      socket = ws
      ws.onmessage = (message) => {
        const event = JSON.parse(String(message.data)) as StampedWsEvent
        if (typeof event.seq === 'number') {
          if (lastSeq !== undefined && event.seq > lastSeq + 1) opts.onGap?.()
          lastSeq = event.seq
        }
        onEvent(event)
      }
      ws.onopen = () => {
        // 重连成功：断开期间的事件已丢失，要求调用方补齐。
        if (attempts > 0) opts.onGap?.()
        attempts = 0
        setReconnecting(false)
      }
      ws.onclose = () => {
        if (closed) return
        setReconnecting(true)
        const delay = delays[Math.min(attempts, delays.length - 1)] ?? 10000
        attempts += 1
        timer = setTimeout(connect, delay)
      }
      ws.onerror = () => { ws.close() }
    }
    connect()

    return () => {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      socket?.close()
    }
  }
}

/** 从消息行提取展示文本。 */
export function messageText(row: MessageRow): string {
  return row.contentBlocks
    .filter((block) => { return block.type === 'text' && typeof block.text === 'string' })
    .map((block) => { return block.text ?? '' })
    .join('\n')
}
