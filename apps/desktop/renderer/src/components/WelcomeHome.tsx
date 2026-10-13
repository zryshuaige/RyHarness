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

import calendarSvg from '../assets/fluent-emoji/calendar.svg?raw'
import envelopeSvg from '../assets/fluent-emoji/envelope.svg?raw'
import memoSvg from '../assets/fluent-emoji/memo.svg?raw'
import folderSvg from '../assets/fluent-emoji/open-file-folder.svg?raw'

/** 建议任务 chips（点击直接发起与 Ryen 的对话，Fluent Emoji 图标）。 */
const SUGGESTIONS = [
  { text: '帮我整理一份本周周报', icon: memoSvg },
  { text: '看看工作区里都有什么文件', icon: folderSvg },
  { text: '写一封简短的请假邮件', icon: envelopeSvg },
  { text: '给我列一个下周工作计划', icon: calendarSvg },
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
    return (
      agents.find((a) => {
        return a.id === id
      })?.name ?? id
    )
  }
  const avatarOf = (conversation: Conversation) => {
    if (conversation.kind === 'group') {
      const members = conversation.memberAgentIds
        .map((id) => {
          return agents.find((a) => {
            return a.id === id
          })
        })
        .filter((a): a is AgentDef => {
          return a !== undefined
        })
      return <GroupAvatar members={members} size={36} />
    }
    const other = agents.find((a) => {
      return a.id === conversation.memberAgentIds[0]
    })
    if (other === undefined) return <Avatar name="?" seed={conversation.id} size={36} />
    return <Avatar avatarKey={other.avatar} name={other.name} seed={other.id} size={36} />
  }

  return (
    <div className="welcome">
      <div className="welcome-cat">
        <Cat mood="idle" size={132} />
      </div>
      <h1 className="welcome-greeting">
        {greeting}，我是 {ryen?.name ?? 'Ryen'}
      </h1>
      <p className="welcome-sub">喵——今天想让我做点什么？挑一个，或者直接跟我说。</p>
      <div className="welcome-chips">
        {SUGGESTIONS.map((chip) => (
          <button
            type="button"
            key={chip.text}
            className="welcome-chip"
            onClick={() => {
              onSuggest(chip.text)
            }}
          >
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: chip 图标为仓库内置 Fluent Emoji SVG，无外部输入 */}
            <span className="chip-emoji" aria-hidden="true" dangerouslySetInnerHTML={{ __html: chip.icon }} />
            {chip.text}
          </button>
        ))}
      </div>
      {recent.length > 0 && (
        <div className="welcome-recent">
          <p className="section-title">最近会话</p>
          {recent.map((conversation) => (
            <button
              type="button"
              key={conversation.id}
              className="welcome-recent-item"
              onClick={() => {
                onOpenConversation(conversation.id)
              }}
            >
              {avatarOf(conversation)}
              <span className="welcome-recent-name">
                {conversation.title || nameOf(conversation.memberAgentIds[0] ?? '')}
              </span>
              <span className="welcome-recent-preview">{conversation.lastMessagePreview ?? ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
