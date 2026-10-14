import { memo, useState } from 'react'
import type { AgentDef } from '../api.ts'
import { isGuardRelay, relayChainLabel } from '../lib/relay-labels.ts'
import { toast } from '../lib/toast.ts'
import { formatSize, type MessagePart, type UiMessage } from '../store.ts'
// 代码块容器与段落换行（styles.css 不长 pre/code 规则，这里是内容渲染的扩展层）。
import '../styles-content.css'
import { Avatar } from './avatars/Avatar.tsx'
import { Icon } from './Icon.tsx'
import { Markdown } from './Markdown.tsx'

/** 历史消息 key 的前缀（ChatView 拼的），与 {@link serverMessageId} 同约定。 */
const HIST_KEY_PREFIX = 'hist:'

/** 单个消息部件的渲染。markdown=true 时文本按 Markdown 渲染（agent 消息全程）。 */
export function MessagePartView({
  part,
  fileUrl,
  markdown = false,
  streaming = false,
}: {
  part: MessagePart
  fileUrl: (name: string) => string
  markdown?: boolean
  /** 还在流式：未闭合的尾块降级为纯文本，避免随 token 长出结构。 */
  streaming?: boolean
}) {
  if (part.kind === 'text') {
    // 流式期也走 Markdown：等 done 才切会让整条气泡在结束瞬间重排（单换行塌成空格）。
    if (markdown)
      return (
        <div className="bubble-text bubble-md">
          <Markdown text={part.text} streaming={streaming} />
        </div>
      )
    return <p className="bubble-text">{part.text}</p>
  }
  if (part.kind === 'tool') {
    return (
      <p
        className={`tool-row ${part.status === 'running' ? 'is-running' : ''} ${part.isError === true ? 'is-error' : ''}`}
      >
        <span className={`tool-dot ${part.status === 'running' ? 'is-running' : ''}`}>
          {part.status === 'running' ? '' : <Icon name={part.isError === true ? 'alert' : 'check'} size={13} />}
        </span>
        {part.status === 'running'
          ? `正在使用工具：${part.name}…`
          : `工具 ${part.name} ${part.isError === true ? '失败' : '完成'}`}
      </p>
    )
  }
  return (
    <div className="file-card">
      <span className="file-icon">
        <Icon name="file" size={22} />
      </span>
      <span className="file-meta">
        <strong>{part.name}</strong>
        <small>
          {formatSize(part.size)} · {part.mime}
        </small>
      </span>
      <a className="file-open" href={fileUrl(part.name)} target="_blank" rel="noreferrer">
        打开
      </a>
    </div>
  )
}

function messagePlainText(message: UiMessage): string {
  return message.parts
    .filter((part) => {
      return part.kind === 'text'
    })
    .map((part) => {
      return part.kind === 'text' ? part.text : ''
    })
    .join('\n')
}

/**
 * 搜索命中定位用的服务端消息 id。
 *
 * 历史消息的 React key 由 ChatView 拼成 `hist:<服务端 id>`，而 /api/search 回的是
 * 裸 id——不摘掉这个前缀，「滚到那条消息」的选择器永远选不中气泡。流式与本地
 * 用户消息没有服务端 id（也不会被搜索命中），保留原 key 不动。
 */
function serverMessageId(key: string): string {
  return key.startsWith(HIST_KEY_PREFIX) ? key.slice(HIST_KEY_PREFIX.length) : key
}

/** 聊天气泡：用户居右（琥珀渐变、右下直角），agent 居左（白底、左下直角）；
 *  带头像列、hover 浮现复制操作、流式光标。 */
