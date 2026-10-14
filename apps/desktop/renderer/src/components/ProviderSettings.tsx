/**
 * 「我的」页的模型供应商区块：内置 / 自定义分组列表 + 添加向导（预设网格 → 表单）。
 *
 * 此前供应商只是几行可展开文字，看不到协议、baseURL，也加不了自己的供应商。
 * 对齐主流产品的形态：每行 = 图标 + 名称 + 徽标（内置或自定义 / 协议 / 免 key）
 * + 右侧模型数；未配置的行内直接填 key；自定义供应商带确认可删。
 *
 * 与服务端契约（apps/server/src/app.ts）的实际形状：GET /api/providers 目前只回
 * id / displayName / apiKeyConfigured / models，custom / protocol / baseUrl 是可选
 * 字段——没有就不展示对应徽标，不猜。预设、新增、删除三个接口在后端实现之前回
 * 404，界面要降级得体面：预设网格只剩「自定义」并说明原因，写操作失败给出能照着
 * 做的中文提示而不是 'not found: POST /api/providers'。
 *
 * 渲染层对 api 只做结构化要求（测试给子集即可）：新方法缺省视为后端未跟上，
 * 添加入口降级为只有「自定义」一格，表单里的保存按钮直接禁用。
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { CreateProviderInput, ProviderInfo, ProviderPreset } from '../api.ts'
import { toast } from '../lib/toast.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { Icon } from './Icon.tsx'
import { Modal } from './Modal.tsx'

export interface ProviderApi {
  setApiKey(providerId: string, apiKey: string): Promise<{ providerId: string; configured: boolean }>
  providerPresets?(): Promise<{ presets: ProviderPreset[] }>
  createProvider?(input: CreateProviderInput): Promise<{ provider: ProviderInfo }>
  deleteProvider?(id: string): Promise<{ deleted: string }>
}

/** 免 key 的协议（Ollama 这类本地服务）：行上挂徽标，表单里不展示 key 输入。 */
function isKeylessProtocol(protocol: string | undefined): boolean {
  return protocol === 'ollama'
}

/**
 * 服务端没注册这条路由时回的是 404 + { error: 'not found: POST /api/providers' }。
 * 那串英文是给排查看的，直接弹给用户等于把内部路径摆上台面；这里换成人能照着做
 * 的一句话。missingEndpoint 告诉调用方「重试也不会变好」。
 */
function explainApiError(cause: unknown, missingEndpointText: string): { message: string; missingEndpoint: boolean } {
  const raw = cause instanceof Error ? cause.message : String(cause)
  if (!/^not found: |^HTTP 404$/.test(raw)) return { message: raw, missingEndpoint: false }
  return { message: missingEndpointText, missingEndpoint: true }
}

/** 预设品牌色：内联 SVG 字母标用，不引外部资源。 */
const BRAND_COLORS: Record<string, string> = {
  siliconflow: '#6E56CF',
  deepseek: '#4D6BFE',
  moonshot: '#26292E',
  zhipu: '#3859FF',
  minimax: '#E5484D',
  openrouter: '#6366F1',
  openai: '#10A37F',
  ollama: '#1F2328',
}

/** 供应商图标：品牌色圆角方块 + 首字符（中文名取第一个字）。 */
export function ProviderIcon({ id, name, size = 36 }: { id?: string; name: string; size?: number }) {
  const color = (id !== undefined ? BRAND_COLORS[id] : undefined) ?? '#D97706'
  const letter = (name.trim()[0] ?? '?').toUpperCase()
  return (
    <span className="provider-logo" style={{ width: size, height: size }} aria-hidden="true">
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: 纯装饰字母标，外层 span 已 aria-hidden */}
      <svg viewBox="0 0 36 36" width={size} height={size}>
        <rect width="36" height="36" rx="10" fill={color} />
        <text x="18" y="24" textAnchor="middle" fontSize="16" fontWeight="600" fill="#FFFDF8">
          {letter}
        </text>
      </svg>
    </span>
  )
}

