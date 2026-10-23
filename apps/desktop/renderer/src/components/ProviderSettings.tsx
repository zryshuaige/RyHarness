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
import type { CSSProperties } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import type { CreateProviderInput, ProviderInfo, ProviderPreset, UpdateProviderInput } from '../api.ts'
import { errorDetail, humanError } from '../lib/error-text.ts'
import { protocolLabel } from '../lib/humanize.ts'
import {
  type CatalogModel,
  catalogFromProvider,
  contextWindowDrafts,
  type DiscoveredModel,
  formatContextWindow,
  mergeDiscovered,
  modelMeta,
  modelTitle,
  type ProviderModelInput,
  parseContextWindowInput,
  providerModelPayload,
  toCatalogModel,
} from '../lib/model-catalog.ts'
import {
  explainVerifyFailure,
  FAILURE_TEXT,
  forgetProviderHealth,
  isKeylessProtocol,
  isLocalService,
  LOCAL_SERVICE_DOWN,
  modelRemovalHint,
  PROVIDER_HEALTH_POLL_MS,
  type ProviderDiscoveryResponse,
  type ProviderFailureCode,
  type ProviderVerifyResponse,
  providerByBaseUrl,
  providerHealth,
  providerModelIds,
  providerStatus,
  providerStatusText,
  providerUsage,
  rememberProviderHealth,
  removedModelIds,
} from '../lib/provider-health.ts'
import { providerLetterBg, providerLogo } from '../lib/provider-logos.ts'
import { toast } from '../lib/toast.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { Icon } from './Icon.tsx'
import { Modal } from './Modal.tsx'
import { Select } from './Select.tsx'

/**
 * 编辑供应商时能改的四个字段（与服务端 PATCH 的白名单一一对应）。
 *
 * 定义在 api.ts——它是随请求发出去的线格式，与 CreateProviderInput 同源；
 * 这里转出去是为了让引用方从本组件取类型，不必再引一次 api。
 */
export type { UpdateProviderInput }

/**
 * 服务端 models 白名单认的条目：裸 id，或带补录上下文长度的对象。
 *
 * 裸 id 那一支留着是为了让真正的 ApiClient 仍然满足 {@link ProviderApi}（方法形参
 * 双变，`string[]` 可赋给这个联合），也让"只改名字、模型列表原样回传"的调用方不必
 * 改写法——服务端两种都收。
 */
export type ProviderModelEntry = string | ProviderModelInput

/** POST /api/providers 的入参：与 CreateProviderInput 同形，models 放宽到 {@link ProviderModelEntry}。 */
export interface CreateProviderForm extends Omit<CreateProviderInput, 'models'> {
  models: ProviderModelEntry[]
}

/** PATCH /api/providers/:id 的入参：与 UpdateProviderInput 同形，models 放宽到 {@link ProviderModelEntry}。 */
export interface UpdateProviderForm extends Omit<UpdateProviderInput, 'models'> {
  models: ProviderModelEntry[]
}

export interface ProviderApi {
  setApiKey(providerId: string, apiKey: string): Promise<{ providerId: string; configured: boolean }>
  providerPresets?(): Promise<{ presets: ProviderPreset[] }>
  createProvider?(input: CreateProviderForm): Promise<{ provider: ProviderInfo }>
  /** 改名称 / 地址 / 模型列表 / 协议；缺省 = 这个客户端没有编辑能力（后端未跟上）。 */
  updateProvider?(id: string, patch: UpdateProviderForm): Promise<{ provider: ProviderInfo }>
  deleteProvider?(id: string): Promise<{ deleted: string }>
  /** 测连接；缺省 = 这版服务端没有，界面禁用入口并说明。 */
  verifyProvider?(id: string): Promise<ProviderVerifyResponse>
  /**
   * 对一份**还没保存**的供应商草稿问模型目录；缺省 = 这版客户端没有这个方法，
   * 添加向导的「从供应商拉取模型」据此禁用并说明（编辑模式仍可用 verify 的回包）。
   */
  discoverProvider?(input: { baseUrl: string; protocol: string; apiKey?: string }): Promise<ProviderDiscoveryResponse>
  /** 移除已存凭据；缺省同上。服务端回的是 `{ providerId, configured }`，没有 `{ deleted }`。 */
  deleteApiKey?(id: string): Promise<{ providerId: string; configured: boolean }>
}

/** 保存类失败的兜底句：这一层不知道调用方在存 Key、存模型还是存供应商。 */
const DEFAULT_SAVE_HINT = '这次没能保存下来，检查一下填的内容再试。'

