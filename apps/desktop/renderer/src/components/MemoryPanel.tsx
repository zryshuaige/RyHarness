import { useCallback, useEffect, useState } from 'react'
import type { ApiClient, MemoryHealthReport, MemoryRow, MemoryStats, ProviderInfo, TelemetrySnapshot } from '../api.ts'
import { errorDetail, humanError } from '../lib/error-text.ts'
import { humanDuration } from '../lib/humanize.ts'
import { toast } from '../lib/toast.ts'
import { AsyncState } from './AsyncState.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { Icon } from './Icon.tsx'
import { Modal } from './Modal.tsx'
import { PanelSkeleton } from './Skeleton.tsx'

/** 记忆类别的中文口径（记忆面板与「我的」页共享同一份，不再各写一套）。 */
export const KIND_LABELS: Record<MemoryRow['kind'], string> = {
  profile: '画像',
  fact: '事实',
  preference: '偏好',
  event: '事件',
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/**
 * 记忆面板（弹层）：某 agent 的私有记忆 + 共享画像列表。
 * kind 徽章 + 内容 + 时间 + 来源会话 + 行内编辑 + 软删按钮。
 * 底部：已归档分区（可折叠、可恢复）与「重建向量索引」（embedding 模型变更后的回填）。
 */
export function MemoryPanel({
  api,
  agentId,
  agentName,
  conversationTitles,
  onClose,
}: {
  api: ApiClient
  agentId: string
  agentName: string
  /** 会话 id → 标题（来源会话显示用）。 */
  conversationTitles: Map<string, string>
  onClose: () => void
}) {
  const [memories, setMemories] = useState<{ agent: MemoryRow[]; shared: MemoryRow[] } | undefined>(undefined)
  /** 读取失败的一句话原因；原文只进 AsyncState 的「详情」。 */
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [archived, setArchived] = useState<MemoryRow[] | undefined>(undefined)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [restoringId, setRestoringId] = useState<string | undefined>(undefined)
  const [deletingId, setDeletingId] = useState<string | undefined>(undefined)
  /** 正在编辑的记忆 id（同一时刻至多一行摊开输入框）。 */
  const [editingId, setEditingId] = useState<string | undefined>(undefined)
  /** 编辑中的草稿（预填原内容；空内容禁用保存）。 */
  const [draft, setDraft] = useState('')
  const [savingEditId, setSavingEditId] = useState<string | undefined>(undefined)
  const [confirmingReembed, setConfirmingReembed] = useState(false)
  const [reembedding, setReembedding] = useState(false)

  const reload = useCallback(() => {
    setLoadError(undefined)
    api.listAgentMemories(agentId).then(
      (next) => {
        setMemories(next)
        setLoadError(undefined)
      },
      (error: unknown) => {
        // 失败不是「没有记忆」：把列表置回未知态，让错误条与重试入口接手。
        // 这里存的是**原文**——它不进第一眼，只进 AsyncState 的「详情」。
        setMemories(undefined)
        setLoadError(errorDetail(error) ?? '未知原因')
      },
    )
  }, [api, agentId])
  const reloadArchived = useCallback(() => {
    api
      .listArchivedMemories()
      .then(({ items }) => {
        setArchived(
          items.filter((item) => {
            return item.agentId === agentId
          }),
        )
      })
      .catch(() => {
        setArchived([])
      })
  }, [api, agentId])
  useEffect(() => {
    reload()
    reloadArchived()
  }, [reload, reloadArchived])

  const restore = async (id: string, announce = true): Promise<void> => {
    setRestoringId(id)
    try {
      await api.restoreMemory(id)
      if (announce) toast.success('已恢复这条记忆')
      else toast.success('已撤销，记忆回到列表')
    } catch (error) {
      toast.error(humanError(error, '这条记忆没能恢复，再试一次'))
    } finally {
      setRestoringId(undefined)
    }
    reload()
    reloadArchived()
  }

  const remove = async (id: string): Promise<void> => {
    // 删除是软删（进归档），所以给「撤销」；接口失败仍要出声，不能假装已经移走。
    setDeletingId(id)
    try {
      await api.deleteMemory(id)
      toast.success('已移入归档', {
        action: {
          label: '撤销',
          run: () => {
            void restore(id, false)
          },
        },
      })
      reload()
    } catch (error) {
      toast.error(humanError(error, '这条记忆没能移走，再试一次'))
    } finally {
      setDeletingId(undefined)
    }
  }

  const reembed = async (): Promise<void> => {
    setReembedding(true)
    try {
      await api.reembedMemories()
      toast.success('向量索引已重建')
    } catch (error) {
      toast.error(humanError(error, '向量索引没能重建，先确认已经配好向量模型'))
    } finally {
      setReembedding(false)
      setConfirmingReembed(false)
    }
  }

  const startEdit = (memory: MemoryRow): void => {
    setEditingId(memory.id)
    setDraft(memory.content)
  }

  const cancelEdit = (): void => {
    setEditingId(undefined)
    setDraft('')
  }

  const saveEdit = async (id: string): Promise<void> => {
    const content = draft.trim()
    if (content.length === 0) return
    setSavingEditId(id)
    try {
      await api.updateMemory(id, content)
      toast.success('已保存修改')
      cancelEdit()
      reload()
    } catch (error) {
      toast.error(humanError(error, '这条记忆没能保存，再试一次'))
    } finally {
      setSavingEditId(undefined)
    }
  }

  const renderRow = (memory: MemoryRow, isShared: boolean) => {
    if (editingId === memory.id) {
      return (
        <li key={memory.id} className="memory-row">
          <span className={`memory-kind kind-${memory.kind}`}>
            {KIND_LABELS[memory.kind]}
            {isShared ? ' · 共享' : ''}
          </span>
          {/* 复用消息气泡的就地编辑样式（bubble-edit*）：同一个「原地摊开输入框」
              的交互，不该为记忆面板再造一套视觉。 */}
          <div className="bubble-edit memory-edit-box">
            <textarea
              className="bubble-edit-input"
              value={draft}
              rows={2}
              aria-label="编辑这条记忆"
              onChange={(event) => {
                setDraft(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                event.preventDefault()
                cancelEdit()
              }}
            />
            <div className="bubble-edit-actions">
              <button
                type="button"
                className="bubble-edit-save"
                aria-label="保存修改"
                disabled={draft.trim().length === 0 || savingEditId !== undefined}
                onClick={() => {
                  void saveEdit(memory.id)
                }}
              >
                {savingEditId === memory.id ? '保存中…' : '保存'}
              </button>
              <button type="button" className="bubble-edit-cancel" aria-label="取消编辑" onClick={cancelEdit}>
                取消
              </button>
            </div>
          </div>
        </li>
      )
    }
    return (
      <li key={memory.id} className="memory-row">
        <span className={`memory-kind kind-${memory.kind}`}>
          {KIND_LABELS[memory.kind]}
          {isShared ? ' · 共享' : ''}
        </span>
        <span className="memory-content">{memory.content}</span>
        {/* 时间、来源与两个动作落到第二行：第一行只留正文。
            挤在一行时正文会被时间和按钮压成一条缝，读不出写了什么。 */}
        <span className="memory-foot">
          <span className="memory-meta">
            {formatDate(memory.updatedAt)}
            {memory.sourceConversationId !== undefined
              ? ` · ${conversationTitles.get(memory.sourceConversationId) ?? '会话'}`
              : ''}
          </span>
          <span className="memory-actions">
            <button
              type="button"
              className="btn btn-mini memory-edit"
              title="编辑这条记忆的内容"
              aria-label={`编辑：${memory.content.slice(0, 20)}`}
              disabled={deletingId === memory.id}
              onClick={() => {
                startEdit(memory)
              }}
            >
              编辑
            </button>
            <button
              type="button"
              className="btn btn-mini memory-delete"
              title="移入归档（可以撤销）"
              aria-label={`移入归档：${memory.content.slice(0, 20)}`}
              disabled={deletingId === memory.id}
              onClick={() => {
                void remove(memory.id)
              }}
            >
              {deletingId === memory.id ? '归档中…' : '移入归档'}
            </button>
          </span>
        </span>
      </li>
    )
  }

  return (
    <Modal title={`${agentName} 的记忆`} onClose={onClose}>
      {loadError !== undefined ? (
        <AsyncState
          loading={false}
          error="记忆没读出来，可能是本机服务暂时不可用。"
          detail={loadError}
          onRetry={reload}
        >
          {null}
        </AsyncState>
      ) : memories === undefined ? (
        <AsyncState loading skeleton={<PanelSkeleton rows={4} />}>
          {null}
        </AsyncState>
      ) : (
        <>
          <MemoryHealth api={api} agentId={agentId} archivedCount={archived === undefined ? null : archived.length} />
          {memories.shared.length > 0 && (
            <>
              {/* 用组件自己拿到的 agentName，不写死 Ryen：这份面板在右栏里对任意
                  agent 都会打开，写死品牌名等于让用户在小明的记忆面板里看到
                  「Ryen 了解你」。隔壁的私有记忆区已经是这个写法。 */}
              <p className="section-title">共享画像（{agentName} 了解你）</p>
              <ul className="memory-list">
                {memories.shared.map((m) => {
                  return renderRow(m, true)
                })}
              </ul>
            </>
          )}
          <p className="section-title">
            {agentName} 的私有记忆（{memories.agent.length}）
          </p>
          {memories.agent.length === 0 && memories.shared.length === 0 ? (
            <p className="panel-empty">还没有记忆。</p>
          ) : (
            <ul className="memory-list">
              {memories.agent.map((m) => {
                return renderRow(m, false)
              })}
            </ul>
          )}
          {archived !== undefined && archived.length > 0 && (
            <div className="memory-archived">
              <button
                type="button"
                className="memory-archived-toggle"
                aria-expanded={archivedOpen}
                onClick={() => {
                  setArchivedOpen((open) => {
                    return !open
                  })
                }}
              >
                <span className="memory-chevron">
                  <Icon name="chevron-right" size={16} />
                </span>
                已归档（{archived.length}）
              </button>
              {archivedOpen && (
                <ul className="memory-list">
                  {archived.map((memory) => {
                    return (
                      <li key={memory.id} className="memory-row is-archived">
                        <span className={`memory-kind kind-${memory.kind}`}>{KIND_LABELS[memory.kind]}</span>
                        <span className="memory-content">{memory.content}</span>
                        <span className="memory-foot">
                          <span className="memory-meta">{formatDate(memory.updatedAt)}</span>
                          <span className="memory-actions">
                            <button
                              type="button"
                              className="memory-restore"
                              disabled={restoringId === memory.id}
                              onClick={() => {
                                void restore(memory.id)
                              }}
                            >
                              {restoringId === memory.id ? '恢复中' : '恢复'}
                            </button>
                          </span>
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}
          <div className="memory-footer">
            <p className="memory-footer-hint">换了向量模型后重建一次，旧记忆才能被重新找到。</p>
            <button
              type="button"
              className="btn memory-reembed"
              disabled={reembedding}
              onClick={() => {
                setConfirmingReembed(true)
              }}
            >
              {reembedding ? '重建中…' : '重建向量索引'}
            </button>
          </div>
        </>
      )}
      {confirmingReembed && (
        <ConfirmDialog
          title="重建向量索引？"
          body="会为全部记忆重新生成检索向量，记忆越多耗时越长，期间检索可能暂时变慢。"
          confirmLabel="重建"
          onConfirm={reembed}
          onCancel={() => {
            setConfirmingReembed(false)
          }}
        />
      )}
    </Modal>
  )
}

/**
 * 记忆健康度要读的数据面。
 *
 * `memoryHealth` 是聚合端点（一次请求拿全五格）。服务端没有它时退回三条分散的
 * 读口（/api/memory/stats + /api/memory/archived + /api/telemetry），此时缺向量与
 * 存储体积注定答不出来——宁可少两格，也不用估算值冒充真实口径。
 */
export interface MemoryHealthApi {
  memoryHealth?(): Promise<MemoryHealthReport>
  /** 旧服务端的降级读口。 */
  memoryStats?(): Promise<MemoryStats>
  telemetry?(limit?: number): Promise<TelemetrySnapshot>
  listArchivedMemories?(): Promise<{ items: MemoryRow[] }>
  /**
   * 供应商清单（选向量模型时用）。
   *
   * 没有它就不显示「配置向量模型」的入口——旧服务端没有这条路由，按钮会点不通。
   */
  providers?(): Promise<{ providers: ProviderInfo[] }>
  /** 指定向量模型；缺省表示这版服务端不支持，入口不出现。 */
  setEmbedding?(input: {
    providerId: string
    model: string
  }): Promise<{ embedding: { providerId: string; model: string } }>
}

/** 遥测环形缓冲默认 50 条；翻这么多条足够找出"最近一次召回"。 */
const RECALL_SCAN_LIMIT = 50

function fail(): undefined {
  return undefined
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/** 字节体积：库文件最大也就几百 MB，一位小数足够对账。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 最近一次召回的统一形状（聚合端点与遥测降级路径共用一套渲染）。 */
interface Recall {
  items: number
  ms: number
  at: number
}

/**
 * 记忆健康度：记忆总数 / 已归档 / 缺向量 / 最近一次召回命中与耗时 / 存储体积。
 *
 * 五格全部来自 GET /api/memory/health——缺向量与存储体积此前没有任何路由能给，
 * 界面上只能显示「—」。聚合端点不可用时才退回 /api/memory/stats +
 * /api/memory/archived + /api/telemetry 拼一拼，那条路径上缺的格子照样留「—」，
 * 不拿"总数"冒充"缺向量数"。
 *
 * 作用域：总数按调用方给的 agentId 从 bySpace 取；归档/缺向量/体积/召回是**全库**
 * 口径（服务端只统计全库），agent 视图下会在脚注里写明。
 */
export function MemoryHealth({
  api,
  agentId,
  archivedCount,
}: {
  api: MemoryHealthApi
  /** 限定某个 agent 的空间；缺省为全部空间。 */
  agentId?: string
  /**
   * 调用方已经数好的归档条数（记忆面板自己拉过那一份，不必再请求一次）。
   * `undefined` = 自己拉；`null` = 调用方正在拉，此刻留空而不是抢跑一个 0。
   */
  archivedCount?: number | null
}) {
  const [health, setHealth] = useState<MemoryHealthReport | undefined>(undefined)
  const [stats, setStats] = useState<MemoryStats | undefined>(undefined)
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot | undefined>(undefined)
  const [archived, setArchived] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  /** 向量模型配置表单：默认收起，用户点了才展开。 */
  const [editingEmbedding, setEditingEmbedding] = useState(false)
  const [embeddingProviders, setEmbeddingProviders] = useState<ProviderInfo[] | undefined>(undefined)
  /** 供应商清单读不到：表单要说明白，而不是留一个空下拉框让人干瞪眼。 */
  const [embeddingProvidersFailed, setEmbeddingProvidersFailed] = useState(false)
  const [embeddingProviderId, setEmbeddingProviderId] = useState('')
  const [embeddingModel, setEmbeddingModel] = useState('')
  const [savingEmbedding, setSavingEmbedding] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    // 降级路径：服务端没有聚合端点（或聚合端点读不通）时，用三条分散读口拼一拼。
    const legacy = async (): Promise<void> => {
      const [s, t] = await Promise.all([
        api.memoryStats?.().catch(fail),
        api.telemetry?.(RECALL_SCAN_LIMIT).catch(fail),
      ])
      if (!alive) return
      setStats(s)
      setTelemetry(t)
      setLoading(false)
    }
    if (api.memoryHealth === undefined) {
      void legacy()
      return () => {
        alive = false
      }
    }
    api.memoryHealth().then(
      (report) => {
        if (!alive) return
        setHealth(report)
        setLoading(false)
      },
      () => {
        if (!alive) return
        setHealth(undefined)
        void legacy()
      },
    )
    return () => {
      alive = false
    }
  }, [api])

  useEffect(() => {
    if (archivedCount !== undefined) {
      setArchived(archivedCount === null ? undefined : archivedCount)
      return
    }
    if (health !== undefined) {
      setArchived(health.enabled ? health.archived : undefined)
      return
    }
    // 聚合端点还在飞：等它回来再决定要不要走归档读口，否则每个面板都白拉一次全量归档。
    if (api.memoryHealth !== undefined && loading) return
    let alive = true
    api.listArchivedMemories?.().then(
      ({ items }) => {
        if (alive) setArchived(items.length)
      },
      () => {
        if (alive) setArchived(undefined)
      },
    )
    return () => {
      alive = false
    }
  }, [api, archivedCount, health, loading])

  const live = health?.enabled ? health : undefined
  const bySpace = live?.bySpace ?? stats?.bySpace
  const grandTotal = live?.total ?? stats?.total
  const total = agentId === undefined ? grandTotal : bySpace?.[agentId]
  const recall = live === undefined ? recallFromTelemetry(telemetry) : recallFromHealth(live)
  const ftsOnly = (live?.embeddings.label ?? stats?.embeddings?.label) === 'none:fts-only'
  const missingVectors = live === undefined ? (ftsOnly ? (total ?? 0) : undefined) : live.missingVectors
  const dbBytes = live?.dbBytes

  if (loading) return <p className="panel-empty">记忆健康度统计中…</p>
  if (live === undefined && (health !== undefined || stats?.enabled === false)) {
    return <p className="panel-empty">记忆系统未启用，这里还没有可统计的记忆。</p>
  }
  if (live === undefined && stats === undefined && recall === undefined && archived === undefined) {
    return <p className="panel-empty">记忆健康度暂时读不到。</p>
  }
  const scoped = agentId !== undefined

  /**
   * 展开向量模型配置：先拉供应商清单，让用户从自己已经配好的那家里选。
   *
   * 拉不到清单要说清楚，而不是留一个空下拉框——那条下拉只有一项「选一家供应商…」，
   * 保存按钮在没选中之前是禁用的，用户会以为界面坏了。
   */
  const openEmbeddingForm = async (): Promise<void> => {
    setEditingEmbedding(true)
    if (embeddingProviders !== undefined) return
    const list = await api.providers?.().catch(fail)
    if (list === undefined) {
      setEmbeddingProvidersFailed(true)
      return
    }
    setEmbeddingProviders(list.providers)
    const first = list.providers[0]
    if (first !== undefined) {
      setEmbeddingProviderId((current) => {
        return current === '' ? first.id : current
      })
    }
  }

  /** 保存向量模型：服务端写盘并热替换，这里顺带提示要重建索引。 */
  const saveEmbedding = async (): Promise<void> => {
    if (api.setEmbedding === undefined) return
    setSavingEmbedding(true)
    try {
      await api.setEmbedding({ providerId: embeddingProviderId, model: embeddingModel.trim() })
      toast.success('向量模型已配好，接下来重建一次索引，老记忆就能被语义检索找到了')
      setEditingEmbedding(false)
    } catch (error) {
      toast.error(humanError(error, '向量模型没能保存，再试一次'))
    } finally {
      setSavingEmbedding(false)
    }
  }

  // 一句话把这堆数字翻成人话：光给五个数，用户不知道该担心哪一个。
  const summary = ((): string => {
    if (ftsOnly) return '还没配向量模型，现在只能按关键词找记忆。'
    if (missingVectors === undefined) return '服务端还没报缺向量的条数。'
    if (missingVectors > 0) return `有 ${missingVectors} 条记忆还没生成向量，检索时找不到它们。`
    return '每条记忆都有向量，检索能找到它们。'
  })()
  return (
    <div className="memory-health">
      <p className="memory-health-title">
        记忆健康度
        <span className="memory-health-scope">{scoped ? '该 agent 空间' : '全部空间'}</span>
      </p>
      <div className="memory-health-grid">
        {/* 总数当头一个数：下面四格是它的补充，不是四个平级的数。 */}
        <div className="health-stat is-lead">
          <span className="health-label">记忆总数</span>
          <span className="health-value">
            {total === undefined ? (
              '—'
            ) : (
              <>
                <span className="num">{total}</span> 条
              </>
            )}
          </span>
        </div>
        <div className="health-stat">
          <span className="health-label">已归档</span>
          <span className="health-value">
            {archived === undefined ? (
              '—'
            ) : (
              <>
                <span className="num">{archived}</span> 条
              </>
            )}
          </span>
        </div>
        <div
          className="health-stat"
          title={
            missingVectors === undefined
              ? '服务端尚未提供缺向量计数'
              : ftsOnly
                ? '未配置 embedding，检索只走全文索引，全部记忆都没有向量'
                : '缺当前 embedding 向量的记忆条数（活跃与已归档都算）'
          }
        >
          <span className="health-label">缺向量</span>
          <span className={missingVectors === undefined ? 'health-value' : 'health-value is-warn'}>
            {missingVectors === undefined ? (
              '—'
            ) : (
              <>
                <span className="num">{missingVectors}</span> 条
              </>
            )}
          </span>
        </div>
        <div className="health-stat" title={recall === undefined ? '本次运行还没有发生过召回' : undefined}>
          <span className="health-label">最近召回</span>
          <span className="health-value">
            {recall === undefined ? (
              '暂无'
            ) : (
              <>
                <span className="num">{recall.items}</span> 条 · <span className="num">{humanDuration(recall.ms)}</span>
              </>
            )}
          </span>
        </div>
        <div
          className="health-stat"
          title={dbBytes === undefined ? '服务端尚未提供存储体积口径' : '记忆库文件大小（含 WAL）'}
        >
          <span className="health-label">存储体积</span>
          <span className="health-value">
            {dbBytes === undefined ? '—' : <span className="num">{formatBytes(dbBytes)}</span>}
          </span>
        </div>
      </div>
      <p className="memory-health-summary">{summary}</p>
      {ftsOnly && api.setEmbedding !== undefined && (
        // 语义召回关着时给一条出路：当场指定用哪家的哪个向量模型。此前这件事只能
        // 手改 providers.json，界面上只留一句「未配置 embedding」——用户既不知道
        // 为什么检索变弱了，也没有办法在应用里改。
        <div className="memory-embedding">
          {editingEmbedding ? (
            <div className="memory-embedding-form">
              <label className="memory-embedding-label" htmlFor="memory-embedding-provider">
                用哪家的向量模型
              </label>
              <select
                id="memory-embedding-provider"
                className="memory-embedding-select"
                value={embeddingProviderId}
                disabled={embeddingProvidersFailed}
                onChange={(event) => {
                  setEmbeddingProviderId(event.target.value)
                }}
              >
                <option value="">选一家供应商…</option>
                {(embeddingProviders ?? []).map((provider) => {
                  return (
                    <option key={provider.id} value={provider.id}>
                      {provider.displayName}
                    </option>
                  )
                })}
              </select>
              {embeddingProvidersFailed && (
                <p className="memory-embedding-hint">
                  读不到供应商清单。去「模型供应商」页确认有一家已经配好凭据的供应商，再回来试一次。
                </p>
              )}
              <label className="memory-embedding-label" htmlFor="memory-embedding-model">
                模型 id
              </label>
              <input
                id="memory-embedding-model"
                className="memory-embedding-input"
                value={embeddingModel}
                placeholder="例如 Qwen/Qwen3-Embedding-0.6B"
                onChange={(event) => {
                  setEmbeddingModel(event.target.value)
                }}
              />
              <p className="memory-embedding-hint">
                模型 id 要照这家供应商的文档填。填错不会报错，只是检索不出东西——向量模型不通用，
                换个模型等于换一套坐标系。
              </p>
              <div className="memory-embedding-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={savingEmbedding || embeddingProviderId === '' || embeddingModel.trim() === ''}
                  onClick={() => {
                    void saveEmbedding()
                  }}
                >
                  {savingEmbedding ? '保存中…' : '保存'}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={savingEmbedding}
                  onClick={() => {
                    setEditingEmbedding(false)
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn memory-embedding-open"
              onClick={() => {
                void openEmbeddingForm()
              }}
            >
              配置向量模型
            </button>
          )}
        </div>
      )}
      <p className="memory-health-foot">
        {recall === undefined ? '本次运行还没有召回记录。' : `上次召回 ${formatRelative(recall.at)}。`}
        {ftsOnly ? '当前未配置 embedding，只能按关键词检索。' : ''}
        {live !== undefined && scoped ? '「已归档 / 缺向量 / 存储体积 / 最近召回」按全库统计。' : ''}
      </p>
    </div>
  )
}

/** 降级路径的「最近召回」：遥测里最近一次注入过记忆的轮次。 */
function recallFromTelemetry(telemetry: TelemetrySnapshot | undefined): Recall | undefined {
  const turn = telemetry?.turns.find((row) => {
    return row.memoryItems > 0
  })
  return turn === undefined ? undefined : { items: turn.memoryItems, ms: turn.memoryRecallMs, at: turn.finishedAt }
}

/** 聚合端点的 lastRecall（没有发生过召回时缺省）。 */
function recallFromHealth(live: Extract<MemoryHealthReport, { enabled: true }>): Recall | undefined {
  if (live.lastRecall === undefined) return undefined
  return { items: live.lastRecall.items, ms: live.lastRecall.ms, at: live.lastRecall.at }
}
