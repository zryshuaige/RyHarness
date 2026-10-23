import { useState } from 'react'
import type { AgentDef, Conversation, ProviderInfo, ProviderPreset } from '../api.ts'
import { authedFetch } from '../lib/authed-fetch.ts'
import { useApiBase } from '../lib/boot.ts'
import { humanError } from '../lib/error-text.ts'
import { humanPreview, LOCAL_DATA_NOTE } from '../lib/humanize.ts'
import { firstProviderMissingKey, hasUsableProvider, missingProviderHint } from '../lib/provider-health.ts'
import { markConversationRemoved, markConversationRestored } from '../lib/removed-conversations.ts'
import { toast } from '../lib/toast.ts'
import { AsyncState } from './AsyncState.tsx'
import { Avatar } from './avatars/Avatar.tsx'
import { Cat } from './Cat.tsx'
import { ChatInput } from './ChatInput.tsx'
import { Icon } from './Icon.tsx'
import { ProviderIcon } from './ProviderSettings.tsx'

/** 按时辰问候（纯函数，供测试）。 */
export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 11) return '早上好'
  if (hour >= 11 && hour < 14) return '中午好'
  if (hour >= 14 && hour < 18) return '下午好'
  if (hour >= 18) return '晚上好'
  return '夜深了'
}

/**
 * 首屏发出去的消息的去向。这是本组件存在的理由：去向必须先由用户（或由建议）选定，
 * 宿主才拿它决定落哪个会话。多 agent 群聊不该是首屏的一句空话。
 *
 * direct 带上 agentId 表示「跟团队里的某一位单聊」。不传 agentId 是默认的 Ryen；
 * 保留这个缺省值，是为了让旧调用方与既有测试里的 { kind: 'direct' } 仍然成立。
 */
export type WelcomeTarget = { kind: 'direct'; agentId?: string } | { kind: 'group' }

/**
 * 起步建议：标题是「做什么」这件东西本身，prompt 才是真正填进输入框的那句话
 * （prompt 是载荷，允许是一整句）。target 与 prompt 必须一致：写着「小队一起上」
 * 却发给一个人，就是这个页面最伤人的假入口。
 */
interface WelcomeTask {
  title: string
  prompt: string
  target: WelcomeTarget
}

const TASKS: WelcomeTask[] = [
  { title: '行业分析 PPT', prompt: '帮我做一份行业分析 PPT，小队一起上', target: { kind: 'group' } },
  { title: '上次的偏好', prompt: '把我上次说的偏好讲给团队听', target: { kind: 'group' } },
  { title: '本周周报', prompt: '帮我整理一份本周周报', target: { kind: 'direct' } },
]

/**
 * 首启种子里的固定 id 与职能一一对应；用户自建的助理认不出来时按「助理」显示。
 *
 * 这里同时留着早期种过的 id（translation / organizer）：改首启小队只影响新库，老用户
 * 库里那些记录还在，映射一并留着才认得出他们是谁（未知的会退化成「助理」）。
 */
const TEAM_ROLE_BY_ID: Readonly<Record<string, string>> = {
  ryen: '总管',
  'ryen-team-coding': '工程师',
  'ryen-team-writing': '文案',
  'ryen-team-translation': '翻译',
  'ryen-team-organizer': '管家',
}

/** 团队排序：总管在左，随后按职能固定顺序；认不出的助理留在最后。 */
const TEAM_ROLE_ORDER = ['总管', '工程师', '文案', '翻译', '管家', '助理'] as const
const TEAM_ROLE_SET = new Set<string>(TEAM_ROLE_ORDER)
const TEAM_ROLE_RANK = new Map<string, number>(
  TEAM_ROLE_ORDER.map((role, index) => {
    return [role, index]
  }),
)

function teamRoleOf(agent: AgentDef, ryenId: string): string {
  if (agent.id === ryenId || agent.id === 'ryen') return '总管'
  const byId = TEAM_ROLE_BY_ID[agent.id]
  if (byId !== undefined) return byId
  if (TEAM_ROLE_SET.has(agent.name)) return agent.name
  return '助理'
}

