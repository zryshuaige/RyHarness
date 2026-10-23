import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { SEARCH_FOCUS_EVENT } from '../../../shared/shortcuts.ts'
import type { AgentDef, Conversation, ConversationPatch, SearchResultRow } from '../api.ts'
import { ApiClient, resolveApiBase } from '../api.ts'
import { humanError } from '../lib/error-text.ts'
import { formatTime } from '../lib/format.ts'
import { humanPreview } from '../lib/humanize.ts'
import { useRemovedConversations } from '../lib/removed-conversations.ts'
import { stagger } from '../lib/stagger.ts'
import { toast } from '../lib/toast.ts'
import { rowTransitionName, withViewTransition } from '../lib/view-transition.ts'
import { useVisibleWindow, windowSlice } from '../lib/windowed.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { GroupAvatar } from './avatars/GroupAvatar.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { Icon } from './Icon.tsx'
import { ConversationSkeleton } from './Skeleton.tsx'

/** 搜索框停手多久才真去搜（ms）：边打字边打接口既吵又费。 */
const SEARCH_DEBOUNCE_MS = 220
/**
 * 全文搜索（服务端 FTS5）能给出有效结果的最短输入（字）。
 *
 * 服务端走的是 FTS5 索引，正文按**相邻两字**一个 token 建：单字查询（"的"）
 * 只有正文恰好是那一个字时才命中，等于白搜一次。两个字是这套索引的最小有效
 * 粒度。
 *
 * 注意这只是**正文搜索**的门槛，不是"要不要进搜索模式"的门槛：会话名一个字
 * 就能找。搜索框下面那两节（会话 / 消息）任何时候都在，输入一个字与输入两个
 * 字是同一套结果——以前这里是两套（满两个字整棵左栏就被换成消息搜索结果），
 * 于是"按会话名找会话"根本没法用。
 */
const SEARCH_MIN_CHARS = 2

/**
 * 浮层与行之间留的缝（px）。量剩余空间时按它留余量：贴着行下沿展开的话，
 * 「差一点点放得下」和「放不下」会被判成同一件事，末行就会掉出可视区。
 */
const MENU_GAP_PX = 8

/**
 * 单行估算高度（px），对上 .conversation-item 的 min-height。
 * 行高并不固定（预览文字会折行），估算偏了只是哨兵略有出入，滚动条仍连续。
 */
const ROW_ESTIMATE_PX = 64

/** 渲染层对后端的能力只做结构化要求：缺哪个方法就降级到哪个功能不可用。 */
export interface ConversationApi {
  searchMessages?(params: { q: string }): Promise<{ results: SearchResultRow[] }>
  patchConversation?(id: string, patch: ConversationPatch): Promise<{ conversation?: Conversation }>
  deleteConversation?(id: string): Promise<{ deleted: string }>
  /** 撤销删除（软删的另一半）：把会话放回列表。 */
  restoreConversation?(id: string): Promise<{ conversation?: Conversation }>
}

/**
 * 会话行：存储的会话 + 服务端附带的「Ryen 主动找过你」标记。
 *
 * `proactive` 由 GET /api/conversations 附带（内容块里有主动消息的标记块）。api.ts
 * 的 Conversation 还没声明这一维，这里就地加——行上要多一个「主动」角标，就得有一处
 * 承认它存在。
 */
export type ConversationRow = Conversation & { proactive?: boolean }

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
 * 翻到行上方的定位（内联，且只写 top/bottom 两个偏移）。
 *
 * 外观（底色/圆角/阴影/层级）一律留给样式表——内联优先级高于选择器，写在这里就
 * 再也点不亮了。这里能覆盖的只有「菜单挂哪一侧」这一件布局事，而它必须内联：翻不翻
 * 取决于这一行在滚动容器里的实时位置，没有哪条静态选择器知道。
 */
const MENU_ABOVE: CSSProperties = { top: 'auto', bottom: 'calc(100% + 8px)' }

/**
 * 片段里的查询词包进行内 <mark>：服务端回的片段是纯文本（首尾各可能带一个省略号），
 * 不标出来的话用户得自己在一句话里找那个词——搜索结果里最该被看见的就是它。
 *
 * className 分两种：消息片段用 .search-hit-mark，会话标题与摘要用
 * .search-title-mark。两者是不同位置上的高亮（一条是"谁说了什么"，一条是"这个
 * 会话叫什么"），样式一样、类名分开，测试与样式表才分得清谁在标什么。
 */
