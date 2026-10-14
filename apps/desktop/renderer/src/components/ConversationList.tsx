import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import type { AgentDef, Conversation, ConversationPatch, SearchResultRow } from '../api.ts'
import { ApiClient, resolveApiBase } from '../api.ts'
import { stagger } from '../lib/stagger.ts'
import { toast } from '../lib/toast.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { GroupAvatar } from './avatars/GroupAvatar.tsx'
import { formatTime } from './ChatView.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { Icon } from './Icon.tsx'
import { ConversationSkeleton } from './Skeleton.tsx'

/** 搜索框停手多久才真去搜（ms）：边打字边打接口既吵又费。 */
const SEARCH_DEBOUNCE_MS = 220

/** 渲染层对后端的能力只做结构化要求：缺哪个方法就降级到哪个功能不可用。 */
export interface ConversationApi {
  searchMessages?(params: { q: string }): Promise<{ results: SearchResultRow[] }>
  patchConversation?(id: string, patch: ConversationPatch): Promise<{ conversation?: Conversation }>
  deleteConversation?(id: string): Promise<{ deleted: string }>
}

/**
 * 没有注入 api 时用的真客户端。
 * 会话列表挂在壳里、壳自己持有 ApiClient，但这一层不该反过来依赖壳传参——
 * 没有它，搜索/置顶/静音/删除会静默变成没接线的死界面。
 */
let sharedClient: ApiClient | undefined
function defaultConversationApi(): ConversationApi {
  sharedClient ??= new ApiClient(resolveApiBase())
  return sharedClient
}

/**
 * 行内的主按钮：把原生 button 复位成「和整行同宽的可点区域」。
 * 行本身是 div（要装行尾操作，button 里嵌 button 是无效 HTML），
 * 但行高、圆角、悬停底色与进场 stagger 仍由 .conversation-item 给出。
 */
const ROW_MAIN: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  flex: 1,
  minWidth: 0,
  padding: 0,
  margin: 0,
  border: 'none',
  background: 'none',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}

/**
 * 行尾的操作入口。压暗常显而不是 hover 才出现：hover 才显形的入口对键盘用户
 * 根本不存在。亮度的两档（压暗 / 点亮）在样式表的 `.conversation-item-actions`
 * 里，内联只留布局——内联优先级高于选择器，写在这里就再也点不亮了。
 */
const ROW_ACTIONS: CSSProperties = { display: 'flex', alignItems: 'center', flexShrink: 0 }

/**
 * 片段里的查询词包进行内 <mark>：服务端回的片段是纯文本（首尾各可能带一个省略号），
 * 不标出来的话用户得自己在一句话里找那个词——搜索结果里最该被看见的就是它。
 */
function markSnippet(snippet: string, query: string): ReactNode[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return [snippet]
  const haystack = snippet.toLowerCase()
  const nodes: ReactNode[] = []
  let cursor = 0
  for (;;) {
    const at = haystack.indexOf(needle, cursor)
    if (at < 0) break
    if (at > cursor) nodes.push(snippet.slice(cursor, at))
    nodes.push(
      <mark className="search-hit-mark" key={at}>
        {snippet.slice(at, at + needle.length)}
      </mark>,
    )
    cursor = at + needle.length
  }
  if (cursor < snippet.length) nodes.push(snippet.slice(cursor))
  return nodes
}

/** 搜索命中：按会话分组，组头 + 若干片段。 */
interface SearchGroup {
  conversationId: string
  conversationTitle: string
  results: SearchResultRow[]
}

function groupResults(results: SearchResultRow[]): SearchGroup[] {
  const groups: SearchGroup[] = []
  for (const result of results) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.conversationId === result.conversationId) {
      last.results.push(result)
      continue
    }
    groups.push({
      conversationId: result.conversationId,
      conversationTitle: result.conversationTitle,
      results: [result],
    })
  }
  return groups
}

/**
 * 尽力把某条消息滚进视野并标一下命中的高亮类。
 *
 * 聊天区可能正在拉历史（消息还没挂上），所以隔几拍重试；同时抛一个窗口事件
 * `ryagent:scroll-to-message`（detail 带 conversationId / messageId），聊天视图
 * 那边只要在消息行上补一个 `data-message-id`，或在收到事件后自己定位，两条路任选。
 */
