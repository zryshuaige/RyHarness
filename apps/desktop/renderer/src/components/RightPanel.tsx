import { memo, useMemo, useState } from 'react'
import type { AgentDef, ApiClient, Conversation } from '../api.ts'
import { toolLabel } from '../lib/tool-labels.ts'
import type { ChatStore, RelayItem } from '../store.ts'
import { useChat } from '../store.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { GroupEvolution, RelayTimeline } from './GroupEvolution.tsx'
import { Icon } from './Icon.tsx'
import { MemoryPanel } from './MemoryPanel.tsx'
import { PlaybookPanel } from './PlaybookPanel.tsx'

/**
 * 右栏信息板：单聊 = 资料卡 + 产物；群聊 = 成员网格 + 调度时间线 + 产物。
 *
 * 自己订阅 chat store（不再由 App 根组件转发 props）：App 每 40ms 的 store 通知
 * 不再带动整棵树重渲染，且直接用 snapshot.messages 引用、不做数组拷贝。
 *
 * 三个内容组件全部 memo：它们展示的资料/产物/轨迹在流式期间一个 token 都不会变，
 * 没有理由跟着 25Hz 的通知重绘。
 */
export function RightPanel({
  api,
  store,
  conversation,
  agents,
  conversations,
  fileUrl,
  collapsed,
  onToggle,
}: {
  api: ApiClient
  store: ChatStore
  conversation: Conversation | undefined
  agents: AgentDef[]
  conversations: Conversation[]
  fileUrl: (name: string) => string
  collapsed: boolean
  onToggle: () => void
}) {
  const [memoryFor, setMemoryFor] = useState<AgentDef | undefined>(undefined)
  const [playbookFor, setPlaybookFor] = useState<AgentDef | undefined>(undefined)
  const snapshot = useChat(store)
  // 产物走 store 的单一 selector：内容没变时返回同一数组身份，避免每 token 重扫 parts。
  const artifacts = store.artifacts()
  const conversationTitles = useMemo(() => {
    return new Map(
      conversations.map((c) => {
        return [c.id, c.title]
      }),
    )
  }, [conversations])
  if (collapsed) {
    return (
      <aside className="right-panel is-collapsed">
        <button type="button" className="panel-expand-btn" title="展开信息板" onClick={onToggle}>
          <Icon name="panel-right" size={14} />
        </button>
      </aside>
    )
  }
  return (
    <aside className="right-panel">
      <span className="panel-banner" aria-hidden="true" />
      <button type="button" className="right-panel-toggle" title="收起信息板" onClick={onToggle}>
        <Icon name="chevron-right" size={13} />
      </button>
      <div className="panel-body">
        {conversation === undefined ? (
          <p className="panel-empty">选择一个会话查看详情</p>
        ) : conversation.kind === 'direct' ? (
          <DirectProfile
            agentId={conversation.memberAgentIds[0]}
            agents={agents}
            artifacts={artifacts}
            fileUrl={fileUrl}
            onShowMemories={setMemoryFor}
            onShowPlaybook={setPlaybookFor}
          />
        ) : (
          <GroupInfo
            conversation={conversation}
            agents={agents}
            relays={snapshot.relays}
            artifacts={artifacts}
            fileUrl={fileUrl}
            onShowMemories={setMemoryFor}
            onShowPlaybook={setPlaybookFor}
          />
        )}
      </div>
      {playbookFor !== undefined && (
        <PlaybookPanel
          api={api}
          agentId={playbookFor.id}
          agentName={playbookFor.name}
          onClose={() => {
            setPlaybookFor(undefined)
          }}
        />
      )}
      {memoryFor !== undefined && (
        <MemoryPanel
          api={api}
          agentId={memoryFor.id}
          agentName={memoryFor.name}
          conversationTitles={conversationTitles}
          onClose={() => {
            setMemoryFor(undefined)
          }}
        />
      )}
    </aside>
  )
}

