/**
 * Kimi Hosted Agents REST 客户端。
 *
 * 只覆盖本客户端真正用到的那几条路径：agents / environments / sessions / events /
 * artifacts / filesystem。所有请求都带版本头（beta 契约的唯一出口），错误统一成
 * {@link HostedApiError}——调用方按 `type` 分支，不去解析英文消息。
 * @module @ryharness/server/hosted/client
 */

import { HOSTED_API_VERSION } from './config.ts'
import { parseSse, type SseFrame } from './sse.ts'
import type {
  HostedArtifact,
  HostedEnvironment,
  HostedEventPage,
  HostedRemoteAgent,
  HostedRemoteSession,
  KhaEvent,
} from './types.ts'

/** 远端返回的错误。`type` 是机器可读的分类（`conflict_error` 等）。 */
export class HostedApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
  ) {
    super(message)
    this.name = 'HostedApiError'
  }
}

/** 客户端依赖。`fetchImpl` 让测试注入假实现，不触网。 */
export interface HostedClientOptions {
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
  /** 普通请求的超时；流式订阅不设（长任务可能跑很久）。 */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000

/** 发出去的用户事件。 */
export type HostedUserEvent =
  | { type: 'user.message'; data: { content: { type: 'text'; text: string }[] } }
  | { type: 'user.interrupt' }
  | { type: 'user.tool_confirmation'; data: { event_id: string; result: 'allow' | 'deny'; deny_message?: string } }
  | {
      type: 'user.custom_tool_result'
      data: { event_id: string; content: { type: 'text'; text: string }[]; is_error?: boolean }
    }

/** 一层薄薄的 REST 封装。 */
export class HostedClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: HostedClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** 底层请求：解析错误体、非 2xx 抛 {@link HostedApiError}。 */
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${this.apiKey}`)
    headers.set('kimi-api-version', HOSTED_API_VERSION)
    if (init.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = init.signal === undefined || init.signal === null ? timeout : AbortSignal.any([init.signal, timeout])
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal })
    if (response.ok) return response
    throw await toApiError(response)
  }

  /** 读 JSON；空体返回 undefined。 */
  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init)
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  // ---- agents ----

  /** 远端正版清单（官方只读 + 自建）。 */
  async listAgents(): Promise<HostedRemoteAgent[]> {
    const body = await this.json<{ items?: unknown[] }>('/v1/agents?page_size=100')
    return (body.items ?? []).map(toRemoteAgent).filter((agent): agent is HostedRemoteAgent => agent !== undefined)
  }

  /** 读一个 agent 的完整配置（雇佣前确认存在与版本）。 */
  async getAgent(id: string): Promise<HostedRemoteAgent> {
    const body = await this.json<Record<string, unknown>>(`/v1/agents/${encodeURIComponent(id)}`)
    const agent = toRemoteAgent(body)
    if (agent === undefined) throw new HostedApiError(500, 'invalid_response', '远端返回的 agent 形状不认识')
    return agent
  }

  /** 创建一个自建 agent；返回它的 id 与首个版本。 */
  async createAgent(body: Record<string, unknown>): Promise<HostedRemoteAgent> {
    const raw = await this.json<Record<string, unknown>>('/v1/agents', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    const agent = toRemoteAgent(raw)
    if (agent === undefined) throw new HostedApiError(500, 'invalid_response', '远端返回的 agent 形状不认识')
    return agent
  }

  /** 更新 agent（生成新的不可变版本）。 */
  async updateAgent(id: string, body: Record<string, unknown>): Promise<HostedRemoteAgent> {
    const raw = await this.json<Record<string, unknown>>(`/v1/agents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
    const agent = toRemoteAgent(raw)
    if (agent === undefined) throw new HostedApiError(500, 'invalid_response', '远端返回的 agent 形状不认识')
    return agent
  }

  /** 归档 agent（不可逆）。 */
  async archiveAgent(id: string): Promise<void> {
    await this.request(`/v1/agents/${encodeURIComponent(id)}/archive`, { method: 'POST' })
  }

  // ---- environments ----

  /** 列执行环境。 */
  async listEnvironments(): Promise<HostedEnvironment[]> {
    const body = await this.json<{ items?: unknown[] }>('/v1/environments?page_size=100')
    return (body.items ?? []).map(toEnvironment).filter((env): env is HostedEnvironment => env !== undefined)
  }

  /** 创建一个云环境（`config.type = 'cloud'`）。 */
  async createEnvironment(input: { name: string; description?: string }): Promise<HostedEnvironment> {
    const raw = await this.json<Record<string, unknown>>('/v1/environments', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
        config: { type: 'cloud' },
      }),
    })
    const env = toEnvironment(raw)
    if (env === undefined) throw new HostedApiError(500, 'invalid_response', '远端返回的环境形状不认识')
    return env
  }

  /** 读环境（等镜像构建完成用）。 */
  async getEnvironment(id: string): Promise<HostedEnvironment> {
    const raw = await this.json<Record<string, unknown>>(`/v1/environments/${encodeURIComponent(id)}`)
    const env = toEnvironment(raw)
    if (env === undefined) throw new HostedApiError(500, 'invalid_response', '远端返回的环境形状不认识')
    return env
  }

  // ---- sessions ----

  /** 建一个工位。 */
  async createSession(input: {
    agentId: string
    environmentId: string
    title?: string
    agentVersion?: string
  }): Promise<HostedRemoteSession> {
    const raw = await this.json<Record<string, unknown>>('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: input.agentId,
        environment_id: input.environmentId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.agentVersion === undefined ? {} : { agent_version: input.agentVersion }),
      }),
    })
    const session = toRemoteSession(raw)
    if (session === undefined) throw new HostedApiError(500, 'invalid_response', '远端返回的会话形状不认识')
    return session
  }

  /** 读会话状态。 */
  async getSession(id: string): Promise<HostedRemoteSession> {
    const raw = await this.json<Record<string, unknown>>(`/v1/sessions/${encodeURIComponent(id)}`)
    const session = toRemoteSession(raw)
    if (session === undefined) throw new HostedApiError(500, 'invalid_response', '远端返回的会话形状不认识')
    return session
  }

  /** 归档会话（先取消当前轮次）。 */
  async archiveSession(id: string): Promise<void> {
    await this.request(`/v1/sessions/${encodeURIComponent(id)}/archive`, { method: 'POST' })
  }

  // ---- events ----

  /** 历史事件（最旧在前）。 */
  async listEvents(
    sessionId: string,
    options: { pageSize?: number; pageToken?: string; order?: 'asc' | 'desc' } = {},
  ): Promise<HostedEventPage> {
    const query = new URLSearchParams()
    query.set('page_size', String(options.pageSize ?? 100))
    if (options.pageToken !== undefined) query.set('page_token', options.pageToken)
    if (options.order !== undefined) query.set('order', options.order)
    const raw = await this.json<Record<string, unknown>>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events?${query.toString()}`,
    )
    const items = Array.isArray(raw.items) ? raw.items.map(toKhaEvent).filter(isKhaEvent) : []
    return {
      items,
      ...(typeof raw.next_page_token === 'string' ? { nextPageToken: raw.next_page_token } : {}),
      ...(typeof raw.stream_cursor === 'string' ? { streamCursor: raw.stream_cursor } : {}),
    }
  }

  /**
   * 实时事件流。
   *
   * 生成器第一次 `next()` 才真正发请求——调用方要先把迭代器建起来、pull 一次
   * （服务端会立刻回一帧 `control`），再发 `user.message`，这样连接已经建好，
   * 不会漏掉早期事件。
   */
  async *streamEvents(
    sessionId: string,
    options: { cursor?: string; includeDeltas?: boolean; signal?: AbortSignal } = {},
  ): AsyncGenerator<SseFrame> {
    const query = new URLSearchParams()
    query.set('cursor', options.cursor ?? 'now')
    if (options.includeDeltas !== false) query.set('include_deltas', 'true')
    const response = await this.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events/stream?${query.toString()}`,
      {
        headers: { accept: 'text/event-stream' },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    )
    if (response.body === null) throw new HostedApiError(502, 'stream_unavailable', '事件流没有响应体')
    yield* parseSse(response.body)
  }

  /** 发用户事件（202）。 */
  async sendEvents(sessionId: string, events: HostedUserEvent[]): Promise<void> {
    await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST',
      body: JSON.stringify({ events }),
    })
  }

  // ---- artifacts / files ----

  /** 列某个会话交付的产物。 */
  async listArtifacts(sessionId: string): Promise<HostedArtifact[]> {
    const body = await this.json<{ items?: unknown[] }>(
      `/v1/artifacts?session_id=${encodeURIComponent(sessionId)}&page_size=100`,
    )
    return (body.items ?? []).map(toArtifact).filter((item): item is HostedArtifact => item !== undefined)
  }

  /** 下载产物内容。 */
  async downloadArtifact(id: string): Promise<Uint8Array> {
    const response = await this.request(`/v1/artifacts/${encodeURIComponent(id)}/content`)
    return new Uint8Array(await response.arrayBuffer())
  }

  /** 列会话文件系统的一层（不递归）。 */
  async listFiles(sessionId: string, prefix?: string): Promise<{ name: string; path: string; directory: boolean }[]> {
    const query = new URLSearchParams()
    if (prefix !== undefined) query.set('prefix', prefix)
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    const body = await this.json<{ items?: unknown[] }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/filesystem${suffix}`,
    )
    return (body.items ?? []).flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as Record<string, unknown>
      const path = typeof record.path === 'string' ? record.path : undefined
      if (path === undefined) return []
      return [
        {
          name: typeof record.name === 'string' ? record.name : path,
          path,
          directory: record.type === 'directory' || record.kind === 'directory' || record.is_directory === true,
        },
      ]
    })
  }

  /** 下载会话文件系统里的一个文件。 */
  async downloadFile(sessionId: string, path: string): Promise<Uint8Array> {
    const query = new URLSearchParams({ path })
    const response = await this.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/filesystem/raw?${query.toString()}`,
    )
    return new Uint8Array(await response.arrayBuffer())
  }
}

