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
  /**
   * 以下几项在服务端补齐前是可选的（apps/server 的 GET /api/providers 只回
   * 上面四个字段），渲染层按「有才展示」处理，不猜协议、不猜归属。
   */
  /** 用户手动添加的供应商（可删除）；缺省视为内置。 */
  custom?: boolean
  /** 接入协议（openai / anthropic / ollama …），徽标展示用。 */
  protocol?: string
  baseUrl?: string
  /** 正在使用它的 agent：删除前要先把它们改绑（缺省 = 没人用）。 */
  usedBy?: { agentId: string; agentName: string }[]
}

/** 测连接的结果（POST /api/providers/:id/verify）。 */
export interface ProviderVerifyResult {
  ok: boolean
  /** ok=false 时的原因；服务端给什么就显示什么（渲染层另有中文归类）。 */
  message: string
  latencyMs: number
}

/** DELETE /api/settings/api-key/:id 的响应体（见 ApiClient.deleteApiKey）。 */
export interface DeletedApiKeyResult {
  providerId: string
  configured: boolean
}

/** 全文搜索命中的一行（GET /api/search）。 */
export interface SearchResultRow {
  conversationId: string
  conversationTitle: string
  messageId: string
  /** 命中片段（服务端已按关键词截断）。 */
  snippet: string
  agentId: string
  createdAt: number
}

/** 会话可改的元信息（PATCH /api/conversations/:id）。 */
export interface ConversationPatch {
  title?: string
  pinned?: boolean
  muted?: boolean
}

/** 供应商预设（/api/provider-presets）：添加供应商向导的可选项。 */
export interface ProviderPreset {
  id: string
  displayName: string
  protocol: string
  baseUrl: string
  models: string[]
  docsUrl?: string
}

/** 新增自定义供应商（POST /api/providers）。 */
export interface CreateProviderInput {
  displayName: string
  protocol: string
  baseUrl: string
  models: string[]
  apiKey?: string
  presetId?: string
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
  /** 置顶：会话列表里排在最前；缺省 = 没置顶。 */
  pinned?: boolean
  /** 静音：不弹未读；缺省 = 没静音。 */
  muted?: boolean
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

/** 单轮（或单条发言）的 token 用量，供应商回报后由服务端原样落库/下发。 */
export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** 会话级累计用量（服务端对各条消息求和）。 */
export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** 计入用量的消息条数。 */
  messages: number
}

/** 记忆系统统计（/api/memory/stats）。 */
export interface MemoryStats {
  enabled: boolean
  embeddings?: { label: string }
  /** 近 24 小时新增的 active 记忆数。 */
  recentLearned: number
  /** 巩固调度：intervalMs = 0 表示没开；lastRunAt 缺省表示本次运行还没巩固过。 */
  consolidation: { intervalMs: number; lastRunAt?: number }
  total?: number
  bySpace?: Record<string, number>
  byKind?: Record<string, number>
  byStatus?: Record<string, number>
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
  | {
      type: 'tool-call-start'
      conversationId: string
      senderId: string
      callId: string
      name: string
      arguments: string
    }
  | {
      type: 'tool-result'
      conversationId: string
      senderId: string
      callId: string
      name: string
      isError: boolean
      content: string
    }
  | {
      type: 'produce-card'
      conversationId: string
      senderId: string
      callId: string
      card: { path: string; name: string; size: number; mime: string }
    }
  | { type: 'dispatch'; conversationId: string; fromAgent?: string; toAgent: string; reason: string; turnIndex: number }
  | {
      type: 'message-done'
      conversationId: string
      senderId: string
      turnIndex: number
      /** 本轮累计 token 用量；供应商未回报时缺省。 */
      usage?: TurnUsage
    }
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
  /**
   * 缺口检测基线：握手前已确认收到的最后一个事件 seq。缺省时退化为
   * 「本次发送消息的回执 seq」（见 postMessage），再缺省才是完全失明——
   * 那正是欢迎页首条消息丢在订阅建立之前的形态。
   */
  fromSeq?: number
}

// ---- 客户端 ----

/** 浏览器直连开发时的默认后端地址（生产由主进程经 ?api= 或启动事件注入）。 */
export const DEFAULT_API_BASE = 'http://127.0.0.1:32100'

