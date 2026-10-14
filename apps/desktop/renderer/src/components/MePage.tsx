import { useEffect, useState } from 'react'
import type {
  AgentDef,
  Conversation,
  MemoryRow,
  MemoryStats,
  MessageUsageRow,
  ProviderInfo,
  TelemetrySnapshot,
} from '../api.ts'
import { toast } from '../lib/toast.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { Icon } from './Icon.tsx'
import { MemoryHealth } from './MemoryPanel.tsx'
import { Modal } from './Modal.tsx'
import type { ProviderApi } from './ProviderSettings.tsx'
import { ProviderSettings } from './ProviderSettings.tsx'
import { WorkspaceSection } from './WorkspaceSection.tsx'

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface MeApi extends ProviderApi {
  listAgentMemories(agentId: string): Promise<{ agent: MemoryRow[]; shared: MemoryRow[] }>
  patchAgent(id: string, patch: Record<string, unknown>): Promise<{ agent: AgentDef }>
  workspace(): Promise<{ path: string }>
  /**
   * 用量账单与记忆健康度要读的数据面。方法可选：缺任一条只会让对应区块显示一句
   * 说明（服务端版本落后时最常走这条路），不该让「我的」页报错或空着。
   */
  conversations?(): Promise<{ conversations: Conversation[] }>
  listAgents?(): Promise<{ agents: AgentDef[] }>
  listUsageRows?(conversationId: string, limit?: number): Promise<{ messages: MessageUsageRow[] }>
  memoryStats?(): Promise<MemoryStats>
  telemetry?(limit?: number): Promise<TelemetrySnapshot>
  listArchivedMemories?(): Promise<{ items: MemoryRow[] }>
}

/**
 * 「我的」页：用户卡（你）、猫管家卡（Ryen，昵称可改）、工作区、供应商、共享画像、关于。
 *
 * 此前这一页只有一张卡，画的是 Ryen 的猫、写的是它的名字——页面叫「我的」，
 * 用户却找不到自己，编辑的还总是内置 agent 的名字。用户与 agent 是两件事，分开说。
 */