/** 把非 2xx 响应转成 {@link HostedApiError}。 */
async function toApiError(response: Response): Promise<HostedApiError> {
  let type = `http_${response.status}`
  let message = `Kimi Hosted API 返回 ${response.status}`
  try {
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null) {
      const error = (body as Record<string, unknown>).error
      if (typeof error === 'object' && error !== null) {
        const record = error as Record<string, unknown>
        if (typeof record.type === 'string') type = record.type
        if (typeof record.message === 'string') message = record.message
      } else if (typeof error === 'string') {
        message = error
      }
    }
  } catch {
    // 非 JSON 错误体：保留状态码与默认文案。
  }
  return new HostedApiError(response.status, type, message)
}

function toRemoteAgent(raw: unknown): HostedRemoteAgent | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.name !== 'string') return undefined
  const model = record.model
  return {
    id: record.id,
    name: record.name,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    scope: record.scope === 'official' ? 'official' : 'custom',
    ...(typeof record.version === 'string' ? { version: record.version } : {}),
    ...(typeof model === 'string'
      ? { model }
      : typeof model === 'object' && model !== null && typeof (model as Record<string, unknown>).id === 'string'
        ? { model: String((model as Record<string, unknown>).id) }
        : {}),
    ...(typeof record.updated_at === 'string' ? { updatedAt: record.updated_at } : {}),
  }
}

