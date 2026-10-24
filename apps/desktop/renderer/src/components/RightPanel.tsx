import type { CSSProperties } from 'react'
import { memo, useEffect, useMemo, useState } from 'react'
import type { AgentDef, ApiClient, Conversation, TodoGroup, TodoItem, UsageTotals } from '../api.ts'
import { ApiRequestError } from '../api.ts'
import { builtinBadge } from '../lib/agents.ts'
import { errorDetail, humanError } from '../lib/error-text.ts'
import { formatSize } from '../lib/format.ts'
import { humanTokens, modelPair } from '../lib/humanize.ts'
import { affinityTier, normalizePersona, TRAIT_META, traitBand } from '../lib/persona.ts'
import { toast } from '../lib/toast.ts'
import { toolLabel } from '../lib/tool-labels.ts'
import type { ChatStore, RelayItem } from '../store.ts'
import { panelSliceOf, useChatSlice } from '../store.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { Cat } from './Cat.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { GroupEvolution, RelayTimeline } from './GroupEvolution.tsx'
import { Icon } from './Icon.tsx'
import { MemoryPanel } from './MemoryPanel.tsx'
import { PlaybookPanel } from './PlaybookPanel.tsx'

/**
 * 右栏自己的重绘窗口。
 *
 * 右栏展示的接力链与产物在一轮里最多各变一次（一次 dispatch、一次产物卡片），流式期间
 * 一个 token 都不动；跟着 store 的基础 40ms 窗口重绘，纯粹是为一件与自己无关的事付出
 * 25 次/秒的 React 协调。200ms（5fps）足够让 dispatch 与产物及时出现。
 */
const PANEL_THROTTLE_MS = 200

/**
 * 右栏信息板：单聊 = 资料卡 + 产物；群聊 = 成员网格 + 调度时间线 + 产物。
 *
 * 自己订阅 chat store（不再由 App 根组件转发 props），且**只订阅自己用到的那一切面**
 * （接力链 + 产物，见 panelSliceOf）：消息区要在 25fps 里出字，右栏跟着同一个 tick
 * 重渲染纯属白花。三个内容组件全部 memo：流式期间它们展示的东西一个 token 都不会变。
 */