function markSnippet(snippet: string, query: string, className = 'search-hit-mark'): ReactNode[] {
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
      <mark className={className} key={at}>
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

/** 会话命中在哪一段：决定高亮落在标题上还是摘要上。 */
export type ConversationMatch = 'title' | 'summary' | 'member'

/**
 * 这个会话能不能被这个词命中，命中在哪一段。
 *
 * 口径就是"按会话名找会话"这件事本身：
 * - 标题命中优先（标题是用户记得的那个名字）；
 * - 摘要（末条消息预览）里有这个词也算命中——用户记得的常常是那句话，而不是
 *   那个标题，尤其是标题是空的那些会话；
 * - 成员助理的名字里有这个词也算（老口径一直有，别丢）。
 *
 * 纯函数：组件与测试共用这一份，别处再写一套过滤条件就会两处口径打架。
 */
export function matchConversation(
  conversation: Conversation,
  needle: string,
  memberName: (id: string) => string,
): ConversationMatch | null {
  const lower = needle.trim().toLowerCase()
  if (lower.length === 0) return null
  if (conversation.title.toLowerCase().includes(lower)) return 'title'
  const summary = conversation.lastMessagePreview ?? ''
  if (summary.toLowerCase().includes(lower)) return 'summary'
  const inMembers = conversation.memberAgentIds.some((id) => {
    return memberName(id).toLowerCase().includes(lower)
  })
  return inMembers ? 'member' : null
}

/**
 * 尽力把某条消息滚进视野并标一下命中的高亮类。
 *
 * 聊天区可能正在拉历史（消息还没挂上），所以隔几拍重试；同时抛一个窗口事件
 * `ryharness:scroll-to-message`（detail 带 conversationId / messageId），聊天视图
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
  window.dispatchEvent(new CustomEvent('ryharness:scroll-to-message', { detail: { conversationId, messageId } }))
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
  onEditGroup,
  onJumpToMessage,
  collapsed,
  onToggleCollapsed,
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
  /** 行尾「群设置」：只有群聊才给这个入口；不传则整项不渲染。 */
  onEditGroup?: (conversation: Conversation) => void
  /** 搜索命中跳转：除切会话外，把定位交给聊天视图。 */
  onJumpToMessage?: (conversationId: string, messageId: string) => void
  /** 左栏收起态（宿主持有状态与持久化）。 */
  collapsed?: boolean
  /** 收起/展开左栏。 */
  onToggleCollapsed?: () => void
}) {
  const [query, setQuery] = useState('')
  const [searchState, setSearchState] = useState<SearchState>('idle')
  const [hits, setHits] = useState<SearchResultRow[]>([])
  /** 置顶/静音的本地覆盖：请求还在路上时界面先动，失败会回滚。 */
  const [overrides, setOverrides] = useState<Record<string, { pinned?: boolean; muted?: boolean }>>({})
  const [removed, setRemoved] = useState<string[]>([])
  /**
   * 别处（欢迎页）删掉的会话：共享名单，不是本组件的 state。
   *
   * 放模块级是因为左栏会被卸载重挂——组件 state 一丢，那一行就又冒出来了，
   * 而服务端删的是软删：列表接口不返回它，可壳手里那份还是旧的。
   */
  const deletedElsewhere = useRemovedConversations()
  const [actionFor, setActionFor] = useState<string | undefined>(undefined)
  /** 菜单挂在行下方放不下、翻到行上方的那个会话 id。 */
  const [flippedFor, setFlippedFor] = useState<string | undefined>(undefined)
  const [deleting, setDeleting] = useState<Conversation | undefined>(undefined)
  /** 搜索框：快捷键 Ctrl/Cmd+K 要把焦点送到这里。 */
  const searchRef = useRef<HTMLInputElement | null>(null)
  /** 滚动容器（.conversation-list 自身 overflow-y: auto）：窗口化靠它量 scrollTop。 */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** 同一时刻只有一个菜单开着，一份引用就够（外加各行的触发器，用于 Esc 后还焦）。 */
  const menuRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    return () => {
      mounted.current = false
    }
  }, [])

  /**
   * 避让：菜单在行下方展开，而滚动容器会 overflow 裁掉溢出部分——列表末行一点
   * 「⋯」，三个按钮的下半截就没了（看得见一半、点不到另一半）。
   *
   * 翻到行上方由实测剩余空间决定；用 layout effect 是因为它在绘制前跑完，
   * 量完就改定位，屏幕上不会先闪一帧「裁掉一半的菜单」。量不到高度（高度 0，
   * 例如布局未完成）就不动——没有证据就不改位置。
   */
  useLayoutEffect(() => {
    if (actionFor === undefined) return
    const menu = menuRef.current
    const row = menu?.closest<HTMLElement>('.conversation-item')
    const viewport = scrollRef.current
    if (menu === null || row === undefined || row === null || viewport === null) return
    const menuBox = menu.getBoundingClientRect()
    if (menuBox.height === 0) return
    const spaceBelow = viewport.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom
    setFlippedFor(spaceBelow < menuBox.height + MENU_GAP_PX ? actionFor : undefined)
  }, [actionFor])

  /** 打开即把焦点落在第一项上：键盘用户不该还要再 Tab 一遍才知道菜单里有东西。 */
  useEffect(() => {
    if (actionFor === undefined) return
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [actionFor])

  /** 点到浮层之外就收起来（含确认删除弹窗盖上来那一下）。 */
  useEffect(() => {
    if (actionFor === undefined) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target) === true) return
      if (triggerRef.current?.contains(target) === true) return
      setActionFor(undefined)
      setFlippedFor(undefined)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [actionFor])

  const closeMenu = (restoreFocus: boolean): void => {
    const trigger = triggerRef.current
    setActionFor(undefined)
    setFlippedFor(undefined)
    if (restoreFocus) trigger?.focus()
  }

  /** ↑↓ 在菜单里走位，Enter 由按钮自己触发，Esc 收起并把焦点还给「⋯」。 */
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu(true)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = [...(menuRef.current?.querySelectorAll('button') ?? [])]
    if (items.length === 0) return
    event.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? at + 1 : at - 1
    items[(next + items.length) % items.length]?.focus()
  }

  const toggleMenu = (conversationId: string): void => {
    const next = actionFor === conversationId ? undefined : conversationId
    setFlippedFor(undefined)
    setActionFor(next)
  }

  const client: ConversationApi = api ?? defaultConversationApi()
  const trimmed = query.trim()

  /**
   * 撤销删除：把会话放回列表。
   *
   * 服务端删的是**软删**（只打标记，消息还在库里），撤销就是把标记清掉。
   * 失败要如实说——"撤销失败"比"没点着"诚实。
   */
  const undoDelete = useCallback(
    (id: string): void => {
      if (client.restoreConversation === undefined) {
        toast.error('这个版本的服务端还没有撤销删除的接口。')
        return
      }
      void client
        .restoreConversation(id)
        .then(() => {
          if (!mounted.current) return
          setRemoved((prev) => {
            return prev.filter((each) => {
              return each !== id
            })
          })
          onChanged?.()
          toast.success('已撤销删除')
        })
        .catch((cause: unknown) => {
          toast.error(`撤销失败：${humanError(cause, '这个会话没能回来')}`)
        })
    },
    [client, onChanged],
  )

  /**
   * 全文搜索：搜消息正文。接口没有 / 失败时降级（那一节说清原因，会话名照常能找）。
   *
   * 门槛只有一个：正文索引按相邻两字建，一个字搜不准（见 SEARCH_MIN_CHARS）。
   * 会话名那边不设门槛——一个字也照找不误。
   */
  useEffect(() => {
    // 快捷键 Ctrl/Cmd+K：把焦点送到搜索框（App 是快捷键的持有者，用事件搭桥）。
    const onFocusSearch = (): void => {
      const node = searchRef.current
      if (node === null) return
      node.focus()
      node.select()
    }
    window.addEventListener(SEARCH_FOCUS_EVENT, onFocusSearch)
    return () => {
      window.removeEventListener(SEARCH_FOCUS_EVENT, onFocusSearch)
    }
  }, [])

  useEffect(() => {
    if (trimmed.length === 0) {
      setSearchState('idle')
      setHits([])
      return
    }
    if (client.searchMessages === undefined) {
      setSearchState('unavailable')
      setHits([])
      return
    }
    if (trimmed.length < SEARCH_MIN_CHARS) {
      // 一个字：正文这头搜不准（索引按两字建），会话名那头照常找得到。
      setSearchState('idle')
      setHits([])
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

  /**
   * 换查询词就从顶上开始看。
   *
   * 滚动位置是上一次查询留下的：留着它，用户会以为搜漏了（明明第一条就命中，
   * 屏幕上却停在中段那一批上）。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: trimmed 是触发条件（换查询词就回到顶上），effect 体内读不到它
  useEffect(() => {
    const node = scrollRef.current
    if (node !== null) node.scrollTop = 0
  }, [trimmed])

  /**
   * 别处删了或撤销了会话：请壳重拉一次列表。
   *
   * 撤销之后那一行得真回来（壳手里那份可能已经把这条会话丢掉了）。首帧不算变化
   * ——那时壳刚拉过一遍列表，不必再拉一次。
   */
  const removedElsewhereBefore = useRef<number | undefined>(undefined)
  useEffect(() => {
    const size = deletedElsewhere.size
    const before = removedElsewhereBefore.current
    removedElsewhereBefore.current = size
    if (before === undefined || size === before) return
    onChanged?.()
  }, [deletedElsewhere, onChanged])

  const nameOf = (id: string): string => {
    return (
      agents.find((a) => {
        return a.id === id
      })?.name ?? id
    )
  }
  /** 本地覆盖叠在宿主给的数据上：置顶/静音不必等一次整表刷新才显形。 */
  const visible: ConversationRow[] = conversations
    .filter((conversation) => {
      // 自己删的（本地 state）与别处删的（共享名单）都不该再出现在列表里。
      return !removed.includes(conversation.id) && !deletedElsewhere.has(conversation.id)
    })
    .map((conversation) => {
      const patch = overrides[conversation.id]
      return patch === undefined ? conversation : { ...conversation, ...patch }
    })
  /**
   * 命中在哪一段：标题、摘要还是成员名。高亮要落在用户真正搜到的那段文字上，
   * 否则标题命中却把摘要标出来，等于标错地方。
   */
  const matchKind = new Map<string, ConversationMatch>()
  const nameFiltered =
    trimmed.length === 0
      ? visible
      : visible.filter((conversation) => {
          const kind = matchConversation(conversation, trimmed, nameOf)
          if (kind === null) return false
          matchKind.set(conversation.id, kind)
          return true
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

  /**
   * 置顶/静音的本地覆盖。写进补间通道：置顶会把这一行换到列表的另一头，直切是
   * 「瞬变」——包一层让浏览器把它补间过去（不支持 / 减少动效时同步执行，语义完全
   * 一致）。失败回滚走的是同一条路，位置也会被补间回来。
   */
  const setFlag = (conversation: Conversation, patch: { pinned?: boolean; muted?: boolean }): void => {
    withViewTransition(() => {
      setOverrides((prev) => {
        return { ...prev, [conversation.id]: { ...prev[conversation.id], ...patch } }
      })
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
      toast.error(`操作失败：${humanError(cause, '这次没能改回来，再点一次')}`)
    }
  }

  /**
   * 搜索态：搜索框里有词。
   *
   * 这里只表示"有词在搜"，不再表示"换成消息搜索模式"——满两个字就把整棵左栏换成
   * 另一种视图，正是那个坑。现在有词就是同一套两节结果（会话 / 消息），一个字与
   * 两个字的差别只有内容，没有模式。
   */
  const searching = trimmed.length > 0
  const groups = groupResults(hits)
  // 会话能攒到几千条，整表进 DOM 的话首屏一次排几千行、滚动全程都在重排：
  // 只渲染可视区，上下各留一个哨兵撑住滚动几何（lib/windowed.ts）。
  // 搜索态里"会话"那一节渲染的还是这批行，所以照样走窗口化。
  const windowed = useVisibleWindow({
    count: filtered.length,
    estimateHeight: ROW_ESTIMATE_PX,
    scrollRef,
  })
  const rows = windowSlice(filtered, windowed, ROW_ESTIMATE_PX)
  // 首帧那一批行的 id：只有它们播进场动画。窗口化之后行会反复挂载，挂在
  // .conversation-item 上的 item-in 每次重挂都从头播一遍——滚动时整列看起来像在
  // 逐条淡入。样式表据此约定：滚动容器挂 data-windowed="true" 关掉默认动画，只给
  // 这批行补 .is-animated 放行一次（那批是整列错落进场，之后滚进来的行静默出现）。
  // 首帧取的是首次非空窗口；此后哪怕滚回顶部也不再补，动画只此一次。
  const animatedRef = useRef<Set<string> | undefined>(undefined)
  if (animatedRef.current === undefined && rows.visible.length > 0) {
    animatedRef.current = new Set(
      rows.visible.map((conversation) => {
        return conversation.id
      }),
    )
  }

  /**
   * roving tabindex：整张列表只占**一个** Tab 位，↑↓ 在行间走。
   *
   * 此前每一行都是普通 button，300 条会话的列表要按 300 次 Tab 才走得到底。
   * 同一套模式（组内一枚 tabIndex=0、方向键移动）在通讯录的头像选择器里已经写好
   * （ContactsPage 的 face-picker），这里沿用同一口径，不另造一套。
   */
  const [focusId, setFocusId] = useState<string | undefined>(undefined)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())

  /** 把焦点落到第 index 行；不在窗口里就先把它滚进窗口。 */
  const focusAt = useCallback(
    (index: number): void => {
      if (filtered.length === 0) return
      const clamped = Math.max(0, Math.min(filtered.length - 1, index))
      const target = filtered[clamped]
      if (target === undefined) return
      setFocusId(target.id)
      // 目标行还没渲染（窗口化）：先滚进去——聚焦一个不存在的 DOM 节点是静默失败。
      const node = scrollRef.current
      if (node !== null && (clamped < windowed.start || clamped >= windowed.end)) {
        node.scrollTop = clamped * ROW_ESTIMATE_PX
      }
    },
    [filtered, windowed.end, windowed.start],
  )

  const onListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (filtered.length === 0) return
      // 行尾菜单（⋯）自己管 ↑↓：按下打开菜单、走到某一项、Esc 收回焦点。
      // 列表级的方向键导航不能抢——否则两个都在响应同一个按键。
      const target = event.target
      if (target instanceof HTMLElement) {
        if (target.closest('.conversation-item-menu') !== null) return
        if (target.classList.contains('conversation-more')) return
        // 消息命中那几颗按钮在另一节里，与会话行不是一条导航线。
        if (target.closest('.search-hit') !== null) return
      }
      const current = filtered.findIndex((row) => {
        return row.id === focusId
      })
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          focusAt(current < 0 ? 0 : current + 1)
          break
        case 'ArrowUp':
          event.preventDefault()
          focusAt(current < 0 ? filtered.length - 1 : current - 1)
          break
        case 'Home':
          event.preventDefault()
          focusAt(0)
          break
        case 'End':
          event.preventDefault()
          focusAt(filtered.length - 1)
          break
        default:
          break
      }
    },
    [filtered, focusAt, focusId],
  )

  // 焦点落到哪一行：行还没渲染出来时（窗口化）这一帧落空，滚动后补上。
  // windowed.start/end 是**触发条件**而不是读取的依赖：窗口一动（滚到别处、
  // 列表变短），这一行才可能刚被渲染出来，得再试一次聚焦。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖窗口位置是为了「行刚渲染出来时再聚焦一次」
  useEffect(() => {
    if (focusId === undefined) return
    const node = rowRefs.current.get(focusId)
    if (node === undefined) return
    node.focus()
  }, [focusId, windowed.end, windowed.start])

  /** 当前持有 roving 焦点的那一行（默认第一行：没有它整张列表 Tab 不到）。 */
  const rovingId = filtered.some((row) => {
    return row.id === focusId
  })
    ? focusId
    : filtered[0]?.id

  /**
   * 一行在搜索态下怎么显示：标题与摘要各自要不要标出命中。
   *
   * 高亮要落在用户真正搜到的那段文字上：标题命中就标标题，摘要命中就标摘要。
   * 标错地方等于宣称"命中在这儿"，而那里其实不是。
   */
  const rowTexts = (conversation: ConversationRow): { title: ReactNode; preview: ReactNode } => {
    const title = conversation.title || nameOf(conversation.memberAgentIds[0] ?? '')
    const preview = humanPreview(conversation.lastMessagePreview ?? '')
    const kind = matchKind.get(conversation.id)
    if (kind === 'title') return { title: markSnippet(title, trimmed, 'search-title-mark'), preview }
    if (kind === 'summary') return { title, preview: markSnippet(preview, trimmed, 'search-title-mark') }
    return { title, preview }
  }

  /** 两节都没命中：这时得给一句人话，而不是"无结果"三个字。 */
  const nothingAtAll = filtered.length === 0 && groups.length === 0

  /**
   * 消息那一节的内容。
   *
   * 四种情形各说各的话：还在搜、这个版本没有全文搜索、正文搜不动（一个字不够）、
   * 真的没有命中。最后一档在"会话那节也没命中"时换成一句人话——两处都没找到，
   * 得让用户知道该换词还是该清空。
   */
  const renderMessageSection = (): ReactNode => {
    if (searchState === 'loading') return <p className="search-section-empty">正在搜消息正文…</p>
    if (searchState === 'unavailable') {
      return (
        <div className="empty-state empty-state-inline">
          <h3>搜不了消息正文</h3>
          <p>全文搜索暂不可用，这里只能按会话名找。</p>
        </div>
      )
    }
    if (trimmed.length < SEARCH_MIN_CHARS) {
      return (
        <div className="empty-state empty-state-inline">
          <h3>消息正文要两个字以上</h3>
          <p>一个字只能找会话名；正文按相邻两字建索引，凑两个字才搜得到。</p>
        </div>
      )
    }
    if (groups.length === 0) {
      return (
        <div className="empty-state empty-state-inline">
          <h3>{nothingAtAll ? `没找到「${trimmed}」` : '没有命中的消息'}</h3>
          <p>{nothingAtAll ? '会话名里没有它，消息正文里也没有命中的消息。换个词试试。' : '换个关键词试试。'}</p>
        </div>
      )
    }
    return groups.map((group) => (
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
            <span className="search-hit-snippet">{markSnippet(humanPreview(hit.snippet), trimmed)}</span>
            <span className="search-hit-meta">
              {nameOf(hit.agentId)} · {formatTime(hit.createdAt)}
            </span>
          </button>
        ))}
      </div>
    ))
  }

  return (
    <>
      {/* 折叠键：必须是 .list-panel 的**直接子节点**（宿主把本组件挂在
          <aside className="list-panel"> 里，而本组件返回片段，所以放在片段
          开头就落在 .list-panel 上）——塞进 .list-panel-header 会被收起态的
          visibility:hidden 一起藏掉，那把展开键就再也够不着了。
          样式表（styles.css 的 .list-panel-toggle）早就写好了，收起态下它
          移到窄边左侧；此前缺的是这个按钮本身。 */}
      {onToggleCollapsed !== undefined && (
        <button
          type="button"
          className="list-panel-toggle"
          title={collapsed === true ? '展开会话列表' : '收起会话列表'}
          aria-label={collapsed === true ? '展开会话列表' : '收起会话列表'}
          aria-expanded={collapsed !== true}
          onClick={onToggleCollapsed}
        >
          <Icon name={collapsed === true ? 'chevron-right' : 'chevron-left'} size={16} />
        </button>
      )}
      <div className="list-panel-header">
        <span className="search-box-wrap">
          <Icon name="search" size={16} className="search-box-icon" />
          <input
            ref={searchRef}
            className="search-box has-icon"
            placeholder="搜索会话与消息"
            value={query}
            aria-label="搜索会话与消息"
            aria-keyshortcuts="Control+K Meta+K"
            onChange={(event) => {
              setQuery(event.target.value)
            }}
          />
        </span>
        {trimmed.length > 0 && (
          <p className="preview">
            {searchState === 'loading'
              ? '正在搜消息正文…'
              : searchState === 'unavailable'
                ? '全文搜索暂不可用，这里只能按会话名找。'
                : trimmed.length < SEARCH_MIN_CHARS
                  ? '会话名一个字就能找；消息正文凑两个字更准。'
                  : `${filtered.length} 个会话 · ${hits.length} 条消息命中「${trimmed}」`}
          </p>
        )}
      </div>
      {/* data-windowed：告诉样式表「这列是窗口化的」，让它把行进场的默认动画关掉，
          只对组件显式标记的 .is-animated 首帧行放行。少了它，滚动时整列逐条重播。
          onKeyDown 挂在容器上：方向键要在**行之间**走（roving tabindex），
          焦点在某一行的按钮上，事件冒泡到这里由它统一分派。 */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 方向键导航的容器，事件由行内按钮冒泡上来 */}
      <div className="conversation-list" data-windowed="true" ref={scrollRef} onKeyDown={onListKeyDown}>
        {/* 会话那一节：没有搜索词时它就是整张列表，有搜索词时它只留命中的那些。
            两节同在、同一套结果——不再有"满两个字就换成另一种视图"那回事，
            "按会话名找会话"因此才真的能用。 */}
        <section className="search-section" data-section="conversations" aria-label="会话">
          {searching && <p className="search-section-title">会话</p>}
          {loading === true ? (
            <ConversationSkeleton />
          ) : filtered.length === 0 ? (
            searching ? (
              <p className="search-section-empty">没有叫「{trimmed}」的会话</p>
            ) : (
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
            )
          ) : (
            <>
              <div data-window-pad="top" aria-hidden="true" style={{ height: windowed.padTop }} />
              {rows.visible.map((conversation, index) => {
                const texts = rowTexts(conversation)
                return (
                  <div
                    key={conversation.id}
                    // 行是布局容器：行尾要放操作按钮，而 button 里嵌 button 是无效 HTML。
                    className={`conversation-item ${conversation.id === activeId ? 'is-active' : ''} ${
                      animatedRef.current?.has(conversation.id) === true ? 'is-animated' : ''
                    }`}
                    // stagger 的 --i 是「这条会话在列表里的位置」：给整表下标，窗口化之后
                    // 同一个会话滚进滚出也不会换值（样式表把延迟封顶在 8 档，不会久等）。
                    // view-transition-name 拼进同一份内联样式（不是另起一份把它盖掉）：
                    // 删除/置顶后浏览器靠它把「同一行」认出来，其余行才会补间上移，而不是瞬变。
                    style={{
                      ...stagger(windowed.start + index),
                      viewTransitionName: rowTransitionName('conv', conversation.id),
                    }}
                  >
                    <button
                      ref={(node) => {
                        if (node === null) rowRefs.current.delete(conversation.id)
                        else rowRefs.current.set(conversation.id, node)
                      }}
                      type="button"
                      className="conversation-item-main"
                      style={ROW_MAIN}
                      aria-current={conversation.id === activeId}
                      // roving tabindex：整张列表只占一个 Tab 位，↑↓ 在行间走。
                      tabIndex={conversation.id === rovingId ? 0 : -1}
                      onFocus={() => {
                        setFocusId(conversation.id)
                      }}
                      onClick={() => {
                        onSelect(conversation.id)
                      }}
                    >
                      {avatarOf(conversation)}
                      <div className="conversation-item-body">
                        <div className="conversation-item-top">
                          {/* 徽标在 `<strong>` **外面**。
                              放在里面时，它会占掉标题那 122px 预算里的一大截：列表栏
                              300px 减去内边距、48px 头像、行尾的 ⋯ 按钮与时间戳，
                              标题实得就一百多像素——「置顶 + 主动」两个徽标一挂，
                              会话名只剩一个「…」，用户根本认不出哪条是哪条。
                              徽标移到外面后，标题独占截断盒子，徽标自己也不会被截。 */}
                          {(conversation.pinned ?? false) && <span className="badge conversation-item-flag">置顶</span>}
                          {/* 主动消息的角标：点这一行就进那个会话，看到的是它自己开口说的回顾，
                          不是用户问出来的对话。 */}
                          {conversation.proactive === true && (
                            <span className="badge conversation-item-flag" data-proactive="true">
                              主动
                            </span>
                          )}
                          <strong>{texts.title}</strong>
                          <time>{formatTime(conversation.updatedAt)}</time>
                        </div>
                        <div className="conversation-item-bottom">
                          <span className="preview">{texts.preview}</span>
                          {/* 静音与未读**并存**，不是二选一：静音把未读数整个换掉之后，
                              「静音且有 3 条未读」和「静音且没有未读」长得一模一样，
                              而最该被提醒的那一批恰恰被静音吞了。 */}
                          {conversation.muted === true && (
                            <span className="conversation-item-flag is-muted">已静音</span>
                          )}
                          {(conversation.unreadCount ?? 0) > 0 && (
                            <span className="unread-badge">
                              {(conversation.unreadCount ?? 0) > 99 ? '99+' : conversation.unreadCount}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                    <span className="conversation-item-actions" style={ROW_ACTIONS}>
                      <button
                        type="button"
                        className="conversation-more"
                        ref={(node) => {
                          // 只记当前展开的那一个：Esc 关闭后要把焦点还回它。
                          if (actionFor === conversation.id) triggerRef.current = node
                        }}
                        aria-label={`「${conversation.title || nameOf(conversation.memberAgentIds[0] ?? '')}」的操作`}
                        aria-expanded={actionFor === conversation.id}
                        title={
                          conversation.kind === 'group' && onEditGroup !== undefined
                            ? '群设置 / 置顶 / 静音 / 删除'
                            : '置顶 / 静音 / 删除'
                        }
                        onClick={() => {
                          toggleMenu(conversation.id)
                        }}
                        onKeyDown={(event) => {
                          // 键盘也要能开：↓ 直接进菜单第一项，↑ 进最后一项。
                          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                          event.preventDefault()
                          if (actionFor === conversation.id) return
                          toggleMenu(conversation.id)
                        }}
                      >
                        <Icon name="ellipsis" size={16} />
                      </button>
                    </span>
                    {actionFor === conversation.id && (
                      // biome-ignore lint/a11y/noStaticElementInteractions: 浮层本身不是控件，↑↓/Esc 是替里面那几个按钮转交的
                      <div
                        className="conversation-item-menu"
                        ref={menuRef}
                        style={flippedFor === conversation.id ? MENU_ABOVE : undefined}
                        onKeyDown={onMenuKeyDown}
                      >
                        {conversation.kind === 'group' && onEditGroup !== undefined && (
                          <button
                            type="button"
                            className="btn btn-mini"
                            onClick={() => {
                              closeMenu(false)
                              onEditGroup(conversation)
                            }}
                          >
                            群设置
                          </button>
                        )}
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
                            closeMenu(false)
                            setDeleting(conversation)
                          }}
                        >
                          删除
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
              <div data-window-pad="bottom" aria-hidden="true" style={{ height: windowed.padBottom }} />
            </>
          )}
        </section>
        {searching && (
          <section className="search-section" data-section="messages" aria-label="消息">
            <p className="search-section-title">消息</p>
            {renderMessageSection()}
          </section>
        )}
      </div>
      {deleting !== undefined && (
        <ConfirmDialog
          title={`删除「${deleting.title || nameOf(deleting.memberAgentIds[0] ?? '')}」？`}
          body="这个会话会从列表里消失，里面的消息仍然留在本机——删完还有一次撤销的机会。"
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
              toast.error(`删除失败：${humanError(cause, '这个会话还在，重新确认一次')}`)
              return
            }
            if (mounted.current) {
              // 补间只包本地的状态更新（上面的 await 是网络请求，进不了快照）：这一行
              // 连同确认弹窗一起退场，后面的行补间上移。onChanged 是让宿主重拉整表，
              // 要等下一次渲染才见效，放在补间外——包进去也补不动它自己的请求。
              withViewTransition(() => {
                setRemoved((prev) => {
                  return [...prev, deleting.id]
                })
                setDeleting(undefined)
                setActionFor(undefined)
              })
              onChanged?.()
            }
            // 撤销入口：删除是最容易手滑的一下，给一次反悔的机会（软删，消息还在库里）。
            toast.success('会话已删除', {
              duration: 8000,
              action: {
                label: '撤销',
                run: () => {
                  undoDelete(deleting.id)
                },
              },
            })
          }}
        />
      )}
    </>
  )
}
