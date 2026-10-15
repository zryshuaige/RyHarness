/**
 * 「我的」页的模型供应商区块：内置 / 自定义分组列表 + 添加向导（预设网格 → 表单）
 * + 行内编辑。
 *
 * 此前供应商只是几行可展开文字，看不到协议、baseURL，也加不了自己的供应商。
 * 对齐主流产品的形态：每行 = 图标 + 名称 + 徽标（内置或自定义 / 协议 / 免 key）
 * + 右侧模型数；未配置的行内直接填 key；每行都能「编辑」（改名字 / Base URL /
 * 模型列表 / 协议）；自定义供应商带确认可删。
 *
 * 与服务端契约（apps/server/src/routes/providers.ts）的实际形状：GET /api/providers
 * 带 id / displayName / protocol / baseUrl / custom / apiKeyConfigured / models /
 * usedBy，凭据只回答"配没配"。写入走 POST /api/providers、PATCH /api/providers/:id、
 * DELETE /api/providers/:id；写方法缺省一律视为后端未跟上，界面降级得体面：按钮
 * 禁用并说明原因，而不是点了没反应或弹一句 'not found: POST /api/providers'。
 *
 * 凭据这块讲的是全生命周期：填进去只是「已备」，不测过就不知道这家认不认；所以状态
 * 分三态（未配置凭据 / 凭据已备（未验证）/ 已验证），并提供更换 Key、移除凭据、
 * 测试连接三个出口。免 key 的本地服务（Ollama）不套用这套：它没有 key 可填，改用
 * 探活，探不通就说「未检测到本地服务」，而不是拿一个绿点假装它在。改过 Base URL 之
 * 后上一次「已验证」就不作数了，绿点会撤掉。
 *
 * 渲染层对 api 只做结构化要求（测试给子集即可）：新方法缺省视为后端未跟上，
 * 添加入口降级为只有「自定义」一格，表单里的保存按钮直接禁用。
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { CreateProviderInput, ProviderInfo, ProviderPreset } from '../api.ts'
import {
  explainVerifyFailure,
  isKeylessProtocol,
  isLocalService,
  LOCAL_SERVICE_DOWN,
  modelRemovalHint,
  type ProviderVerifyResponse,
  providerByBaseUrl,
  providerModelIds,
  providerStatus,
  providerStatusText,
  providerUsage,
  removedModelIds,
} from '../lib/provider-health.ts'
import { toast } from '../lib/toast.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { Icon } from './Icon.tsx'
import { Modal } from './Modal.tsx'

/** 编辑供应商时能改的四个字段（与服务端 PATCH 的白名单一一对应）。 */
export interface UpdateProviderInput {
  displayName: string
  protocol: string
  baseUrl: string
  models: string[]
}

export interface ProviderApi {
  setApiKey(providerId: string, apiKey: string): Promise<{ providerId: string; configured: boolean }>
  providerPresets?(): Promise<{ presets: ProviderPreset[] }>
  createProvider?(input: CreateProviderInput): Promise<{ provider: ProviderInfo }>
  /** 改名称 / 地址 / 模型列表 / 协议；缺省 = 这个客户端没有编辑能力（后端未跟上）。 */
  updateProvider?(id: string, patch: UpdateProviderInput): Promise<{ provider: ProviderInfo }>
  deleteProvider?(id: string): Promise<{ deleted: string }>
  /** 测连接；缺省 = 这版服务端没有，界面禁用入口并说明。 */
  verifyProvider?(id: string): Promise<ProviderVerifyResponse>
  /** 移除已存凭据；缺省同上。服务端回的是 `{ providerId, configured }`，没有 `{ deleted }`。 */
  deleteApiKey?(id: string): Promise<{ providerId: string; configured: boolean }>
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

/** 测连接 / 探活的结果（本地服务与云端供应商共用一条路径）。 */
type VerifyState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; latencyMs: number }
  | { kind: 'down'; reason: string }
  | { kind: 'unsupported' }

