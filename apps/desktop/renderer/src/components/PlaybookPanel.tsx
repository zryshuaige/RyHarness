import { useCallback, useEffect, useState } from 'react'
import type { ApiClient, EvolveRoundKind, EvolveStatsReport, PlaybookEntryRow, ReflectionRow } from '../api.ts'
import { errorDetail, humanError } from '../lib/error-text.ts'
import { humanDuration } from '../lib/humanize.ts'
import { toast } from '../lib/toast.ts'
import { AsyncState } from './AsyncState.tsx'
import { EntryExplain } from './GroupEvolution.tsx'
import { Modal } from './Modal.tsx'
import { PanelSkeleton } from './Skeleton.tsx'

/**
 * 教训转正所需的命中次数。
 *
 * 真源是服务端的 `CONVERT_HIT_THRESHOLD`（packages/evolve/src/schema.ts）。这里
 * 不 import 那个包：渲染层要打进浏览器，而 evolve 的入口把 SQLite 拖了进来——
 * 与 lib/persona.ts 对 @ryharness/session 做的同一个取舍。两边改动要一起改。
 */
const CONVERT_HIT_THRESHOLD = 2

const SECTION_LABELS: Record<PlaybookEntryRow['section'], string> = {
  strategy: '策略',
  pitfall: '坑',
  preference: '偏好',
  tooling: '工具用法',
}
const SECTION_ORDER: PlaybookEntryRow['section'][] = ['strategy', 'pitfall', 'preference', 'tooling']
/**
 * 来源徽章从「谁写的」的角度写，不是从「流水线走到哪一站」的角度。
 * `策展`/`转正`/`种子` 是内部管道的说法，用户既不参与也没有对应的心智模型。
 */
const SOURCE_LABELS: Record<PlaybookEntryRow['source'], string> = {
  curator: '整理得出',
  reflection: '上次复盘',
  seed: '预置',
  manual: '你加的',
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/** 进化轮的相对时刻（后台任务的时间尺度：分钟到小时）。 */
function ago(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return formatDate(ts)
}

const ROUND_LABELS: Record<EvolveRoundKind, string> = {
  turn: '对话轮',
  feedback: '反馈',
  consolidate: '巩固',
}

const KIND_ORDER: EvolveRoundKind[] = ['turn', 'feedback', 'consolidate']

/** 最近几轮列出的条数：够看出节奏，又不至于把手册正文挤下去。 */
const EVOLVE_ROUND_ROWS = 5

/** 进化指标要读的数据面。方法可选：读不通就把这一块藏起来，手册照常读。 */
export interface EvolveStatsApi {
  evolveStats?(limit?: number): Promise<EvolveStatsReport>
}

/**
 * 进化进度：它到底有没有在学、学得怎么样。
 *
 * 手册与反思区块回答的是「学到了什么」，这块回答「还在不在学」——进化在服务端是
 * 后台异步跑的（反思、归因、巩固都不在用户那一轮的关键路径上），此前出问题时界面
 * 上没有任何提示。这里直接读 GET /api/evolve/stats：累计轮数、平均耗时、处理条数、
 * 失败轮数，外加最近几轮逐条列出。
 *
 * 四种状态各说各的话：还在读 = 骨架；读失败 = 错误条 + 重试；服务端没这个能力 /
 * 子系统关着 = 「未启用」；读到真值才画数字。此前「读失败」与「未启用」都整块消失，
 * 用户既不知道在不在学，也不知道是没开还是坏了。
 *
 * 口径是**全进程**的（服务端只有一份进化记账，不按 agent 分），而手册本身是某个
 * agent 的——所以标题旁写明「全部 agent」，别让人把这里的轮数当成这个 agent 单独的。
 */
export function EvolveStatsBlock({ api }: { api: EvolveStatsApi }) {
  const [stats, setStats] = useState<EvolveStatsReport | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    if (api.evolveStats === undefined) {
      setStats(undefined)
      setLoadError(undefined)
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(undefined)
    api.evolveStats(EVOLVE_ROUND_ROWS).then(
      (next) => {
        setStats(next)
        setLoadError(undefined)
        setLoading(false)
      },
      (error: unknown) => {
        setStats(undefined)
        // 原文：这一处只进 AsyncState 折起来的「详情」。
        setLoadError(errorDetail(error) ?? '未知原因')
        setLoading(false)
      },
    )
  }, [api])
  useEffect(load, [load])

  // 端点不存在 = 这版服务端没有进化统计，属于「未启用」，不是故障。
  if (api.evolveStats === undefined) {
    return <p className="evolve-stats is-off">进化系统未启用，这一块暂时没有记录。</p>
  }
  return (
    <AsyncState
      loading={loading}
      error={loadError === undefined ? undefined : '进化统计没读出来，可能是本机服务暂时不可用。'}
      detail={loadError}
      onRetry={load}
      skeleton={<PanelSkeleton rows={2} />}
    >
      {stats === undefined ? null : stats.enabled ? (
        <EvolveStatsReady stats={stats} />
      ) : (
        <p className="evolve-stats is-off">进化系统未启用，这一块暂时没有记录。</p>
      )}
    </AsyncState>
  )
}

