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
 * 首屏发出去的消息的去向。这是本组件存在的理由：文案写着「群里还有另外两位」，
 * 实际每一个 chip、每一句自己打的字都落进与 Ryen 的单聊——多 agent 群聊在首屏
 * 是句空话。去向必须先由用户（或由 chip）选定，宿主才拿它决定落哪个会话。
 */
export type WelcomeTarget = { kind: 'direct' } | { kind: 'group' }

/**
 * 建议场景 chips：点了只把文案填进上面的输入框，顺便把去向也拨到它该去的地方，
 * 改与不改仍由用户决定。
 *
 * target 与文案必须一致：写着「我们三个」「讲给团队听」却发给一个人的场景就是
 * 骗人的入口，这类 chip 一律落到小队群，只有明确点名 Ryen 的才进单聊。
 */
const SUGGESTIONS: { text: string; icon: IconName; target: WelcomeTarget }[] = [
  { text: '我们三个定下周去哪吃', icon: 'users', target: { kind: 'group' } },
  { text: '把我上次说的偏好讲给团队听', icon: 'brain', target: { kind: 'group' } },
  { text: '让 Ryen 复盘这轮，把学到的写进手册', icon: 'clipboard-list', target: { kind: 'direct' } },
  { text: '帮我整理一份本周周报', icon: 'file', target: { kind: 'direct' } },
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

/** 首屏演示会话的标题前缀；主进程 seedFirstLaunchDemo 种出来的会话就带它。 */
export const DEMO_CONVERSATION_PREFIX = '示例'

/**
 * 会话行 + 服务端附带的「Ryen 主动找过你」标记（GET /api/conversations 的 proactive）。
 * api.ts 的 Conversation 还没声明这一维，这里就地承认它：首屏的最近会话里要能一眼
 * 分出哪一条是它自己开口说的。
 */
export type ConversationRow = Conversation & { proactive?: boolean }

/**
 * 欢迎主页：聊天 tab 无选中会话时的首屏。
 *
 * 首屏的排布按「开口 > 找回 > 才开始学产品」分层：问候 → 去向 → 输入框 → 最近会话
 * 全部排在折叠线以上，凭据卡、场景 chips、卖点与本地数据说明往后放。最小窗口
 * （1024×680）下前面的东西一多，输入框与示例会话就会被顶下去，而那正是首启用户
 * 唯一要用的两样。
 *
 * 首屏必须能"开口就说"：文案写着「或者直接跟我说」却没有任何输入框，chip 一点就把
 * 替用户拟好的话发了出去且无从修改——等于让用户替自己开口。
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
  onSend: (text: string, target: WelcomeTarget) => void
  onOpenConversation: (id: string) => void
}) {
  const greeting = greetingForHour(new Date().getHours())
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(() => {
    return new Set()
  })
  const recent: ConversationRow[] = conversations
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
  /** 去向：默认只跟 Ryen 聊——用户没选「开小队」之前，不替他把消息群发。 */
  const [target, setTarget] = useState<WelcomeTarget>({ kind: 'direct' })
  const [focusToken, setFocusToken] = useState(0)
  const [deletingDemo, setDeletingDemo] = useState(false)
  const [demoError, setDemoError] = useState<string | undefined>(undefined)
  /** 小队 = 通讯录里的全体 agent；少于两位就没有「小队」可开。 */
  const squad = agents
  const ryenName = ryen?.name ?? 'Ryen'
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
          英文枚举（role="img" 的 aria-label 是 "Ryen idle"）。尺寸压到 104 是为了
          给下面的输入框与最近会话让出折叠线以上的位置。 */}
      <div className="welcome-cat" aria-hidden="true">
        <Cat mood="idle" size={104} />
      </div>
      <h1 className="welcome-greeting">
        {greeting}，我是 {ryenName}
      </h1>
      <p className="welcome-sub">
        喵——今天想让我做点什么？<b>跟 {ryenName} 聊</b>只有它回话；<b>开个小队</b>拉上其他 agent
        一起商量。选好去向，下面挑一句填进框里。
      </p>
      {/* 去向是这页的第一决策：先定「发给谁」，再说什么。chip 也会把这一格拨到它该去的方向。
          两格各自带 aria-pressed，读屏器能听出当前选的是哪条路。 */}
      <div className="welcome-chips">
        <button
          type="button"
          className={`btn btn-mini ${target.kind === 'direct' ? 'btn-primary' : ''}`}
          aria-pressed={target.kind === 'direct'}
          onClick={() => {
            setTarget({ kind: 'direct' })
          }}
        >
          跟 {ryenName} 聊
        </button>
        <button
          type="button"
          className={`btn btn-mini ${target.kind === 'group' ? 'btn-primary' : ''}`}
          aria-pressed={target.kind === 'group'}
          disabled={squad.length < 2}
          title={squad.length < 2 ? '通讯录里只有一位 agent，先新建一位才组得成小队' : '发给通讯录里的全体 agent'}
          onClick={() => {
            setTarget({ kind: 'group' })
          }}
        >
          开个小队（{squad.length} 人）
        </button>
      </div>
      <div className="welcome-compose">
        <div className="chat-input-row">
          <ChatInput
            members={
              target.kind === 'group'
                ? squad.map((agent) => {
                    return { id: agent.id, name: agent.name, avatar: agent.avatar, tools: agent.tools }
                  })
                : []
            }
            draft={draft}
            onDraftChange={setDraft}
            focusToken={focusToken}
            onSend={(text) => {
              onSend(text, target)
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
                {conversation.proactive === true && (
                  <span className="badge" data-proactive="true">
                    主动
                  </span>
                )}
                {conversation.title || nameOf(conversation.memberAgentIds[0] ?? '')}
              </span>
              <span className="welcome-recent-preview">{conversation.lastMessagePreview ?? ''}</span>
            </button>
          ))}
        </div>
      )}
      <div className="welcome-chips">
        {SUGGESTIONS.map((chip) => (
          <button
            type="button"
            key={chip.text}
            className="welcome-chip"
            title={`把这句填进输入框，你可以改完再发；发往${chip.target.kind === 'group' ? '小队群' : `与 ${ryenName} 的单聊`}`}
            onClick={() => {
              setDraft(chip.text)
              setTarget(chip.target)
              setFocusToken((token) => {
                return token + 1
              })
            }}
          >
            <Icon name={chip.icon} size={16} />
            {chip.text}
            {/* 去向写在 chip 上：文案说「我们三个」却发给一个人，是这个页面最大的坑。 */}
            <span className="chip">{chip.target.kind === 'group' ? '小队' : ryenName}</span>
          </button>
        ))}
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
        {HIGHLIGHTS.map((item) => (
          <span key={item.text} className="chip">
            <Icon name={item.icon} size={12} />
            {item.text}
          </span>
        ))}
        <p className="chat-hint">{LOCAL_DATA_NOTE}</p>
      </div>
    </div>
  )
}