/**
 * 这一版还做不到某个动作时的说法。界面上只此一份措辞。
 *
 * 同一个事实此前按出现位置改写过五六遍——「这个版本的服务端还没有…」「这个版本的服务端
 * 还能不能…」「这个客户端还没有…」「这一版没有提供…」——用户看到的是五种说法，而不是
 * 一个状态。统一成「这一版还不支持「X」」之后，「这版服务端」还是「这版客户端」这种
 * 内部区分也一并拿掉：用户要知道的只有一件事——这个按钮在这版里点不动。
 */
const unsupportedNotice = (what: string): string => `这一版还不支持「${what}」`

/**
 * 凭据存在哪。用户真正在意的只有「只在本机」这一句：文件路径、权限位、存成什么格式
 * 都是排查看的。与区块副标题、以及 lib/humanize 的隐私口径同一句话。
 */
const KEY_STORAGE_NOTE = 'key 只保存在本机。'

/**
 * 服务端没注册这条路由时回的是 404 + { error: 'not found: POST /api/providers' }。
 *
 * 这不是第二个人话层：认得出的失败仍旧交给 lib/error-text 的 {@link humanError}，
 * 这里只多做一件它表达不了的事——把「这版根本没有这个接口」单独标出来，好让调用方
 * 知道重试也不会变好（删供应商那条要据此把弹窗收起来）。
 */
function explainApiError(cause: unknown, missingEndpointText: string): { message: string; missingEndpoint: boolean } {
  // 判据读的是**原文**（errorDetail）：ApiRequestError.message 现在说的是人话，
  // 拿它去匹配 `not found:` 只会永远落空，把"这版没这个接口"说成普通失败。
  const missingEndpoint = /^not found: |^http 404$/i.test(errorDetail(cause) ?? '')
  return {
    message: missingEndpoint ? missingEndpointText : humanError(cause, DEFAULT_SAVE_HINT),
    missingEndpoint,
  }
}

/**
 * 供应商图标：真实品牌 logo，缺的那几家退回首字母色块。
 *
 * 此前一律是「品牌色圆角方块 + 首字母」——DeepSeek 是 D、OpenAI 是 O，一屏排开
 * 全是认不出的占位符。品牌标识是识别一家供应商最快的线索，竞品（Cursor /
 * Continue / Cline）也都用真 logo。来源与主题适配见 lib/provider-logos.ts。
 */