function MessageBubbleInner({
  message,
  fileUrl,
  agent,
  tight = false,
  firstOfGroup = true,
  animated = false,
  onFeedback,
}: {
  message: UiMessage
  fileUrl: (name: string) => string
  /** 对应 agent（拿头像）；用户消息为 undefined。 */
  agent?: AgentDef
  /** 与同 sender 上一条相邻（收紧间距）。 */
  tight?: boolean
  /** 同 sender 组首条（显示头像与名字）。 */
  firstOfGroup?: boolean
  /** 播进场动画：只给本次会话新到的消息，历史消息整屏淡入像掉帧。 */
  animated?: boolean
  /** 👍/👎 反馈（仅 agent 消息）。 */
  onFeedback?: (message: UiMessage, signal: 'thumb_up' | 'thumb_down') => void
}) {
  const [copied, setCopied] = useState(false)
  const [feedback, setFeedback] = useState<'thumb_up' | 'thumb_down' | undefined>(undefined)
  const isUser = message.senderType === 'user'

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(messagePlainText(message))
      setCopied(true)
      setTimeout(() => {
        setCopied(false)
      }, 1200)
    } catch (error) {
      // 剪贴板不可用（未授权 / 非安全上下文）时按钮毫无变化，等于没点过。
      toast.error(`复制失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const rowClass = [
    'bubble-row',
    isUser ? 'from-user' : 'from-agent',
    tight ? 'tight' : '',
    firstOfGroup ? 'first-of-group' : '',
    animated ? 'is-new' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rowClass} data-sender={message.senderId} data-message-id={serverMessageId(message.key)}>
      {!isUser && (
        <span style={{ width: 40, flexShrink: 0, paddingTop: 2 }}>
          {firstOfGroup && agent !== undefined ? (
            <Avatar avatarKey={agent.avatar} name={agent.name} seed={agent.id} size={40} />
          ) : null}
        </span>
      )}
      <div className="bubble">
        {!isUser && firstOfGroup && <div className="bubble-name">{message.senderName}</div>}
        <div className="bubble-bubble">
          {message.parts.map((part, index) => (
            <MessagePartView
              key={`${part.kind}-${index}`}
              part={part}
              fileUrl={fileUrl}
              markdown={message.senderType === 'agent'}
              streaming={!message.done}
            />
          ))}
          {message.senderType === 'agent' && !message.done && <span className="bubble-cursor">▍</span>}
        </div>
        <span className="bubble-actions">
          <button
            type="button"
            className="bubble-action"
            title="复制"
            aria-label={copied ? '已复制' : '复制这条消息'}
            onClick={() => {
              void copy()
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} size={14} />
          </button>
          {!isUser && onFeedback !== undefined && message.done && (
            <>
              <button
                type="button"
                className={`bubble-action ${feedback === 'thumb_up' ? 'is-active' : ''}`}
                title="有帮助"
                aria-label="有帮助"
                onClick={() => {
                  setFeedback('thumb_up')
                  onFeedback(message, 'thumb_up')
                }}
              >
                <Icon name="thumbs-up" size={14} />
              </button>
              <button
                type="button"
                className={`bubble-action ${feedback === 'thumb_down' ? 'is-active-neg' : ''}`}
                title="有问题（触发反思）"
                aria-label="有问题（会触发它反思）"
                onClick={() => {
                  setFeedback('thumb_down')
                  onFeedback(message, 'thumb_down')
                }}
              >
                <Icon name="thumbs-down" size={14} />
              </button>
            </>
          )}
        </span>
      </div>
    </div>
  )
}

/**
 * memo 包装（O(1)）：store 定点更新 + 结构共享保证「没变的消息对象就是同一引用」，
 * 所以这里只比 key/senderId/done/version 与几个 props——绝不序列化 parts。
 * version 由 store 在 parts/done 变化时自增，历史消息无此字段按 0 处理。
 */
export const MessageBubble = memo(MessageBubbleInner, (prev, next) => {
  if (prev.tight !== next.tight) return false
  if (prev.firstOfGroup !== next.firstOfGroup) return false
  if (prev.animated !== next.animated) return false
  if (prev.onFeedback !== next.onFeedback || prev.fileUrl !== next.fileUrl) return false
  if (prev.agent !== next.agent) return false
  const a = prev.message
  const b = next.message
  if (a === b) return true
  return a.key === b.key && a.senderId === b.senderId && a.done === b.done && (a.version ?? 0) === (b.version ?? 0)
})

/** 群聊接力链：头像 A → 箭头 → 头像 B 的流转提示，错峰滑入。 */
function RelayChainInner({
  relays,
  turnIndex,
  nameOf,
  avatarOf,
}: {
  relays: { fromAgent?: string; toAgent: string; reason: string; turnIndex: number }[]
  turnIndex: number
  nameOf: (id: string) => string
  avatarOf: (id: string) => { avatarKey?: string; name: string }
}) {
  const items = relays.filter((relay) => {
    return relay.turnIndex === turnIndex
  })
  if (items.length === 0) return null
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: 纯展示容器，aria-label 供读屏器命名
    <div className="relay-chain" aria-label="调度轨迹">
      {items.map((relay, index) => (
        <span
          key={`${relay.reason}-${index}`}
          className={`relay-flow ${isGuardRelay(relay.reason) ? 'is-guard' : ''}`}
          style={{ animationDelay: `${index * 90}ms` }}
        >
          {relay.fromAgent !== undefined && (
            <>
              <span className="relay-avatar">
                <Avatar
                  avatarKey={avatarOf(relay.fromAgent).avatarKey}
                  name={nameOf(relay.fromAgent)}
                  seed={relay.fromAgent}
                  size={20}
                />
              </span>
              <span className="relay-arrow" aria-hidden="true">
                <Icon name="chevron-right" size={11} />
              </span>
            </>
          )}
          <span className="relay-avatar">
            <Avatar
              avatarKey={avatarOf(relay.toAgent).avatarKey}
              name={nameOf(relay.toAgent)}
              seed={relay.toAgent}
              size={20}
            />
          </span>
          <span className="relay-label">{relayChainLabel(relay.reason)}</span>
        </span>
      ))}
    </div>
  )
}

/**
 * memo：props 全是稳定引用（relays 数组只在调度事件时换新、nameOf/avatarOf 已 useCallback），
 * 聊天流式期间没有理由每个 token 都重跑一遍 filter。
 */
export const RelayChain = memo(RelayChainInner)
