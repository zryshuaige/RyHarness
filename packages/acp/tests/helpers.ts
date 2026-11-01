/**
 * 测试用的假 agent：回放一段固定事件。
 *
 * 它是一个**真的对端**：接一条传输，按 ACP 的方法名应答，把固定的事件一段段
 * 推过来。客户端那一侧看到的就是「另一个进程在跟我说话」。
 */
import { createMemoryTransportPair, JsonRpcPeer, type RpcTransport } from '@ryharness/api'

/** 假 agent 收到过哪些通知。 */
export interface FakeAgent {
  /** 客户端那一侧的传输。 */
  readonly transport: RpcTransport
  /** 收到过的通知方法名。 */
  readonly notifications: string[]
  /** 收到过的请求方法名。 */
  readonly requests: string[]
  /** 手工推一条会话更新（用来看客户端怎么处理不认识的事件）。 */
  push(params: unknown): void
}

/** 回放的事件序列。 */
export const REPLAY_EVENTS = [
  { kind: 'message_chunk', text: '我' },
  { kind: 'message_chunk', text: '在' },
  { kind: 'tool_call', callId: 'c1', title: '读文件', status: 'in_progress', toolKind: 'read' },
  { kind: 'tool_result', callId: 'c1', status: 'completed', content: '文件内容' },
  { kind: 'message_chunk', text: '。' },
  { kind: 'completed', stopReason: 'end_turn' },
] as const

/**
 * 起一个假 agent。
 * @param sessionId - 它给的会话 id。
 * @returns 假 agent 与客户端那一侧的传输。
 */
export function createFakeAgent(sessionId = 'sess-1'): FakeAgent {
  const [clientSide, agentSide] = createMemoryTransportPair()
  const notifications: string[] = []
  const requests: string[] = []
  const peer = new JsonRpcPeer(agentSide, {
    onRequest: (request) => {
      requests.push(request.method)
      switch (request.method) {
        case 'initialize':
          return { protocolVersion: 1, agentCapabilities: { streaming: true, tools: true } }
        case 'session/new':
          return { sessionId }
        case 'session/prompt': {
          const params = request.params as { sessionId: string }
          REPLAY_EVENTS.forEach((event, index) => {
            peer.notify('session/update', { version: 1, sessionId: params.sessionId, seq: index + 1, ...event })
          })
          return { stopReason: 'end_turn' }
        }
        case 'session/close':
          return { ok: true }
        default:
          throw new Error(`假 agent 不认识这个方法：${request.method}`)
      }
    },
    onNotification: (notification) => {
      notifications.push(notification.method)
    },
  })
  return {
    transport: clientSide,
    notifications,
    requests,
    push: (params: unknown): void => {
      peer.notify('session/update', params)
    },
  }
}
