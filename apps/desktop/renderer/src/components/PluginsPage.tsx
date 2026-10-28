/**
 * 独立「插件」页：列出服务端真实装载的插件，并给出开关。
 *
 * 清单与运行状态都以 `GET /api/plugins` 为准，渲染层不在本地维护插件表；切换走
 * PATCH，服务端会真实卸载/重挂。页面按服务端声明的 group 分组，但群组、能力、
 * 影响说明都是**可选字段**——旧服务端或精简替身只回核心字段时，仍按
 * `core ? 内置 : 功能` 兜底并照常渲染，不把缺字段显示成坏数据。
 */
import { useEffect, useState } from 'react'
import type { PluginView } from '../api.ts'
import { errorDetail, humanError } from '../lib/error-text.ts'
import { toast } from '../lib/toast.ts'
import { routeLabel, toolLabel } from '../lib/tool-labels.ts'
import { AsyncState } from './AsyncState.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { Icon, type IconName } from './Icon.tsx'
import { PanelSkeleton } from './Skeleton.tsx'

/** 插件页对 api 的结构要求（测试可以只给这两个方法）。 */
export interface PluginsApi {
  plugins?(): Promise<{ plugins: PluginView[] }>
  setPluginEnabled?(id: string, enabled: boolean): Promise<{ plugin: PluginView }>
}

type GroupKey = 'core' | 'feature' | 'voice' | 'tool'

const GROUP_KEYS: readonly GroupKey[] = ['core', 'feature', 'voice', 'tool']

const GROUP_LABELS: Record<GroupKey, string> = {
  core: '内置',
  feature: '功能',
  voice: '语音',
  tool: '工具',
}

const STATUS_LABELS: Record<PluginView['status'], string> = {
  running: '运行中',
  stopped: '已停止',
  error: '启动失败',
}

/**
 * 每个插件一个能认出用途的图标，而不是全页同一个方块。
 *
 * 按 id 精确映射；未知插件按分组兜底——这样第三方插件也不会空着图标位，
 * 同时不必在渲染层维护一份「插件注册表」（清单仍以服务端为准）。
 */
const PLUGIN_ICONS: Record<string, IconName> = {
  'core-tools': 'gear',
  'llm-openai': 'brain',
  voice: 'speaker',
  'voice-piper': 'speaker',
  todo: 'clipboard-list',
  'ask-user': 'chat-bubble',
  'web-read': 'search',
}

function iconOf(plugin: PluginView, group: GroupKey): IconName {
  return PLUGIN_ICONS[plugin.id] ?? (group === 'voice' ? 'speaker' : group === 'core' ? 'gear' : 'blocks')
}

/** 没有 impact 时的关闭说明；确认弹窗与展开区共用同一句，不两处各写一遍。 */
const DEFAULT_IMPACT = '关闭后它的工具与界面会一起消失，已有数据会保留。'

/** core 插件没有 impact 时的兜底：它是底座，不是普通功能。 */
const CORE_IMPACT = '内置能力，关掉后助理无法正常工作。'

/**
 * 分组：声明了合法 group 就用它；缺字段时按 core 兜底。
 *
 * 逐项比对而不是 `includes(plugin.group)`，是为了在运行时拿到未知字符串时也能
 * 落回兜底（类型只覆盖当前已知的四组，旧/新服务端可能给出别的值）。
 */
function groupOf(plugin: PluginView): GroupKey {
  const declared = plugin.group
  if (declared !== undefined) {
    for (const key of GROUP_KEYS) {
      if (key === declared) return key
    }
  }
  return plugin.core ? 'core' : 'feature'
}

/** 运行态：字段缺失时按开关推断，避免状态标签变成空白。 */
function statusOf(plugin: PluginView): PluginView['status'] {
  if (plugin.status === 'running' || plugin.status === 'stopped' || plugin.status === 'error') return plugin.status
  return plugin.enabled ? 'running' : 'stopped'
}