export function MePage({
  api,
  ryen,
  providers,
  theme,
  onThemeChange,
  onRyenPatched,
}: {
  api: MeApi
  ryen: AgentDef | undefined
  providers: ProviderInfo[]
  theme: 'light' | 'dark'
  onThemeChange: (theme: 'light' | 'dark') => void
  onRyenPatched?: () => void
}) {
  const [shared, setShared] = useState<MemoryRow[] | undefined>(undefined)
  const [sharedError, setSharedError] = useState<string | undefined>(undefined)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [showAbout, setShowAbout] = useState(false)
  useEffect(() => {
    if (ryen === undefined) return
    api
      .listAgentMemories(ryen.id)
      .then(({ shared: profile }) => {
        setShared(profile)
        setSharedError(undefined)
      })
      .catch((error: unknown) => {
        // 清空列表等于把「读不出来」说成「还没有画像」。
        setShared([])
        setSharedError(reason(error))
      })
  }, [api, ryen])

  const saveName = async (): Promise<void> => {
    if (ryen === undefined) return
    const trimmed = nameDraft.trim()
    setEditingName(false)
    if (trimmed.length === 0 || trimmed === ryen.name) return
    try {
      await api.patchAgent(ryen.id, { name: trimmed })
    } catch (error) {
      toast.error(`改昵称失败：${reason(error)}`)
      return
    }
    toast.success(`猫管家现在叫「${trimmed}」`)
    onRyenPatched?.()
  }

  return (
    <section className="page">
      <header className="page-header">
        <h2>我的</h2>
      </header>
      <div className="page-scroll">
        <div className="page-scroll-col me-page">
          <div className="me-usercard">
            <span className="me-avatar">
              <Avatar name="你" seed="you" size={96} />
            </span>
            <p className="me-name is-static">你</p>
            <p className="me-sub">这台电脑上的使用者 · 数据都在本机，不上传</p>
          </div>

          {ryen !== undefined && (
            <div className="me-section">
              <div className="me-row me-butler">
                <Avatar avatarKey={ryen.avatar} name={ryen.name} seed={ryen.id} size={44} />
                <div className="me-row-body">
                  {editingName ? (
                    <input
                      className="me-name-inline"
                      value={nameDraft}
                      aria-label="猫管家昵称"
                      // biome-ignore lint/a11y/noAutofocus: 点击昵称进入行内编辑，聚焦输入框是预期行为
                      autoFocus
                      onChange={(e) => {
                        setNameDraft(e.target.value)
                      }}
                      onBlur={() => {
                        void saveName()
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveName()
                        if (e.key === 'Escape') setEditingName(false)
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="me-row-title me-inline-edit"
                      title="给它改个昵称"
                      onClick={() => {
                        setNameDraft(ryen.name)
                        setEditingName(true)
                      }}
                    >
                      {ryen.name} <Icon name="pencil" size={12} className="me-pencil" />
                    </button>
                  )}
                  <div className="me-row-sub">猫管家总管 · 内置 Agent（改的是它的名字，不是你的）</div>
                </div>
                <span className="badge">内置</span>
              </div>
            </div>
          )}

          <div className="me-section">
            <WorkspaceSection api={api} />
          </div>

          <div className="me-section">
            <ProviderSettings
              api={api}
              providers={providers}
              onChanged={() => {
                onRyenPatched?.()
              }}
            />
          </div>

          <div className="me-section">
            <div className="me-row" style={{ alignItems: 'flex-start' }}>
              <div className="me-row-body">
                <div className="me-row-title">
                  <Icon name="clipboard-list" size={15} /> 用量账单
                </div>
                <div className="me-row-sub">跨会话、跨供应商累计花了多少 token——换模型前先在这里比一比</div>
                <UsageLedger api={api} providers={providers} />
              </div>
            </div>
            <div className="me-row" style={{ alignItems: 'flex-start' }}>
              <div className="me-row-body">
                <div className="me-row-title">
                  <Icon name="brain" size={15} /> 记忆健康度
                </div>
                <div className="me-row-sub">长期记忆库的整体状态；单个 agent 的条目在右栏记忆面板里</div>
                <MemoryHealth api={api} />
              </div>
            </div>
          </div>

          <div className="me-section">
            <div className="me-row">
              <div className="me-row-body">
                <div className="me-row-title">外观主题</div>
                <div className="me-row-sub">暖琥珀浅色 / 暖黑暗色</div>
              </div>
              <span className="theme-toggle" role="radiogroup" aria-label="主题">
                {/* biome-ignore lint/a11y/useSemanticElements: 胶囊式单选，原生 radio 的样式无法套用 .theme-toggle button */}
                <button
                  type="button"
                  role="radio"
                  aria-checked={theme === 'light'}
                  className={theme === 'light' ? 'is-active' : ''}
                  onClick={() => {
                    onThemeChange('light')
                  }}
                >
                  <Icon name="sun" size={14} /> 浅色
                </button>
                {/* biome-ignore lint/a11y/useSemanticElements: 同上 */}
                <button
                  type="button"
                  role="radio"
                  aria-checked={theme === 'dark'}
                  className={theme === 'dark' ? 'is-active' : ''}
                  onClick={() => {
                    onThemeChange('dark')
                  }}
                >
                  <Icon name="moon" size={14} /> 暗色
                </button>
              </span>
            </div>
            <button
              type="button"
              className="me-row me-row-btn"
              onClick={() => {
                setShowAbout(true)
              }}
            >
              <div className="me-row-body">
                <div className="me-row-title">关于 RyAgent</div>
                <div className="me-row-sub">版本、开源许可与第三方署名</div>
              </div>
              <span className="me-chevron" aria-hidden="true">
                ›
              </span>
            </button>
            <div className="me-row" style={{ alignItems: 'flex-start' }}>
              <div className="me-row-body">
                <div className="me-row-title">
                  <Icon name="brain" size={15} /> {ryen?.name ?? 'Ryen'} 了解你
                </div>
                <div className="me-row-sub">共享画像——从你们的对话中沉淀，注入每轮记忆</div>
                {sharedError !== undefined ? (
                  <p className="apikey-error" role="alert" style={{ marginTop: 8 }}>
                    共享画像没读出来：{sharedError}
                  </p>
                ) : (
                  shared !== undefined && (
                    <ul className="memory-list" style={{ marginTop: 8 }}>
                      {shared.length === 0 && <li className="panel-empty">还没有画像，聊几轮就有了。</li>}
                      {shared.map((memory) => (
                        <li key={memory.id} className="memory-row">
                          <span className={`memory-kind kind-${memory.kind}`}>{memory.kind}</span>
                          <span className="memory-content">{memory.content}</span>
                        </li>
                      ))}
                    </ul>
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {showAbout && (
        <Modal
          title="关于 RyAgent"
          onClose={() => {
            setShowAbout(false)
          }}
        >
          <AboutContent />
        </Modal>
      )}
    </section>
  )
}

/** 用量账单的一行：某个会话 / 某家供应商的累计 token。 */
interface UsageBucket {
  key: string
  label: string
  sub: string
  input: number
  output: number
  total: number
  messages: number
}

/** 会话用量，另按发言 agent 拆一份——供应商归因只能用这一维。 */
interface ConversationUsage extends UsageBucket {
  byAgent: { agentId: string; input: number; output: number; total: number; messages: number }[]
}

/** 账单一次最多列出的行数；再多折叠成一句「另有 N 项」。 */
const LEDGER_ROWS = 8

/** token 缩写：千位一位小数，1k 以下原样。 */
function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 1000) return String(Math.max(0, Math.round(value)))
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/**
 * 单个会话的用量：服务端把 usage 挂在每条 assistant 消息上，会话级汇总并不保留
 * "哪个 agent 花的"，所以这里读消息行而不是 GET /api/conversations/:id 的合计。
 * 两个维度（按会话 / 按供应商）必须来自同一批消息，否则两栏加总对不上、看着像 bug。
 */
async function conversationUsage(api: MeApi, conversation: Conversation): Promise<ConversationUsage> {
  const rows = (
    await api.listUsageRows!(conversation.id).catch(() => {
      return { messages: [] }
    })
  ).messages
  const byAgent = new Map<string, { input: number; output: number; total: number; messages: number }>()
  let input = 0
  let output = 0
  let total = 0
  let messages = 0
  for (const row of rows) {
    const usage = row.usage
    if (usage === undefined || row.senderId === undefined) continue
    const rowTotal = usage.totalTokens ?? usage.inputTokens + usage.outputTokens
    input += usage.inputTokens
    output += usage.outputTokens
    total += rowTotal
    messages += 1
    const acc = byAgent.get(row.senderId) ?? { input: 0, output: 0, total: 0, messages: 0 }
    acc.input += usage.inputTokens
    acc.output += usage.outputTokens
    acc.total += rowTotal
    acc.messages += 1
    byAgent.set(row.senderId, acc)
  }
  return {
    key: conversation.id,
    label: conversation.title,
    sub: conversation.kind === 'group' ? `群聊 · ${conversation.memberAgentIds.length} 位成员` : '单聊',
    input,
    output,
    total,
    messages,
    byAgent: [...byAgent].map(([agentId, acc]) => {
      return { agentId, ...acc }
    }),
  }
}

/** 把按会话的账单折成按供应商：发言 agent → 其绑定的供应商（agent 已删则记未知）。 */
function byProvider(rows: ConversationUsage[], agents: AgentDef[], providers: ProviderInfo[]): UsageBucket[] {
  const buckets = new Map<string, UsageBucket & { agentNames: Set<string> }>()
  for (const row of rows) {
    for (const usage of row.byAgent) {
      const agent = agents.find((a) => {
        return a.id === usage.agentId
      })
      const providerId = agent?.provider ?? 'unknown'
      const bucket = buckets.get(providerId) ?? {
        key: providerId,
        label:
          providers.find((p) => {
            return p.id === providerId
          })?.displayName ?? providerId,
        sub: providerId,
        input: 0,
        output: 0,
        total: 0,
        messages: 0,
        agentNames: new Set<string>(),
      }
      bucket.input += usage.input
      bucket.output += usage.output
      bucket.total += usage.total
      bucket.messages += usage.messages
      if (agent !== undefined) bucket.agentNames.add(agent.name)
      buckets.set(providerId, bucket)
    }
  }
  return [...buckets.values()]
    .sort((a, b) => {
      return b.total - a.total
    })
    .map((bucket) => {
      const names = [...bucket.agentNames]
      return {
        key: bucket.key,
        label: bucket.key === 'unknown' ? '未知供应商' : bucket.label,
        sub: names.length === 0 ? '发言方已删除' : names.join('、'),
        input: bucket.input,
        output: bucket.output,
        total: bucket.total,
        messages: bucket.messages,
      }
    })
}

/**
 * 用量账单：跨会话、跨供应商的累计 token。此前只有右栏一行"本会话用了多少"，
 * 换个模型到底贵没贵、花在哪个会话，只能靠感觉。
 *
 * 口径写在界面上：只统计每个会话最近 200 条消息里带 usage 的模型调用（服务端单页
 * 上限），更早的轮次要等聚合端点才有——那也是本块需要服务端补的东西。
 */
function UsageLedger({ api, providers }: { api: MeApi; providers: ProviderInfo[] }) {
  const [rows, setRows] = useState<ConversationUsage[] | undefined>(undefined)
  const [agents, setAgents] = useState<AgentDef[]>([])
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [view, setView] = useState<'conversation' | 'provider'>('conversation')

  useEffect(() => {
    if (api.conversations === undefined || api.listUsageRows === undefined) {
      setProblem('这版服务端还没有提供用量数据，账单暂时做不出来。')
      return
    }
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const { conversations } = await api.conversations!()
        const [perConversation, agentList] = await Promise.all([
          Promise.all(
            conversations.map((conversation) => {
              return conversationUsage(api, conversation)
            }),
          ),
          api.listAgents?.().catch(() => {
            return { agents: [] }
          }) ?? Promise.resolve({ agents: [] }),
        ])
        if (!alive) return
        setRows(
          perConversation.filter((row) => {
            return row.messages > 0
          }),
        )
        setAgents(agentList.agents)
        setProblem(undefined)
      } catch (error) {
        // 统计读不出来就说读不出来：空表和"真的没用过 token"长得一模一样。
        if (alive) setProblem(`用量没读出来：${reason(error)}`)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [api])

  if (problem !== undefined) {
    return (
      <p className="panel-empty" role="alert" style={{ marginTop: 8 }}>
        {problem}
      </p>
    )
  }
  if (rows === undefined) {
    return (
      <p className="panel-empty" style={{ marginTop: 8 }}>
        用量统计中…
      </p>
    )
  }
  const buckets =
    view === 'conversation' ? [...rows].sort((a, b) => b.total - a.total) : byProvider(rows, agents, providers)
  const totals = rows.reduce(
    (acc, row) => {
      return { input: acc.input + row.input, output: acc.output + row.output, total: acc.total + row.total }
    },
    { input: 0, output: 0, total: 0 },
  )
  return (
    <div className="usage-ledger">
      <p className="usage-total">
        累计 {formatTokens(totals.total)} tokens · 输入 {formatTokens(totals.input)} · 输出{' '}
        {formatTokens(totals.output)}
        <span className="usage-scope">覆盖 {rows.length} 个会话 · 每个会话最近 200 条消息</span>
      </p>
      <div className="usage-tabs">
        <button
          type="button"
          aria-pressed={view === 'conversation'}
          className={view === 'conversation' ? 'usage-tab is-active' : 'usage-tab'}
          onClick={() => {
            setView('conversation')
          }}
        >
          按会话
        </button>
        <button
          type="button"
          aria-pressed={view === 'provider'}
          className={view === 'provider' ? 'usage-tab is-active' : 'usage-tab'}
          onClick={() => {
            setView('provider')
          }}
        >
          按供应商
        </button>
      </div>
      {buckets.length === 0 ? (
        <p className="panel-empty">还没有可统计的用量——聊一轮就会出现在这里。</p>
      ) : (
        <>
          <ul className="usage-list">
            {buckets.slice(0, LEDGER_ROWS).map((bucket) => (
              <li key={bucket.key} className="usage-row">
                <span className="usage-name" title={bucket.label}>
                  {bucket.label}
                </span>
                <span className="usage-sub">{bucket.sub}</span>
                <span className="usage-total-num" title={`输入 ${bucket.input} · 输出 ${bucket.output}`}>
                  {formatTokens(bucket.total)}
                </span>
              </li>
            ))}
          </ul>
          {buckets.length > LEDGER_ROWS && <p className="usage-more">另有 {buckets.length - LEDGER_ROWS} 项未列出</p>}
        </>
      )}
    </div>
  )
}

/**
 * 关于弹窗正文。单独导出是为了能被测试直接断言——署名写错是最难靠肉眼复查、
 * 又最容易在重构里悄悄漂移的一处（此前就署着早已不用的 Fluent Emoji 与四个
 * DiceBear 家族）。只写**实际在用**的资产，数量以 renderer 的注册表为准。
 */
export function AboutContent() {
  return (
    <div className="about-body">
      <p>
        <strong>RyAgent</strong> v0.1.0 · 单机多 Agent 即时通讯桌面应用
      </p>
      <p>
        本体以 <strong>MIT License</strong> 发布（见仓库 LICENSE）。
      </p>
      <p className="about-heading">第三方资产与署名</p>
      <ul className="about-list">
        <li>
          界面图标：<strong>Lucide</strong>（ISC License）
        </li>
        <li>应用图标与猫管家形象：本仓库原创（随本项目 MIT）</li>
        <li>
          Agent 头像：<strong>DiceBear</strong>（框架 MIT；本地生成，不联网）
        </li>
        <li>
          CC BY 4.0 署名：DiceBear <strong>Dylan!</strong>（人物）by Natalia Spivak；DiceBear <strong>Fun Emoji</strong>
          （吉祥物）by Davis Uche
        </li>
        <li>Agent 内核：cordis / cosmokit / schemastery（MIT，vendor 自上游）</li>
      </ul>
      <p className="about-note">完整许可文本见仓库 NOTICE.md 与 vendor/*/LICENSE。</p>
    </div>
  )
}
