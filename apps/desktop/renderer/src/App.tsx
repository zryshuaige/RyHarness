import { useEffect, useMemo, useState } from 'react'
import { ApiClient, resolveApiBase } from './api.ts'
import type { AgentDef, AgentTemplate, Conversation, ProviderInfo } from './api.ts'
import { ChatStore } from './store.ts'
import { ConversationList } from './components/ConversationList.tsx'
import { ChatView } from './components/ChatView.tsx'
import { RightPanel } from './components/RightPanel.tsx'
import { ContactsPage, CreateAgentModal, CreateGroupModal, SettingsModal } from './components/ContactsPage.tsx'

type Page = 'chat' | 'contacts'

export function App() {
  const api = useMemo(() => { return new ApiClient(resolveApiBase()) }, [])
  const [page, setPage] = useState<Page>('chat')
  const [agents, setAgents] = useState<AgentDef[]>([])
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [modal, setModal] = useState<'agent' | 'group' | 'settings' | undefined>(undefined)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [store] = useState(() => { return new ChatStore() })

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
      setPage('chat')
      return
    }
    try {
      const { conversation } = await api.createConversation({ kind: 'direct', agentId })
      setConversations((prev) => { return [conversation, ...prev] })
      setActiveId(conversation.id)
      setPage('chat')
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
      {page === 'contacts' ? (
        <ContactsPage
          agents={agents}
          templates={templates}
          providers={providers}
          onBack={() => { setPage('chat') }}
          onCreateAgent={() => { setModal('agent') }}
          onCreateGroup={() => { setModal('group') }}
          onChat={(agentId) => { void openDirectChat(agentId) }}
        />
      ) : (
        <>
          <ConversationList
            conversations={conversations}
            agents={agents}
            activeId={activeId}
            onSelect={(id) => { setActiveId(id) }}
            onOpenContacts={() => { setPage('contacts') }}
            onOpenSettings={() => { setModal('settings') }}
          />
          {active !== undefined ? (
            <ChatView
              key={active.id}
              api={api}
              conversation={active}
              agents={agents}
              store={store}
              onRead={() => { void refresh() }}
            />
          ) : (
            <section className="chat-view chat-empty">
              <p>选择一个会话，或去通讯录找 agent 聊聊。</p>
            </section>
          )}
          <RightPanel
            conversation={active}
            agents={agents}
            relays={store.getSnapshot().relays}
            collapsed={panelCollapsed}
            onToggle={() => { setPanelCollapsed((v) => { return !v }) }}
          />
        </>
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
            setPage('chat')
          }}
        />
      )}
      {modal === 'settings' && (
        <SettingsModal
          ryen={ryen}
          providers={providers}
          onClose={() => { setModal(undefined) }}
          onPatchRyen={async (patch) => {
            if (ryen !== undefined) await api.patchAgent(ryen.id, patch)
            await refresh()
          }}
        />
      )}
    </div>
  )
}