/**
 * 首屏演示会话的标题前缀；主进程 seedFirstLaunchDemo 种出来的会话就带它。
 */
export const DEMO_CONVERSATION_PREFIX = '示例'

/**
 * 会话行 + 服务端附带的「Ryen 主动找过你」标记（GET /api/conversations 的 proactive）。
 * api.ts 的 Conversation 还没声明这一维，这里就地承认它：首屏要能一眼分出哪一条是
 * 它自己开口说的。
 */
export type ConversationRow = Conversation & { proactive?: boolean }

/**
 * 欢迎主页：聊天 tab 无选中会话时的首屏。
 *
 * 一屏一件事——把话交给某个人。其余都是安静的配角，全页只有一句大标题、只有 composer
 * 一块抬升面。
 *
 * 三条结构决定，都是为了让它读起来像"设计出来的"，而不是"拼起来的"：
 *
 * 1. **不重复左栏**。左栏已经按时间列了全部会话（带时间戳与未读角标），首屏再放一行
 *    "最近的那次"就是同一条会话在同一屏里出现两次。所以这里只留**待办**：
 *    有未读、或 Ryen 主动开口过的那一条——那才是左栏不显眼、而首屏必须给信号的事。
 *    什么都没等着的时候，这一整块不渲染。
 * 2. **去向只有一个控件**。收件人行就贴在 composer 上方，像邮件的 `收件人` 字段：
 *    一排头像就是单聊选项（Ryen 的头像即"跟 Ryen 聊"），另一端一枚小队胶囊。
 *    曾经头像排与"跟 X 聊 / 开个小队"两处都写 `target`，同一个决定被画了两遍。
 * 3. **卡片只说自己是什么**。起步建议是一排安静的胶囊，左端摆的是**真实去向的头像**
 *    （单聊一位、小队两位叠起来），而不是一个"我是功能"图标的圆角方块——点之前
 *    就知道这句话会发给谁，而这正是 fillTask 真正会做的事。
 *
 * 凭据仍是硬前置：没有可用来源时，配置卡排在输入框之前。建议只把话填进输入框，
 * 发不发由用户决定。
 */
