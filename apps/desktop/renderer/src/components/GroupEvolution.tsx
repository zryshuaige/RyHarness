/**
 * 群聊右栏的进化入口与调度轨迹。
 *
 * 此前这两块只有单聊右栏（DirectProfile）有：群聊里看不到任何一位成员的记忆与
 * 经验手册，"群里的人也在越聊越懂我"这件事完全不可见；调度轨迹则把服务端枚举
 * （user-mention / loop-guard / …）原样甩给用户。
 *
 * 这里只做纯展示组件，成员列表、面板开关都由 RightPanel 通过 props 注入——
 * 面板状态仍归右栏所有，group 分支一行接上即可。
 */
import type { AgentDef } from '../api.ts'
import { isGuardRelay, relayLabel } from '../lib/relay-labels.ts'
import type { RelayItem } from '../store.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { Icon } from './Icon.tsx'

/** 群成员的进化入口：逐人打开记忆 / 经验手册（面板由注入方持有）。 */
export function GroupEvolution({
  members,
  onShowMemories,
  onShowPlaybook,
}: {
  members: AgentDef[]
  onShowMemories: (agent: AgentDef) => void
  onShowPlaybook: (agent: AgentDef) => void
}) {
  if (members.length === 0) return <p className="panel-empty">群里还没有成员</p>
  return (
    <>
      <h4>谁在进化</h4>
      <ul className="evolution-list">
        {members.map((member) => (
          <li key={member.id} className="evolution-row">
            <Avatar avatarKey={member.avatar} name={member.name} seed={member.id} size={28} />
            <span className="evolution-name">{member.name}</span>
            <span className="evolution-actions">
              <button
                type="button"
                className="btn btn-mini"
                title={`查看 ${member.name} 的记忆`}
                onClick={() => {
                  onShowMemories(member)
                }}
              >
                <Icon name="brain" size={12} /> 记忆
              </button>
              <button
                type="button"
                className="btn btn-mini"
                title={`查看 ${member.name} 的经验手册`}
                onClick={() => {
                  onShowPlaybook(member)
                }}
              >
                <Icon name="check" size={12} /> 经验手册
              </button>
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

/** 调度轨迹：原因一律走中文口径，护栏拦截用警示色标出。 */
export function RelayTimeline({ relays, nameOf }: { relays: readonly RelayItem[]; nameOf: (id: string) => string }) {
  if (relays.length === 0) return <p className="panel-empty">本轮还没有调度事件</p>
  return (
    <ul className="relay-list">
      {relays.map((relay, index) => (
        <li key={`${relay.reason}-${index}`} className={isGuardRelay(relay.reason) ? 'is-guard' : ''}>
          {relay.fromAgent !== undefined ? `${nameOf(relay.fromAgent)} → ` : ''}@{nameOf(relay.toAgent)}
          <em>{relayLabel(relay.reason)}</em>
          <small>第 {relay.turnIndex + 1} 轮</small>
        </li>
      ))}
    </ul>
  )
}
