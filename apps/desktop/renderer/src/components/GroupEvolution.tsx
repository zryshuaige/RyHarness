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
import { useState } from 'react'
import type { AgentDef, EntryExplanation, EntryOriginRow, PlaybookEntryRow } from '../api.ts'
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

/** 溯源种类的中文口径：服务端给了 detail 用 detail，缺了这一层兜底。 */
const ORIGIN_LABELS: Record<EntryOriginRow['kind'], string> = {
  trajectory: '对话',
  reflection: '教训',
  feedback: '反馈',
  memory: '记忆',
  seed: '种子',
}

/** 可解释性要读的数据面；缺这条方法 = 服务端还没这版路由，界面据此降级。 */
export interface EntryExplainApi {
  explainPlaybookEntry?(id: string): Promise<EntryExplanation>
}

function isOriginKind(value: unknown): value is EntryOriginRow['kind'] {
  return (
    value === 'trajectory' || value === 'reflection' || value === 'feedback' || value === 'memory' || value === 'seed'
  )
}

/**
 * 经验手册条目的「它从哪来」：点开看证据链（来自哪次对话 / 哪条教训 / 哪次反馈 /
 * 哪条记忆 / 哪个种子模板）。
 *
 * 手册此前只显示一个来源徽章（策展 / 转正 / 种子），用户无从判断这条经验值不值得
 * 照做——"它凭什么这么说"和"它说了什么"同样重要。
 *
 * 接线契约（PlaybookPanel.tsx）：在每条 entry 的行内替换/追加
 * `<EntryExplain api={api} entry={entry} />`，api 传面板已有的 ApiClient 即可；
 * 本组件自己管展开态与降级，调用方无需额外状态。
 *
 * 服务端路由未上线（404）时只显示一句灰字，不弹错、不阻断手册其余内容——证据链是
 * 锦上添花，缺了不该让经验手册变成一个坏掉的面板。
 */
export function EntryExplain({ api, entry }: { api: EntryExplainApi; entry: PlaybookEntryRow }) {
  const [open, setOpen] = useState(false)
  const [explanation, setExplanation] = useState<EntryExplanation | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (!next || explanation !== undefined || loading) return
    if (api.explainPlaybookEntry === undefined) {
      setFailed(true)
      return
    }
    setLoading(true)
    api.explainPlaybookEntry(entry.id).then(
      (result) => {
        setExplanation(result)
        setLoading(false)
      },
      () => {
        setFailed(true)
        setLoading(false)
      },
    )
  }

  return (
    <span className="entry-explain">
      <button
        type="button"
        className="entry-explain-toggle"
        aria-expanded={open}
        title="这条经验从哪来"
        onClick={toggle}
      >
        <Icon name="chevron-right" size={11} />
        它从哪来
      </button>
      {open && (
        <span className="entry-explain-body">
          {loading && <span className="entry-explain-note">查来源…</span>}
          {failed && <span className="entry-explain-note">来历暂时查不到（服务端还没有这条数据）。</span>}
          {explanation !== undefined && <OriginList explanation={explanation} />}
        </span>
      )}
    </span>
  )
}

function OriginList({ explanation }: { explanation: EntryExplanation }) {
  return (
    <span className="entry-explain-list">
      <span className="entry-explain-summary">{explanation.summary}</span>
      {explanation.origins.length === 0 ? (
        <span className="entry-explain-note">没有记录到具体来源（多半是种子或手动写入）。</span>
      ) : (
        <ul className="entry-origin-list">
          {explanation.origins.map((origin, index) => {
            const label = isOriginKind(origin.kind) ? ORIGIN_LABELS[origin.kind] : origin.kind
            return (
              <li key={`${origin.kind}-${origin.refId}-${index}`} className="entry-origin" title={origin.refId}>
                <span className={`entry-origin-kind is-${isOriginKind(origin.kind) ? origin.kind : 'unknown'}`}>
                  {label}
                </span>
                <span className="entry-origin-detail">
                  {origin.detail === undefined || origin.detail.length === 0 ? label : origin.detail}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </span>
  )
}
