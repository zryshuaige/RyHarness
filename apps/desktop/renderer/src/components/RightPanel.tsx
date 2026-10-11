import { useState } from 'react'
import type { AgentDef, ApiClient, Conversation } from '../api.ts'
import { MemoryPanel } from './MemoryPanel.tsx'
import { Avatar } from './avatars/Avatar.tsx'
import type { RelayItem, UiMessage } from '../store.ts'

const TOOL_LABELS: Record<string, string> = {
  fs_read: '读文件', fs_write: '写文件', shell_exec: '执行命令', file_produce: '产出文件',
}

/** 从消息流收集产物文件。 */
function collectArtifacts(messages: UiMessage[]): { callId: string; name: string; size: number; mime: string }[] {
  const out: { callId: string; name: string; size: number; mime: string }[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind === 'file') out.push({ callId: part.callId, name: part.name, size: part.size, mime: part.mime })
    }
  }
  return out
}

/** 右栏信息板：单聊 = 资料卡 + 产物；群聊 = 成员网格 + 调度时间线 + 产物。 */
export function RightPanel({
  api,
  conversation,
  agents,
  conversations,
  relays,
  messages,
  fileUrl,
  collapsed,
  onToggle,
}: {
  api: ApiClient
  conversation: Conversation | undefined
  agents: AgentDef[]
  conversations: Conversation[]
  relays: RelayItem[]
  messages: UiMessage[]
  fileUrl: (name: string) => string
  collapsed: boolean
  onToggle: () => void
}) {
  const [memoryFor, setMemoryFor] = useState<AgentDef | undefined>(undefined)
  if (collapsed) {
    return (
      <aside className="right-panel is-collapsed">
        <button className="panel-expand-btn" title="展开信息板" onClick={onToggle}>«</button>
      </aside>
    )
  }
  return (
    <aside className="right-panel">
      <button className="right-panel-toggle" title="收起信息板" onClick={onToggle}>»</button>
      <div className="panel-body">
        {conversation === undefined ? (
          <p className="panel-empty">选择一个会话查看详情</p>
        ) : conversation.kind === 'direct' ? (
          <DirectProfile
            agentId={conversation.memberAgentIds[0]}
            agents={agents}
            artifacts={collectArtifacts(messages)}
            fileUrl={fileUrl}
            onShowMemories={setMemoryFor}
          />
        ) : (
          <GroupInfo
            conversation={conversation}
            agents={agents}
            relays={relays}
            artifacts={collectArtifacts(messages)}
            fileUrl={fileUrl}
          />
        )}
      </div>
      {memoryFor !== undefined && (
        <MemoryPanel
          api={api}
          agentId={memoryFor.id}
          agentName={memoryFor.name}
          conversationTitles={new Map(conversations.map((c) => { return [c.id, c.title] }))}
          onClose={() => { setMemoryFor(undefined) }}
        />
      )}
    </aside>
  )
}

function ArtifactList({
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
          <span aria-hidden="true">📄</span>
          <span className="artifact-name" title={artifact.name}>{artifact.name}</span>
          <a href={fileUrl(artifact.name)} target="_blank" rel="noreferrer">打开</a>
        </li>
      ))}
    </ul>
  )
}

function DirectProfile({
  agentId,
  agents,
  artifacts,
  fileUrl,
  onShowMemories,
}: {
  agentId: string | undefined
  agents: AgentDef[]
  artifacts: { callId: string; name: string; size: number; mime: string }[]
  fileUrl: (name: string) => string
  onShowMemories: (agent: AgentDef) => void
}) {
  const agent = agents.find((a) => { return a.id === agentId })
  if (agent === undefined) return <p className="panel-empty">未找到 agent</p>
  return (
    <>
      <div className="profile-head">
        <Avatar avatarKey={agent.avatar} name={agent.name} seed={agent.id} size={80} className="avatar-lg-ring" />
        <h3>
          {agent.name}
          {agent.isBuiltin && <span className="badge">内置</span>}
        </h3>
        <button className="btn" style={{ marginTop: 4 }} onClick={() => { onShowMemories(agent) }}>🧠 记忆</button>
      </div>
      <dl className="profile-fields">
        <dt>人设</dt>
        <dd className="profile-prompt">{agent.systemPrompt}</dd>
        <dt>模型</dt>
        <dd>{agent.provider} / {agent.model}</dd>
        <dt>工具</dt>
        <dd>
          {agent.tools.length === 0 ? (
            <span className="panel-empty">无（纯对话）</span>
          ) : (
            <span className="tool-chips">
              {agent.tools.map((tool) => { return <span key={tool} className="chip">{TOOL_LABELS[tool] ?? tool}</span> })}
            </span>
          )}
        </dd>
      </dl>
      <h4>本会话产物</h4>
      <ArtifactList artifacts={artifacts} fileUrl={fileUrl} />
    </>
  )
}

function GroupInfo({
  conversation,
  agents,
  relays,
  artifacts,
  fileUrl,
}: {
  conversation: Conversation
  agents: AgentDef[]
  relays: RelayItem[]
  artifacts: { callId: string; name: string; size: number; mime: string }[]
  fileUrl: (name: string) => string
}) {
  const members = conversation.memberAgentIds
    .map((id) => { return agents.find((a) => { return a.id === id }) })
    .filter((a): a is AgentDef => { return a !== undefined })
  const nameOf = (id: string): string => { return agents.find((a) => { return a.id === id })?.name ?? id }
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
      <h4>调度轨迹</h4>
      {relays.length === 0 ? (
        <p className="panel-empty">本轮还没有调度事件</p>
      ) : (
        <ul className="relay-list">
          {relays.map((relay, index) => (
            <li key={index} className={relay.reason === 'loop-guard' || relay.reason === 'max-turns' ? 'is-guard' : ''}>
              {relay.fromAgent !== undefined ? `${nameOf(relay.fromAgent)} → ` : ''}@{nameOf(relay.toAgent)}
              <em>{relay.reason}</em>
              <small>第 {relay.turnIndex + 1} 轮</small>
            </li>
          ))}
        </ul>
      )}
      <h4>本会话产物</h4>
      <ArtifactList artifacts={artifacts} fileUrl={fileUrl} />
    </>
  )
}
