import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentDef, AgentTemplate, Conversation, ProviderInfo } from './api.ts'
import { ApiClient } from './api.ts'
import { AppIcon } from './components/AppIcon.tsx'
import { ChatView } from './components/ChatView.tsx'
import { ConfirmDialog } from './components/ConfirmDialog.tsx'
import { ContactsPage, CreateAgentModal, CreateGroupModal } from './components/ContactsPage.tsx'
import { ConversationList } from './components/ConversationList.tsx'
import type { IconName } from './components/Icon.tsx'
import { Icon } from './components/Icon.tsx'
import { MePage } from './components/MePage.tsx'
import { RightPanel } from './components/RightPanel.tsx'
import { ToastHost } from './components/ToastHost.tsx'
import { WelcomeHome } from './components/WelcomeHome.tsx'
import { useApiBase } from './lib/boot.ts'
import { toast } from './lib/toast.ts'
import { ChatStore } from './store.ts'

type Tab = 'chats' | 'contacts' | 'me'

type Theme = 'light' | 'dark'

/** 主题切换过渡的 class（styles.css 定义 .theme-animating）。 */
const THEME_ANIMATING_CLASS = 'theme-animating'
/** 已读等高频刷新事件的合并窗口（ms）。 */
const REFRESH_DEBOUNCE_MS = 800

function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem('ryagent-theme')
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // 隐私模式下 localStorage 不可用，回退浅色。
  }
  return 'light'
}

/** 应用 documentElement 的 data-theme（供测试与 App 共用）。 */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

const RAIL_TABS: { key: Tab; icon: IconName; label: string }[] = [
  { key: 'chats', icon: 'chat-bubble', label: '聊天' },
  { key: 'contacts', icon: 'users', label: '通讯录' },
  { key: 'me', icon: 'cat-face', label: '我的' },
]