const ArtifactList = memo(function ArtifactList({
  artifacts,
  fileUrl,
}: {
  artifacts: { callId: string; name: string; size: number; mime: string }[]
  fileUrl: (name: string) => string
}) {
  if (artifacts.length === 0) {
    return <p className="panel-empty">本会话还没有产物文件</p>
  }
  return (
    <ul className="artifact-list">
      {artifacts.map((artifact) => (
        <li key={artifact.callId}>
          <span aria-hidden="true">
            <Icon name="file" size={15} />
          </span>
          <span className="artifact-name" title={artifact.name}>
            {artifact.name}
          </span>
          <a href={fileUrl(artifact.name)} target="_blank" rel="noreferrer">
            打开
          </a>
        </li>
      ))}
    </ul>
  )
})

const DirectProfile = memo(function DirectProfile({
  agentId,
  agents,
  artifacts,
  fileUrl,
  onShowMemories,
  onShowPlaybook,
}: {
  agentId: string | undefined
  agents: AgentDef[]
  artifacts: { callId: string; name: string; size: number; mime: string }[]
  fileUrl: (name: string) => string
  onShowMemories: (agent: AgentDef) => void
  onShowPlaybook: (agent: AgentDef) => void
}) {
  const agent = agents.find((a) => {
    return a.id === agentId
  })
  if (agent === undefined) return <p className="panel-empty">未找到 agent</p>
  return (
    <>
      <div className="profile-head">
        <Avatar avatarKey={agent.avatar} name={agent.name} seed={agent.id} size={80} className="avatar-lg-ring" />
        <h3>
          {agent.name}
          {agent.isBuiltin && <span className="badge">内置</span>}
        </h3>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            className="btn"
            onClick={() => {
              onShowMemories(agent)
            }}
          >
            <Icon name="brain" size={15} /> 记忆
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              onShowPlaybook(agent)
            }}
          >
            <Icon name="check" size={15} /> 经验手册
          </button>
        </div>
      </div>
      <dl className="profile-fields">
        <dt>人设</dt>
        <dd className="profile-prompt">{agent.systemPrompt}</dd>
        <dt>模型</dt>
        <dd>
          {agent.provider} / {agent.model}
        </dd>
        <dt>工具</dt>
        <dd>
          {agent.tools.length === 0 ? (
            <span className="panel-empty">无（纯对话）</span>
          ) : (
            <span className="tool-chips">
              {agent.tools.map((tool) => {
                return (
                  <span key={tool} className="chip">
                    {toolLabel(tool)}
                  </span>
                )
              })}
            </span>
          )}
        </dd>
      </dl>
      <h4>本会话产物</h4>
      <ArtifactList artifacts={artifacts} fileUrl={fileUrl} />
    </>
  )
})

const GroupInfo = memo(function GroupInfo({
  conversation,
  agents,
  relays,
  artifacts,
  fileUrl,
  onShowMemories,
  onShowPlaybook,
}: {
  conversation: Conversation
  agents: AgentDef[]
  relays: RelayItem[]
  artifacts: { callId: string; name: string; size: number; mime: string }[]
  fileUrl: (name: string) => string
  onShowMemories: (agent: AgentDef) => void
  onShowPlaybook: (agent: AgentDef) => void
}) {
  const members = conversation.memberAgentIds
    .map((id) => {
      return agents.find((a) => {
        return a.id === id
      })
    })
    .filter((a): a is AgentDef => {
      return a !== undefined
    })
  const nameOf = (id: string): string => {
    return (
      agents.find((a) => {
        return a.id === id
      })?.name ?? id
    )
  }
  return (
    <>
      <h4>成员（{members.length}）</h4>
      <div className="member-grid">
        {members.map((member) => (
          <div key={member.id} className="member-cell">
            <Avatar avatarKey={member.avatar} name={member.name} seed={member.id} size={44} />
            <span className="member-name">
              {member.name}
              {conversation.dispatcherAgentId === member.id ? ' ★' : ''}
            </span>
          </div>
        ))}
      </div>
      {/* 群聊此前完全没有记忆/经验手册入口，"群里的人也在进化"这件事看不见。 */}
      <GroupEvolution members={members} onShowMemories={onShowMemories} onShowPlaybook={onShowPlaybook} />
      <h4>调度轨迹</h4>
      <RelayTimeline relays={relays} nameOf={nameOf} />
      <h4>本会话产物</h4>
      <ArtifactList artifacts={artifacts} fileUrl={fileUrl} />
    </>
  )
})