function revealMessage(conversationId: string, messageId: string): void {
  const safe = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(messageId) : messageId
  for (const delay of [0, 160, 420, 900]) {
    window.setTimeout(() => {
      const node = document.querySelector<HTMLElement>(`[data-message-id="${safe}"]`)
      if (node === null) return
      node.scrollIntoView?.({ block: 'center' })
      node.classList.add('is-search-hit')
      window.setTimeout(() => {
        node.classList.remove('is-search-hit')
      }, 2400)
    }, delay)
  }
  window.dispatchEvent(new CustomEvent('ryagent:scroll-to-message', { detail: { conversationId, messageId } }))
}

type SearchState = 'idle' | 'loading' | 'done' | 'unavailable'

/** 左栏会话列表：48px 头像、未读徽标、预览、全文搜索、行尾操作、骨架屏。 */
export function ConversationList({
  conversations,
  agents,
  activeId,
  loading,
  onSelect,
  onGoContacts,
  api,
  onChanged,
  onJumpToMessage,
}: {
  conversations: Conversation[]
  agents: AgentDef[]
  activeId: string | undefined
  loading?: boolean
  onSelect: (id: string) => void
  /** 空态里的"去通讯录"入口（此前只有一句提示，用户不知道往哪走）。 */
  onGoContacts?: () => void
  /** 未传时用内置客户端；测试注入 mock。 */
  api?: ConversationApi
  /** 置顶/静音/删除成功后通知宿主重拉列表。 */
  onChanged?: () => void
  /** 搜索命中跳转：除切会话外，把定位交给聊天视图。 */
  onJumpToMessage?: (conversationId: string, messageId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [searchState, setSearchState] = useState<SearchState>('idle')
  const [hits, setHits] = useState<SearchResultRow[]>([])
  /** 置顶/静音的本地覆盖：请求还在路上时界面先动，失败会回滚。 */
  const [overrides, setOverrides] = useState<Record<string, { pinned?: boolean; muted?: boolean }>>({})
  const [removed, setRemoved] = useState<string[]>([])
  const [actionFor, setActionFor] = useState<string | undefined>(undefined)
  const [deleting, setDeleting] = useState<Conversation | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    return () => {
      mounted.current = false
    }
  }, [])

  const client: ConversationApi = api ?? defaultConversationApi()
  const trimmed = query.trim()

  // 全文搜索：搜消息正文，不只是会话名。接口没有 / 失败时降级回按会话名过滤。
  useEffect(() => {
    if (trimmed.length === 0) {
      setSearchState('idle')
      setHits([])
      return
    }
    if (client.searchMessages === undefined) {
      setSearchState('unavailable')
      return
    }
    setSearchState('loading')
    let cancelled = false
    const timer = window.setTimeout(() => {
      client
        .searchMessages?.({ q: trimmed })
        .then((response) => {
          if (cancelled) return
          setHits(response.results)
          setSearchState('done')
        })
        .catch(() => {
          if (cancelled) return
          setHits([])
          setSearchState('unavailable')
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [trimmed, client])

  const nameOf = (id: string): string => {
    return (
      agents.find((a) => {
        return a.id === id
      })?.name ?? id
    )
  }
  /** 本地覆盖叠在宿主给的数据上：置顶/静音不必等一次整表刷新才显形。 */
  const visible = conversations
    .filter((conversation) => {
      return !removed.includes(conversation.id)
    })
    .map((conversation) => {
      const patch = overrides[conversation.id]
      return patch === undefined ? conversation : { ...conversation, ...patch }
    })
  const nameFiltered =
    trimmed.length === 0
      ? visible
      : visible.filter((conversation) => {
          return (
            conversation.title.toLowerCase().includes(trimmed.toLowerCase()) ||
            conversation.memberAgentIds.some((id) => {
              return nameOf(id).toLowerCase().includes(trimmed.toLowerCase())
            })
          )
        })
  // 置顶的排前面，其余保持服务端给的顺序（服务端一般已按 updatedAt 排好）。
  const filtered = [...nameFiltered].sort((a, b) => {
    return Number(b.pinned ?? false) - Number(a.pinned ?? false)
  })

  const avatarOf = (conversation: Conversation) => {
    if (conversation.kind === 'group') {
      const members = conversation.memberAgentIds
        .map((id) => {
          return agents.find((a) => {
            return a.id === id
          })
        })
        .filter((a): a is AgentDef => {
          return a !== undefined
        })
      return <GroupAvatar members={members} size={48} />
    }
    const other = agents.find((a) => {
      return a.id === conversation.memberAgentIds[0]
    })
    if (other === undefined) {
      return <Avatar name={conversation.title || '?'} seed={conversation.id} size={48} />
    }
    return <Avatar avatarKey={other.avatar} name={other.name} seed={other.id} size={48} />
  }

  const setFlag = (conversation: Conversation, patch: { pinned?: boolean; muted?: boolean }): void => {
    setOverrides((prev) => {
      return { ...prev, [conversation.id]: { ...prev[conversation.id], ...patch } }
    })
  }

  const patchConversation = async (
    conversation: Conversation,
    patch: { pinned?: boolean; muted?: boolean },
  ): Promise<void> => {
    if (client.patchConversation === undefined) {
      toast.error('这个版本的服务端还不支持置顶/静音，先更新服务端再来。')
      return
    }
    setFlag(conversation, patch)
    try {
      await client.patchConversation(conversation.id, patch)
      onChanged?.()
    } catch (cause: unknown) {
      // 只回滚这次动过的字段：顺手把没碰过的另一个翻过去，等于凭空改静音状态。
      const rollback: { pinned?: boolean; muted?: boolean } = {}
      if (patch.pinned !== undefined) rollback.pinned = !patch.pinned
      if (patch.muted !== undefined) rollback.muted = !patch.muted
      setFlag(conversation, rollback)
      toast.error(`操作失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  const searching = trimmed.length > 0 && (searchState === 'loading' || searchState === 'done')
  const groups = groupResults(hits)

  return (
    <>
      <div className="list-panel-header">
        <span className="search-box-wrap">
          <Icon name="search" size={15} className="search-box-icon" />
          <input
            className="search-box has-icon"
            placeholder="搜索会话与消息"
            value={query}
            aria-label="搜索会话与消息"
            onChange={(event) => {
              setQuery(event.target.value)
            }}
          />
        </span>
        {trimmed.length > 0 && (
          <p className="preview">
            {searching
              ? searchState === 'loading'
                ? '正在搜消息正文…'
                : `${hits.length} 条消息命中「${trimmed}」`
              : searchState === 'unavailable'
                ? '全文搜索暂不可用，下面只按会话名过滤。'
                : ''}
          </p>
        )}
      </div>
      <div className="conversation-list">
        {searching ? (
          groups.length === 0 ? (
            <div className="empty-state empty-state-inline">
              <h3>{searchState === 'loading' ? '正在搜索…' : '没有命中的消息'}</h3>
              <p>{searchState === 'loading' ? '在所有会话里找这条内容。' : '换个关键词试试。'}</p>
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.conversationId} className="search-group">
                <p className="search-group-title">{group.conversationTitle || nameOf(group.conversationId)}</p>
                {group.results.map((hit) => (
                  <button
                    type="button"
                    key={hit.messageId}
                    className="search-hit"
                    onClick={() => {
                      onSelect(group.conversationId)
                      onJumpToMessage?.(group.conversationId, hit.messageId)
                      revealMessage(group.conversationId, hit.messageId)
                    }}
                  >
                    <span className="search-hit-snippet">{markSnippet(hit.snippet, trimmed)}</span>
                    <span className="search-hit-meta">
                      {nameOf(hit.agentId)} · {formatTime(hit.createdAt)}
                    </span>
                  </button>
                ))}
              </div>
            ))
          )
        ) : loading === true ? (
          <ConversationSkeleton />
        ) : filtered.length === 0 ? (
          <div className="empty-state empty-state-inline">
            <h3>{conversations.length === 0 ? '还没有会话' : '没有匹配的会话'}</h3>
            <p>{conversations.length === 0 ? '先去通讯录看看有什么助理。' : '换个关键词试试。'}</p>
            {conversations.length === 0 && onGoContacts !== undefined && (
              <div className="empty-state-actions">
                <button type="button" className="btn" onClick={onGoContacts}>
                  去通讯录
                </button>
              </div>
            )}
          </div>
        ) : (
          filtered.map((conversation, index) => (
            <div
              key={conversation.id}
              // 行是布局容器：行尾要放操作按钮，而 button 里嵌 button 是无效 HTML。
              className={`conversation-item ${conversation.id === activeId ? 'is-active' : ''}`}
              style={stagger(index)}
            >
              <button
                type="button"
                className="conversation-item-main"
                style={ROW_MAIN}
                aria-current={conversation.id === activeId}
                onClick={() => {
                  onSelect(conversation.id)
                }}
              >
                {avatarOf(conversation)}
                <div className="conversation-item-body">
                  <div className="conversation-item-top">
                    <strong>
                      {(conversation.pinned ?? false) && <span className="badge conversation-item-flag">置顶</span>}
                      {conversation.title || nameOf(conversation.memberAgentIds[0] ?? '')}
                    </strong>
                    <time>{formatTime(conversation.updatedAt)}</time>
                  </div>
                  <div className="conversation-item-bottom">
                    <span className="preview">{conversation.lastMessagePreview ?? ''}</span>
                    {conversation.muted === true ? (
                      <span className="conversation-item-flag is-muted">已静音</span>
                    ) : (
                      (conversation.unreadCount ?? 0) > 0 && (
                        <span className="unread-badge">
                          {(conversation.unreadCount ?? 0) > 99 ? '99+' : conversation.unreadCount}
                        </span>
                      )
                    )}
                  </div>
                </div>
              </button>
              <span className="conversation-item-actions" style={ROW_ACTIONS}>
                <button
                  type="button"
                  className="conversation-more"
                  aria-label={`「${conversation.title || nameOf(conversation.memberAgentIds[0] ?? '')}」的操作`}
                  aria-expanded={actionFor === conversation.id}
                  title="置顶 / 静音 / 删除"
                  onClick={() => {
                    setActionFor((prev) => {
                      return prev === conversation.id ? undefined : conversation.id
                    })
                  }}
                >
                  ⋯
                </button>
              </span>
              {actionFor === conversation.id && (
                <div className="conversation-item-menu">
                  <button
                    type="button"
                    className="btn btn-mini"
                    onClick={() => {
                      void patchConversation(conversation, { pinned: !(conversation.pinned ?? false) })
                    }}
                  >
                    {conversation.pinned === true ? '取消置顶' : '置顶'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-mini"
                    onClick={() => {
                      void patchConversation(conversation, { muted: !(conversation.muted ?? false) })
                    }}
                  >
                    {conversation.muted === true ? '取消静音' : '静音'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-mini btn-danger"
                    onClick={() => {
                      setDeleting(conversation)
                    }}
                  >
                    删除
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
      {deleting !== undefined && (
        <ConfirmDialog
          title={`删除「${deleting.title || nameOf(deleting.memberAgentIds[0] ?? '')}」？`}
          body="这个会话和里面的全部消息都会从本机删掉，删不回来。想留的话，先把要紧的内容复制走。"
          confirmLabel="确认删除"
          onCancel={() => {
            setDeleting(undefined)
          }}
          onConfirm={async () => {
            if (client.deleteConversation === undefined) {
              setDeleting(undefined)
              toast.error('这个版本的服务端还没有删除会话的接口。')
              return
            }
            try {
              await client.deleteConversation(deleting.id)
            } catch (cause: unknown) {
              toast.error(`删除失败：${cause instanceof Error ? cause.message : String(cause)}`)
              return
            }
            if (mounted.current) {
              setRemoved((prev) => {
                return [...prev, deleting.id]
              })
              setDeleting(undefined)
              setActionFor(undefined)
              onChanged?.()
            }
            toast.success('会话已删除')
          }}
        />
      )}
    </>
  )
}