/** 单个供应商：可展开行；未配置时行内直接填 key；已配置的管凭据与测连接。 */
function ProviderItem({
  provider,
  api,
  onChanged,
  onDelete,
  onEdit,
}: {
  provider: ProviderInfo
  api: ProviderApi
  onChanged: () => void
  onDelete: (provider: ProviderInfo) => void
  onEdit: (provider: ProviderInfo) => void
}) {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [replacingKey, setReplacingKey] = useState(false)
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' })
  const [removing, setRemoving] = useState(false)
  const headRef = useRef<HTMLButtonElement>(null)
  /** 上一次测通过的地址：被编辑换掉之后就不再作数。 */
  const verifiedBaseUrl = useRef<string | undefined>(undefined)
  const panelId = useId()
  const local = isLocalService(provider)
  const configured = provider.apiKeyConfigured || local
  const status = providerStatus(provider, verify.kind === 'ok')
  const usage = providerUsage(provider)
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
        setReplacingKey(false)
        // 换了 key 就等于没验过：状态退回「凭据已备（未验证）」，别让旧的绿点骗人。
        setVerify({ kind: 'idle' })
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

  const runVerify = (): void => {
    if (api.verifyProvider === undefined) {
      setVerify({ kind: 'unsupported' })
      return
    }
    setVerify({ kind: 'checking' })
    setError(undefined)
    api
      .verifyProvider(provider.id)
      .then((result) => {
        if (result.ok) {
          setVerify({ kind: 'ok', latencyMs: result.latencyMs })
          verifiedBaseUrl.current = provider.baseUrl
          if (local) {
            toast.success(`「${provider.displayName}」本地服务在线（${result.latencyMs}ms）`)
          } else {
            toast.success(`「${provider.displayName}」连接正常（${result.latencyMs}ms）`)
          }
          return
        }
        // 服务端给了分类就以它的话为准（那边已经写好「现象 → 下一步」）；老服务端
        // 没给分类时，界面上仍然是人话（401 / 连不上 / 限流各有说法）。
        setVerify({ kind: 'down', reason: explainVerifyFailure(result.message, result.code) })
      })
      .catch((cause: unknown) => {
        setVerify({
          kind: 'down',
          reason: explainVerifyFailure(cause instanceof Error ? cause.message : String(cause)),
        })
      })
  }

  // 端点被改过之后，上一次「已验证」说的已经不是这个地址了：绿点得撤掉。
  useEffect(() => {
    if (verifiedBaseUrl.current === undefined || verifiedBaseUrl.current === provider.baseUrl) return
    verifiedBaseUrl.current = undefined
    setVerify({ kind: 'idle' })
  }, [provider.baseUrl])

  // 本地服务没有「有没有 key」这回事，能不能用只能靠探活：进页面先探一次，
  // 用户随时能手动重探（Ollama 常常是用户启动之后才起来的）。
  useEffect(() => {
    if (!local || api.verifyProvider === undefined) return
    let cancelled = false
    setVerify({ kind: 'checking' })
    api
      .verifyProvider(provider.id)
      .then((result) => {
        if (cancelled) return
        if (result.ok) verifiedBaseUrl.current = provider.baseUrl
        setVerify(
          result.ok ? { kind: 'ok', latencyMs: result.latencyMs } : { kind: 'down', reason: LOCAL_SERVICE_DOWN },
        )
      })
      .catch(() => {
        if (!cancelled) setVerify({ kind: 'down', reason: LOCAL_SERVICE_DOWN })
      })
    return () => {
      cancelled = true
    }
  }, [local, api, provider.id, provider.baseUrl])

  const statusLabel =
    status === 'local'
      ? verify.kind === 'ok'
        ? `本地服务 · 在线 · ${verify.latencyMs}ms`
        : verify.kind === 'checking'
          ? '本地服务 · 检测中…'
          : verify.kind === 'unsupported'
            ? providerStatusText('local')
            : verify.kind === 'down'
              ? LOCAL_SERVICE_DOWN
              : providerStatusText('local')
      : verify.kind === 'ok'
        ? `${providerStatusText(status)} · ${verify.latencyMs}ms`
        : providerStatusText(status)

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
            {local && <span className="provider-chip">免 key</span>}
          </span>
        </span>
        <span className="provider-meta">
          <span className="provider-status">
            {/* 免 key 的本地服务不挂绿点：它没经过任何凭据校验，绿点等于撒谎。 */}
            {!local && <span className={`status-dot ${status === 'verified' ? 'ok' : 'warn'}`} aria-hidden="true" />}
            {statusLabel}
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
          {configured && !replacingKey ? (
            <>
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
              <div className="provider-item-actions">
                <button
                  type="button"
                  className="btn btn-mini"
                  disabled={verify.kind === 'checking'}
                  onClick={runVerify}
                  title={
                    api.verifyProvider === undefined ? '这个版本的服务端还没有「测试连接」' : '真的打一次这家供应商'
                  }
                >
                  {verify.kind === 'checking' ? '测试中…' : local ? '重新检测' : '测试连接'}
                </button>
                {!local && (
                  <>
                    <button
                      type="button"
                      className="btn btn-mini"
                      onClick={() => {
                        setReplacingKey(true)
                        setError(undefined)
                      }}
                    >
                      更换 Key
                    </button>
                    <button
                      type="button"
                      className="btn btn-mini btn-danger"
                      disabled={api.deleteApiKey === undefined}
                      title={api.deleteApiKey === undefined ? '这个版本的服务端还不能移除凭据' : '删掉本机存的这份 key'}
                      onClick={() => {
                        setRemoving(true)
                      }}
                    >
                      移除凭据
                    </button>
                  </>
                )}
              </div>
              {verify.kind === 'down' && (
                <p className="apikey-error" role="alert">
                  {verify.reason}
                </p>
              )}
              {verify.kind === 'unsupported' && (
                <p className="provider-note">这个版本的服务端还没有「测试连接」，发一条消息也能看出通不通。</p>
              )}
              <p className="provider-note">
                {local
                  ? '本地服务不需要 key：这条状态来自刚才那次探活，Ollama 起了就会变成「在线」。'
                  : 'key 只写在本机配置文件（api-keys.json，权限 0600），可随时更换或移除。'}
              </p>
            </>
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
              {replacingKey && (
                <button
                  type="button"
                  className="provider-back"
                  onClick={() => {
                    setReplacingKey(false)
                    setError(undefined)
                  }}
                >
                  ‹ 取消更换
                </button>
              )}
              <p className="provider-note">Key 只写在本机配置文件（api-keys.json，权限 0600）。</p>
            </>
          )}
          {/*
            编辑与删除放同一行：两个都是"这条路由本身的命运"，与上面的凭据操作分开。
            编辑对内置条目同样开放——它们删不掉，模型过期时只有这条路能改。
          */}
          <div className="provider-item-actions">
            <button
              type="button"
              className="btn btn-mini"
              disabled={api.updateProvider === undefined}
              title={
                api.updateProvider === undefined ? '这个版本的服务端还不能编辑供应商' : '改名称、Base URL 或模型列表'
              }
              onClick={() => {
                onEdit(provider)
              }}
            >
              编辑
            </button>
            {provider.custom === true &&
              (usage.length > 0 ? (
                // 服务端会回 409，但界面要先把话说在前面：先改绑，再删。
                <>
                  <button type="button" className="btn btn-mini btn-danger" disabled title="先改绑使用它的 agent 再删">
                    删除供应商
                  </button>
                  <p className="provider-note">
                    正在被{' '}
                    {usage
                      .map((item) => {
                        return item.agentName
                      })
                      .join('、')}{' '}
                    使用：先去通讯录把它们改绑到别的供应商，才能删这家。
                  </p>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-mini btn-danger"
                  onClick={() => {
                    onDelete(provider)
                  }}
                >
                  删除供应商
                </button>
              ))}
          </div>
        </div>
      )}
      {removing && (
        <ConfirmDialog
          title={`移除「${provider.displayName}」的凭据？`}
          body={`本机 api-keys.json 里存的那份 key 会被删掉，用它的 agent 立刻回复不了，直到重新填一个。随时可以再填回来。`}
          confirmLabel="确认移除"
          onCancel={() => {
            setRemoving(false)
          }}
          onConfirm={async () => {
            if (api.deleteApiKey === undefined) {
              setRemoving(false)
              return
            }
            try {
              await api.deleteApiKey(provider.id)
            } catch (cause: unknown) {
              const raw = cause instanceof Error ? cause.message : String(cause)
              toast.error(`移除「${provider.displayName}」的凭据失败：${raw}`)
              return
            }
            setRemoving(false)
            setVerify({ kind: 'idle' })
            onChanged()
            toast.success(`「${provider.displayName}」的凭据已移除`)
          }}
        />
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
  onEdit,
}: {
  label: string
  providers: ProviderInfo[]
  api: ProviderApi
  onChanged: () => void
  onDelete: (provider: ProviderInfo) => void
  onEdit: (provider: ProviderInfo) => void
}) {
  if (providers.length === 0) return null
  return (
    <div className="provider-group">
      <p className="provider-group-label">{label}</p>
      {providers.map((provider) => {
        return (
          <ProviderItem
            key={provider.id}
            provider={provider}
            api={api}
            onChanged={onChanged}
            onDelete={onDelete}
            onEdit={onEdit}
          />
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

/** 后端没实现对应写接口时给出的中文说法（各带一句能照着做的替代路径）。 */
const ADD_UNSUPPORTED =
  '这个版本的服务端还不能新增供应商：接口没实现。可以先在 data/config/providers.json 里加一条，重启服务端后再回来填 key。'
const EDIT_UNSUPPORTED =
  '这个版本的服务端还不能编辑供应商：接口没实现。可以直接改 data/config/providers.json 里这一条，重启服务端后生效。'

/**
 * 添加向导第二步 / 编辑弹窗：同一张表单，两种模式。
 *
 * 编辑模式（provider 有值）改的是「已经存在的那条路由」——以前改地址、改模型、改
 * 名字只能删了重建，而删除还被 409 挡着；模型列表里删掉的 id 会先在界面提示一遍，
 * 真有 agent 挂在上面时由服务端 409 点名拦下。
 */
function ProviderForm({
  preset,
  provider,
  api,
  onBack,
  onSaved,
}: {
  preset: ProviderPreset | undefined
  /** 编辑模式：改这一条已存在的供应商（缺省 = 新增）。 */
  provider: ProviderInfo | undefined
  api: ProviderApi
  onBack: () => void
  onSaved: () => void
}) {
  const editing = provider !== undefined
  const keyless = isKeylessProtocol(provider?.protocol ?? preset?.protocol)
  const [displayName, setDisplayName] = useState(provider?.displayName ?? preset?.displayName ?? '')
  const [protocol, setProtocol] = useState(provider?.protocol ?? preset?.protocol ?? 'openai')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? preset?.baseUrl ?? '')
  const [modelsText, setModelsText] = useState(
    (
      provider?.models.map((model) => {
        return model.id
      }) ??
      preset?.models ??
      []
    ).join('\n'),
  )
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const errorRef = useRef<HTMLParagraphElement>(null)
  const canSave = displayName.trim().length > 0 && baseUrl.trim().length > 0 && parseModels(modelsText).length > 0
  /** 缺省对应的写方法 = 这个客户端没有该能力（后端未跟上）：按钮禁用并说明，而不是点了没反应。 */
  const unsupported = editing ? api.updateProvider === undefined : api.createProvider === undefined
  const removed =
    editing && provider !== undefined ? removedModelIds(providerModelIds(provider), parseModels(modelsText)) : []
  const removalHint =
    editing && provider !== undefined
      ? modelRemovalHint(provider.displayName, removed, providerUsage(provider))
      : undefined

  // 保存失败时把焦点送到原因上：读屏会念出来，键盘用户也不用回头找红字在哪。
  useEffect(() => {
    if (error !== undefined) errorRef.current?.focus()
  }, [error])

  /** 两种模式共用的尾巴：成功收起弹窗，失败把原因就地显示（输入一律原样保留）。 */
  const runSave = (request: Promise<unknown>, success: () => void, unsupportedText: string): void => {
    setBusy(true)
    setError(undefined)
    request
      .then(() => {
        success()
      })
      .catch((cause: unknown) => {
        setError(explainApiError(cause, unsupportedText).message)
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const save = (): void => {
    const models = parseModels(modelsText)
    const wantedProtocol = protocol.trim().length > 0 ? protocol.trim() : 'openai'
    if (provider === undefined) {
      if (api.createProvider === undefined) return
      const input: CreateProviderInput = {
        displayName: displayName.trim(),
        protocol: wantedProtocol,
        baseUrl: baseUrl.trim(),
        models,
      }
      if (!keyless && apiKey.trim().length > 0) input.apiKey = apiKey.trim()
      if (preset !== undefined) input.presetId = preset.id
      runSave(
        api.createProvider(input),
        () => {
          toast.success(`已添加「${input.displayName}」`)
          onSaved()
        },
        ADD_UNSUPPORTED,
      )
      return
    }
    if (api.updateProvider === undefined) return
    runSave(
      api.updateProvider(provider.id, {
        displayName: displayName.trim(),
        protocol: wantedProtocol,
        baseUrl: baseUrl.trim(),
        models,
      }),
      () => {
        toast.success(`「${provider.displayName}」已更新`)
        onSaved()
      },
      EDIT_UNSUPPORTED,
    )
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
        {editing ? '‹ 取消编辑' : '‹ 重选供应商'}
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
      {!keyless && !editing && (
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
      {removalHint !== undefined && <p className="provider-note provider-warn">{removalHint}</p>}
      <p className="provider-note">
        {editing
          ? '模型列表一行一个，也可用逗号分隔；要换 Key 请回到这一行用「更换 Key」。'
          : '模型列表一行一个，也可用逗号分隔；保存后还能逐个补 key。'}
      </p>
      {unsupported && (
        <p className="apikey-error" role="alert">
          {editing
            ? '这个客户端还没有「编辑供应商」的能力，只能手工改 data/config/providers.json。'
            : '这个客户端还没有「新增供应商」的能力，只能手工编辑 data/config/providers.json。'}
        </p>
      )}
      {error !== undefined && (
        // 可聚焦：保存失败后焦点直接落到原因上，键盘用户不必回头找红字。
        <p className="apikey-error" role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </p>
      )}
      <div className="modal-actions">
        {/* 保存中不禁用：disabled 会把焦点从按钮上打掉，键盘用户保存完要重新 Tab 回来。 */}
        <button type="submit" className="btn btn-primary" disabled={!canSave || unsupported} aria-disabled={busy}>
          {busy ? '保存中' : editing ? '保存修改' : '保存'}
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
function AddProviderModal({
  api,
  providers,
  onClose,
  onAdded,
}: {
  api: ProviderApi
  /** 已有供应商：用来把配过的预设标成「已添加」，而不是让用户再点一次生成重复项。 */
  providers: ProviderInfo[]
  onClose: () => void
  onAdded: () => void
}) {
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
                // 同一个 baseUrl 只能有一条路由：配过的置灰并说清已加了几个模型，
                // 免得用户点进去存一存，拿到一条丢品牌图标的 custom-xxxxxxxx。
                const installed = providerByBaseUrl(providers, preset.baseUrl)
                return (
                  <button
                    type="button"
                    key={preset.id}
                    className={`provider-preset-tile${installed === undefined ? '' : ' is-installed'}`}
                    disabled={installed !== undefined}
                    title={
                      installed === undefined
                        ? undefined
                        : `已经添加过「${installed.displayName}」，不用重复添加；要改它请到列表里点「编辑」`
                    }
                    onClick={() => {
                      setSelected(preset)
                    }}
                  >
                    <ProviderIcon id={preset.id} name={preset.displayName} size={40} />
                    <span className="provider-preset-name">{preset.displayName}</span>
                    <span className="provider-preset-sub">
                      {installed === undefined ? presetSummary(preset) : `已添加 · ${installed.models.length} 个模型`}
                    </span>
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
          provider={undefined}
          api={api}
          onBack={() => {
            setSelected(undefined)
          }}
          onSaved={onAdded}
        />
      )}
    </Modal>
  )
}

/** 编辑弹窗：复用添加向导那张表单，只是换成 PATCH。 */
function EditProviderModal({
  provider,
  api,
  onClose,
  onSaved,
}: {
  provider: ProviderInfo
  api: ProviderApi
  onClose: () => void
  onSaved: () => void
}) {
  return (
    <Modal title={`编辑「${provider.displayName}」`} onClose={onClose}>
      <ProviderForm preset={undefined} provider={provider} api={api} onBack={onClose} onSaved={onSaved} />
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
  const [editing, setEditing] = useState<ProviderInfo | undefined>(undefined)
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
          <ProviderGroup
            label="内置"
            providers={builtin}
            api={api}
            onChanged={onChanged}
            onDelete={setDeleting}
            onEdit={setEditing}
          />
          <ProviderGroup
            label="自定义供应商"
            providers={custom}
            api={api}
            onChanged={onChanged}
            onDelete={setDeleting}
            onEdit={setEditing}
          />
        </div>
      )}
      {editing !== undefined && (
        <EditProviderModal
          provider={editing}
          api={api}
          onClose={() => {
            setEditing(undefined)
          }}
          onSaved={() => {
            setEditing(undefined)
            onChanged()
          }}
        />
      )}
      {adding && (
        <AddProviderModal
          api={api}
          providers={providers}
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
          body={
            providerUsage(deleting).length > 0
              ? `「${deleting.displayName}」正在被 ${providerUsage(deleting)
                  .map((item) => {
                    return item.agentName
                  })
                  .join('、')} 使用：先到通讯录把这些 agent 改绑到别的供应商，才能删这家。`
              : `「${deleting.displayName}」会从供应商列表移除，正在使用它的 agent 将无法回复，直到改用其他供应商。删除后不可恢复。`
          }
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
              const raw = cause instanceof Error ? cause.message : String(cause)
              const { message, missingEndpoint } = explainApiError(
                cause,
                '这个版本的服务端还不能删除供应商：接口没实现。需要删的话，先把 data/config/providers.json 里的这一条去掉再重启。',
              )
              // 409 = 还有 agent 绑在这家身上（界面上的 usedBy 可能还没刷新到）。
              toast.error(
                /409|in use|used by/.test(raw)
                  ? '还有 agent 正在用它：请先到通讯录把它们改绑到别的供应商，再回来删。'
                  : message,
              )
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
