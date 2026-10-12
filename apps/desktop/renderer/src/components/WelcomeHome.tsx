import type { AgentDef, Conversation } from '../api.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { GroupAvatar } from './avatars/GroupAvatar.tsx'
import { Cat } from './Cat.tsx'

/** 按时辰问候（纯函数，供测试）。 */
export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 11) return '早上好'
  if (hour >= 11 && hour < 14) return '中午好'
  if (hour >= 14 && hour < 18) return '下午好'
  if (hour >= 18) return '晚上好'
  return '夜深了'
}

/** 建议任务 chips（点击直接发起与 Ryen 的对话）。 */
const SUGGESTIONS = [
  '帮我整理一份本周周报',
  '看看工作区里都有什么文件',
  '写一封简短的请假邮件',
  '给我列一个下周工作计划',
]

/**
 * 欢迎主页：聊天 tab 无选中会话时的首屏。
 * 大号猫管家 + 时辰问候 + 建议任务 chips + 最近会话快捷入口。
 */
export function WelcomeHome({
  ryen,
  agents,
  conversations,
  onSuggest,
  onOpenConversation,
}: {
  ryen: AgentDef | undefined
  agents: AgentDef[]
  conversations: Conversation[]
  onSuggest: (text: string) => void
  onOpenConversation: (id: string) => void
}) {
  const greeting = greetingForHour(new Date().getHours())
  const recent = conversations.slice(0, 3)
  const nameOf = (id: string): string => {
    return agents.find((a) => { return a.id === id })?.name ?? id
  }
  const avatarOf = (conversation: Conversation) => {
    if (conversation.kind === 'group') {
      const members = conversation.memberAgentIds
        .map((id) => { return agents.find((a) => { return a.id === id }) })
        .filter((a): a is AgentDef => { return a !== undefined })
      return <GroupAvatar members={members} size={36} />
    }
    const other = agents.find((a) => { return a.id === conversation.memberAgentIds[0] })
    if (other === undefined) return <Avatar name="?" seed={conversation.id} size={36} />
    return <Avatar avatarKey={other.avatar} name={other.name} seed={other.id} size={36} />
  }

  return (
    <div className="welcome">
      <div className="welcome-cat">
        <Cat mood="idle" size={132} />
      </div>
      <h1 className="welcome-greeting">{greeting}，我是 {ryen?.name ?? 'Ryen'}</h1>
      <p className="welcome-sub">喵——今天想让我做点什么？挑一个，或者直接跟我说。</p>
      <div className="welcome-chips">
        {SUGGESTIONS.map((text) => (
          <button key={text} className="welcome-chip" onClick={() => { onSuggest(text) }}>
            {text}
          </button>
        ))}
      </div>
      {recent.length > 0 && (
        <div className="welcome-recent">
          <p className="section-title">最近会话</p>
          {recent.map((conversation) => (
            <button key={conversation.id} className="welcome-recent-item" onClick={() => { onOpenConversation(conversation.id) }}>
              {avatarOf(conversation)}
              <span className="welcome-recent-name">{conversation.title || nameOf(conversation.memberAgentIds[0] ?? '')}</span>
              <span className="welcome-recent-preview">{conversation.lastMessagePreview ?? ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
