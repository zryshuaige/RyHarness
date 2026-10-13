import { useState } from 'react'
import type { AgentDef, Conversation } from '../api.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { GroupAvatar } from './avatars/GroupAvatar.tsx'
import { formatTime } from './ChatView.tsx'
import { ConversationSkeleton } from './Skeleton.tsx'
import { Icon } from './Icon.tsx'

/** 左栏会话列表：48px 头像、未读徽标、预览、搜索过滤、骨架屏。 */
export function ConversationList({
  conversations,
  agents,
  activeId,
  loading,
  onSelect,
}: {
  conversations: Conversation[]
  agents: AgentDef[]
  activeId: string | undefined
  loading?: boolean
  onSelect: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const nameOf = (id: string): string => {
    return agents.find((a) => { return a.id === id })?.name ?? id
  }
  const trimmed = query.trim().toLowerCase()
  const filtered = trimmed.length === 0
    ? conversations
    : conversations.filter((conversation) => {
      return conversation.title.toLowerCase().includes(trimmed)
        || conversation.memberAgentIds.some((id) => { return nameOf(id).toLowerCase().includes(trimmed) })
    })

  const avatarOf = (conversation: Conversation) => {
    if (conversation.kind === 'group') {
      const members = conversation.memberAgentIds
        .map((id) => { return agents.find((a) => { return a.id === id }) })
        .filter((a): a is AgentDef => { return a !== undefined })
      return <GroupAvatar members={members} size={48} />
    }
    const other = agents.find((a) => { return a.id === conversation.memberAgentIds[0] })
    if (other === undefined) {
      return <Avatar name={conversation.title || '?'} seed={conversation.id} size={48} />
    }
    return <Avatar avatarKey={other.avatar} name={other.name} seed={other.id} size={48} />
  }

  return (
    <>
      <div className="list-panel-header">
        <span className="search-box-wrap">
          <Icon name="search" size={15} className="search-box-icon" />
          <input
            className="search-box has-icon"
            placeholder="搜索会话"
            value={query}
            onChange={(event) => { setQuery(event.target.value) }}
          />
        </span>
      </div>
      <div className="conversation-list">
        {loading === true ? (
          <ConversationSkeleton />
        ) : filtered.length === 0 ? (
          <div className="empty-state" style={{ minHeight: 220 }}>
            <h3>{conversations.length === 0 ? '还没有会话' : '没有匹配的会话'}</h3>
            <p>{conversations.length === 0 ? '去通讯录找 agent 聊聊吧。' : '换个关键词试试。'}</p>
          </div>
        ) : filtered.map((conversation) => (
          <button
            type="button"
            key={conversation.id}
            className={`conversation-item ${conversation.id === activeId ? 'is-active' : ''}`}
            onClick={() => { onSelect(conversation.id) }}
          >
            {avatarOf(conversation)}
            <div className="conversation-item-body">
              <div className="conversation-item-top">
                <strong>{conversation.title || nameOf(conversation.memberAgentIds[0] ?? '')}</strong>
                <time>{formatTime(conversation.updatedAt)}</time>
              </div>
              <div className="conversation-item-bottom">
                <span className="preview">{conversation.lastMessagePreview ?? ''}</span>
                {(conversation.unreadCount ?? 0) > 0 && (
                  <span className="unread-badge">
                    {(conversation.unreadCount ?? 0) > 99 ? '99+' : conversation.unreadCount}
                  </span>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>
    </>
  )
}
