import { memo, useEffect, useMemo, useState } from 'react'
import type { AgentDef, ApiClient, Conversation, UsageTotals } from '../api.ts'
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
  // 收起态不早返回：整块面板（柔光带 + 内容）始终挂着，收起/展开才是同一根
  // width 过渡上的两次伸缩。早返回会让内容在动画开始前就没了，两个方向都成了
  // 硬切；而宽度归零时展开键跟着被 overflow:hidden 裁掉，右栏就再也展不开。
  return (
    <aside className={collapsed ? 'right-panel is-collapsed' : 'right-panel'}>
      <span className="panel-banner" aria-hidden="true" />
      {/* 收起键与展开键在同一角上互换，面板本体始终在场 */}
      {collapsed ? (
        <button type="button" className="panel-expand-btn" title="展开信息板" onClick={onToggle}>
          <Icon name="panel-right" size={14} />
        </button>
      ) : (
        <button type="button" className="right-panel-toggle" title="收起信息板" onClick={onToggle}>
          <Icon name="chevron-right" size={13} />
        </button>
      )}
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
        {/* 用量一行带过：GET /api/conversations/:id 早就把 usage 算好送回来了，
            此前整个界面没有任何地方消费它——聊了多久、花了多少只有服务端知道。
            刻意排在最后、只占一行，统计不该盖过内容本身。 */}
        {conversation !== undefined && (
          <ConversationUsage api={api} conversationId={conversation.id} updatedAt={conversation.updatedAt} />
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

/** token 缩写：千位一位小数，1k 以下原样。 */
function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 1000) return String(Math.max(0, Math.round(value)))
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/**
 * 本会话累计 token 用量。数据来自 GET /api/conversations/:id 的 usage（服务端对
 * 各条消息求和），随会话 updatedAt 变化重取；还没有任何一轮用量时不占那一行。
 */
const ConversationUsage = memo(function ConversationUsage({
  api,
  conversationId,
  updatedAt,
}: {
  api: ApiClient
  conversationId: string
  /** 会话更新时间：每有新消息就重取一次，统计不滞后。 */
  updatedAt: number
}) {
  const [usage, setUsage] = useState<UsageTotals | undefined>(undefined)
  useEffect(() => {
    let alive = true
    api
      .conversationDetail(conversationId)
      .then(({ usage: totals }) => {
        if (alive) setUsage(totals)
      })
      .catch(() => {
        // 读不到就当没有：统计缺失不该在右栏报错，更不该挡住其它信息。
        if (alive) setUsage(undefined)
      })
    return () => {
      alive = false
    }
  }, [api, conversationId, updatedAt])
  if (usage === undefined || usage.messages === 0) return null
  return (
    <dl className="profile-fields">
      <dt>本会话用量</dt>
      <dd>
        累计 {formatTokens(usage.totalTokens)} tokens（输入 {formatTokens(usage.inputTokens)} · 输出{' '}
        {formatTokens(usage.outputTokens)}）
      </dd>
    </dl>
  )
})

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