export function RightPanel({
  api,
  store,
  conversation,
  agents,
  conversations,
  fileUrl,
  collapsed,
  overlay,
  open,
  onToggle,
  onOpenPlugins,
  onPreview,
}: {
  api: ApiClient
  store: ChatStore
  conversation: Conversation | undefined
  agents: AgentDef[]
  conversations: Conversation[]
  fileUrl: (name: string) => string
  collapsed: boolean
  /**
   * 窄窗：面板改走覆盖式抽屉（盖在聊天区上面），不再占固定的一列。
   *
   * 此前这个宽度下整块 display:none——记忆、手册、待办、调度轨迹一个入口都没有，
   * 内容还在服务端却既看不到也打不开。
   */
  overlay?: boolean
  /** 抽屉此刻是开着的吗（覆盖态下由它决定滑进滑出）。 */
  open?: boolean
  onToggle: () => void
  /** 待办插件关闭时的出口；不传则只显示文案（页面级测试可以省掉导航）。 */
  onOpenPlugins?: () => void
  /** 打开产物内嵌预览；缺省时产物行退回「新窗口打开」。 */
  onPreview?: (file: { name: string; mime: string; size: number }) => void
}) {
  const [memoryFor, setMemoryFor] = useState<AgentDef | undefined>(undefined)
  const [playbookFor, setPlaybookFor] = useState<AgentDef | undefined>(undefined)
  const select = useMemo(() => {
    return panelSliceOf(store)
  }, [store])
  const { relays, artifacts } = useChatSlice(store, select, PANEL_THROTTLE_MS)
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
  //
  // 覆盖态（窄窗抽屉）不看 collapsed：抽屉的开关由壳掌握，宽度过渡换成位移过渡。
  const panelClass =
    overlay === true
      ? `right-panel is-overlay${open === true ? ' is-overlay-open' : ''}`
      : collapsed
        ? 'right-panel is-collapsed'
        : 'right-panel'
  return (
    <aside className={panelClass}>
      <span className="panel-banner" aria-hidden="true" />
      {/* 收起键与展开键在同一角上互换，面板本体始终在场。
          覆盖态下这两枚键都换成"关掉抽屉"，因为它此刻盖在聊天区上面。 */}
      {overlay === true ? (
        <button
          type="button"
          className="panel-expand-btn"
          title="收起信息板"
          aria-label="收起信息板"
          onClick={onToggle}
        >
          <Icon name="chevron-right" size={16} />
        </button>
      ) : collapsed ? (
        <button
          type="button"
          className="panel-expand-btn"
          title="展开信息板"
          aria-label="展开信息板"
          onClick={onToggle}
        >
          <Icon name="panel-right" size={16} />
        </button>
      ) : (
        <button
          type="button"
          className="right-panel-toggle"
          title="收起信息板"
          aria-label="收起信息板"
          onClick={onToggle}
        >
          <Icon name="chevron-right" size={16} />
        </button>
      )}
      <div className="panel-body">
        {/* 待办排在**最前**：它是这一栏里唯一能动手的东西（能勾、能清空），
            而下面那些全是参考资料——助理是谁、这场群里有谁、产出过哪些文件。
            用户点开右栏，多半就是为了勾掉一件事；把它压在资料卡后面，等于把
            唯一可操作的清单塞到首屏之外。 */}
        {conversation !== undefined && (
          <TodoSection
            api={api}
            conversationId={conversation.id}
            updatedAt={conversation.updatedAt}
            onOpenPlugins={onOpenPlugins}
          />
        )}
        {conversation === undefined ? (
          <p className="panel-empty">选择一个会话查看详情</p>
        ) : conversation.kind === 'direct' ? (
          <DirectProfile
            agentId={conversation.memberAgentIds[0]}
            agents={agents}
            artifacts={artifacts}
            fileUrl={fileUrl}
            onPreview={onPreview}
            onShowMemories={setMemoryFor}
            onShowPlaybook={setPlaybookFor}
          />
        ) : (
          <GroupInfo
            conversation={conversation}
            agents={agents}
            relays={relays}
            artifacts={artifacts}
            fileUrl={fileUrl}
            onPreview={onPreview}
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

/** 待办区依赖的三条接口（与 ApiClient 上的可选属性同形）。 */
interface TodoClient {
  listTodos(conversationId: string): Promise<TodoGroup>
  setTodoDone(conversationId: string, id: string, done: boolean): Promise<TodoGroup>
  clearTodos(conversationId: string): Promise<TodoGroup>
  /** 撤销清空（服务端未实现时整块降级为"不可撤销"）。 */
  restoreTodos?(conversationId: string, items: TodoItem[]): Promise<TodoGroup>
}

function todoClientOf(api: ApiClient): TodoClient | undefined {
  const { listTodos, setTodoDone, clearTodos, restoreTodos } = api
  if (listTodos === undefined || setTodoDone === undefined || clearTodos === undefined) return undefined
  return {
    listTodos,
    setTodoDone,
    clearTodos,
    ...(restoreTodos === undefined ? {} : { restoreTodos }),
  }
}

type TodoState =
  | { status: 'loading' }
  | { status: 'ready'; items: TodoItem[] }
  | { status: 'disabled' }
  /** `detail` = 服务端原话，只出现在折起来的「详情」里（见 lib/error-text.ts）。 */
  | { status: 'error'; message: string; detail?: string }

/** 服务端形状不对时按空清单处理：列表区不该因为一版坏回包整块崩掉。 */
function itemsOf(group: TodoGroup): TodoItem[] {
  return Array.isArray(group.items) ? group.items : []
}

/** 插件关闭时服务端连路由一起撤掉，GET 回的是通用 NOT_FOUND；业务 404 另有机器码。 */
function isPluginOff(error: unknown): boolean {
  return (
    error instanceof ApiRequestError && error.status === 404 && (error.code === undefined || error.code === 'NOT_FOUND')
  )
}

/**
 * 当前会话的待办区。
 *
 * 数据来自 `todo` 插件挂的 `/api/todos`：插件关闭后路由 404，这里显示「插件已关闭」
 * 而不是一个红色报错——用户只是关了一个功能，不是系统坏了。`updatedAt` 变化时
 * 重取：助理刚用 todo 工具写完，一轮结束后的会话刷新会把新清单带进来。
 */
const TodoSection = memo(function TodoSection({
  api,
  conversationId,
  updatedAt,
  onOpenPlugins,
}: {
  api: ApiClient
  conversationId: string
  /** 会话更新时间：每轮结束后 App 会刷新会话列表，这里据此重取清单。 */
  updatedAt: number
  onOpenPlugins?: (() => void) | undefined
}) {
  const client = useMemo(() => {
    return todoClientOf(api)
  }, [api])
  const [state, setState] = useState<TodoState>({ status: 'loading' })
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  /** 清空待办的确认弹窗开着。 */
  const [confirmingClear, setConfirmingClear] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: updatedAt 只作重取触发器，不在 effect 体内读取
  useEffect(() => {
    if (client === undefined) return
    let alive = true
    setState({ status: 'loading' })
    setActionError(undefined)
    client.listTodos(conversationId).then(
      (group) => {
        if (alive) setState({ status: 'ready', items: itemsOf(group) })
      },
      (error: unknown) => {
        if (!alive) return
        if (isPluginOff(error)) {
          setState({ status: 'disabled' })
          return
        }
        const detail = errorDetail(error)
        setState({
          status: 'error',
          message: humanError(error, '待办清单没读出来，再试一次'),
          ...(detail === undefined ? {} : { detail }),
        })
      },
    )
    return () => {
      alive = false
    }
  }, [client, conversationId, updatedAt])

  if (client === undefined) return null

  const applyResult = (group: TodoGroup): void => {
    setState({ status: 'ready', items: itemsOf(group) })
  }
  const reportError = (error: unknown, prefix: string): void => {
    if (isPluginOff(error)) {
      setState({ status: 'disabled' })
      return
    }
    setActionError(`${prefix}：${humanError(error, '再试一次')}`)
  }

  const toggle = async (item: TodoItem): Promise<void> => {
    setBusy(item.id)
    setActionError(undefined)
    try {
      applyResult(await client.setTodoDone(conversationId, item.id, !item.done))
    } catch (error) {
      reportError(error, '没能更新这条待办')
    } finally {
      setBusy(undefined)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy('clear')
    setActionError(undefined)
    // 清空前把这一批留在手里：撤销要靠它原样写回（id 与勾选状态都不丢）。
    const removed = state.status === 'ready' ? state.items : []
    try {
      applyResult(await client.clearTodos(conversationId))
    } catch (error) {
      reportError(error, '没能清空待办')
      return
    } finally {
      setBusy(undefined)
    }
    toast.success('待办已清空', {
      duration: 8000,
      action: {
        label: '撤销',
        run: () => {
          void undoClear(removed)
        },
      },
    })
  }

  /** 撤销清空：把被清掉的那批待办原样写回去。 */
  const undoClear = async (items: readonly TodoItem[]): Promise<void> => {
    if (client.restoreTodos === undefined) {
      toast.error('这个版本的服务端还没有撤销清空的接口。')
      return
    }
    try {
      applyResult(await client.restoreTodos(conversationId, [...items]))
      toast.success('已撤销清空')
    } catch (error) {
      reportError(error, '没能撤销清空')
    }
  }

  const items = state.status === 'ready' ? state.items : []
  return (
    <>
      <div className="todo-head">
        <h4>待办{state.status === 'ready' && items.length > 0 ? `（${items.length}）` : ''}</h4>
        {state.status === 'ready' && items.length > 0 && (
          <button
            type="button"
            className="btn btn-mini"
            disabled={busy === 'clear'}
            onClick={() => {
              // 一键清空整个清单是右栏里最狠的一个动作：先问一句（撤不回来
              // 的那种"不可逆"提示语已经不成立了——清完还能撤销）。
              setConfirmingClear(true)
            }}
          >
            清空
          </button>
        )}
      </div>
      {state.status === 'loading' && <p className="panel-empty">正在读取待办…</p>}
      {state.status === 'disabled' && (
        <div className="todo-plugin-off">
          <span className="panel-empty">待办插件已关闭</span>
          {onOpenPlugins !== undefined && (
            <button type="button" className="btn btn-mini" onClick={onOpenPlugins}>
              打开插件页
            </button>
          )}
        </div>
      )}
      {state.status === 'error' && <p className="panel-empty">待办没读出来。</p>}
      {state.status === 'ready' && items.length === 0 && <p className="panel-empty">还没有待办。</p>}
      {items.length > 0 && (
        <ul className="todo-list">
          {items.map((item) => {
            return (
              <li key={item.id}>
                <label className={item.done ? 'todo-text is-done' : 'todo-text'}>
                  <input
                    type="checkbox"
                    checked={item.done}
                    disabled={busy === item.id}
                    aria-label={`${item.done ? '标记未完成' : '标记完成'}：${item.text}`}
                    onChange={() => {
                      void toggle(item)
                    }}
                  />
                  <span>{item.text}</span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
      {actionError !== undefined && (
        <p className="panel-empty" role="status">
          {actionError}
        </p>
      )}
      {confirmingClear && (
        <ConfirmDialog
          title="清空这份待办？"
          body="助理记下的这些跟进事项会从清单里移除。清空之后还能在提示里撤销一次。"
          confirmLabel="清空"
          onCancel={() => {
            setConfirmingClear(false)
          }}
          onConfirm={async () => {
            setConfirmingClear(false)
            await clear()
          }}
        />
      )}
    </>
  )
})

/**
 * 本会话累计 token 用量。数据来自 GET /api/conversations/:id 的 usage（服务端对
 * 各条消息求和），随会话 updatedAt 变化重取；还没有任何一轮用量时不占那一行。
 * 单位已换成人话（千字/万字）——token 是开发者单位，不该出现在用户界面。
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
        已用 {humanTokens(usage.totalTokens)}（输入 {humanTokens(usage.inputTokens)} · 输出{' '}
        {humanTokens(usage.outputTokens)}）
      </dd>
    </dl>
  )
})

const ArtifactList = memo(function ArtifactList({
  artifacts,
  fileUrl,
  onPreview,
}: {
  artifacts: { callId: string; name: string; size: number; mime: string }[]
  fileUrl: (name: string) => string
  onPreview?: (file: { name: string; mime: string; size: number }) => void
}) {
  if (artifacts.length === 0) {
    return (
      <div className="artifact-empty">
        {/* 空态要有个东西接住眼睛：用母版猫（与头像、图标、启动屏同一只），不再是两行纯文本。 */}
        <span className="artifact-empty-cat" aria-hidden="true">
          <Cat size={56} shape="circle" />
        </span>
        <p className="panel-empty">本会话还没有产物文件</p>
        <p className="panel-empty">助理产出文件后会出现在这里。</p>
      </div>
    )
  }
  return (
    <ul className="artifact-list">
      {artifacts.map((artifact) => (
        <li key={artifact.callId}>
          <span aria-hidden="true">
            <Icon name="file" size={16} />
          </span>
          <span className="artifact-name" title={artifact.name}>
            {artifact.name}
            <small>{formatSize(artifact.size)}</small>
          </span>
          {/* 与气泡里的文件卡同一个判断：产物先给人看，下载是显式的第二个动作。 */}
          {onPreview === undefined ? (
            <a href={fileUrl(artifact.name)} target="_blank" rel="noreferrer">
              打开
            </a>
          ) : (
            <button
              type="button"
              onClick={() => {
                onPreview({ name: artifact.name, mime: artifact.mime, size: artifact.size })
              }}
            >
              预览
            </button>
          )}
          {/* `file-open` 不能少：静默样式的规则是 `.file-open.is-quiet`（两个类），
              只写 `is-quiet` 就不命中，下载会落回 `.artifact-list a` 的主操作样式——
              于是「预览」与「下载」同色同字重，两个并列的主要动作。 */}
          <a className="file-open is-quiet" href={fileUrl(artifact.name)} download={artifact.name}>
            下载
          </a>
        </li>
      ))}
    </ul>
  )
})

/**
 * 「首次相遇」的日期。
 *
 * 服务端 GET /api/agents 下发的 StoredAgent 带 createdAt（ms），但渲染层的 AgentDef
 * 还没声明这个字段（api.ts 归另一条线）。这里就地窄化一次，读不到就如实说未知，
 * 不猜日期——资料卡上的日期必须是真数据。
 */
function firstMetLabel(agent: AgentDef): string {
  const createdAt = (agent as AgentDef & { createdAt?: number }).createdAt
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) return '未知'
  return new Date(createdAt).toLocaleDateString('zh-CN')
}

const DirectProfile = memo(function DirectProfile({
  agentId,
  agents,
  artifacts,
  fileUrl,
  onPreview,
  onShowMemories,
  onShowPlaybook,
}: {
  agentId: string | undefined
  agents: AgentDef[]
  artifacts: { callId: string; name: string; size: number; mime: string }[]
  fileUrl: (name: string) => string
  onPreview?: (file: { name: string; mime: string; size: number }) => void
  onShowMemories: (agent: AgentDef) => void
  onShowPlaybook: (agent: AgentDef) => void
}) {
  const agent = agents.find((a) => {
    return a.id === agentId
  })
  if (agent === undefined) return <p className="panel-empty">这位助理已经不在了。</p>
  // 存量 agent 没有 persona 字段：按默认人格展示，别让资料卡在人格这一节空着。
  const persona = normalizePersona(agent.persona)
  const tier = affinityTier(persona.affinity)
  const badge = builtinBadge(agent)
  return (
    <>
      <div className="profile-head">
        <Avatar
          avatarKey={agent.avatar}
          name={agent.name}
          seed={agent.id}
          size={80}
          className="avatar-lg-ring"
          breathing
        />
        <h3>
          {agent.name}
          {badge !== undefined && <span className="badge">{badge}</span>}
        </h3>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            className="btn"
            onClick={() => {
              onShowMemories(agent)
            }}
          >
            <Icon name="brain" size={16} /> 记忆
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              onShowPlaybook(agent)
            }}
          >
            <Icon name="check" size={16} /> 经验手册
          </button>
        </div>
      </div>
      <dl className="profile-fields">
        <dt>人设</dt>
        <dd className="profile-prompt">{agent.systemPrompt}</dd>
        {/* 性格四维：分档名与描述取自内核同一份文案，鼠标悬停看得到该档的行为解释。 */}
        <dt>性格</dt>
        <dd>
          <span className="tool-chips">
            {TRAIT_META.map((meta) => {
              const band = traitBand(meta, persona[meta.key])
              return (
                <span key={meta.key} className="chip" title={band.describe}>
                  {meta.label} · {band.label}
                </span>
              )
            })}
          </span>
        </dd>
        <dt>相处</dt>
        <dd>
          {tier.label}（亲密度 {persona.affinity}/100）——{tier.address}
        </dd>
        {persona.birthday !== undefined && (
          <>
            <dt>生日</dt>
            <dd>{persona.birthday}</dd>
          </>
        )}
        {persona.appearance.length > 0 && (
          <>
            <dt>形象</dt>
            <dd>{persona.appearance}</dd>
          </>
        )}
        <dt>首次相遇</dt>
        <dd>{firstMetLabel(agent)}</dd>
        <dt>模型</dt>
        <dd>{modelPair(agent.provider, agent.model)}</dd>
        <dt>工具</dt>
        <dd>
          {agent.tools.length === 0 ? (
            <span className="panel-empty">不调用任何工具</span>
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
      <ArtifactList artifacts={artifacts} fileUrl={fileUrl} onPreview={onPreview} />
    </>
  )
})

/**
 * 调度者皇冠与名字之间留 3px：名字是 nowrap + ellipsis，图标紧贴文字会读成一个词。
 * 皇冠放在名字前面而不是后面——名字过长时省略号吃的是名字，标记始终可见。
 */
const DISPATCH_MARK_STYLE: CSSProperties = { display: 'inline-flex', verticalAlign: '-3px', marginRight: 3 }

const GroupInfo = memo(function GroupInfo({
  conversation,
  agents,
  relays,
  artifacts,
  fileUrl,
  onPreview,
  onShowMemories,
  onShowPlaybook,
}: {
  conversation: Conversation
  agents: AgentDef[]
  relays: readonly RelayItem[]
  artifacts: { callId: string; name: string; size: number; mime: string }[]
  fileUrl: (name: string) => string
  onPreview?: (file: { name: string; mime: string; size: number }) => void
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
            <span
              className="member-name"
              // 名字在三列网格里会被截断（六七个汉字），所以**全名必须能拿回来**：
              // 调度者另给一句说明，普通成员给全名——原来只有调度者有 title，
              // 于是普通成员截断后 hover 也看不到自己是谁。
              title={conversation.dispatcherAgentId === member.id ? `${member.name} · 本会话的调度者` : member.name}
            >
              {conversation.dispatcherAgentId === member.id ? (
                <span style={DISPATCH_MARK_STYLE}>
                  <Icon name="crown" size={16} />
                </span>
              ) : null}
              {member.name}
            </span>
          </div>
        ))}
      </div>
      {/* 群聊此前完全没有记忆/经验手册入口，"群里的人也在进化"这件事看不见。 */}
      <GroupEvolution members={members} onShowMemories={onShowMemories} onShowPlaybook={onShowPlaybook} />
      {/* 标题归 RelayTimeline 自己：折叠行要整行可点，标题留在外面就没法一起点 */}
      <RelayTimeline relays={relays} nameOf={nameOf} />
      <h4>本会话产物</h4>
      <ArtifactList artifacts={artifacts} fileUrl={fileUrl} onPreview={onPreview} />
    </>
  )
})