export function WelcomeHome({
  ryen,
  agents,
  conversations,
  providers,
  providersLoading,
  presets,
  onSaveApiKey,
  onSaveProviderKey,
  onSend,
  onOpenConversation,
}: {
  ryen: AgentDef | undefined
  agents: AgentDef[]
  conversations: Conversation[]
  providers: ProviderInfo[]
  /**
   * 供应商清单还在路上。宿主把「首份数据未到」传进来，首屏才分得清
   * 「还没有可用来源」与「还没读完来源」——后者不该催用户去填 Key。
   */
  providersLoading?: boolean
  /**
   * 可选的供应商预设目录（/api/provider-presets）。
   *
   * 给了它，首屏就是**先挑一家再填 key**：用户自己选，而不是被默认到某一家。
   * 没给（老服务端或测试的最小替身）时退回旧行为——点名唯一那家缺 key 的供应商。
   */
  presets?: ProviderPreset[]
  onSaveApiKey: (providerId: string, apiKey: string) => Promise<void>
  /**
   * 给某一家填 key（可选）。
   *
   * 与 onSaveApiKey 的差别：这条知道用户挑的是**哪个预设**，于是能把一家还没建
   * 路由的供应商先建起来再存 key——不必让用户先去「我的」页建一遍。
   */
  onSaveProviderKey?: (preset: ProviderPreset, apiKey: string) => Promise<void>
  onSend: (text: string, target: WelcomeTarget) => void
  onOpenConversation: (id: string) => void
}) {
  const greeting = greetingForHour(new Date().getHours())
  const loadingProviders = providersLoading === true
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(() => {
    return new Set()
  })
  const visible: ConversationRow[] = conversations.filter((conversation) => {
    return !deletedIds.has(conversation.id)
  })
  /**
   * 首屏只留**待办**：有未读、或 Ryen 主动开口过的那一条。
   *
   * 为什么不留"最近的那次"：左栏已经按时间列了全部会话，最近的那条就躺在最上面一行，
   * 带时间戳与未读角标。首屏再放一遍，是同一条会话在同一屏里出现两次——缩小它只会让
   * 重复变得不那么难看，不会让重复消失。等待才是不显眼却必须被抬起来的那件事；
   * 什么都没等着的时候，这一块整个不渲染。
   */
  const pending = visible.find((conversation) => {
    return (conversation.unreadCount ?? 0) > 0 || conversation.proactive === true
  })
  const demo = visible.find((conversation) => {
    return conversation.title.startsWith(DEMO_CONVERSATION_PREFIX)
  })
  // 一个能用的供应商都没有时，聊天一定失败——先把这条前置摆到能打字之前，别让用户先失败一次。
  // 免 key 的本地服务（Ollama 这类）也算数：它没有 key 可填，判定与「我的」页共用一份。
  // 清单还在加载时 `usable=false` 只代表「还不知道」，不能据此说「没有可用来源」。
  const usable = hasUsableProvider(providers)
  const unconfigured = usable || loadingProviders ? undefined : firstProviderMissingKey(providers)
  /** 连"缺哪家"都说不出来（供应商列表空）：给三条并列的路，别只点名一家。 */
  const noSourceHint = usable || loadingProviders ? undefined : missingProviderHint(providers)
  /** 供应商预设目录：给了就先让用户挑一家，而不是默认点名某一家。 */
  const presetList = presets ?? []
  /** 用户挑中的那家；undefined = 还没挑。 */
  const [pickedPreset, setPickedPreset] = useState<ProviderPreset | undefined>(undefined)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [keyError, setKeyError] = useState<string | undefined>(undefined)
  /** 首屏草稿：任务卡填词、用户改词都在这里，发送后才清空。 */
  const [draft, setDraft] = useState('')
  /** 去向：默认只跟 Ryen 聊——用户没选「小队」之前，不替他把消息群发。 */
  const [target, setTarget] = useState<WelcomeTarget>({ kind: 'direct' })
  const [focusToken, setFocusToken] = useState(0)
  /** 读屏器听到的最近一次动作，由下方 aria-live 区域播报。 */
  const [announcement, setAnnouncement] = useState('')
  const [deletingDemo, setDeletingDemo] = useState(false)
  /** 小队 = 通讯录里的全体 agent；少于两位就没有「小队」可开。 */
  const squad = agents
  const ryenName = ryen?.name ?? 'Ryen'
  const ryenId = ryen?.id ?? 'ryen'
  // Ryen 可能不在 agents 列表里（旧宿主只传了 ryen），收件人行仍应把他放在第一位。
  const roster = ryen !== undefined && !agents.some((agent) => agent.id === ryen.id) ? [ryen, ...agents] : agents
  const team = roster
    .map((agent) => {
      return { agent, role: teamRoleOf(agent, ryenId) }
    })
    .sort((left, right) => {
      return (
        (TEAM_ROLE_RANK.get(left.role) ?? TEAM_ROLE_ORDER.length) -
        (TEAM_ROLE_RANK.get(right.role) ?? TEAM_ROLE_ORDER.length)
      )
    })
  const selectedTeamId = target.kind === 'direct' ? (target.agentId ?? ryenId) : undefined
  const squadSelected = target.kind === 'group'
  const pendingParticipants =
    pending === undefined
      ? []
      : pending.memberAgentIds
          .map((id) => {
            return roster.find((agent) => {
              return agent.id === id
            })
          })
          .filter((agent): agent is AgentDef => {
            return agent !== undefined
          })
          .slice(0, 3)
  /** 小队胶囊与任务卡上的头像用的是同一批人：谁会被这条消息看见，界面上得长得一样。 */
  const squadFaces = squad.length > 0 ? squad : roster.slice(0, 2)
  // 示例会话要能删掉：这里直接打后端 DELETE。渲染层的会话列表由 App 持有，
  // 删成功后本地先把它从首屏摘掉；左栏那份旧列表靠 markConversationRemoved 通知，
  // 服务端重拉之后它自己也不会再回来（软删的会话列表接口不返回）。
  const apiBase = useApiBase()
  /**
   * 删除示例会话。
   *
   * 后端删的是**软删**（只打标记，消息还在库里），所以删完还能撤销回来——文案不能
   * 写"删不回来"，那种话在一个能撤销的删除上就是骗人。删成功之后还要通知左栏：那一
   * 行得从列表里消失（留着就是一行点进去 404 的僵尸会话，还像没删干净）。
   */
  const deleteDemo = (): void => {
    if (demo === undefined) return
    if (apiBase === undefined) {
      toast.error('还没拿到本机服务地址，删不掉示例会话——稍等一下再试。')
      return
    }
    setDeletingDemo(true)
    void authedFetch(apiBase, `/api/conversations/${demo.id}`, { method: 'DELETE' })
      .then((response) => {
        if (!response.ok) throw new Error(`删除失败（HTTP ${response.status}）`)
        setDeletedIds((previous) => {
          return new Set([...previous, demo.id])
        })
        // 左栏手里那份列表是旧的（这里删的不会触发壳重拉）：通知它把这一行摘掉。
        markConversationRemoved(demo.id)
        toast.success('示例会话已删除，还能撤销回来', {
          duration: 8000,
          action: {
            label: '撤销',
            run: () => {
              restoreDemo(demo.id)
            },
          },
        })
      })
      .catch((error: unknown) => {
        toast.error(humanError(error, '这条示例会话没删掉，再点一次叉。'))
      })
      .finally(() => {
        setDeletingDemo(false)
      })
  }
  /** 撤销删除：把示例会话放回列表（服务端删的是软删，restore 端点一直在）。 */
  const restoreDemo = (id: string): void => {
    if (apiBase === undefined) {
      toast.error('还没拿到本机服务地址，恢复不了——稍等一下再试。')
      return
    }
    void authedFetch(apiBase, `/api/conversations/${id}/restore`, { method: 'POST', body: '{}' })
      .then((response) => {
        if (!response.ok) throw new Error(`恢复失败（HTTP ${response.status}）`)
        setDeletedIds((previous) => {
          const next = new Set(previous)
          next.delete(id)
          return next
        })
        // 左栏那一行也回来：撤销之后不该还留着一个空位。
        markConversationRestored(id)
        toast.success('示例会话回来了')
      })
      .catch((error: unknown) => {
        toast.error(humanError(error, '这条示例没能恢复回来，再试一次。'))
      })
  }
  const nameOf = (id: string): string => {
    return (
      agents.find((agent) => {
        return agent.id === id
      })?.name ?? id
    )
  }
  const focusComposer = (message: string): void => {
    setFocusToken((token) => {
      return token + 1
    })
    setAnnouncement(message)
  }
  const fillTask = (task: WelcomeTask): void => {
    setDraft(task.prompt)
    setTarget(task.target)
    focusComposer(
      `已填入「${task.title}」，发往${task.target.kind === 'group' ? '小队群' : ryenName}。你可以改完再发。`,
    )
  }
  const pickAgent = (agent: AgentDef): void => {
    setTarget(agent.id === ryenId ? { kind: 'direct' } : { kind: 'direct', agentId: agent.id })
    focusComposer(`下一句发给 ${agent.name}，可以直接输入。`)
  }

  return (
    <div className="welcome">
      <div className="welcome-grid">
        <header className="welcome-head">
          {/* 问候只是一行上下文：它是「谁在」，不是本页的主标题。 */}
          <div className="welcome-context">
            {/* 装饰性品牌猫：同一句话不必由徽标再说一遍，徽标自己是 aria-hidden 的纯装饰。 */}
            <div className="welcome-cat" aria-hidden="true">
              <Cat size={36} />
            </div>
            <p className="welcome-context-line">
              <strong>
                {greeting}，我是 {ryenName}
              </strong>
            </p>
          </div>
          <h1 className="welcome-greeting">今天想一起做点什么？</h1>
        </header>
        {/* 凭据前置：排在能打字之前。硬前置放在页尾，就等于让每个新用户先撞一次错。
            清单还在加载时只画一块轻骨架：这一帧既不能说「缺 Key」，也不该把输入框锁上。 */}
        <div className="welcome-prereq">
          {loadingProviders && (
            <AsyncState
              loading
              skeleton={
                <div className="apikey-card" aria-busy="true">
                  <p className="apikey-title">正在读取模型供应商…</p>
                  <span className="skeleton" style={{ display: 'block', width: '58%', height: 14, margin: '10px 0' }} />
                  <span className="skeleton" style={{ display: 'block', width: '38%', height: 12 }} />
                </div>
              }
            >
              {null}
            </AsyncState>
          )}
          {!loadingProviders && !usable && (
            <div className="apikey-card">
              {presetList.length > 0 && pickedPreset === undefined ? (
                <>
                  <p className="apikey-title">先选一家模型供应商</p>
                  <p className="apikey-hint">哪家都行，key 只存在你这台机器上。换厂商随时能改，助理会跟着走。</p>
                  <div className="provider-picker-grid welcome-preset-grid">
                    {presetList.map((preset) => {
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          className="provider-pick-tile"
                          onClick={() => {
                            setPickedPreset(preset)
                            setKey('')
                            setKeyError(undefined)
                          }}
                        >
                          <ProviderIcon id={preset.id} name={preset.displayName} size={36} />
                          <span className="provider-preset-name">{preset.displayName}</span>
                        </button>
                      )
                    })}
                  </div>
                </>
              ) : (
                <>
                  <p className="apikey-title">
                    {pickedPreset === undefined ? '先填一个 API Key' : `填 ${pickedPreset.displayName} 的 key`}
                  </p>
                  {pickedPreset !== undefined || unconfigured !== undefined ? (
                    <>
                      <p className="apikey-hint">
                        {pickedPreset === undefined
                          ? `还没有配置 ${unconfigured?.displayName ?? ''} 的凭据，聊天会用不了。`
                          : '存在本机的密钥库里，不写进任何配置文件。'}
                      </p>
                      <div className="apikey-row">
                        <input
                          type="password"
                          value={key}
                          placeholder={`${pickedPreset?.displayName ?? unconfigured?.displayName ?? ''} API Key`}
                          autoComplete="off"
                          aria-label={`${pickedPreset?.displayName ?? unconfigured?.displayName ?? ''} API Key`}
                          onChange={(e) => {
                            setKey(e.target.value)
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={saving || key.trim().length === 0}
                          onClick={() => {
                            if (pickedPreset === undefined && unconfigured === undefined) return
                            setSaving(true)
                            setKeyError(undefined)
                            const task =
                              pickedPreset !== undefined && onSaveProviderKey !== undefined
                                ? onSaveProviderKey(pickedPreset, key.trim())
                                : onSaveApiKey((pickedPreset ?? unconfigured)?.id ?? '', key.trim())
                            task
                              .catch((error: unknown) => {
                                setKeyError(humanError(error, '这条 Key 没存下来，再点一次保存。'))
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
                      {pickedPreset !== undefined && (
                        <button
                          type="button"
                          className="provider-pick-back"
                          onClick={() => {
                            setPickedPreset(undefined)
                            setKey('')
                            setKeyError(undefined)
                          }}
                        >
                          换一家
                        </button>
                      )}
                    </>
                  ) : (
                    // 一条能用的来源都没有、连"缺哪家 key"都指不出来时：只说清楚有哪几条路，
                    // 输入框给不出来（给一个也存不进去）。
                    <>
                      <p className="apikey-hint">{noSourceHint ?? '到「我的 → 模型供应商」里加一家，再回来开口。'}</p>
                      <p className="provider-note">填好之前，下面的输入框是关着的——现在发出去一定失败。</p>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        {/* 待办：有未读、或 Ryen 主动开口过的那一条。左栏已经列了全部会话，这里只抬
            起真正"有人等你"的那一条；没有待办时整块不渲染，而不是留一张空卡占位。 */}
        {pending !== undefined && (
          <section className="welcome-recent welcome-pending" aria-label="等你回一句">
            <p className="welcome-label">等你回一句</p>
            <button
              type="button"
              className="welcome-recent-item welcome-pending-row"
              title={`打开「${pending.title || nameOf(pending.memberAgentIds[0] ?? '')}」`}
              onClick={() => {
                onOpenConversation(pending.id)
              }}
            >
              <span className="welcome-continue-avatars" aria-hidden="true">
                {pendingParticipants.map((agent, index) => {
                  return (
                    <span
                      key={agent.id}
                      className="welcome-continue-avatar"
                      style={{ zIndex: pendingParticipants.length - index }}
                    >
                      <Avatar avatarKey={agent.avatar} name={agent.name} seed={agent.id} size={24} />
                    </span>
                  )
                })}
              </span>
              <span className="welcome-continue-body">
                <span className="welcome-continue-title">
                  {pending.proactive === true && (
                    <span className="badge" data-proactive="true">
                      主动
                    </span>
                  )}
                  <span className="welcome-continue-title-text">
                    {pending.title || nameOf(pending.memberAgentIds[0] ?? '')}
                  </span>
                </span>
                <span className="welcome-continue-preview">
                  {humanPreview(pending.lastMessagePreview ?? '') || '还没有消息'}
                </span>
              </span>
              <span className="welcome-continue-side">
                {(pending.unreadCount ?? 0) > 0 && (
                  <span className="unread-badge">{(pending.unreadCount ?? 0) > 99 ? '99+' : pending.unreadCount}</span>
                )}
              </span>
            </button>
          </section>
        )}
        <section className="welcome-suggestions" aria-label="试试这些">
          <p className="welcome-label">试试这些</p>
          <div className="welcome-task-grid">
            {TASKS.map((task) => {
              const toSquad = task.target.kind === 'group'
              const destination = toSquad ? `小队 ${squadFaces.length} 人` : ryenName
              // 左端摆的是**真实去向**的头像：点之前就知道这句话会发给谁，而这正是
              // fillTask 真正会做的事。装饰性图标说的是"我是功能"，头像说的是"发给谁"。
              const faces = toSquad ? squadFaces.slice(0, 2) : [ryen].filter((agent) => agent !== undefined)
              return (
                <button
                  type="button"
                  key={task.title}
                  className="welcome-chip welcome-task"
                  data-prompt={task.prompt}
                  title={`${task.prompt}（发往${destination}）`}
                  onClick={() => {
                    fillTask(task)
                  }}
                >
                  <span className="welcome-task-avatars" aria-hidden="true">
                    {faces.map((agent) => {
                      return (
                        <Avatar
                          key={agent.id}
                          avatarKey={agent.avatar}
                          name={agent.name}
                          seed={agent.id}
                          size={toSquad ? 16 : 20}
                        />
                      )
                    })}
                  </span>
                  <span className="welcome-task-title">{task.title}</span>
                  {/* 去向已经画成头像了，但读屏器读不出头像——补一句给它们。 */}
                  <span className="welcome-sr">发往{destination}</span>
                </button>
              )
            })}
          </div>
        </section>
        {/* 输入 dock 是这一页唯一的焦点，也是唯一一块抬升面。收件人行贴在它上沿，
            像邮件的「收件人」字段：怎么写这句话、发给谁，是同一件事。 */}
        <div className="welcome-compose">
          <div className="welcome-addressee">
            <span className="welcome-addressee-label">发给</span>
            {/*
              每一格的名字就是它自己的可读名（"Ryen" / "小队 · 4 人"），前面那行「发给」
              已经把这一排是什么说清楚了，所以这里不再补一个 role="group" + aria-label：
              那样做只会多出一层读屏要念、而用户已经看得见的话。
            */}
            {team.length > 0 ? (
              <div className="welcome-team-row">
                {team.map(({ agent, role }) => {
                  const selected = selectedTeamId === agent.id
                  const name = agent.id === ryenId ? agent.name : agent.name.length > 0 ? agent.name : role
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      className={selected ? 'welcome-team-member is-selected' : 'welcome-team-member'}
                      aria-pressed={selected}
                      title={`发给 ${name}`}
                      onClick={() => {
                        pickAgent(agent)
                      }}
                    >
                      <Avatar avatarKey={agent.avatar} name={agent.name} seed={agent.id} size={28} />
                      <span className="welcome-team-name">{name}</span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <p className="welcome-team-empty">还没有助理。先到通讯录建一位。</p>
            )}
            {/* 小队是同一件事的另一个选项，不是第二套控件：同一行的另一端，同一组
                aria-pressed 语义，共用选中态那套画法。 */}
            <button
              type="button"
              className={squadSelected ? 'welcome-squad is-selected' : 'welcome-squad'}
              aria-pressed={squadSelected}
              disabled={squad.length < 2}
              title={squad.length < 2 ? '通讯录里只有一位 agent，先新建一位才组得成小队' : '发给通讯录里的全体 agent'}
              onClick={() => {
                setTarget({ kind: 'group' })
                setAnnouncement(`已切到小队，消息会发给 ${squad.length} 位助理。`)
              }}
            >
              小队 · {squad.length} 人
            </button>
          </div>
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
              // 没有可用来源时输入框与发送键都禁用；清单还在加载时保持可输入——那时
              // 「没有来源」尚未成立，锁上等于把「还不知道」演成「不能用」。
              // onSend 这道拦是给键盘与测试的兜底：按钮禁用了不代表回调一定不会被叫到。
              disabled={!usable && !loadingProviders}
              onSend={(text) => {
                if (!usable && !loadingProviders) return
                onSend(text, target)
              }}
            />
          </div>
          {/* key 跟着 focusToken 重挂：连续点同一张任务卡时，同一句播报也会再念一次。 */}
          <p className="welcome-live" role="status" aria-live="polite" key={focusToken}>
            {announcement}
          </p>
        </div>
      </div>
      {/* 页脚只放两件与"这一步做什么"无关的事：数据去哪了，以及示例数据怎么清掉。
          都不该和 composer 抢同一个视觉层。 */}
      <footer className="welcome-foot">
        <details className="welcome-privacy">
          <summary className="welcome-privacy-summary">
            数据存在本机，上下文会发给你选的模型供应商
            <Icon name="chevron-right" size={13} />
          </summary>
          <p className="welcome-privacy-detail">{LOCAL_DATA_NOTE}</p>
        </details>
        {/*
          示例的删除键跟着示例走，但它不再占用一块"会话行"的位置：首屏的会话行只留给
          待办，示例大多不是待办。这里是页脚的一行 housekeeping——一句事实 + 一个叉，
          紧挨着隐私披露：都与"下一步做什么"无关，却都得留着。
          删掉是软删（消息还在库里，删完还能撤销），所以提示里说的是"还能撤销回来"，
          不是"删不回来"——那种话在一个能撤销的删除上就是骗人。
        */}
        {demo !== undefined && (
          <div className="welcome-demo-row">
            <span className="welcome-demo-tag" title="首次启动时自带的示例会话">
              示例
            </span>
            <span className="welcome-demo-title">首次启动时自带的一条</span>
            <button
              type="button"
              className="welcome-demo-clear"
              aria-label="删除示例会话"
              title="删除示例会话（删了还能撤销回来）"
              disabled={deletingDemo}
              onClick={deleteDemo}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        )}
      </footer>
    </div>
  )
}