/** 能力清单：缺省与非数组都按空处理，不让一版坏回包把整页打崩。 */
function capabilityList(value: readonly string[] | undefined): readonly string[] {
  return Array.isArray(value) ? value : []
}

function impactOf(plugin: PluginView): string {
  return plugin.impact ?? (plugin.core ? CORE_IMPACT : DEFAULT_IMPACT)
}

/** 开关是开的、插件却没跑起来：这是需要解释的状态，不能只留一个「已停止」。 */
function runtimeNote(plugin: PluginView): string | undefined {
  if (statusOf(plugin) === 'stopped' && plugin.enabled) return '开关是开的，但插件当前没有运行。'
  return undefined
}

/**
 * 「开关开着、插件却没跑」和「用户自己把它关了」是两回事，页面上必须能分开：
 * 前者状态点画成空心琥珀环并补一行说明，后者就是普通的灰点「已停止」。
 */
function isStalled(plugin: PluginView): boolean {
  return statusOf(plugin) === 'stopped' && plugin.enabled
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; detail: string }
  | { kind: 'unsupported' }
  | { kind: 'ready'; plugins: PluginView[] }

function PluginCard({
  plugin,
  open,
  busy,
  onToggleOpen,
  onToggleEnabled,
  onRetry,
}: {
  plugin: PluginView
  open: boolean
  busy: boolean
  onToggleOpen: () => void
  onToggleEnabled: () => void
  onRetry: () => void
}) {
  const group = groupOf(plugin)
  const status = statusOf(plugin)
  const note = runtimeNote(plugin)
  const stalled = isStalled(plugin)
  const tools = capabilityList(plugin.capabilities?.tools)
  const routes = capabilityList(plugin.capabilities?.routes)
  const missing = capabilityList(plugin.missing)
  const panelId = `plugin-detail-${plugin.id}`
  return (
    <article className={`plugin-card${open ? ' is-open' : ''}`} data-plugin-id={plugin.id} data-group={group}>
      <div className="plugin-card-head">
        <button
          type="button"
          className="plugin-card-main"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggleOpen}
        >
          <span className="plugin-icon" aria-hidden="true">
            <Icon name={iconOf(plugin, group)} size={20} />
          </span>
          <span className="plugin-body">
            <span className="plugin-name">{plugin.name}</span>
            <span className="plugin-desc">{plugin.description}</span>
            {plugin.core && (
              // 内置那组要解释为什么关不掉。这句话与展开区里的「为什么不可关闭」是同一句，
              // 所以展开后这行让位给展开区（见 styles-plugins.css 的 .is-open 规则），
              // 同一屏不出现两遍一样的话。
              <span className="plugin-core-note">{impactOf(plugin)}</span>
            )}
            {!plugin.core && note !== undefined && (
              <span className="plugin-note">
                <Icon name="alert" size={16} />
                <span>{note}</span>
              </span>
            )}
          </span>
        </button>
        <div className="plugin-side">
          <span className={`plugin-status is-${status}${stalled ? ' is-stalled' : ''}`}>
            <span className="plugin-status-dot" aria-hidden="true" />
            {STATUS_LABELS[status]}
          </span>
          {plugin.core ? (
            // core 不用禁用开关：一个灰掉的开关暗示「以后也许能开」，静态徽章才
            // 准确表达「它不参与开关」。原因在卡片正文里说清楚。
            <span className="badge plugins-core-badge">内置</span>
          ) : (
            <button
              type="button"
              role="switch"
              aria-checked={plugin.enabled}
              aria-label={`${plugin.name}（${plugin.enabled ? '已开启' : '已关闭'}，点一下${plugin.enabled ? '关闭' : '开启'}）`}
              className={`plugin-switch${plugin.enabled ? ' is-on' : ''}`}
              disabled={busy}
              onClick={onToggleEnabled}
            >
              {/* 开关画成真开关：滑块的位置、颜色、旁边那两个字一起变，只换颜色分不出
                  开还是关。字面文案放在可见标签上，屏幕阅读器读到的名字也带上它。 */}
              <span className="plugin-switch-track" aria-hidden="true">
                <span className="plugin-switch-knob" />
              </span>
              <span className="plugin-switch-label">{plugin.enabled ? '已开启' : '已关闭'}</span>
            </button>
          )}
          <button
            type="button"
            className="plugin-chevron"
            aria-label={`${open ? '收起' : '展开'}${plugin.name}`}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={onToggleOpen}
          >
            <Icon name="chevron-right" size={16} className="plugin-chevron-icon" />
          </button>
        </div>
      </div>
      {open && (
        <div className="plugin-detail" id={panelId}>
          {tools.length > 0 && (
            <div className="plugin-detail-row">
              <span className="plugin-detail-label">工具</span>
              <span className="plugin-chips">
                {tools.map((tool) => {
                  return (
                    // 原值留在 title 上：`fs_read` 这类标识对用户没信息量，但排障时
                    // 需要它对得上服务端的能力声明。
                    <span key={`tool-${tool}`} className="plugin-chip" title={tool}>
                      {toolLabel(tool)}
                    </span>
                  )
                })}
              </span>
            </div>
          )}
          {routes.length > 0 && (
            <div className="plugin-detail-row">
              <span className="plugin-detail-label">接口</span>
              <span className="plugin-chips">
                {routes.map((route) => {
                  return (
                    <span key={`route-${route}`} className="plugin-chip is-route" title={route}>
                      {routeLabel(route)}
                    </span>
                  )
                })}
              </span>
            </div>
          )}
          <div className="plugin-detail-row">
            <span className="plugin-detail-label">{plugin.core ? '为什么不可关闭' : '关闭影响'}</span>
            <p className="plugin-detail-text">{impactOf(plugin)}</p>
          </div>
          {status === 'error' && (
            <div className="plugin-detail-row">
              <span className="plugin-detail-label">失败原因</span>
              <p className="plugin-error">{humanError(plugin.error, '服务端没有留下失败原因。')}</p>
            </div>
          )}
          {missing.length > 0 && (
            // 声明与事实对不上：插件说自己提供这些能力，运行时却查不到。
            // 与其照着声明显示一个其实不存在的能力，不如把差的那几项点出来。
            <div className="plugin-detail-row">
              <span className="plugin-detail-label">声明与实际不符</span>
              <p className="plugin-error">
                声明里有、运行时却找不到：{missing.join('、')}。这多半是插件的声明没跟上代码。
              </p>
            </div>
          )}
          {(status === 'error' || stalled) && (
            // 失败或「开关开着却没跑」都要给一条出路：重新挂一次。服务端在开关仍为
            // 开启时会重新 apply 这个插件，所以这个按钮就是重试。
            <div className="plugin-detail-row">
              <span className="plugin-detail-label">重新挂载</span>
              <p className="plugin-detail-text">
                {status === 'error'
                  ? '刚才是挂载失败（多半是它依赖的插件没开）。可以重试一次。'
                  : '开关是开的，但它没跑起来。重试会重新挂载一次。'}
              </p>
              <button type="button" className="btn" disabled={busy} onClick={onRetry}>
                {busy ? '重试中…' : '重试'}
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  )
}

function EmptyPlugins({ hasPlugins, query, onClear }: { hasPlugins: boolean; query: string; onClear: () => void }) {
  const trimmed = query.trim()
  return (
    <div className="plugins-empty">
      <span className="plugins-empty-icon" aria-hidden="true">
        <Icon name={hasPlugins ? 'search' : 'blocks'} size={20} />
      </span>
      <h3>{hasPlugins ? '没有找到匹配的插件' : '还没有可显示的插件'}</h3>
      <p>
        {hasPlugins
          ? `没有名字或描述包含「${trimmed}」的插件。`
          : '服务端没有装载任何插件；重新打开应用或检查插件配置。'}
      </p>
      {hasPlugins && (
        <button type="button" className="btn" onClick={onClear}>
          清空搜索
        </button>
      )}
    </div>
  )
}

export function PluginsPage({ api }: { api: PluginsApi }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    return new Set()
  })
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [confirming, setConfirming] = useState<PluginView | undefined>(undefined)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey 只作重试触发器，不在 effect 体内读取
  useEffect(() => {
    if (api.plugins === undefined) {
      setState({ kind: 'unsupported' })
      return
    }
    let alive = true
    setState({ kind: 'loading' })
    api
      .plugins()
      .then(({ plugins: list }) => {
        if (!alive) return
        // 结构校验放在这里而不是渲染里：坏回包只该让页面显示空态，不该在 map
        // 里抛一次异常把整页送进错误边界。
        setState({ kind: 'ready', plugins: Array.isArray(list) ? list : [] })
      })
      .catch((error: unknown) => {
        // 空列表和「读不出来」长得一样，必须分开说。原文只进 AsyncState 的「详情」。
        if (!alive) return
        setState({ kind: 'error', detail: errorDetail(error) ?? '未知原因' })
      })
    return () => {
      alive = false
    }
  }, [api, reloadKey])

  const patch = async (plugin: PluginView, enabled: boolean): Promise<PluginView | undefined> => {
    if (api.setPluginEnabled === undefined) {
      toast.error('这版服务端还不支持切换插件。')
      return undefined
    }
    setBusy(plugin.id)
    try {
      const { plugin: updated } = await api.setPluginEnabled(plugin.id, enabled)
      setState((current) => {
        if (current.kind !== 'ready') return current
        return {
          kind: 'ready',
          plugins: current.plugins.map((item) => {
            return item.id === updated.id ? updated : item
          }),
        }
      })
      return updated
    } catch (error) {
      toast.error(
        `${enabled ? '开启' : '关闭'}「${plugin.name}」失败：${humanError(error, '这个开关没能拨动，再试一次')}`,
      )
      return undefined
    } finally {
      setBusy(undefined)
    }
  }

  const enable = async (plugin: PluginView): Promise<void> => {
    const updated = await patch(plugin, true)
    if (updated !== undefined) toast.success(`已开启「${updated.name}」`)
  }

  const disable = async (plugin: PluginView): Promise<boolean> => {
    const updated = await patch(plugin, false)
    if (updated === undefined) return false
    toast.success(`已关闭「${updated.name}」`, {
      action: {
        label: '撤销',
        run: () => {
          void enable(updated)
        },
      },
    })
    return true
  }

  const requestToggle = (plugin: PluginView): void => {
    if (plugin.core) return
    // 关闭会撤掉工具与界面，是不可预期的损失；开启没有这个风险，直接执行。
    if (plugin.enabled) {
      setConfirming(plugin)
      return
    }
    void enable(plugin)
  }

  /**
   * 重新挂载一个没跑起来的插件。
   *
   * 开关本来就是开着的，所以不能再走「切换」那条路（那会把开关拨成关）。服务端
   * 在开关仍为开启、而插件没有 fiber 时会重新 apply 一次——这正是重试要的动作。
   */
  const retry = async (plugin: PluginView): Promise<void> => {
    const updated = await patch(plugin, true)
    if (updated === undefined) return
    if (updated.status === 'error') {
      toast.error(`「${updated.name}」还是没能挂上：${humanError(updated.error, '原因未知')}`)
      return
    }
    toast.success(`「${updated.name}」已经重新挂上`)
  }

  const toggleExpanded = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const needle = query.trim().toLowerCase()
  const visible =
    state.kind === 'ready'
      ? state.plugins.filter((plugin) => {
          if (needle === '') return true
          return plugin.name.toLowerCase().includes(needle) || plugin.description.toLowerCase().includes(needle)
        })
      : []
  const grouped = GROUP_KEYS.map((key) => {
    return {
      key,
      items: visible.filter((plugin) => {
        return groupOf(plugin) === key
      }),
    }
  }).filter((group) => {
    return group.items.length > 0
  })
  const hasPlugins = state.kind === 'ready' && state.plugins.length > 0

  return (
    <section className="page plugins-page">
      <header className="page-header plugins-header">
        <div className="plugins-head-text">
          <h2>插件</h2>
          <p className="plugins-lede">关掉后，对应的工具与界面会一起消失。「内置」那组是助理的地盘，不能关。</p>
          {state.kind === 'ready' && needle !== '' && visible.length > 0 && (
            <p className="plugins-result" aria-live="polite">
              找到 {visible.length} 个插件
            </p>
          )}
        </div>
        <div className="page-actions plugins-search">
          <label className="search-box-wrap">
            <span className="search-box-icon">
              <Icon name="search" size={16} />
            </span>
            <input
              className="search-box has-icon"
              type="search"
              value={query}
              placeholder="搜索插件"
              aria-label="搜索插件"
              onChange={(event) => {
                setQuery(event.target.value)
              }}
            />
          </label>
        </div>
      </header>
      <div className="page-scroll">
        <div className="page-scroll-col plugins-col">
          {state.kind === 'unsupported' ? (
            <div className="plugins-empty plugins-unsupported">
              <span className="plugins-empty-icon" aria-hidden="true">
                <Icon name="blocks" size={20} />
              </span>
              <h3>这版服务端还没有插件接口</h3>
              <p>插件页暂时不可用。</p>
            </div>
          ) : (
            <AsyncState
              loading={state.kind === 'loading'}
              error={state.kind === 'error' ? '插件清单没读出来。' : undefined}
              detail={state.kind === 'error' ? state.detail : undefined}
              onRetry={() => {
                setReloadKey((key) => {
                  return key + 1
                })
              }}
              skeleton={<PanelSkeleton rows={4} />}
              empty={state.kind === 'ready' && visible.length === 0}
              emptyView={
                <EmptyPlugins
                  hasPlugins={hasPlugins}
                  query={query}
                  onClear={() => {
                    setQuery('')
                  }}
                />
              }
            >
              {grouped.map((group) => {
                return (
                  <section
                    key={group.key}
                    className="plugin-group"
                    data-group={group.key}
                    aria-labelledby={`plugin-group-${group.key}`}
                  >
                    <div className="plugin-group-head">
                      <h3 className="plugin-group-title" id={`plugin-group-${group.key}`}>
                        {GROUP_LABELS[group.key]}
                      </h3>
                      <span className="plugin-group-count">{group.items.length}</span>
                    </div>
                    <div className="plugin-list">
                      {group.items.map((plugin) => {
                        return (
                          <PluginCard
                            key={plugin.id}
                            plugin={plugin}
                            open={expanded.has(plugin.id)}
                            busy={busy === plugin.id}
                            onToggleOpen={() => {
                              toggleExpanded(plugin.id)
                            }}
                            onToggleEnabled={() => {
                              requestToggle(plugin)
                            }}
                            onRetry={() => {
                              void retry(plugin)
                            }}
                          />
                        )
                      })}
                    </div>
                  </section>
                )
              })}
            </AsyncState>
          )}
        </div>
      </div>
      {confirming !== undefined && (
        <ConfirmDialog
          title={`关闭「${confirming.name}」？`}
          body={confirming.impact ?? DEFAULT_IMPACT}
          confirmLabel="关闭"
          onCancel={() => {
            setConfirming(undefined)
          }}
          onConfirm={async () => {
            const closed = await disable(confirming)
            // 失败时让弹窗留在原地：patch 已经把原因弹成 toast，用户可以再点一次
            // 或取消，不必重新走一遍「找到插件 → 关开关」。
            if (closed) setConfirming(undefined)
          }}
        />
      )}
    </section>
  )
}
