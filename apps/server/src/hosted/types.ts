/**
 * Kimi Hosted Agents 的线上形状（只声明本客户端真正消费的字段）。
 *
 * 远端契约还是 beta，字段可能增删；所以事件负载一律按 `Record<string, unknown>`
 * 收，具体含义在 bridge.ts 里防御式读取——一个没见过的字段不该让整轮对话崩掉。
 * @module @ryharness/server/hosted/types
 */

/** 一帧 KHA 事件（SSE 的 `data:` 部分）。 */
export interface KhaEvent {
  id: string
  type: string
  processed_at?: string
  session_thread_id?: string
  data?: Record<string, unknown>
}

/** 远端 agent 的摘要（雇佣对话框用；不展开完整配置）。 */
export interface HostedRemoteAgent {
  id: string
  name: string
  description?: string
  scope: 'official' | 'custom'
  version?: string
  model?: string
  updatedAt?: string
}

/** 远端执行环境。 */
export interface HostedEnvironment {
  id: string
  name: string
  /** `ready` 之前不能建会话。 */
  status?: string
  configType?: string
}

/** 远端会话（工位）。 */
export interface HostedRemoteSession {
  id: string
  status: 'idle' | 'running' | 'terminated'
  agentId?: string
  environmentId?: string
  title?: string
  updatedAt?: string
}

/** 远端产物。 */
export interface HostedArtifact {
  id: string
  name: string
  size: number
  mime: string
}

/** 远端事件的游标页。 */
export interface HostedEventPage {
  items: KhaEvent[]
  nextPageToken?: string
  streamCursor?: string
}
