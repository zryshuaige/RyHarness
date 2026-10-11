import type { AgentDef, Conversation } from '../api.ts'
import { AgentAvatar } from './Cat.tsx'
import type { RelayItem } from '../store.ts'

const TOOL_LABELS: Record<string, string> = {
  fs_read: '读文件', fs_write: '写文件', shell_exec: '执行命令', file_produce: '产出文件',
}

/** 右栏信息板：单聊 = agent 资料卡；群聊 = 成员列表 + 调度轨迹。 */
export function RightPanel({
  conversation,
  agents,
  relays,
  collapsed,
  onToggle,
}: {
  conversation: Conversation | undefined
  agents: AgentDef[]
  relays: RelayItem[]
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <aside className={`right-panel ${collapsed ? 'is-collapsed' : ''}`}>
      <button className="panel-toggle" onClick={onToggle}>{collapsed ? '«' : '»'}</button>
      {collapsed || conversation === undefined ? null : conversation.kind === 'direct' ? (
        <DirectProfile agentId={conversation.memberAgentIds[0]} agents={agents} />
      ) : (
        <GroupInfo conversation={conversation} agents={agents} relays={relays} />
      )}
    </aside>
  )
}

function DirectProfile({ agentId, agents }: { agentId: string | undefined; agents: AgentDef[] }) {
  const agent = agents.find((a) => { return a.id === agentId })
  if (agent === undefined) return <p className="panel-empty">未找到 agent</p>
  return (
    <div className="panel-body">
      <div className="profile-head">
        <AgentAvatar agent={agent} size={64} />
        <h3>{agent.name}</h3>
        {agent.isBuiltin && <span className="badge">内置</span>}
      </div>
      <dl className="profile-fields">
        <dt>人设</dt>
        <dd className="profile-prompt">{agent.systemPrompt}</dd>
        <dt>模型</dt>
        <dd>{agent.provider} / {agent.model}</dd>
        <dt>工具</dt>
        <dd>
          {agent.tools.length === 0 ? '无（纯对话）' : (
            <span className="tool-chips">
              {agent.tools.map((tool) => { return <span key={tool} className="chip">{TOOL_LABELS[tool] ?? tool}</span> })}
            </span>
          )}
        </dd>
      </dl>
    </div>
  )
}

function GroupInfo({ conversation, agents, relays }: { conversation: Conversation; agents: AgentDef[]; relays: RelayItem[] }) {
  const members = conversation.memberAgentIds
    .map((id) => { return agents.find((a) => { return a.id === id }) })
    .filter((a): a is AgentDef => { return a !== undefined })
  const nameOf = (id: string): string => { return agents.find((a) => { return a.id === id })?.name ?? id }
  return (
    <div className="panel-body">
      <h4>成员（{members.length}）</h4>
      <ul className="member-list">
        {members.map((member) => (
          <li key={member.id}>
            <AgentAvatar agent={member} size={28} />
            <span>{member.name}</span>
            {conversation.dispatcherAgentId === member.id && <span className="badge">调度员</span>}
          </li>
        ))}
      </ul>
      <h4>调度轨迹</h4>
      {relays.length === 0 ? <p className="panel-empty">本轮还没有调度事件</p> : (
        <ul className="relay-list">
          {relays.map((relay, index) => (
            <li key={index} className={relay.reason === 'loop-guard' ? 'is-guard' : ''}>
              <small>T{relay.turnIndex}</small>{' '}
              {relay.fromAgent !== undefined ? `${nameOf(relay.fromAgent)} → ` : ''}@{nameOf(relay.toAgent)}
              <em>{relay.reason}</em>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
