import { useCallback, useEffect, useState } from 'react'
import type { ApiClient, MemoryHealthReport, MemoryRow, MemoryStats, TelemetrySnapshot } from '../api.ts'
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
 * kind 徽章 + 内容 + 时间 + 来源会话 + 软删按钮。
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

  const renderRow = (memory: MemoryRow, isShared: boolean) => (
    <li key={memory.id} className="memory-row">
      <span className={`memory-kind kind-${memory.kind}`}>
        {KIND_LABELS[memory.kind]}
        {isShared ? ' · 共享' : ''}
      </span>
      <span className="memory-content">{memory.content}</span>
      <span className="memory-meta">
        {formatDate(memory.updatedAt)}
        {memory.sourceConversationId !== undefined
          ? ` · ${conversationTitles.get(memory.sourceConversationId) ?? '会话'}`
          : ''}
      </span>
      <button
        type="button"
        className="btn btn-mini memory-delete"
        style={{ width: 'auto', height: 'auto', padding: '2px 8px', whiteSpace: 'nowrap' }}
        title="移入归档（可以撤销）"
        aria-label={`移入归档：${memory.content.slice(0, 20)}`}
        disabled={deletingId === memory.id}
        onClick={() => {
          void remove(memory.id)
        }}
      >
        {deletingId === memory.id ? '归档中…' : '移入归档'}
      </button>
    </li>
  )

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
                        <span className="memory-meta">{formatDate(memory.updatedAt)}</span>
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
  return (
    <div className="memory-health">
      <p className="memory-health-title">
        记忆健康度
        <span className="memory-health-scope">{scoped ? '该 agent 空间' : '全部空间'}</span>
      </p>
      <div className="memory-health-grid">
        <div className="health-stat">
          <span className="health-label">记忆总数</span>
          <span className="health-value">{total === undefined ? '—' : `${total} 条`}</span>
        </div>
        <div className="health-stat">
          <span className="health-label">已归档</span>
          <span className="health-value">{archived === undefined ? '—' : `${archived} 条`}</span>
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
            {missingVectors === undefined ? '—' : `${missingVectors} 条`}
          </span>
        </div>
        <div className="health-stat" title={recall === undefined ? '本次运行还没有发生过召回' : undefined}>
          <span className="health-label">最近召回</span>
          <span className="health-value">
            {recall === undefined ? '暂无' : `${recall.items} 条 · ${humanDuration(recall.ms)}`}
          </span>
        </div>
        <div
          className="health-stat"
          title={dbBytes === undefined ? '服务端尚未提供存储体积口径' : '记忆库文件大小（含 WAL）'}
        >
          <span className="health-label">存储体积</span>
          <span className="health-value">{dbBytes === undefined ? '—' : formatBytes(dbBytes)}</span>
        </div>
      </div>
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