export function ProviderIcon({ id, name, size = 36 }: { id?: string; name: string; size?: number }) {
  const logo = providerLogo(id)
  if (logo !== undefined) {
    return (
      <span className="provider-logo" style={{ width: size, height: size }} aria-hidden="true">
        <img
          className="provider-logo-img"
          src={logo}
          alt=""
          width={size}
          height={size}
          draggable={false}
          decoding="async"
        />
      </span>
    )
  }
  const letter = (name.trim()[0] ?? '?').toUpperCase()
  return (
    <span className="provider-logo" style={{ width: size, height: size }} aria-hidden="true">
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: 纯装饰字母标，外层 span 已 aria-hidden */}
      <svg viewBox="0 0 36 36" width={size} height={size}>
        <rect width="36" height="36" rx="10" fill={providerLetterBg(id)} />
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

/**
 * 挂载时的初始探测态：从模块级健康缓存里取，而不是一律 idle。
 *
 * 「刚测过没有」是跨页面的事实（新建 agent 的供应商下拉也要用它排序），停在设置页
 * 组件 state 里就只在这一页成立——用户切到通讯录再回来，得重测一次才知道这家通不通。
 */
function initialVerifyState(provider: ProviderInfo, local: boolean): VerifyState {
  const health = providerHealth(provider.id)
  if (health === undefined) return { kind: 'idle' }
  if (health.code === 'ok') return { kind: 'ok', latencyMs: health.latencyMs }
  // 免 key 的本地服务不该显示某次失败的中文原因（探活失败就是"服务没起来"这一句）。
  return { kind: 'down', reason: local ? LOCAL_SERVICE_DOWN : FAILURE_TEXT[health.code] }
}

/** 单个供应商：可展开行；未配置时行内直接填 key；已配置的管凭据与测连接。 */
function ProviderItem({
  provider,
  api,
  onChanged,
  onDelete,
  onEdit,
  initiallyOpen,
}: {
  provider: ProviderInfo
  api: ProviderApi
  onChanged: () => void
  onDelete: (provider: ProviderInfo) => void
  onEdit: (provider: ProviderInfo) => void
  /** 初始就展开（用户刚在「先挑一家」的网格里点过这一家）。 */
  initiallyOpen?: boolean
}) {
  const [open, setOpen] = useState(initiallyOpen === true)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [replacingKey, setReplacingKey] = useState(false)
  const [verify, setVerify] = useState<VerifyState>(() => {
    return initialVerifyState(provider, isLocalService(provider))
  })
  const [removing, setRemoving] = useState(false)
  const headRef = useRef<HTMLButtonElement>(null)
  /** 上一次测通过的地址：被编辑换掉之后就不再作数。 */
  const verifiedBaseUrl = useRef<string>(provider.baseUrl ?? '')
  const panelId = useId()
  const local = isLocalService(provider)
  const configured = provider.apiKeyConfigured || local
  const status = providerStatus(provider, verify.kind === 'ok')
  const usage = providerUsage(provider)
  // 目录条目直接来自服务端（它就是内核在用的那一份）：用户在设置页补录的长度会随
  // 保存进 providers.json，所以这一行显的与内核算预算的必然同值。
  const catalog = catalogFromProvider(provider)
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
        forgetProviderHealth(provider.id)
        toast.success(`「${provider.displayName}」的 key 已存到本机`)
        onChanged()
      })
      .catch((cause: unknown) => {
        setError(humanError(cause, '这个 Key 没存上，再试一次'))
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
        rememberProviderHealth(provider.id, result)
        if (result.ok) {
          setVerify({ kind: 'ok', latencyMs: result.latencyMs })
          verifiedBaseUrl.current = provider.baseUrl ?? ''
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
          reason: explainVerifyFailure(errorDetail(cause)),
        })
      })
  }

  // 端点被改过之后，上一次「已验证」说的已经不是这个地址了：绿点得撤掉，
  // 共享的健康缓存里那条结论也要一起作废（否则别的页面仍按旧地址的结论排序）。
  useEffect(() => {
    if (verifiedBaseUrl.current === (provider.baseUrl ?? '')) return
    verifiedBaseUrl.current = provider.baseUrl ?? ''
    setVerify({ kind: 'idle' })
    forgetProviderHealth(provider.id)
  }, [provider.baseUrl, provider.id])

  // 本地服务没有「有没有 key」这回事，能不能用只能靠探活：进页面先探一次，
  // 之后按分钟重探（Ollama 常常是用户启动之后才起来的），用户随时能手动重探。
  useEffect(() => {
    // 先把方法取出来再进闭包：守卫里的收窄不会带进 probe 这个内层函数。
    // 必须 bind——api 是类实例，裸取方法调用会丢 this（生产环境直接崩在 this.request 上）。
    const verify = api.verifyProvider?.bind(api)
    if (!local || verify === undefined) return
    let cancelled = false
    const probe = (): void => {
      setVerify({ kind: 'checking' })
      verify(provider.id)
        .then((result) => {
          if (cancelled) return
          rememberProviderHealth(provider.id, result)
          if (result.ok) verifiedBaseUrl.current = provider.baseUrl ?? ''
          setVerify(
            result.ok ? { kind: 'ok', latencyMs: result.latencyMs } : { kind: 'down', reason: LOCAL_SERVICE_DOWN },
          )
        })
        .catch(() => {
          if (cancelled) return
          rememberProviderHealth(provider.id, { ok: false, code: 'service-down' })
          setVerify({ kind: 'down', reason: LOCAL_SERVICE_DOWN })
        })
    }
    probe()
    // 只给本地服务开轮询：云端供应商每分钟被自动打一次是替用户发请求，用户没要求的
    // 网络行为不该由界面自己决定。
    const timer = setInterval(probe, PROVIDER_HEALTH_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
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
            {/* 徽标本身已经说了协议是什么：title 再挂一遍原始标识（openai / ollama）
                只是把同一个词换成用户看不懂的写法多显示一次。 */}
            {provider.protocol !== undefined && (
              <span className="provider-chip">{protocolLabel(provider.protocol)}</span>
            )}
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
            <Icon name="chevron-right" size={16} />
          </span>
        </span>
      </button>
      {open && (
        <div className="provider-body" id={panelId}>
          {provider.baseUrl !== undefined && <p className="provider-endpoint">{provider.baseUrl}</p>}
          {configured && !replacingKey ? (
            <>
              <ul className="provider-model-list">
                {catalog.map((model) => {
                  return (
                    <li key={model.id}>
                      {modelTitle(model)}
                      <small>{modelMeta(model)}</small>
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
                  title={api.verifyProvider === undefined ? unsupportedNotice('测试连接') : '真的打一次这家供应商'}
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
                      title={api.deleteApiKey === undefined ? unsupportedNotice('移除凭据') : '删掉本机存的这份 key'}
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
                // 这一版测不了，但状态本身没丢：告诉用户还能怎么判断通不通。
                <p className="provider-note">{unsupportedNotice('测试连接')}，发一条消息也能看出通不通。</p>
              )}
              <p className="provider-note">
                {local ? '本地服务不需要 key：Ollama 起来了，这条会自动变成「在线」。' : KEY_STORAGE_NOTE}
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
                  <Icon name="chevron-left" size={16} /> 取消更换
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
              toast.error(
                `移除「${provider.displayName}」的凭据失败：${humanError(cause, '这个 Key 没被移除，再试一次')}`,
              )
              return
            }
            setRemoving(false)
            setVerify({ kind: 'idle' })
            forgetProviderHealth(provider.id)
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
  initiallyOpenIds,
}: {
  label: string
  providers: ProviderInfo[]
  api: ProviderApi
  onChanged: () => void
  onDelete: (provider: ProviderInfo) => void
  onEdit: (provider: ProviderInfo) => void
  /** 这些条目初始就是展开的（用户刚在「先挑一家」里点过它）。 */
  initiallyOpenIds?: ReadonlySet<string>
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
            initiallyOpen={initiallyOpenIds?.has(provider.id) === true}
          />
        )
      })}
    </div>
  )
}

/**
 * 可选协议。与服务端 {@link ProviderProtocol} 同一份取值（'openai' | 'ollama'）：
 * 这是个封闭集合，给下拉而不是文本框——用户把标识拼错，错误要等到真正发请求才
 * 报出来，而那时候他已经在别处填了一整页配置。
 *
 * 展示名复用 protocolLabel，label 里带上这句话对用户的含义：光说「OpenAI 兼容」
 * 新手不知道该选它。
 */
const PROTOCOL_OPTIONS = [
  { value: 'openai', label: 'OpenAI 兼容（绝大多数云端服务商）' },
  { value: 'ollama', label: '本地 Ollama（跑在自己电脑上，免 Key）' },
] as const

/**
 * 模型列表的输入分隔符：空白 + 中英文逗号 + 分号 + 顿号。
 *
 * 空白也当分隔符是有依据的：模型 id 里不会出现空格（`deepseek-ai/DeepSeek-V4-Flash`
 * 这类只含字母数字与 `-_/`），而从各家控制台复制过来的清单恰恰是用空格或换行排的。
 * 按空白切，用户把整段粘进来就直接是模型列表，不必先自己去挑分隔符。
 */
const MODEL_SEPARATORS = /[\s,，;；、]+/

/**
 * 模型列表输入 → 数组。分隔符见 {@link MODEL_SEPARATORS}。
 *
 * 去重：同一段文字里重复出现的 id 只留第一次，否则供应商配置里会出现两条一模一样的
 * 模型，下拉框里点两次长得一样。
 */
function parseModels(text: string): string[] {
  const seen = new Set<string>()
  const models: string[] = []
  for (const item of text.split(MODEL_SEPARATORS)) {
    if (item.length === 0 || seen.has(item)) continue
    seen.add(item)
    models.push(item)
  }
  return models
}

/** 数组 → 文本框内容：一行一个。用户写的时候怎么写都行，失焦时由这里整理成规范形式。 */
function formatModels(models: readonly string[]): string {
  return models.join('\n')
}

/** 后端没实现对应写接口时给出的中文说法（各带一句能照着做的替代路径）。 */
const ADD_UNSUPPORTED =
  '这个版本的服务端还不能新增供应商：接口没实现。可以先在 data/config/providers.json 里加一条，重启服务端后再回来填 key。'
const EDIT_UNSUPPORTED =
  '这个版本的服务端还不能编辑供应商：接口没实现。可以直接改 data/config/providers.json 里这一条，重启服务端后生效。'

/**
 * 「从供应商拉取模型」的结果。
 *
 * failed 里那一句是给人看的下一步（服务端已经按「现象 → 下一步」写好，老客户端没给
 * 分类时由 explainVerifyFailure 兜底），不是把 401 / ECONNREFUSED 之类原样弹出来。
 */
type DiscoveryState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; models: DiscoveredModel[] }
  | { kind: 'failed'; message: string }
  | { kind: 'unsupported' }

/**
 * 模型发现面板：按钮 + 勾选清单 + 插入。
 *
 * 刻意做成一个受控的小组件（所有数据与副作用都在 ProviderForm 里）：ProviderForm
 * 已经有 1000 行，再往里塞发现的状态机只会更难拆；这块独立出来之后，日后整块
 * 挪走或换实现都不用碰表单其余部分。
 *
 * 「勾选后插入」而不是「拉回来直接覆盖模型列表」：一个网关能报上百个模型（嵌入、
 * 重排、图片），全塞进去用户既删不完也不知道该删哪些——清单让他自己决定要哪几个。
 */
function ModelDiscoveryPanel({
  state,
  picked,
  supported,
  onReload,
  onToggle,
  onToggleAll,
  onInsert,
}: {
  state: DiscoveryState
  /** 已勾选的模型 id。 */
  picked: ReadonlySet<string>
  /** 客户端有没有这个能力（缺省 = 后端/客户端未跟上，按钮禁用并说明）。 */
  supported: boolean
  onReload: () => void
  onToggle: (modelId: string, checked: boolean) => void
  onToggleAll: (checked: boolean) => void
  onInsert: () => void
}) {
  const models = state.kind === 'loaded' ? state.models : []
  return (
    <div className="provider-discovery">
      <button
        type="button"
        className="btn btn-mini"
        disabled={!supported || state.kind === 'loading'}
        title={supported ? '真的向这家供应商问一次它有哪些模型' : '这个版本还没有拉取模型列表的能力，可手动填写模型 id'}
        onClick={onReload}
      >
        {state.kind === 'loading' ? '拉取中…' : '从供应商拉取模型'}
      </button>
      {state.kind === 'loaded' && (
        <>
          <p className="provider-note">这家供应商报了 {models.length} 个模型：勾选后插进上面的模型列表，再自行删减。</p>
          <ul className="provider-model-list">
            {models.map((model) => {
              const entry = toCatalogModel(model, 'discovered')
              return (
                <li key={entry.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={picked.has(entry.id)}
                      onChange={(event) => {
                        onToggle(entry.id, event.target.checked)
                      }}
                    />
                    {entry.name ?? entry.id}
                    {entry.name !== undefined && <small>{entry.id}</small>}
                  </label>
                </li>
              )
            })}
          </ul>
          <div className="provider-item-actions">
            <button
              type="button"
              className="btn btn-mini"
              onClick={() => {
                onToggleAll(true)
              }}
            >
              全选
            </button>
            <button
              type="button"
              className="btn btn-mini"
              onClick={() => {
                onToggleAll(false)
              }}
            >
              全不选
            </button>
            <button type="button" className="btn btn-mini btn-primary" disabled={picked.size === 0} onClick={onInsert}>
              插入到模型列表
            </button>
          </div>
        </>
      )}
      {state.kind === 'failed' && (
        <p className="apikey-error" role="alert">
          {state.message}
        </p>
      )}
    </div>
  )
}

/** 补录行：id 在左、框在中、读数在右。行内样式是为这处新排版就地声明的，视觉参数沿用既有 token。 */
const windowRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const windowNameStyle: CSSProperties = {
  flex: '1 1 160px',
  minWidth: 0,
  wordBreak: 'break-all',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-xs)',
}
const windowInputStyle: CSSProperties = {
  width: 110,
  padding: '6px 10px',
  borderRadius: 'var(--radius-md)',
  background: 'var(--bg-subtle)',
  boxShadow: 'inset 0 0 0 1px var(--edge)',
  fontSize: 'var(--fs-sm)',
}
const windowHintStyle: CSSProperties = { flex: '0 0 auto', color: 'var(--text-tertiary)', fontSize: 'var(--fs-xs)' }

/**
 * 上下文长度补录：模型列表下面一行一个框，让用户替"厂家没报"的模型填上长度。
 *
 * 为什么要有这个手工入口：OpenAI 兼容的 `/v1/models` 只回 id，上下文长度在发现结果里
 * 必然是空的（model-catalog 的硬规矩是不猜）。整库只有内置预设里三五个模型带长度，
 * 用户新建自己的网关后看到的一整屏「上下文未知」就成了常态——界面不提供补的地方，
 * 这个缺口就永远补不上，用户也就永远只能凭模型名瞎猜。
 *
 * 填的值随「保存」进 providers.json，内核按它算这一条路由的请求预算——所以这里显的
 * 数字就是长会话真正能吃到的数字，不是注释。清空输入框即撤回这一条。
 */
function ContextWindowEditor({
  models,
  windows,
  onChange,
}: {
  /** 当前模型列表（文本框里解析出来的顺序，保持与上面的列表一致）。 */
  models: readonly string[]
  windows: Readonly<Record<string, string>>
  onChange: (modelId: string, raw: string) => void
}) {
  if (models.length === 0) return null
  return (
    <fieldset className="field" aria-label="上下文长度">
      <span>上下文长度（不知道就留空）</span>
      <p className="provider-note">
        供应商一般不报这个数字，界面也不会按模型名猜一个。照厂商文档填上，这里就显示成「128K·上下文」，建 agent
        选模型时同样看得见；随「保存」存进本机配置，对话按它留历史，清空即撤回。
      </p>
      <ul className="provider-model-list">
        {models.map((modelId) => {
          const raw = windows[modelId] ?? ''
          const parsed = parseContextWindowInput(raw)
          const invalid = raw.trim().length > 0 && parsed === undefined
          return (
            <li key={modelId} style={windowRowStyle}>
              <span style={windowNameStyle}>{modelId}</span>
              <input
                style={windowInputStyle}
                value={raw}
                placeholder="未知"
                aria-label={`${modelId} 的上下文长度（token）`}
                onChange={(event) => {
                  onChange(modelId, event.target.value)
                }}
              />
              <small style={windowHintStyle}>{invalid ? '看不懂这个写法' : formatContextWindow(parsed)}</small>
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}

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
  /**
   * 上下文长度的输入框：模型 id → 用户此刻敲的原文（空串 = 没填）。
   * 存原文而不是存数字：非法输入要留在框里让用户看见并改，而不是被静默吃掉。
   *
   * 初值一律来自服务端那一份（{@link contextWindowDrafts}），不来自任何本机覆盖层：
   * 重新拉一次模型目录重建表单时，用户上次填好的数字因此还在——此前正是在这里被
   * 静默清空的，而且那个值当时连内核都读不到，等于填了个寂寞。
   */
  const [windows, setWindows] = useState<Readonly<Record<string, string>>>(() => {
    return contextWindowDrafts(catalogFromProvider(provider))
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [discovery, setDiscovery] = useState<DiscoveryState>({ kind: 'idle' })
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set<string>())
  const errorRef = useRef<HTMLParagraphElement>(null)
  const canSave = displayName.trim().length > 0 && baseUrl.trim().length > 0 && parseModels(modelsText).length > 0
  /** 缺省对应的写方法 = 这个客户端没有该能力（后端未跟上）：按钮禁用并说明，而不是点了没反应。 */
  const unsupported = editing ? api.updateProvider === undefined : api.createProvider === undefined
  /**
   * 发现能力分两种来源：已存在的路由直接用 verify 的回包（它已经打过模型列表端点），
   * 还没保存的草稿只能走 discover——它没有路由 id 可用。
   */
  const canDiscover = editing ? api.verifyProvider !== undefined : api.discoverProvider !== undefined
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

  /**
   * 问一次这家供应商有哪些模型，结果落进面板（不直接改模型列表）。
   *
   * 空目录也是一种回答：说明这家不提供模型列表端点，用户照着提示手填，而不是对着
   * 一个永远转圈的按钮干瞪眼。
   */
  const applyDiscovery = (result: {
    ok: boolean
    code?: ProviderFailureCode
    message?: string
    models?: DiscoveredModel[]
    discovered?: DiscoveredModel[]
  }): void => {
    if (!result.ok) {
      setDiscovery({ kind: 'failed', message: explainVerifyFailure(result.message, result.code) })
      return
    }
    const models = result.models ?? result.discovered ?? []
    if (models.length === 0) {
      setDiscovery({
        kind: 'failed',
        message: '这家供应商没有报出模型（多半不提供模型列表端点）：请在上面的模型列表里手动填写 id。',
      })
      return
    }
    setDiscovery({ kind: 'loaded', models })
    // 一个都不默认勾上：网关动辄上百个模型（全选再让用户删）比让用户自己挑更糟。
    setPicked(new Set<string>())
  }

  const runDiscovery = (): void => {
    const wantedProtocol = protocol.trim().length > 0 ? protocol.trim() : 'openai'
    if (provider !== undefined) {
      if (api.verifyProvider === undefined) {
        setDiscovery({ kind: 'unsupported' })
        return
      }
      setDiscovery({ kind: 'loading' })
      api
        .verifyProvider(provider.id)
        .then((result) => {
          applyDiscovery({ ok: result.ok, code: result.code, message: result.message, discovered: result.discovered })
        })
        .catch((cause: unknown) => {
          setDiscovery({
            kind: 'failed',
            message: explainVerifyFailure(errorDetail(cause)),
          })
        })
      return
    }
    // 同上的 this 绑定坑：裸取 discoverProvider 再调用会在生产环境丢 this 崩掉。
    const discover = api.discoverProvider?.bind(api)
    if (discover === undefined) {
      setDiscovery({ kind: 'unsupported' })
      return
    }
    const key = apiKey.trim()
    setDiscovery({ kind: 'loading' })
    discover({
      baseUrl: baseUrl.trim(),
      protocol: wantedProtocol,
      // 一次性凭据：免 key 的本地服务不带 Key 字段（带上去也是白带）。
      ...(keyless || key.length === 0 ? {} : { apiKey: key }),
    })
      .then((result) => {
        applyDiscovery(result)
      })
      .catch((cause: unknown) => {
        setDiscovery({
          kind: 'failed',
          message: explainVerifyFailure(errorDetail(cause)),
        })
      })
  }

  // 首次添加自动问一次：预设里的推荐模型常常早就过期了，而"手打精确的 model id"
  // 正是加供应商这一步最容易卡住的地方。只在打开表单那一刻问，之后由按钮触发。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只想在打开表单时跑一次，输入变化不该触发网络请求
  useEffect(() => {
    if (provider !== undefined || api.discoverProvider === undefined) return
    if (baseUrl.trim().length === 0) return
    runDiscovery()
  }, [provider, api])

  /** 勾中的模型插到模型列表末尾：已存在的按原样留在原位（用户手打的顺序不动）。 */
  const insertPicked = (): void => {
    if (discovery.kind !== 'loaded') return
    const current: CatalogModel[] = parseModels(modelsText).map((id) => {
      return { id, source: 'preset' }
    })
    const chosen = discovery.models.filter((model) => {
      return picked.has(model.id)
    })
    setModelsText(
      mergeDiscovered(current, chosen)
        .map((model) => {
          return model.id
        })
        .join('\n'),
    )
  }

  /** 两种模式共用的尾巴：成功收起弹窗，失败把原因就地显示（输入一律原样保留）。 */
  const runSave = (request: Promise<unknown>, success: (value: unknown) => void, unsupportedText: string): void => {
    setBusy(true)
    setError(undefined)
    request
      .then((value) => {
        success(value)
      })
      .catch((cause: unknown) => {
        setError(explainApiError(cause, unsupportedText).message)
      })
      .finally(() => {
        setBusy(false)
      })
  }

  /**
   * 本轮填的上下文长度 → 随模型列表一起发出去（新增与编辑共用一条通路）。
   *
   * `previous` 是服务端现在存着的那一份，只在"写法看不懂"时兜底：手滑打出的半个字
   * 不该把之前填对的数字抹掉，而空串才是"我改主意了，不要这条"（见
   * {@link providerModelPayload}）。
   */
  const modelPayload = (): ProviderModelEntry[] => {
    return providerModelPayload(parseModels(modelsText), windows, catalogFromProvider(provider))
  }

  const save = (): void => {
    const models = modelPayload()
    const wantedProtocol = protocol.trim().length > 0 ? protocol.trim() : 'openai'
    if (provider === undefined) {
      if (api.createProvider === undefined) return
      const input: CreateProviderForm = {
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
        <Icon name="chevron-left" size={16} />
        {editing ? '取消编辑' : '重选供应商'}
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
        <div className="field">
          <span>协议</span>
          {/* 下拉而不是文本框：协议是有限集合（服务端 ProviderProtocol 只有两个值），
              让用户手敲 `openai` 拼错成 `Openai` 时，错误要到保存之后、
              真正发请求失败时才暴露出来。展示名走 protocolLabel，不给用户看标识。 */}
          <Select
            value={protocol}
            options={PROTOCOL_OPTIONS}
            ariaLabel="协议"
            onChange={(next) => {
              setProtocol(next)
            }}
          />
        </div>
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
        <span>模型列表</span>
        <textarea
          rows={5}
          value={modelsText}
          placeholder="deepseek-ai/DeepSeek-V4-Flash&#10;gpt-oss-120b"
          // 失焦时整理成一行一个：用户写的时候可以用空格、逗号、换行，也可以整段粘贴，
          // 不必先去挑分隔符；整理只发生在他离开这个框之后，不打断正在输入的人。
          onBlur={() => {
            setModelsText(formatModels(parseModels(modelsText)))
          }}
          onChange={(event) => {
            setModelsText(event.target.value)
          }}
        />
      </label>
      <ContextWindowEditor
        models={parseModels(modelsText)}
        windows={windows}
        onChange={(modelId, raw) => {
          setWindows((prev) => {
            return { ...prev, [modelId]: raw }
          })
        }}
      />
      <ModelDiscoveryPanel
        state={discovery}
        picked={picked}
        supported={canDiscover}
        onReload={() => {
          runDiscovery()
        }}
        onToggle={(modelId, checked) => {
          setPicked((prev) => {
            const next = new Set(prev)
            if (checked) next.add(modelId)
            else next.delete(modelId)
            return next
          })
        }}
        onToggleAll={(checked) => {
          setPicked(
            checked && discovery.kind === 'loaded'
              ? new Set(
                  discovery.models.map((model) => {
                    return model.id
                  }),
                )
              : new Set<string>(),
          )
        }}
        onInsert={insertPicked}
      />
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
            <Icon name="arrow-up-right" size={16} /> 去官网申请 API Key
          </a>
        </p>
      )}
      {removalHint !== undefined && <p className="provider-note provider-warn">{removalHint}</p>}
      <p className="provider-note">
        {editing
          ? '空格、逗号或换行都行，离开这一栏会自动排成一行一个；要换 Key 请回到这一行用「更换 Key」。'
          : '空格、逗号或换行都行，离开这一栏会自动排成一行一个；不知道 id 就点上面的「从供应商拉取模型」，保存后还能逐个补 key。'}
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
  if (isKeylessProtocol(preset.protocol)) return `${protocolLabel(preset.protocol)} · 免 key`
  return `${protocolLabel(preset.protocol)} · ${preset.models.length} 个模型`
}

/** 添加向导：第一步预设网格（含「自定义」），第二步表单。 */
function AddProviderModal({
  api,
  providers,
  onClose,
  onAdded,
  initialPreset,
}: {
  api: ProviderApi
  /** 已有供应商：用来把配过的预设标成「已添加」，而不是让用户再点一次生成重复项。 */
  providers: ProviderInfo[]
  onClose: () => void
  onAdded: () => void
  /** 打开时直接落在某一家上（用户刚在「先挑一家」的网格里点过它）。 */
  initialPreset?: ProviderPreset
}) {
  const [presets, setPresets] = useState<ProviderPreset[] | undefined>(undefined)
  const [loadFailed, setLoadFailed] = useState(false)
  const [selected, setSelected] = useState<ProviderPreset | 'custom' | undefined>(initialPreset)

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
  /** 供应商预设目录：一张网格让用户**自己挑一家**，而不是默认点名某一家。 */
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  /** 用户在网格里点过的那家：已存在就展开它，不存在就打开添加向导（预选）。 */
  const [pickedPreset, setPickedPreset] = useState<ProviderPreset | undefined>(undefined)
  /** 需要初始展开的条目（用户刚点过的那家）。 */
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    if (api.providerPresets === undefined) return
    api
      .providerPresets()
      .then(({ presets: list }) => {
        // 后端没给 presets 字段（老服务端 / 替身）时别把 state 设成 undefined——
        // 下一行 presets.length 会直接崩，整个设置页跟着白屏。
        if (!cancelled) setPresets(list ?? [])
      })
      .catch(() => {
        // 读不到预设就当没有：设置页照常有列表，不因为这个接口挂了就整个不能用。
      })
    return () => {
      cancelled = true
    }
  }, [api])

  const builtin = providers.filter((provider) => {
    return provider.custom !== true
  })
  const custom = providers.filter((provider) => {
    return provider.custom === true
  })
  /** 一家能用的都没有：先把「挑一家」摆在最前面，别让他面对一个默认选项。 */
  const configured = providers.filter((provider) => {
    return provider.apiKeyConfigured || isLocalService(provider)
  })
  const needPick = configured.length === 0 && presets.length > 0
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
            // 从这个按钮进来就回到「选哪一家」那一步，别带着上一次挑过的那家进来。
            setPickedPreset(undefined)
            setAdding(true)
          }}
        >
          <Icon name="plus" size={16} /> 添加供应商
        </button>
      </div>
      {needPick && (
        <section className="provider-picker">
          <p className="provider-note">先挑一家：哪家都行，之后在下面随时能换。key 只存在这台机器上。</p>
          <div className="provider-picker-grid">
            {presets.map((preset) => {
              // 已经建过路由的那家（内置的 SiliconFlow）直接展开它填 key，
              // 不要再走一遍添加向导——那会多出一条同地址的重复路由。
              const installed = providers.find((provider) => {
                return provider.id === preset.id
              })
              return (
                <button
                  key={preset.id}
                  type="button"
                  className="provider-pick-tile"
                  onClick={() => {
                    setPickedPreset(preset)
                    if (installed === undefined) {
                      setAdding(true)
                      return
                    }
                    setOpenIds((prev) => {
                      return new Set([...prev, installed.id])
                    })
                  }}
                >
                  <ProviderIcon id={preset.id} name={preset.displayName} size={36} />
                  <span className="provider-preset-name">{preset.displayName}</span>
                  <span className="provider-preset-sub">
                    {installed === undefined ? presetSummary(preset) : '已添加 · 点这里填 key'}
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      )}
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
            initiallyOpenIds={openIds}
          />
          <ProviderGroup
            label="自定义供应商"
            providers={custom}
            api={api}
            onChanged={onChanged}
            onDelete={setDeleting}
            onEdit={setEditing}
            initiallyOpenIds={openIds}
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
            setPickedPreset(undefined)
          }}
          onAdded={() => {
            setAdding(false)
            setPickedPreset(undefined)
            onChanged()
          }}
          initialPreset={pickedPreset}
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
              // 自己 toast 而不是把异常抛给 ConfirmDialog：那里给的是一句中性兜底，
              // 说不出"这家还有 agent 在用"这种只有这里知道的事。
              const raw = errorDetail(cause) ?? ''
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
            forgetProviderHealth(deleting.id)
            onChanged()
            toast.success(`「${deleting.displayName}」已删除`)
          }}
        />
      )}
    </>
  )
}