/** 从窗口 URL 读主进程注入的 API 地址（?api=…）；没有则返回 undefined。 */
export function readApiBaseFromLocation(): string | undefined {
  const fromQuery = new URLSearchParams(window.location.search).get('api')
  return fromQuery !== null && fromQuery.length > 0 ? fromQuery : undefined
}

/** 解析 API 地址：query 优先，否则回退本机默认端口（同步场景用）。 */
export function resolveApiBase(): string {
  return readApiBaseFromLocation() ?? DEFAULT_API_BASE
}

export class ApiClient {
  constructor(readonly base: string) {}

  /**
   * 已发出消息的会话基线：POST 回执里的 streamSeq（见 postMessage）。
   * 只被下一次 subscribe 取用一次就丢弃，避免过期基线在下次进会话时误报缺口。
   */
  private readonly pendingBaselines = new Map<string, number>()

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    })
    const body = (await response.json().catch(() => {
      return {}
    })) as T & { error?: string }
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

  deleteAgent(id: string): Promise<{ deleted: string }> {
    return this.request(`/api/agents/${id}`, { method: 'DELETE' })
  }

  deleteConversation(id: string): Promise<{ deleted: string }> {
    return this.request(`/api/conversations/${id}`, { method: 'DELETE' })
  }

  /** 中止该会话在途的一轮生成。 */
  cancelTurn(conversationId: string): Promise<{ cancelled: boolean }> {
    return this.request(`/api/conversations/${conversationId}/cancel`, { method: 'POST' })
  }

  /** 应用内保存 API key（后端写 0600 文件，不回显明文）。 */
  setApiKey(providerId: string, apiKey: string): Promise<{ providerId: string; configured: boolean }> {
    return this.request('/api/settings/api-key', {
      method: 'POST',
      body: JSON.stringify({ providerId, apiKey }),
    })
  }

  /**
   * 移除已存的凭据（换 Key 前先清除、或彻底不用这家了）。
   *
   * 响应体只有两个字段：`{ providerId, configured: false }`——服务端没有别处那些
   * `{ deleted }` 回执，「已经删掉」这件事就是 configured 翻回 false，调用方据此
   * 重拉供应商清单。
   */
  deleteApiKey(providerId: string): Promise<DeletedApiKeyResult> {
    return this.request(`/api/settings/api-key/${encodeURIComponent(providerId)}`, { method: 'DELETE' })
  }

  /** 测连接：真正打一次供应商，拿到是否通过与往返延迟。 */
  verifyProvider(providerId: string): Promise<ProviderVerifyResult> {
    return this.request(`/api/providers/${encodeURIComponent(providerId)}/verify`, { method: 'POST' })
  }

  templates(): Promise<{ templates: AgentTemplate[] }> {
    return this.request('/api/agent-templates')
  }

  providers(): Promise<{ providers: ProviderInfo[] }> {
    return this.request('/api/providers')
  }

  /**
   * 供应商预设（添加供应商向导的可选项）。
   * 服务端未实现该路由时回 404 + { error: 'not found: GET /api/provider-presets' }，
   * 调用方据此降级（向导只剩「自定义」一格）。
   */
  providerPresets(): Promise<{ presets: ProviderPreset[] }> {
    return this.request('/api/provider-presets')
  }

  /** 新增自定义供应商；服务端未实现时同 providerPresets 走 404 分支。 */
  createProvider(input: CreateProviderInput): Promise<{ provider: ProviderInfo }> {
    return this.request('/api/providers', { method: 'POST', body: JSON.stringify(input) })
  }

  /** 删除自定义供应商（内置供应商后端会拒绝）；未实现时 404。 */
  deleteProvider(id: string): Promise<{ deleted: string }> {
    return this.request(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  /** 改会话元信息（重命名 / 置顶 / 静音）。 */
  patchConversation(conversationId: string, patch: ConversationPatch): Promise<{ conversation: Conversation }> {
    return this.request(`/api/conversations/${conversationId}`, { method: 'PATCH', body: JSON.stringify(patch) })
  }

  /** 全文搜索：搜会话名之外还搜消息正文，命中按会话分组回。 */
  searchMessages(params: { q: string; conversationId?: string }): Promise<{ results: SearchResultRow[] }> {
    const query = new URLSearchParams()
    query.set('q', params.q)
    if (params.conversationId !== undefined) query.set('conversationId', params.conversationId)
    return this.request(`/api/search?${query.toString()}`)
  }

  conversations(): Promise<{ conversations: Conversation[] }> {
    return this.request('/api/conversations')
  }

  /** 会话详情：会话元信息 + 该会话累计 token 用量。 */
  conversationDetail(conversationId: string): Promise<{ conversation: Conversation; usage: UsageTotals }> {
    return this.request(`/api/conversations/${conversationId}`)
  }

  /** 记忆系统统计（最近学到多少、巩固节奏）。 */
  memoryStats(): Promise<MemoryStats> {
    return this.request('/api/memory/stats')
  }

  /** 该会话当前的事件序号（握手前读一次当缺口检测基线）。 */
  streamSeq(conversationId: string): Promise<{ seq: number }> {
    return this.request(`/api/conversations/${conversationId}/stream-seq`)
  }

  createConversation(
    input:
      | { kind: 'direct'; agentId: string }
      | { kind: 'group'; memberAgentIds: string[]; dispatcherAgentId?: string; title?: string },
  ): Promise<{ conversation: Conversation }> {
    return this.request('/api/conversations', { method: 'POST', body: JSON.stringify(input) })
  }

  messages(
    conversationId: string,
    opts: { limit?: number; before?: number } = {},
  ): Promise<{ messages: MessageRow[] }> {
    const params = new URLSearchParams()
    params.set('limit', String(opts.limit ?? 50))
    if (opts.before !== undefined) params.set('before', String(opts.before))
    return this.request(`/api/conversations/${conversationId}/messages?${params.toString()}`)
  }

  /**
   * 发一条消息。202 回执里的 streamSeq 存成缺口检测基线：欢迎页是「先切会话、
   * 后建 WS 订阅」，而服务端在 202 之前就把这一轮的事件发出去了——没有这个
   * 基线，订阅建立之前丢掉的事件对客户端完全隐形。
   */
  postMessage(conversationId: string, text: string): Promise<{ accepted: boolean; streamSeq?: number }> {
    return this.request<{ accepted: boolean; streamSeq?: number }>(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }).then((body) => {
      if (typeof body.streamSeq === 'number') this.pendingBaselines.set(conversationId, body.streamSeq)
      return body
    })
  }

  /** 标记会话已读（未读徽标归零）。 */
  markRead(conversationId: string): Promise<{ conversationId: string; lastReadSeq: number }> {
    return this.request(`/api/conversations/${conversationId}/read`, { method: 'POST', body: '{}' })
  }

  /** 调度事件历史。 */
  listDispatchEvents(
    conversationId: string,
  ): Promise<{ events: { fromAgent?: string; toAgent: string; reason: string; turnIndex: number }[] }> {
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

  /** 已归档的记忆（全量返回，调用方按 agent 过滤）。 */
  listArchivedMemories(): Promise<{ items: MemoryRow[] }> {
    return this.request('/api/memory/archived')
  }

  /** 把一条归档记忆恢复到活跃列表。 */
  restoreMemory(id: string): Promise<{ restored: string }> {
    return this.request('/api/memory/restore', { method: 'POST', body: JSON.stringify({ id }) })
  }

  /** 重建向量索引：embedding 模型变更后为存量记忆回填向量。 */
  reembedMemories(): Promise<{ reembedded: number }> {
    return this.request('/api/memory/reembed', { method: 'POST' })
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

  /** 工作区目录（agent 读写文件的默认位置；由服务端解析，渲染层不猜路径）。 */
  workspace(): Promise<{ path: string }> {
    return this.request('/api/workspace')
  }

  /**
   * 订阅会话事件；返回退订函数。
   * 断线自动指数退避重连（默认 1s/2s/5s/10s 封顶）；事件 seq 出现缺口或
   * 重连成功时回调 onGap（调用方重拉历史补齐，断线期间的事件服务器不重放）。
   * 缺口检测的基线见 SubscribeOptions.fromSeq。
   */
  subscribe(conversationId: string, onEvent: (event: StampedWsEvent) => void, opts: SubscribeOptions = {}): () => void {
    const delays = opts.reconnectDelays ?? [1000, 2000, 5000, 10000]
    const url = `${this.base.replace('http', 'ws')}/ws?conversationId=${conversationId}`
    let closed = false
    let attempts = 0
    // 基线：显式传入 > 本次发送的回执 seq > 未知（首条事件之前查不出缺口）。
    const baseline = opts.fromSeq ?? this.pendingBaselines.get(conversationId)
    this.pendingBaselines.delete(conversationId)
    let lastSeq: number | undefined = baseline
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
      ws.onerror = () => {
        ws.close()
      }
    }
    connect()

    return () => {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      socket?.close()
    }
  }

  /** 运行时计量快照：轮次耗时（首 token 延迟 / 总耗时 / 记忆召回计量）与请求计时。 */
  telemetry(limit?: number): Promise<TelemetrySnapshot> {
    const query = limit === undefined ? '' : `?limit=${Math.trunc(limit)}`
    return this.request(`/api/telemetry${query}`)
  }

  /**
   * playbook 条目的来源证据链（这条经验从哪次对话 / 哪条教训 / 哪次反馈来）。
   * 服务端未注册该路由时回 404 + { error: 'not found: ...' }，调用方据此降级。
   */
  explainPlaybookEntry(id: string): Promise<EntryExplanation> {
    return this.request(`/api/evolve/entries/${encodeURIComponent(id)}/explain`)
  }

  /**
   * 会话消息里的 usage 行（每条 assistant 消息挂一次模型调用的 token 用量）。
   * 按供应商归因只能从这里拿——服务端把 usage 挂在消息行上，会话级汇总并不保留
   * "哪个 agent 花的"这一维。limit 省略时按服务端单页上限取。
   */
  listUsageRows(conversationId: string, limit: number = USAGE_PAGE_LIMIT): Promise<{ messages: MessageUsageRow[] }> {
    return this.request(`/api/conversations/${conversationId}/messages?limit=${Math.trunc(limit)}`)
  }
}

/** 用量账单单会话拉取的消息条数上限（与服务端 MAX_MESSAGE_PAGE 对齐）。 */
const USAGE_PAGE_LIMIT = 200

// ---- 记忆健康度 / 用量账单 / 经验溯源：这三块面板要读的服务端形状 ----

/** 一轮 turn 的耗时画像（GET /api/telemetry 的 turns 元素）。 */
export interface TurnTiming {
  conversationId: string
  kind: 'direct' | 'group'
  turnIndex: number
  /** 首 token 延迟；全程无文本时缺省。 */
  firstTokenMs?: number
  totalMs: number
  /** 本轮记忆召回累计耗时（毫秒）。 */
  memoryRecallMs: number
  /** 注入本轮的记忆条数。 */
  memoryItems: number
  status: 'ok' | 'error' | 'aborted'
  finishedAt: number
}

/** GET /api/telemetry 的返回体。 */
export interface TelemetrySnapshot {
  /** 最近的轮次，按结束时间倒序。 */
  turns: TurnTiming[]
  /** 最近的请求，按完成时间倒序。 */
  requests: { method: string; path: string; status: number; durationMs: number; at: number }[]
  /** 环形缓冲容量（两类各一份）。 */
  capacity: number
}

/** 带 usage 的消息行：服务端在消息行上带 usage，MessageRow 未声明这一维。 */
export interface MessageUsageRow extends MessageRow {
  usage?: TurnUsage
}

/** 一条溯源记录：这条经验是从哪儿来的。 */
export interface EntryOriginRow {
  kind: 'trajectory' | 'reflection' | 'feedback' | 'memory' | 'seed'
  /** 溯源对象 id：会话 id / 教训 id / 反馈事件 id / 记忆 id / 模板 key。 */
  refId: string
  /** 一句话说明（UI 直接显示；服务端缺失时留空）。 */
  detail?: string
  createdAt?: number
}

/** playbook 条目的证据链（GET /api/evolve/entries/:id/explain）。 */
export interface EntryExplanation {
  entry: PlaybookEntryRow
  origins: EntryOriginRow[]
  /** 服务端生成的一句话来源摘要（中文）。 */
  summary: string
}

/** 从消息行提取展示文本。 */
export function messageText(row: MessageRow): string {
  return row.contentBlocks
    .filter((block) => {
      return block.type === 'text' && typeof block.text === 'string'
    })
    .map((block) => {
      return block.text ?? ''
    })
    .join('\n')
}