function toEnvironment(raw: unknown): HostedEnvironment | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string') return undefined
  const config = record.config
  return {
    id: record.id,
    name: typeof record.name === 'string' ? record.name : record.id,
    ...(typeof record.status === 'string' ? { status: record.status } : {}),
    ...(typeof config === 'object' && config !== null && typeof (config as Record<string, unknown>).type === 'string'
      ? { configType: String((config as Record<string, unknown>).type) }
      : {}),
  }
}

function toRemoteSession(raw: unknown): HostedRemoteSession | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string') return undefined
  const status = record.status === 'running' || record.status === 'terminated' ? record.status : 'idle'
  return {
    id: record.id,
    status,
    ...(typeof record.agent_id === 'string' ? { agentId: record.agent_id } : {}),
    ...(typeof record.environment_id === 'string' ? { environmentId: record.environment_id } : {}),
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    ...(typeof record.updated_at === 'string' ? { updatedAt: record.updated_at } : {}),
  }
}

function toArtifact(raw: unknown): HostedArtifact | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.name !== 'string') return undefined
  return {
    id: record.id,
    name: record.name,
    size: typeof record.size === 'number' ? record.size : 0,
    mime: typeof record.mime === 'string' ? record.mime : 'application/octet-stream',
  }
}

function toKhaEvent(raw: unknown): KhaEvent | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.type !== 'string') return undefined
  return {
    id: typeof record.id === 'string' ? record.id : '',
    type: record.type,
    ...(typeof record.processed_at === 'string' ? { processed_at: record.processed_at } : {}),
    ...(typeof record.session_thread_id === 'string' ? { session_thread_id: record.session_thread_id } : {}),
    ...(typeof record.data === 'object' && record.data !== null
      ? { data: record.data as Record<string, unknown> }
      : {}),
  }
}

function isKhaEvent(event: KhaEvent | undefined): event is KhaEvent {
  return event !== undefined
}