/** 后端就绪前的骨架屏（复用既有样式类，不新增 CSS）。 */
function BootSkeleton() {
  return (
    <div className="app-shell" aria-busy="true">
      <div className="chat-view">
        <div className="chat-scroll">
          <div className="chat-col">
            <p className="chat-hint">正在启动本地服务…</p>
            {[72, 56, 88, 64].map((width, index) => (
              <div className="skeleton-item" key={width}>
                <span className="skeleton" style={{ width, height: 16, borderRadius: 8 }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function App() {
  // 主进程窗口先行启动：后端就绪前先渲染骨架。
  const apiBase = useApiBase()
  const [api, setApi] = useState<ApiClient | undefined>(undefined)
  const [tab, setTab] = useState<Tab>('chats')
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [agents, setAgents] = useState<AgentDef[]>([])
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [modal, setModal] = useState<'agent' | 'group' | undefined>(undefined)
  /** 待确认删除的 agent（确认弹窗内完成，避免 window.confirm 割裂界面）。 */
  const [deletingAgent, setDeletingAgent] = useState<AgentDef | undefined>(undefined)
  /** 新建 agent 时的初始模板（通讯录模板轨带入）。 */
  const [agentTemplateKey, setAgentTemplateKey] = useState<string | undefined>(undefined)
  /** 非空 = 编辑既有 agent。 */
  const [editingAgent, setEditingAgent] = useState<AgentDef | undefined>(undefined)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [store] = useState(() => {
    return new ChatStore()
  })
  // 注意：App **不**订阅 chat store——流式 token 的 40ms 通知不应该带动整棵树重渲染。
  // 右栏在 RightPanel.tsx 内自行 useChat(store)。

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    if (apiBase === undefined) return
    setApi(new ApiClient(apiBase))
  }, [apiBase])

  const changeTheme = (next: Theme): void => {
    if (next === theme) return
    // 过渡类先挂上，data-theme 翻转（useEffect）发生在其后；过渡结束再摘掉。
    const body = document.body
    body.classList.add(THEME_ANIMATING_CLASS)
    requestAnimationFrame(() => {
      setTimeout(() => {
        body.classList.remove(THEME_ANIMATING_CLASS)
      }, 250)
    })
    setTheme(next)
    try {
      localStorage.setItem('ryagent-theme', next)
    } catch {
      // 忽略持久化失败。
    }
  }

  const runRefresh = useCallback(
    async (client: ApiClient): Promise<void> => {
      try {
        const [agentRes, templateRes, providerRes, conversationRes] = await Promise.all([
          client.listAgents(),
          client.templates(),
          client.providers(),
          client.conversations(),
        ])
        setAgents((prev) => {
          return sameList(prev, agentRes.agents) ? prev : agentRes.agents
        })
        setTemplates((prev) => {
          return sameList(prev, templateRes.templates) ? prev : templateRes.templates
        })
        setProviders((prev) => {
          return sameList(prev, providerRes.providers) ? prev : providerRes.providers
        })
        setConversations((prev) => {
          return sameList(prev, conversationRes.conversations) ? prev : conversationRes.conversations
        })
        store.setAgentNames(
          new Map(
            agentRes.agents.map((a) => {
              return [a.id, a.name]
            }),
          ),
        )
        setLoadError(undefined)
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error))
      } finally {
        setListLoading(false)
      }
    },
    [store],
  )

  /** 全量刷新：并发调用合并为一次，飞行中再来请求只排一次尾随刷新。 */
  const refreshGate = useRef<{ inflight: Promise<void> | null; queued: boolean }>({
    inflight: null,
    queued: false,
  })
  const apiRef = useRef<ApiClient | undefined>(api)
  apiRef.current = api
  const refreshRef = useRef<(() => Promise<void>) | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    const client = apiRef.current
    if (client === undefined) return
    const gate = refreshGate.current
    if (gate.inflight !== null) {
      gate.queued = true
      await gate.inflight
      return
    }
    gate.inflight = runRefresh(client).finally(() => {
      const g = refreshGate.current
      g.inflight = null
      if (g.queued) {
        g.queued = false
        void refreshRef.current?.()
      }
    })
    await gate.inflight
  }, [runRefresh])
  refreshRef.current = refresh

  /** 尾随合并：已读等高频事件在窗口内只发一次全量刷新。 */
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scheduleRefresh = useCallback((): void => {
    if (refreshTimer.current !== undefined) clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined
      void refresh()
    }, REFRESH_DEBOUNCE_MS)
  }, [refresh])

  useEffect(() => {
    if (api === undefined) return
    void refresh()
  }, [api, refresh])

  const active = conversations.find((c) => {
    return c.id === activeId
  })
  const ryen = agents.find((a) => {
    return a.id === 'ryen'
  })

  /** 会话已读：本地把未读数归零（markRead 响应已带 lastReadSeq），不再发 4 个 HTTP。 */
  const markConversationRead = useCallback((conversationId: string): void => {
    setConversations((prev) => {
      const index = prev.findIndex((c) => {
        return c.id === conversationId
      })
      if (index < 0) return prev
      const target = prev[index]!
      if ((target.unreadCount ?? 0) === 0) return prev
      const next = prev.slice()
      next[index] = { ...target, unreadCount: 0 }
      return next
    })
  }, [])

  /** 与 agent 的单聊：找已有 direct 会话，没有就建。 */
  const openDirectChat = async (agentId: string): Promise<void> => {
    if (api === undefined) return
    const existing = conversations.find((c) => {
      return c.kind === 'direct' && c.memberAgentIds.length === 1 && c.memberAgentIds[0] === agentId
    })
    if (existing !== undefined) {
      setActiveId(existing.id)
      setTab('chats')
      return
    }
    try {
      const { conversation } = await api.createConversation({ kind: 'direct', agentId })
      setConversations((prev) => {
        return [conversation, ...prev]
      })
      setActiveId(conversation.id)
      setTab('chats')
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }

  /** 欢迎页输入框/建议 chip 的回车：打开（或创建）与 Ryen 的单聊并发送这句话。 */
  const startChatWithRyen = async (text: string): Promise<void> => {
    if (api === undefined || ryen === undefined) return
    try {
      const existing = conversations.find((c) => {
        return c.kind === 'direct' && c.memberAgentIds.length === 1 && c.memberAgentIds[0] === ryen.id
      })
      const conversationId =
        existing !== undefined
          ? existing.id
          : (await api.createConversation({ kind: 'direct', agentId: ryen.id })).conversation.id
      if (existing === undefined) await refresh()
      setActiveId(conversationId)
      setTab('chats')
      await api.postMessage(conversationId, text)
    } catch (error) {
      toast.error(`没能发出这句话：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (api === undefined) return <BootSkeleton />

  if (loadError !== undefined) {
    return (
      <div className="app-error">
        <h2>无法连接 RyAgent 后端</h2>
        <p>{loadError}</p>
        <p>
          请确认桌面服务已启动（Electron 内嵌或 <code>pnpm --filter @ryagent/server dev</code>）。
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setLoadError(undefined)
            setListLoading(true)
            void refresh()
          }}
        >
          重试
        </button>
      </div>
    )
  }

  return (
    <div className="app-shell">
      {/* 栏 1：72px icon rail */}
      <nav className="rail" aria-label="主导航">
        <span className="rail-logo">
          <AppIcon size={40} />
        </span>
        {RAIL_TABS.map((item) => (
          <button
            type="button"
            key={item.key}
            className={`rail-tab ${tab === item.key ? 'is-active' : ''}`}
            onClick={() => {
              setTab(item.key)
            }}
          >
            <span className="rail-icon" aria-hidden="true">
              {/* 「我的」用品牌橘猫，其余用线性图标——全局只保留一套图形语言。 */}
              {item.key === 'me' ? <AppIcon size={22} /> : <Icon name={item.icon} size={22} />}
            </span>
            {item.label}
          </button>
        ))}
        <span className="rail-spacer" />
        <button
          type="button"
          className="rail-icon-btn"
          title={theme === 'light' ? '切换到暗色' : '切换到浅色'}
          onClick={() => {
            changeTheme(theme === 'light' ? 'dark' : 'light')
          }}
        >
          <Icon name={theme === 'light' ? 'moon' : 'sun'} size={18} />
        </button>
        <button
          type="button"
          className="rail-icon-btn"
          title="我的 / 设置"
          onClick={() => {
            setTab('me')
          }}
        >
          <Icon name="gear" size={18} />
        </button>
      </nav>

      {/* 栏 2：列表栏（聊天 tab）或空（通讯录/我的为整页） */}
      {tab === 'chats' && (
        <aside className="list-panel">
          <ConversationList
            conversations={conversations}
            agents={agents}
            activeId={activeId}
            loading={listLoading}
            onSelect={(id) => {
              setActiveId(id)
            }}
            onGoContacts={() => {
              setTab('contacts')
            }}
          />
        </aside>
      )}

      {/* 栏 3：内容区 */}
      {tab === 'chats' ? (
        active !== undefined ? (
          <ChatView
            key={active.id}
            api={api}
            conversation={active}
            agents={agents}
            store={store}
            onRead={() => {
              markConversationRead(active.id)
              // 列表里的预览/时间戳仍可能过期，用尾随合并刷新兜底（切会话再快也只发一次）。
              scheduleRefresh()
            }}
          />
        ) : (
          <section className="chat-view">
            <div className="chat-scroll">
              <WelcomeHome
                ryen={ryen}
                agents={agents}
                conversations={conversations}
                providers={providers}
                onSaveApiKey={async (providerId, apiKey) => {
                  await api.setApiKey(providerId, apiKey)
                  await refresh()
                }}
                onSend={(text) => {
                  void startChatWithRyen(text)
                }}
                onOpenConversation={(id) => {
                  setActiveId(id)
                }}
              />
            </div>
          </section>
        )
      ) : tab === 'contacts' ? (
        <ContactsPage
          agents={agents}
          templates={templates}
          providers={providers}
          onCreateAgent={(templateKey) => {
            setAgentTemplateKey(templateKey)
            setEditingAgent(undefined)
            setModal('agent')
          }}
          onEditAgent={(agent) => {
            setEditingAgent(agent)
            setAgentTemplateKey(undefined)
            setModal('agent')
          }}
          onDeleteAgent={(agent) => {
            setDeletingAgent(agent)
          }}
          onCreateGroup={() => {
            setModal('group')
          }}
          onChat={(agentId) => {
            void openDirectChat(agentId)
          }}
        />
      ) : (
        <MePage
          api={api}
          ryen={ryen}
          providers={providers}
          theme={theme}
          onThemeChange={changeTheme}
          onRyenPatched={() => {
            void refresh()
          }}
        />
      )}

      {tab === 'chats' && active !== undefined && (
        <RightPanel
          api={api}
          store={store}
          conversation={active}
          agents={agents}
          conversations={conversations}
          fileUrl={(name) => {
            return api.fileUrl(name)
          }}
          collapsed={panelCollapsed}
          onToggle={() => {
            setPanelCollapsed((v) => {
              return !v
            })
          }}
        />
      )}

      {modal === 'agent' && (
        <CreateAgentModal
          templates={templates}
          providers={providers}
          {...(agentTemplateKey === undefined ? {} : { initialTemplateKey: agentTemplateKey })}
          {...(editingAgent === undefined ? {} : { editing: editingAgent })}
          onClose={() => {
            setModal(undefined)
            setEditingAgent(undefined)
            setAgentTemplateKey(undefined)
          }}
          onSubmit={async (input) => {
            if (editingAgent === undefined) await api.createAgent(input)
            else await api.patchAgent(editingAgent.id, input)
            await refresh()
          }}
        />
      )}
      {modal === 'group' && (
        <CreateGroupModal
          agents={agents}
          onClose={() => {
            setModal(undefined)
          }}
          onSubmit={async (input) => {
            const { conversation } = await api.createConversation({ kind: 'group', ...input })
            await refresh()
            setActiveId(conversation.id)
            setTab('chats')
          }}
        />
      )}
      {deletingAgent !== undefined && (
        <ConfirmDialog
          title={`删除「${deletingAgent.name}」？`}
          body={`「${deletingAgent.name}」会从通讯录里消失，它此前的聊天记录仍留在历史会话中。删除后不可恢复：即使重新建一个同名 agent，那也是一个全新的它，记忆与经验都不会回来。`}
          onCancel={() => {
            setDeletingAgent(undefined)
          }}
          onConfirm={async () => {
            await api.deleteAgent(deletingAgent.id)
            await refresh()
            setDeletingAgent(undefined)
            toast.success(`「${deletingAgent.name}」已删除`)
          }}
        />
      )}
      {/* toast 宿主：会话打开时由 ChatView 挂在输入区上沿（composer 变高不会压住发送键），
          其余页面（欢迎页 / 通讯录 / 我的）由这里兜底——保存、删除的反馈不能只有
          聊天页看得见。任何时刻只有一个宿主在屏上。 */}
      {!(tab === 'chats' && active !== undefined) && <ToastHost />}
    </div>
  )
}

/** 列表内容没变就保持旧引用：省掉一次整树重渲染（refresh 会重复触发）。 */
function sameList<T>(prev: readonly T[], next: readonly T[]): boolean {
  if (prev.length !== next.length) return false
  for (let i = 0; i < prev.length; i++) {
    if (JSON.stringify(prev[i]) !== JSON.stringify(next[i])) return false
  }
  return true
}
