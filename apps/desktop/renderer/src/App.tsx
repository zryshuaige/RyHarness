import { useEffect, useMemo, useState } from 'react'
import { ApiClient, resolveApiBase } from './api.ts'
import type { AgentDef, AgentTemplate, Conversation, ProviderInfo } from './api.ts'
import { ChatStore } from './store.ts'
import { useChat } from './store.ts'
import { ConversationList } from './components/ConversationList.tsx'
import { ChatView } from './components/ChatView.tsx'
import { RightPanel } from './components/RightPanel.tsx'
import { ContactsPage, CreateAgentModal, CreateGroupModal } from './components/ContactsPage.tsx'
import { MePage } from './components/MePage.tsx'
import { AppIcon } from './components/AppIcon.tsx'

type Tab = 'chats' | 'contacts' | 'me'

type Theme = 'light' | 'dark'

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

const RAIL_TABS: { key: Tab; icon: string; label: string }[] = [
  { key: 'chats', icon: '💬', label: '聊天' },
  { key: 'contacts', icon: '👥', label: '通讯录' },
  { key: 'me', icon: '🐱', label: '我的' },
]

export function App() {
  const api = useMemo(() => { return new ApiClient(resolveApiBase()) }, [])
  const [tab, setTab] = useState<Tab>('chats')
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [agents, setAgents] = useState<AgentDef[]>([])
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [modal, setModal] = useState<'agent' | 'group' | undefined>(undefined)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [store] = useState(() => { return new ChatStore() })
  const snapshot = useChat(store)

  useEffect(() => { applyTheme(theme) }, [theme])

  const changeTheme = (next: Theme): void => {
    setTheme(next)
    try {
      localStorage.setItem('ryagent-theme', next)
    } catch {
      // 忽略持久化失败。
    }
  }

  const refresh = async (): Promise<void> => {
    try {
      const [agentRes, templateRes, providerRes, conversationRes] = await Promise.all([
        api.listAgents(), api.templates(), api.providers(), api.conversations(),
      ])
      setAgents(agentRes.agents)
      setTemplates(templateRes.templates)
      setProviders(providerRes.providers)
      setConversations(conversationRes.conversations)
      store.setAgentNames(new Map(agentRes.agents.map((a) => { return [a.id, a.name] })))
      setLoadError(undefined)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setListLoading(false)
    }
  }

  useEffect(() => { void refresh() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const active = conversations.find((c) => { return c.id === activeId })
  const ryen = agents.find((a) => { return a.id === 'ryen' })

  /** 与 agent 的单聊：找已有 direct 会话，没有就建。 */
  const openDirectChat = async (agentId: string): Promise<void> => {
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
      setConversations((prev) => { return [conversation, ...prev] })
      setActiveId(conversation.id)
      setTab('chats')
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }

  if (loadError !== undefined) {
    return (
      <div className="app-error">
        <h2>无法连接 RyAgent 后端</h2>
        <p>{loadError}</p>
        <p>请确认桌面服务已启动（Electron 内嵌或 <code>pnpm --filter @ryagent/server dev</code>）。</p>
      </div>
    )
  }

  return (
    <div className="app-shell">
      {/* 栏 1：72px icon rail */}
      <nav className="rail" aria-label="主导航">
        <span className="rail-logo"><AppIcon size={40} /></span>
        {RAIL_TABS.map((item) => (
          <button
            key={item.key}
            className={`rail-tab ${tab === item.key ? 'is-active' : ''}`}
            onClick={() => { setTab(item.key) }}
          >
            <span className="rail-icon" aria-hidden="true">{item.icon}</span>
            {item.label}
          </button>
        ))}
        <span className="rail-spacer" />
        <button
          className="rail-icon-btn"
          title={theme === 'light' ? '切换到暗色' : '切换到浅色'}
          onClick={() => { changeTheme(theme === 'light' ? 'dark' : 'light') }}
        >
          {theme === 'light' ? '🌙' : '☀️'}
        </button>
        <button className="rail-icon-btn" title="我的 / 设置" onClick={() => { setTab('me') }}>⚙️</button>
      </nav>

      {/* 栏 2：列表栏（聊天 tab）或空（通讯录/我的为整页） */}
      {tab === 'chats' && (
        <aside className="list-panel">
          <ConversationList
            conversations={conversations}
            agents={agents}
            activeId={activeId}
            loading={listLoading}
            onSelect={(id) => { setActiveId(id) }}
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
            onRead={() => { void refresh() }}
          />
        ) : (
          <section className="chat-view">
            <div className="chat-scroll">
              <div className="empty-state" style={{ height: '100%' }}>
                <span className="empty-cat"><AppIcon size={96} /></span>
                <h3>挑一个会话，或者开始新的</h3>
                <p>喵——今天的安排，交给我和同事们就好。</p>
              </div>
            </div>
          </section>
        )
      ) : tab === 'contacts' ? (
        <ContactsPage
          agents={agents}
          templates={templates}
          providers={providers}
          onCreateAgent={() => { setModal('agent') }}
          onCreateGroup={() => { setModal('group') }}
          onChat={(agentId) => { void openDirectChat(agentId) }}
        />
      ) : (
        <MePage api={api} ryen={ryen} providers={providers} theme={theme} onThemeChange={changeTheme} />
      )}

      {tab === 'chats' && active !== undefined && (
        <RightPanel
          api={api}
          conversation={active}
          agents={agents}
          conversations={conversations}
          relays={snapshot.relays}
          messages={[...store.getSnapshot().messages]}
          fileUrl={(name) => { return api.fileUrl(name) }}
          collapsed={panelCollapsed}
          onToggle={() => { setPanelCollapsed((v) => { return !v }) }}
        />
      )}

      {modal === 'agent' && (
        <CreateAgentModal
          templates={templates}
          providers={providers}
          onClose={() => { setModal(undefined) }}
          onSubmit={async (input) => {
            await api.createAgent(input)
            await refresh()
          }}
        />
      )}
      {modal === 'group' && (
        <CreateGroupModal
          agents={agents}
          onClose={() => { setModal(undefined) }}
          onSubmit={async (input) => {
            const { conversation } = await api.createConversation({ kind: 'group', ...input })
            await refresh()
            setActiveId(conversation.id)
            setTab('chats')
          }}
        />
      )}
    </div>
  )
}
