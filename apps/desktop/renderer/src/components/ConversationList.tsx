import type { AgentDef, Conversation } from '../api.ts'
import { AgentAvatar } from './Cat.tsx'
import { formatTime } from './ChatView.tsx'

/** 左栏会话列表。 */
export function ConversationList({
  conversations,
  agents,
  activeId,
  onSelect,
  onOpenContacts,
  onOpenSettings,
}: {
  conversations: Conversation[]
  agents: AgentDef[]
  activeId: string | undefined
  onSelect: (id: string) => void
  onOpenContacts: () => void
  onOpenSettings: () => void
}) {
  return (
    <aside className="conversation-list">
      <header className="list-header">
        <input className="search-box" placeholder="搜索（即将上线）" disabled />
        <div className="list-actions">
          <button title="通讯录" onClick={onOpenContacts}>👥</button>
          <button title="设置" onClick={onOpenSettings}>⚙️</button>
        </div>
      </header>
      <ul>
        {conversations.map((conversation) => {
          const other = conversation.kind === 'direct'
            ? agents.find((a) => { return a.id === conversation.memberAgentIds[0] })
            : undefined
          return (
            <li
              key={conversation.id}
              className={conversation.id === activeId ? 'is-active' : ''}
              onClick={() => { onSelect(conversation.id) }}
            >
              {other !== undefined
                ? <AgentAvatar agent={other} size={40} />
                : <span className="agent-avatar group-avatar" style={{ width: 40, height: 40 }}>👪</span>}
              <div className="list-item-body">
                <div className="list-item-top">
                  <strong>{conversation.title || (other?.name ?? '群聊')}</strong>
                  <time>{formatTime(conversation.updatedAt)}</time>
                </div>
                <div className="list-item-bottom">
                  <span className="preview">{conversation.lastMessagePreview ?? ''}</span>
                  {(conversation.unreadCount ?? 0) > 0 && (
                    <span className="unread-badge">{conversation.unreadCount}</span>
                  )}
                </div>
              </div>
            </li>
          )
        })}
        {conversations.length === 0 && <p className="list-empty">还没有会话，去通讯录找 agent 聊聊吧。</p>}
      </ul>
      <div className="list-footer" onClick={onOpenContacts}>+ 通讯录 / 新建 Agent / 建群</div>
    </aside>
  )
}
