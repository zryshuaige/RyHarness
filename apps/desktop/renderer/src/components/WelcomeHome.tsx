import { useState } from 'react'
import type { AgentDef, Conversation, ProviderInfo } from '../api.ts'
import { useApiBase } from '../lib/boot.ts'
import { firstProviderMissingKey, hasUsableProvider } from '../lib/provider-health.ts'
import { toast } from '../lib/toast.ts'
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

/**
 * 建议场景 chips：点了只把文案填进下面的输入框，改与不改由用户决定。
 *
 * 首屏要卖的是多 agent、长期记忆、自我进化，所以默认给的是天然会触发群聊接力、
 * 翻旧账与复盘的场景——周报、请假邮件这类公文用一枚 chip 兜住熟悉感就够，开屏的
 * 位置让给差异点。
 */
const SUGGESTIONS: { text: string; icon: IconName }[] = [
  { text: '我们三个定下周去哪吃', icon: 'users' },
  { text: '把我上次说的偏好讲给团队听', icon: 'brain' },
  { text: '让 Ryen 复盘这轮，把学到的写进手册', icon: 'clipboard-list' },
  { text: '帮我整理一份本周周报', icon: 'file' },
]

/** 首屏三件事：差异点写在页面上，而不是只活在产品文档和「我的」页第三级。 */
const HIGHLIGHTS: { text: string; icon: IconName }[] = [
  { text: '多 agent 群聊接力', icon: 'users' },
  { text: '长期记忆，隔天还记得', icon: 'brain' },
  { text: '自我进化，会写经验手册', icon: 'pencil' },
]

/** 本地优先的差异化叙事：此前只藏在「我的」页第三级，等于没有。 */
const LOCAL_DATA_NOTE =
  '数据都在本机：对话、长期记忆和经验手册只写在这台电脑的 ryagent-data 目录里，不上传到任何服务器。'

/** 首启演示会话的标题前缀；主进程 seedFirstLaunchDemo 种出来的会话就带它。 */
export const DEMO_CONVERSATION_PREFIX = '示例'

/**
 * 欢迎主页：聊天 tab 无选中会话时的首屏。
 * 大号猫管家 + 时辰问候 + 三件事说明 + 直接可用的输入框 + 场景 chips + 最近会话快捷入口。
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
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(() => {
    return new Set()
  })
  const recent = conversations
    .filter((conversation) => {
      return !deletedIds.has(conversation.id)
    })
    .slice(0, 3)
  const demo = recent.find((conversation) => {
    return conversation.title.startsWith(DEMO_CONVERSATION_PREFIX)
  })
  // 一个能用的供应商都没有时，聊天一定失败——先让人把 key 填上。
  // 免 key 的本地服务（Ollama 这类）也算数：它没有 key 可填，判定与「我的」页共用一份。
  const unconfigured = hasUsableProvider(providers) ? undefined : firstProviderMissingKey(providers)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [keyError, setKeyError] = useState<string | undefined>(undefined)
  /** 首屏草稿：chip 填词、用户改词都在这里，发送后才清空。 */
  const [draft, setDraft] = useState('')
  const [focusToken, setFocusToken] = useState(0)
  const [deletingDemo, setDeletingDemo] = useState(false)
  const [demoError, setDemoError] = useState<string | undefined>(undefined)
  // 示例会话要能一键删掉：这里直接打后端 DELETE。渲染层的会话列表由 App 持有，
  // 删成功后本地先把这行摘掉，下次全量刷新时它也不会再回来。
  const apiBase = useApiBase()
  const deleteDemo = (): void => {
    if (demo === undefined) return
    if (apiBase === undefined) {
      toast.error('还没拿到本机服务地址，删不掉示例会话——稍等一下再试。')
      return
    }
    setDeletingDemo(true)
    setDemoError(undefined)
    void fetch(`${apiBase}/api/conversations/${demo.id}`, { method: 'DELETE' })
      .then((response) => {
        if (!response.ok) throw new Error(`删除失败（HTTP ${response.status}）`)
        setDeletedIds((previous) => {
          return new Set([...previous, demo.id])
        })
        toast.success('示例会话已删掉')
      })
      .catch((error: unknown) => {
        setDemoError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        setDeletingDemo(false)
      })
  }
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
      {/* 装饰性品牌猫：标题下面已经有「我是 Ryen」，让它再说一遍只会多读出一句
          英文枚举（role="img" 的 aria-label 是 "Ryen idle"）。 */}
      <div className="welcome-cat" aria-hidden="true">
        <Cat mood="idle" size={132} />
      </div>
      <h1 className="welcome-greeting">
        {greeting}，我是 {ryen?.name ?? 'Ryen'}
      </h1>
      <p className="welcome-sub">
        喵——今天想让我做点什么？群里还有另外两位，可以一起商量。挑一个填进下面的框，或者直接自己说。
      </p>
      <div className="welcome-chips">
        {HIGHLIGHTS.map((item) => (
          <span key={item.text} className="chip">
            <Icon name={item.icon} size={12} />
            {item.text}
          </span>
        ))}
        <p className="chat-hint">{LOCAL_DATA_NOTE}</p>
      </div>
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
      </div>
      {recent.length > 0 && (
        <div className="welcome-recent">
          <p className="section-title">最近会话</p>
          {demo !== undefined && (
            <div className="welcome-sub">
              「{demo.title}」是产品自带的示例，接力已经发生过了，不是你自己的历史。
              <button type="button" className="btn btn-mini" disabled={deletingDemo} onClick={deleteDemo}>
                {deletingDemo ? '删除中' : '删掉示例'}
              </button>
              {demoError !== undefined && <span className="apikey-error">{demoError}</span>}
            </div>
          )}
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