/** 读到真值之后的统计块（只在 enabled=true 时渲染）。 */
function EvolveStatsReady({ stats }: { stats: Extract<EvolveStatsReport, { enabled: true }> }) {
  const { totals } = stats
  const avgMs = totals.rounds === 0 ? 0 : Math.round(totals.durationMs / totals.rounds)
  const last = stats.rounds[0]
  const foot =
    totals.rounds === 0
      ? '本次运行还没有进化记录——聊几轮或给一次反馈就有了。'
      : last === undefined
        ? '累计口径有账，但最近几轮没有明细。'
        : `最近一轮是${ROUND_LABELS[last.kind]}，${ago(last.startedAt)}。`
  return (
    <div className="evolve-stats">
      <p className="evolve-stats-title">
        进化记录
        <span className="evolve-stats-scope">全部 agent · 本次运行</span>
      </p>
      <p className="evolve-stats-total">
        累计 {totals.rounds} 轮 · 平均 {humanDuration(avgMs)} · 处理 {totals.processed} 条
        {totals.failures > 0 ? ` · 失败 ${totals.failures} 轮` : ''}
      </p>
      <ul className="evolve-stats-kinds">
        {KIND_ORDER.map((kind) => {
          const bucket = stats.byKind[kind] ?? { rounds: 0, failures: 0, durationMs: 0, processed: 0 }
          return (
            <li key={kind} className="evolve-kind" title={`${ROUND_LABELS[kind]}：${bucket.rounds} 轮`}>
              <span className="evolve-kind-name">{ROUND_LABELS[kind]}</span>
              <span className="evolve-kind-num">
                {bucket.rounds} 轮 · {bucket.processed} 条
              </span>
            </li>
          )
        })}
      </ul>
      {stats.rounds.length > 0 && (
        <ul className="evolve-rounds">
          {stats.rounds.map((round, index) => {
            return (
              <li key={`${round.startedAt}-${index}`} className={round.ok ? 'evolve-round' : 'evolve-round is-failed'}>
                <span className="evolve-round-kind">{ROUND_LABELS[round.kind]}</span>
                <span className="evolve-round-num">
                  {humanDuration(round.durationMs)} · 处理 {round.processed} 条
                </span>
                <span className="evolve-round-at" title={round.error}>
                  {round.ok ? ago(round.startedAt) : `失败：${humanError(round.error, '这一轮没跑完')}`}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <p className="evolve-stats-foot">
        {foot}
        {totals.rounds > stats.rounds.length ? ` 更早的 ${totals.rounds - stats.rounds.length} 轮未列出。` : ''}
      </p>
    </div>
  )
}

/**
 * 经验手册面板（弹层）：playbook 条目按 section 分组（helpful/harmful
 * 计数、来源、状态、手动 deprecate/恢复）+ 待验证反思区块。
 */
export function PlaybookPanel({
  api,
  agentId,
  agentName,
  onClose,
}: {
  api: ApiClient
  agentId: string
  agentName: string
  onClose: () => void
}) {
  const [data, setData] = useState<{ entries: PlaybookEntryRow[]; reflections: ReflectionRow[] } | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)

  const reload = useCallback(() => {
    api
      .getPlaybook(agentId)
      .then((next) => {
        setData(next)
        setLoadError(undefined)
      })
      .catch((error: unknown) => {
        // 读不出来就说读不出来：静默清空会让「加载失败」长成「手册还是空的」。
        // 这一条**没有**折叠的详情位（原实现是把原文直接拼在冒号后面），所以整句
        // 走人话层：认出服务端字面量时说清原因，认不出时给一句可照做的兜底。
        setData({ entries: [], reflections: [] })
        setLoadError(`经验手册没读出来：${humanError(error, '再试一次；一直这样就重启应用')}`)
      })
  }, [api, agentId])
  useEffect(reload, [reload])

  const applyStatus = async (
    entry: PlaybookEntryRow,
    next: 'active' | 'deprecated',
    message: string,
    allowUndo: boolean,
  ): Promise<void> => {
    try {
      await api.setPlaybookStatus(entry.id, next)
    } catch (error) {
      toast.error(
        `${next === 'active' ? '恢复' : '停用'}这条经验失败：${humanError(error, '这条经验没能改回来，再点一次')}`,
      )
      return
    }
    toast.success(
      message,
      allowUndo
        ? {
            action: {
              label: '撤销',
              run: () => {
                void applyStatus(entry, entry.status, '已撤销', false)
              },
            },
          }
        : undefined,
    )
    reload()
  }

  const toggle = (entry: PlaybookEntryRow): void => {
    const next = entry.status === 'active' ? 'deprecated' : 'active'
    void applyStatus(entry, next, next === 'active' ? '已恢复，不再忽略这条经验' : '已停用，它不会再被注入提示', true)
  }

  const net = (entry: PlaybookEntryRow): number => {
    return entry.helpful - entry.harmful
  }

  return (
    <Modal title={`${agentName} 的经验手册`} onClose={onClose}>
      {data === undefined ? (
        <PanelSkeleton rows={4} />
      ) : (
        <>
          {loadError !== undefined && (
            <p className="apikey-error" role="alert">
              {loadError}
              <button
                type="button"
                className="btn btn-mini"
                onClick={() => {
                  reload()
                }}
              >
                重试
              </button>
            </p>
          )}
          <EvolveStatsBlock api={api} />
          {data.reflections.length > 0 && (
            <>
              {/* 门槛取自服务端常量，不写死：写死的那个 2 早晚会和实现对不上。 */}
              <p className="section-title">待验证的教训（命中 {CONVERT_HIT_THRESHOLD} 次后转正）</p>
              <ul className="memory-list">
                {data.reflections.map((reflection) => (
                  <li key={reflection.id} className="memory-row">
                    <span className="memory-kind kind-event">教训</span>
                    <span className="memory-content">{reflection.lesson}</span>
                    <span className="memory-meta">
                      命中 {reflection.hitCount}/{CONVERT_HIT_THRESHOLD} · {formatDate(reflection.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {SECTION_ORDER.map((section) => {
            const entries = data.entries.filter((entry) => {
              return entry.section === section
            })
            if (entries.length === 0) return null
            return (
              <div key={section}>
                <p className="section-title">
                  {SECTION_LABELS[section]}（
                  {
                    entries.filter((e) => {
                      return e.status === 'active'
                    }).length
                  }{' '}
                  生效）
                </p>
                <ul className="memory-list">
                  {entries.map((entry) => (
                    <li key={entry.id} className={`memory-row ${entry.status === 'deprecated' ? 'is-deprecated' : ''}`}>
                      {/* 溯源入口挂在正文列里：证据链要占满一整行的宽度，挤在行尾
                          会被正文压成一条缝。正文单占一块，入口与它天然换行。 */}
                      <div className="memory-content">
                        <div>{entry.content}</div>
                        <EntryExplain api={api} entry={entry} />
                      </div>
                      <span
                        className={`pb-count ${net(entry) >= 0 ? 'pos' : 'neg'}`}
                        title="这条经验被标记有用/没用的次数"
                      >
                        有用 {entry.helpful} · 没用 {entry.harmful}
                      </span>
                      <span className="memory-meta">{SOURCE_LABELS[entry.source]}</span>
                      <button
                        type="button"
                        className="btn btn-mini memory-delete"
                        style={{ width: 'auto', height: 'auto', padding: '2px 8px', whiteSpace: 'nowrap' }}
                        title={
                          entry.status === 'active' ? '停用这条经验：它不会再被注入提示' : '恢复这条经验：重新参与提示'
                        }
                        aria-label={`${entry.content.slice(0, 20)}：${entry.status === 'active' ? '停用' : '恢复'}`}
                        onClick={() => {
                          toggle(entry)
                        }}
                      >
                        {entry.status === 'active' ? '停用' : '恢复'}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
          {loadError === undefined && data.entries.length === 0 && data.reflections.length === 0 && (
            <p className="panel-empty">还没有经验。</p>
          )}
        </>
      )}
    </Modal>
  )
}
