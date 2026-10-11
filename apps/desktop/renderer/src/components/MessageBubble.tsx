import type { MessagePart, UiMessage } from '../store.ts'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 单个消息部件的渲染。 */
export function MessagePartView({ part, fileUrl }: { part: MessagePart; fileUrl: (name: string) => string }) {
  if (part.kind === 'text') {
    return <p className="bubble-text">{part.text}</p>
  }
  if (part.kind === 'tool') {
    return (
      <p className={`tool-row ${part.status === 'running' ? 'is-running' : ''} ${part.isError === true ? 'is-error' : ''}`}>
        <span className="tool-dot">{part.status === 'running' ? '⏳' : part.isError === true ? '⚠️' : '✓'}</span>
        {part.status === 'running' ? `正在使用工具：${part.name}…` : `工具 ${part.name} ${part.isError === true ? '失败' : '完成'}`}
      </p>
    )
  }
  return (
    <div className="file-card">
      <span className="file-icon">📄</span>
      <span className="file-meta">
        <strong>{part.name}</strong>
        <small>{formatSize(part.size)} · {part.mime}</small>
      </span>
      <a className="file-open" href={fileUrl(part.name)} target="_blank" rel="noreferrer">打开</a>
    </div>
  )
}

/** 聊天气泡：用户右侧琥珀色，agent/system 左侧白底。 */
export function MessageBubble({ message, fileUrl }: { message: UiMessage; fileUrl: (name: string) => string }) {
  const isUser = message.senderType === 'user'
  return (
    <div className={`bubble-row ${isUser ? 'from-user' : 'from-agent'}`} data-sender={message.senderId}>
      <div className="bubble">
        {!isUser && <div className="bubble-name">{message.senderName}</div>}
        {message.parts.map((part, index) => (
          <MessagePartView key={`${part.kind}-${index}`} part={part} fileUrl={fileUrl} />
        ))}
        {message.senderType === 'agent' && !message.done && <span className="bubble-cursor">▍</span>}
      </div>
    </div>
  )
}

/** 群聊接力链：一条 dispatch 记录渲染为头像间流转提示。 */
export function RelayChain({
  relays,
  turnIndex,
  nameOf,
}: {
  relays: { fromAgent?: string; toAgent: string; reason: string; turnIndex: number }[]
  turnIndex: number
  nameOf: (id: string) => string
}) {
  const items = relays.filter((relay) => { return relay.turnIndex === turnIndex })
  if (items.length === 0) return null
  const label = (reason: string): string => {
    if (reason === 'user-mention') return '点名'
    if (reason === 'default-dispatcher') return '调度'
    if (reason === 'loop-guard') return '循环保护'
    if (reason === 'max-turns') return '达到轮次上限'
    if (reason.startsWith('relay @')) return '转交'
    return reason
  }
  return (
    <div className="relay-chain" aria-label="调度轨迹">
      {items.map((relay, index) => (
        <span key={index} className={`relay-item ${relay.reason === 'loop-guard' || relay.reason === 'max-turns' ? 'is-guard' : ''}`}>
          {relay.fromAgent !== undefined && <>{nameOf(relay.fromAgent)} → </>}
          @{nameOf(relay.toAgent)} · {label(relay.reason)}
        </span>
      ))}
    </div>
  )
}
