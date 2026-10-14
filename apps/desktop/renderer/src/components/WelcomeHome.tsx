import { useState } from 'react'
import type { AgentDef, Conversation, ProviderInfo } from '../api.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { GroupAvatar } from './avatars/GroupAvatar.tsx'
import { Cat } from './Cat.tsx'
import { ChatInput } from './ChatInput.tsx'
import { Icon, type IconName } from './Icon.tsx'

/** 按时辰问候（纯函数，供测试）。 */
export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 11) return '早上好'
  if (hour >= 11 && hour < 14) return '中午好'
  if (hour >= 14 && hour < 18) return '下午好'
  if (hour >= 18) return '晚上好'
  return '夜深了'
}

/** 建议任务 chips：点了只把文案填进下面的输入框，改与不改由用户决定。 */
const SUGGESTIONS: { text: string; icon: IconName }[] = [
  { text: '帮我整理一份本周周报', icon: 'clipboard-list' },
  { text: '看看工作区里都有什么文件', icon: 'file' },
  { text: '写一封简短的请假邮件', icon: 'mail' },
  { text: '给我列一个下周工作计划', icon: 'calendar-days' },
]

/**
 * 欢迎主页：聊天 tab 无选中会话时的首屏。
 * 大号猫管家 + 时辰问候 + 直接可用的输入框 + 建议 chips + 最近会话快捷入口。
 *
 * 首屏必须能"开口就说"：此前文案写着「或者直接跟我说」却没有任何输入框，chip
 * 一点就把替用户拟好的话发了出去且无从修改——等于让用户替自己开口。
 */
export function WelcomeHome({
  ryen,
  agents,
  conversations,
  providers,
  onSaveApiKey,
  onSend,
  onOpenConversation,
}: {
  ryen: AgentDef | undefined
  agents: AgentDef[]
  conversations: Conversation[]
  providers: ProviderInfo[]
  onSaveApiKey: (providerId: string, apiKey: string) => Promise<void>
  onSend: (text: string) => void
  onOpenConversation: (id: string) => void
}) {
  const greeting = greetingForHour(new Date().getHours())
  const recent = conversations.slice(0, 3)
  // 没配置任何供应商凭据时，聊天一定失败——先让人把 key 填上。
  const unconfigured = providers.find((p) => {
    return !p.apiKeyConfigured
  })
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [keyError, setKeyError] = useState<string | undefined>(undefined)
  /** 首屏草稿：chip 填词、用户改词都在这里，发送后才清空。 */
  const [draft, setDraft] = useState('')
  const [focusToken, setFocusToken] = useState(0)
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
      <p className="welcome-sub">喵——今天想让我做点什么？挑一个填进下面的框，或者直接自己说。</p>
      {unconfigured !== undefined && (
        <div className="apikey-card">
          <p className="apikey-title">先填一个 API Key</p>
          <p className="apikey-hint">
            还没有配置 {unconfigured.displayName} 的凭据，聊天会用不了。Key 只写在本机的配置文件里，不会上传到别处。
          </p>
          <div className="apikey-row">
            <input
              type="password"
              value={key}
              placeholder={`${unconfigured.displayName} API Key`}
              autoComplete="off"
              onChange={(e) => {
                setKey(e.target.value)
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || key.trim().length === 0}
              onClick={() => {
                setSaving(true)
                setKeyError(undefined)
                onSaveApiKey(unconfigured.id, key.trim())
                  .catch((error: unknown) => {
                    setKeyError(error instanceof Error ? error.message : String(error))
                  })
                  .finally(() => {
                    setSaving(false)
                  })
              }}
            >
              {saving ? '保存中' : '保存'}
            </button>
          </div>
          {keyError !== undefined && <p className="apikey-error">{keyError}</p>}
        </div>
      )}
      <div className="welcome-chips">
        {SUGGESTIONS.map((chip) => (
          <button
            type="button"
            key={chip.text}
            className="welcome-chip"
            title="把这句填进输入框，你可以改完再发"
            onClick={() => {
              setDraft(chip.text)
              setFocusToken((token) => {
                return token + 1
              })
            }}
          >
            <Icon name={chip.icon} size={16} />
            {chip.text}
          </button>
        ))}
      </div>
      <div className="welcome-compose">
        <div className="chat-input-row">
          <ChatInput
            members={[]}
            draft={draft}
            onDraftChange={setDraft}
            focusToken={focusToken}
            onSend={(text) => {
              onSend(text)
            }}
          />
        </div>
        <p className="welcome-compose-hint">Enter 发送 · Shift+Enter 换行</p>
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