/** 单个供应商：可展开行；未配置时行内直接填 key；自定义的可删除。 */
function ProviderItem({
  provider,
  api,
  onChanged,
  onDelete,
}: {
  provider: ProviderInfo
  api: ProviderApi
  onChanged: () => void
  onDelete: (provider: ProviderInfo) => void
}) {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const headRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const configured = provider.apiKeyConfigured || isKeylessProtocol(provider.protocol)
  /** 收起并把焦点还给行标题：Esc 在这一层是「退出当前这层」，不是「关掉应用」。 */
  const collapse = (): void => {
    setOpen(false)
    headRef.current?.focus()
  }
  const saveKey = (): void => {
    setBusy(true)
    setError(undefined)
    api
      .setApiKey(provider.id, key.trim())
      .then(() => {
        setKey('')
        toast.success(`「${provider.displayName}」的 key 已存到本机`)
        onChanged()
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        setBusy(false)
      })
  }
  return (
    <div className="provider-item">
      <button
        type="button"
        ref={headRef}
        className="provider-head"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((prev) => {
            return !prev
          })
        }}
      >
        <ProviderIcon id={provider.id} name={provider.displayName} />
        <span className="provider-name-col">
          <span className="provider-name">{provider.displayName}</span>
          <span className="provider-badges">
            <span className="badge">{provider.custom === true ? '自定义' : '内置'}</span>
            {provider.protocol !== undefined && <span className="provider-chip">{provider.protocol}</span>}
            {isKeylessProtocol(provider.protocol) && <span className="provider-chip">免 key</span>}
          </span>
        </span>
        <span className="provider-meta">
          <span className="provider-status">
            <span className={`status-dot ${configured ? 'ok' : 'warn'}`} aria-hidden="true" />
            {configured ? '已配置' : '未配置'}
          </span>
          <span className="provider-models-count">{provider.models.length} 个模型</span>
          <span className={`me-chevron provider-chevron${open ? ' is-open' : ''}`} aria-hidden="true">
            ›
          </span>
        </span>
      </button>
      {open && (
        <div className="provider-body" id={panelId}>
          {provider.baseUrl !== undefined && <p className="provider-endpoint">{provider.baseUrl}</p>}
          {configured ? (
            <ul className="provider-model-list">
              {provider.models.map((model) => {
                return (
                  <li key={model.id}>
                    {model.name ?? model.id}
                    <small>{model.id}</small>
                  </li>
                )
              })}
            </ul>
          ) : (
            <>
              {/* 用 form 包裹：回车即可保存，键盘用户不必 Tab 去够「保存」按钮。 */}
              <form
                className="apikey-row"
                aria-busy={busy}
                onSubmit={(event) => {
                  event.preventDefault()
                  if (busy || key.trim().length === 0) return
                  saveKey()
                }}
              >
                <input
                  type="password"
                  value={key}
                  placeholder="粘贴 API Key"
                  autoComplete="off"
                  // 保存中用 readOnly 而不是 disabled：禁用会把焦点从输入框上打掉，
                  // 键盘用户保存完还得重新 Tab 回来。
                  readOnly={busy}
                  aria-label={`${provider.displayName} 的 API Key`}
                  onChange={(event) => {
                    setKey(event.target.value)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') collapse()
                  }}
                />
                <button type="submit" className="btn btn-primary" disabled={busy || key.trim().length === 0}>
                  {busy ? '保存中' : '保存'}
                </button>
              </form>
              {error !== undefined && (
                <p className="apikey-error" role="alert">
                  {error}
                </p>
              )}
              <p className="provider-note">Key 只写在本机配置文件（api-keys.json，权限 0600）。</p>
            </>
          )}
          {provider.custom === true && (
            <div className="provider-item-actions">
              <button
                type="button"
                className="btn btn-mini btn-danger"
                onClick={() => {
                  onDelete(provider)
                }}
              >
                删除供应商
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ProviderGroup({
  label,
  providers,
  api,
  onChanged,
  onDelete,
}: {
  label: string
  providers: ProviderInfo[]
  api: ProviderApi
  onChanged: () => void
  onDelete: (provider: ProviderInfo) => void
}) {
  if (providers.length === 0) return null
  return (
    <div className="provider-group">
      <p className="provider-group-label">{label}</p>
      {providers.map((provider) => {
        return (
          <ProviderItem key={provider.id} provider={provider} api={api} onChanged={onChanged} onDelete={onDelete} />
        )
      })}
    </div>
  )
}

/** 模型列表输入：一行一个或逗号分隔都行，保存前归一成数组。 */
function parseModels(text: string): string[] {
  return text
    .split(/[\n,，]+/)
    .map((item) => {
      return item.trim()
    })
    .filter((item) => {
      return item.length > 0
    })
}

/** 添加向导第二步：表单。预设已预填名称 / 协议 / baseURL / 推荐模型。 */
function ProviderForm({
  preset,
  api,
  onBack,
  onAdded,
}: {
  preset: ProviderPreset | undefined
  api: ProviderApi
  onBack: () => void
  onAdded: () => void
}) {
  const keyless = isKeylessProtocol(preset?.protocol)
  const [displayName, setDisplayName] = useState(preset?.displayName ?? '')
  const [protocol, setProtocol] = useState(preset?.protocol ?? 'openai')
  const [baseUrl, setBaseUrl] = useState(preset?.baseUrl ?? '')
  const [modelsText, setModelsText] = useState((preset?.models ?? []).join('\n'))
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const canSave = displayName.trim().length > 0 && baseUrl.trim().length > 0 && parseModels(modelsText).length > 0
  /** createProvider 缺省 = 这个客户端没有新增能力（后端未跟上）：按钮禁用并说明，而不是点了没反应。 */
  const unsupported = api.createProvider === undefined

  const save = (): void => {
    if (api.createProvider === undefined) return
    const input: CreateProviderInput = {
      displayName: displayName.trim(),
      protocol: protocol.trim().length > 0 ? protocol.trim() : 'openai',
      baseUrl: baseUrl.trim(),
      models: parseModels(modelsText),
    }
    if (!keyless && apiKey.trim().length > 0) input.apiKey = apiKey.trim()
    if (preset !== undefined) input.presetId = preset.id
    setBusy(true)
    setError(undefined)
    api
      .createProvider(input)
      .then(() => {
        toast.success(`已添加「${input.displayName}」`)
        onAdded()
      })
      .catch((cause: unknown) => {
        setError(
          explainApiError(
            cause,
            '这个版本的服务端还不能新增供应商：接口没实现。可以先在 data/config/providers.json 里加一条，重启服务端后再回来填 key。',
          ).message,
        )
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    // 表单而非 div：任意字段里按回车都能保存，键盘用户不用一路 Tab 到按钮。
    <form
      className="provider-form"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault()
        if (busy || !canSave) return
        save()
      }}
    >
      <button
        type="button"
        className="provider-back"
        onClick={() => {
          onBack()
        }}
      >
        ‹ 重选供应商
      </button>
      <label className="field">
        <span>名称</span>
        <input
          value={displayName}
          onChange={(event) => {
            setDisplayName(event.target.value)
          }}
        />
      </label>
      <div className="field-row">
        <label className="field">
          <span>协议</span>
          <input
            value={protocol}
            placeholder="openai"
            onChange={(event) => {
              setProtocol(event.target.value)
            }}
          />
        </label>
        <label className="field">
          <span>Base URL</span>
          <input
            value={baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(event) => {
              setBaseUrl(event.target.value)
            }}
          />
        </label>
      </div>
      <label className="field">
        <span>模型列表（一行一个）</span>
        <textarea
          rows={4}
          value={modelsText}
          onChange={(event) => {
            setModelsText(event.target.value)
          }}
        />
      </label>
      {!keyless && (
        <label className="field">
          <span>API Key（可稍后再填）</span>
          <input
            type="password"
            value={apiKey}
            autoComplete="off"
            onChange={(event) => {
              setApiKey(event.target.value)
            }}
          />
        </label>
      )}
      {preset?.docsUrl !== undefined && (
        <p className="provider-note">
          <a href={preset.docsUrl} target="_blank" rel="noreferrer">
            去官网申请 API Key ↗
          </a>
        </p>
      )}
      <p className="provider-note">模型列表一行一个，也可用逗号分隔；保存后还能逐个补 key。</p>
      {unsupported && (
        <p className="apikey-error" role="alert">
          这个客户端还没有「新增供应商」的能力，只能手工编辑 data/config/providers.json。
        </p>
      )}
      {error !== undefined && (
        <p className="apikey-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !canSave || unsupported}>
          {busy ? '保存中' : '保存'}
        </button>
      </div>
    </form>
  )
}

/** 预设副标题：协议 + 推荐模型数。免 key 的协议直说，免得以为点进去还要填 key。 */
function presetSummary(preset: ProviderPreset): string {
  if (isKeylessProtocol(preset.protocol)) return `${preset.protocol} · 免 key`
  return `${preset.protocol} · ${preset.models.length} 个模型`
}

/** 添加向导：第一步预设网格（含「自定义」），第二步表单。 */
function AddProviderModal({ api, onClose, onAdded }: { api: ProviderApi; onClose: () => void; onAdded: () => void }) {
  const [presets, setPresets] = useState<ProviderPreset[] | undefined>(undefined)
  const [loadFailed, setLoadFailed] = useState(false)
  const [selected, setSelected] = useState<ProviderPreset | 'custom' | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    if (api.providerPresets === undefined) {
      setPresets([])
      return
    }
    api
      .providerPresets()
      .then(({ presets: list }) => {
        if (!cancelled) setPresets(list)
      })
      .catch(() => {
        if (cancelled) return
        setPresets([])
        setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [api])

  const title =
    selected === undefined ? '添加供应商' : `添加 ${selected === 'custom' ? '自定义供应商' : selected.displayName}`
  return (
    <Modal title={title} onClose={onClose}>
      {selected === undefined ? (
        <>
          {presets === undefined ? (
            <p className="provider-note">正在读取预设…</p>
          ) : (
            <div className="provider-preset-grid">
              {presets.map((preset) => {
                return (
                  <button
                    type="button"
                    key={preset.id}
                    className="provider-preset-tile"
                    onClick={() => {
                      setSelected(preset)
                    }}
                  >
                    <ProviderIcon id={preset.id} name={preset.displayName} size={40} />
                    <span className="provider-preset-name">{preset.displayName}</span>
                    <span className="provider-preset-sub">{presetSummary(preset)}</span>
                  </button>
                )
              })}
              <button
                type="button"
                className="provider-preset-tile"
                onClick={() => {
                  setSelected('custom')
                }}
              >
                <ProviderIcon name="自定义" size={40} />
                <span className="provider-preset-name">自定义</span>
                <span className="provider-preset-sub">手动填写</span>
              </button>
            </div>
          )}
          {/* 没读到预设分两种：接口报错（说得更具体）与后端根本没提供列表。 */}
          {loadFailed && <p className="provider-note">预设列表没读到，可以先选「自定义」手动填写。</p>}
          {!loadFailed && presets !== undefined && presets.length === 0 && (
            <p className="provider-note">这个版本的服务端没有提供预设列表，选「自定义」手填即可。</p>
          )}
        </>
      ) : (
        <ProviderForm
          preset={selected === 'custom' ? undefined : selected}
          api={api}
          onBack={() => {
            setSelected(undefined)
          }}
          onAdded={onAdded}
        />
      )}
    </Modal>
  )
}

/** 供应商区块：分组列表 + 右上「添加供应商」入口。 */
export function ProviderSettings({
  api,
  providers,
  onChanged,
}: {
  api: ProviderApi
  providers: ProviderInfo[]
  onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<ProviderInfo | undefined>(undefined)
  const builtin = providers.filter((provider) => {
    return provider.custom !== true
  })
  const custom = providers.filter((provider) => {
    return provider.custom === true
  })
  return (
    <>
      <div className="provider-section-head">
        <div className="provider-section-title">
          <div className="me-row-title">模型供应商</div>
          <div className="me-row-sub">对话能力由它们提供 · key 只保存在本机</div>
        </div>
        <button
          type="button"
          className="btn provider-add-btn"
          onClick={() => {
            setAdding(true)
          }}
        >
          <Icon name="plus" size={14} /> 添加供应商
        </button>
      </div>
      {providers.length === 0 ? (
        // 首次加载时 providers 也是空数组，所以这句话必须两种情况都成立，
        // 不能一上来就喊「服务端没起来」。
        <p className="provider-empty">
          还没读到供应商：可能正在加载；若一直为空，多半是服务端没起来或 providers.json 是空的。
        </p>
      ) : (
        <div className="provider-groups">
          <ProviderGroup label="内置" providers={builtin} api={api} onChanged={onChanged} onDelete={setDeleting} />
          <ProviderGroup
            label="自定义供应商"
            providers={custom}
            api={api}
            onChanged={onChanged}
            onDelete={setDeleting}
          />
        </div>
      )}
      {adding && (
        <AddProviderModal
          api={api}
          onClose={() => {
            setAdding(false)
          }}
          onAdded={() => {
            setAdding(false)
            onChanged()
          }}
        />
      )}
      {deleting !== undefined && (
        <ConfirmDialog
          title={`删除「${deleting.displayName}」？`}
          body={`「${deleting.displayName}」会从供应商列表移除，正在使用它的 agent 将无法回复，直到改用其他供应商。删除后不可恢复。`}
          confirmLabel="确认删除"
          onCancel={() => {
            setDeleting(undefined)
          }}
          onConfirm={async () => {
            if (api.deleteProvider === undefined) return
            try {
              await api.deleteProvider(deleting.id)
            } catch (cause: unknown) {
              // 自己 toast 而不是把异常抛给 ConfirmDialog：那里只会原样弹英文。
              const { message, missingEndpoint } = explainApiError(
                cause,
                '这个版本的服务端还不能删除供应商：接口没实现。需要删的话，先把 data/config/providers.json 里的这一条去掉再重启。',
              )
              toast.error(message)
              // 接口不存在时重试也不会变好，留着弹窗只会让人干瞪眼；其余情况留着，
              // 用户能看清原因直接重试。
              if (missingEndpoint) setDeleting(undefined)
              return
            }
            setDeleting(undefined)
            onChanged()
            toast.success(`「${deleting.displayName}」已删除`)
          }}
        />
      )}
    </>
  )
}
