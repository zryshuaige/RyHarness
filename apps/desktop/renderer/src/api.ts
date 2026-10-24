/**
 * 渲染层 API 客户端：REST + WS，契约对齐 apps/server/README。
 * API 地址从窗口 URL query（?api=...，主进程注入）读取。
 */

import type { PlaybookEntry, ReflectionRow } from '@ryharness/evolve'
import type { PublicMemoryRow } from '@ryharness/memory'
import type {
  AgentTemplate,
  ConversationState,
  ConversationUsageRow,
  MemoryRecall,
  PluginView,
  ProviderAgentUsage,
  ProviderPreset,
  ProviderUsageRow,
  StampedWsEvent,
  TelemetrySnapshot,
  TodoGroup,
  TodoItem,
  TurnTiming,
  UsageReport,
  UserProfile,
  VibeOutputView,
  VibeProjectView,
  VibeQuestionView,
  VibeSessionView,
  VibeSquadMemberView,
  WsEvent,
} from '@ryharness/server'
/**
 * 其余真源包：会话/人格/消息行在 @ryharness/session，经验手册在 @ryharness/evolve，
 * 记忆的对外投影在 @ryharness/memory——同样是纯类型导入，转译期整条擦除，不会把
 * node:sqlite 之类的服务端依赖拖进渲染层 bundle（lib/persona.ts 对**值**导入的顾虑
 * 不适用于 `import type`）。
 */
/** 局部别名绑定：MessageUsageRow 要用 TurnUsage 这个名字；纯 re-export 不进局部作用域。 */
import type {
  AgentPersona,
  Conversation as ServerConversation,
  StoredAgent,
  StoredMessage,
  StoredUsage as TurnUsage,
  UsageTotals,
} from '@ryharness/session'
/**
 * discover 的回执类型借 lib/provider-health.ts 那一份，而不是在这里另抄：同一个
 * 契约两处各写一遍，服务端加字段时渲染层就会出现「两处形状不同」的静默分叉。
 * 类型导入在转译期整条擦除，provider-health.ts 不会因此被打进渲染层 bundle。
 */
import { humanError } from './lib/error-text.ts'
import type { ProviderDiscoveryResponse } from './lib/provider-health.ts'

/**
 * ApiRequestError 的兜底句：只有这一层才知道"调用点在做什么"，所以它给不出更贴切
 * 的话（调用点自己会给一句，见 lib/error-text.ts 的 humanError）。这一句存在的意义
 * 是**不让英文原话回到界面**——哪怕调用点忘了包装，冒出来的也还是一句中文。
 */
const REST_HINT = '这次操作没能完成，再试一次。'

/**
 * 契约单一真源：WS 事件与用量账单的形状只在服务端定义（apps/server 的 events.ts /
 * routes/usage.ts），渲染层做**纯类型**导入，不再整段手抄。StampedWsEvent 是服务端
 * 为每条事件附的每会话单调递增 seq（客户端据此检测断线期间的缺口）。
 *
 * 手抄的代价是静默的：服务端改一个字段名，渲染层 tsc 全绿，只在运行时读到
 * undefined。纯类型导入在 Vite/esbuild 转译期被整条擦除，服务端代码不会因此
 * 被打进渲染层 bundle（renderer/vite.config.ts 无需加 alias）。
 */
export type {
  AgentTemplate,
  ConversationUsageRow,
  MemoryRecall,
  PluginView,
  ProviderAgentUsage,
  ProviderPreset,
  ProviderUsageRow,
  StampedWsEvent,
  TelemetrySnapshot,
  TodoGroup,
  TodoItem,
  TurnTiming,
  UsageReport,
  VibeOutputView,
  VibeProjectView,
  VibeQuestionView,
  VibeSessionView,
  VibeSquadMemberView,
  WsEvent,
}

// ---- 服务端形状 ----
//
// 本节的规则：服务端（或其包）已把形状定义成**导出类型**的，一律改为纯类型导入并
// 在此换名重导出（对外导出名不变）；形状只写在路由处理函数里的（内联返回体 /
// 模块私有接口），保留手抄并在各类型头上注明出处与原因。

/** 单轮 token 用量。真源：@ryharness/session 的 StoredUsage（消息行 usage 列的归一形态）。 */
export type { StoredUsage as TurnUsage } from '@ryharness/session'
/** 人格四维 + 生日/口头禅/形象/音色/亲密度。真源：@ryharness/session 的 persona.ts。 */
/** 会话级累计用量。真源：@ryharness/session 的 UsageTotals（store.conversationUsage 的返回）。 */
export type { AgentPersona, UsageTotals }

/** 长期记忆行。真源：@ryharness/memory 的 PublicMemoryRow（路由出包一律过 toPublicMemories 投影）。 */
export type MemoryRow = PublicMemoryRow

/** 经验手册条目。真源：@ryharness/evolve 的 PlaybookEntry（GET /api/agents/:id/playbook 原样下发）。 */
export type PlaybookEntryRow = PlaybookEntry

/**
 * 待验证的反思教训。真源：@ryharness/evolve 的 ReflectionRow——渲染层此前只抄了
 * 五个字段，真源还有 contextDigest / status / updatedAt（多余字段按需再读，不影响）。
 */
export type { ReflectionRow }

/**
 * Agent 定义的读模型，真源：@ryharness/session 的 StoredAgent（GET /api/agents 的
 * 返回形状）。真源里 persona 读出来必带（存储层对旧行按默认值补齐）、createdAt /
 * updatedAt 恒在；渲染层仍把 persona 按可缺省处理（旧服务端与测试替身不全带），
 * 时间戳不在读模型里（RightPanel 要用时另走 `as` 局部收窄），故这三项不透传。
 */
export type AgentDef = Omit<StoredAgent, 'persona' | 'createdAt' | 'updatedAt'> & {
  /** 人格；缺省（旧服务端/测试替身）时按默认人格渲染。 */
  persona?: AgentPersona
}

/**
 * 产物预览的元数据（GET /api/files/:name/info）。
 *
 * 手抄原因：形状是 apps/server/src/routes/conversations.ts 的 statArtifact 返回的
 * 模块私有接口 PreviewFile（未导出），没有可 import 的真源；字段以那条路由为准。
 */
export interface ArtifactInfo {
  name: string
  /** 工作区内的绝对路径：「用系统程序打开 / 复制路径」两个动作的唯一原料。 */
  path: string
  size: number
  mime: string
}

/**
 * GET /api/providers 的行。
 *
 * 手抄原因：形状是 apps/server/src/routes/providers.ts 的 providerInfo 的**内联返回
 * 类型**（未命名、未导出），且它声明的返回类型漏列了 reasoningEfforts（运行时按
 * 路由的 reasoningControl 条件带上）——没有可 import 的完整真源。渲染层按「有才
 * 展示」的容错读模型声明可选字段；服务端实际恒回 protocol/baseUrl/custom/usedBy。
 */
export interface ProviderInfo {
  id: string
  displayName: string
  apiKeyConfigured: boolean
  models: { id: string; name?: string; contextWindow?: number }[]
  /** 用户手动添加的供应商（可删除）；缺省视为内置。 */
  custom?: boolean
  /** 接入协议（openai / ollama），徽标展示用。 */
  protocol?: string
  baseUrl?: string
  /**
   * 这条路由支持哪些思考强度档位（`low` / `medium` / `high`）。
   *
   * 缺省或空数组 = 该路由不认思考参数，UI 就不给选择器——给一个选了会被端点
   * 静默忽略的控件，比没有更糟。
   */
  reasoningEfforts?: string[]
  /** 正在使用它的 agent：删除前要先把它们改绑（缺省 = 没人用）。 */
  usedBy?: { agentId: string; agentName: string }[]
}

/**
 * 测连接的结果（POST /api/providers/:id/verify）。
 *
 * 手抄原因：服务端的探测结论 VerifyOutcome 是 routes/providers.ts 的模块私有接口，
 * 回包实际还带 code（机器可读分类）与 discovered（顺带发现的模型目录）——渲染层
 * 只读 ok/message/latencyMs 三项，按子集声明；要读 code/discovered 时再补。
 */
export interface ProviderVerifyResult {
  ok: boolean
  /** ok=false 时的原因；服务端给什么就显示什么（渲染层另有中文归类）。 */
  message: string
  latencyMs: number
}

/**
 * DELETE /api/settings/api-key/:id 的响应体（见 ApiClient.deleteApiKey）。
 *
 * 手抄原因：形状是 routes/settings.ts 那条路由的内联字面量 `{providerId, configured:
 * false}`，没有命名真源。
 */
export interface DeletedApiKeyResult {
  providerId: string
  configured: boolean
}

/**
 * 全文搜索命中的一行（GET /api/search）。
 *
 * 手抄原因：真源是 routes/conversations.ts 的 SearchResult 接口（未导出），字段与其
 * 逐一对齐；服务端加字段时以那边为准。
 */
export interface SearchResultRow {
  conversationId: string
  conversationTitle: string
  messageId: string
  /** 命中片段（服务端已按关键词截断）。 */
  snippet: string
  agentId: string
  createdAt: number
}

/**
 * 会话可改的元信息（PATCH /api/conversations/:id 的入参）。
 *
 * 真源：@ryharness/server 的 ConversationState——服务端 PATCH 的 patchable 白名单就
 * 是 title/pinned/muted/memberAgentIds（见 routes/conversations.ts），白名单外的键
 * 一律被忽略；群调度员**不在其中**（新建群时可指定，改群时不落），要改调度员的
 * 调用方见 {@link ApiClient.patchGroup} 的说明。
 */
export type { ConversationState as ConversationPatch }

/**
 * 新增自定义供应商（POST /api/providers）。
 *
 * 手抄原因：服务端校验后的入参类型 NewProviderInput 是 routes/providers.ts 的模块
 * 私有接口（models 是 `ProviderModelInput[]`，即裸 id 或带 contextWindow 的对象）；
 * 渲染层表单实际按 ProviderSettings 的 Form 类型放宽流转，这里保持表单侧的宽模型。
 */
export interface CreateProviderInput {
  displayName: string
  protocol: string
  baseUrl: string
  models: string[]
  apiKey?: string
  presetId?: string
}

/**
 * 改供应商（PATCH /api/providers/:id）。
 *
 * 手抄原因：真源是 routes/providers.ts 的 ProviderPatchInput（字段全部**可选**、
 * models 为 ProviderModelInput[]）；渲染层编辑表单恒发全量四字段且 protocol 以宽
 * string 流转，收敛到真源要连带动表单状态类型，此处保持现状并注明差异。
 *
 * 凭据与 custom/presetId **不在白名单里**：前两个是归属标记（改了就等于伪造一条
 * 新的），凭据另有 settings 路由管。服务端对同名 baseUrl 与「删掉仍被 agent 引用
 * 的模型」回 409。
 */
export interface UpdateProviderInput {
  displayName: string
  protocol: string
  baseUrl: string
  models: string[]
}

/**
 * 一个会话。基底真源：@ryharness/session 的 Conversation（存储行）；列表接口在基底
 * 上再叠 lastMessagePreview/unreadCount，界面态视图恒补 pinned/muted，而 POST 建会
 * 话的回包是裸存储行——所以这三组都按可缺省声明。proactive 标记由组件层的
 * ConversationRow 叠加（见 ConversationList/WelcomeHome），不进这份类型。
 */
export type Conversation = ServerConversation & {
  /** 最近一条消息的预览（GET /api/conversations 的列表行才有）。 */
  lastMessagePreview?: string
  unreadCount?: number
  /** 置顶：会话列表里排在最前；缺省 = 没置顶。 */
  pinned?: boolean
  /** 静音：不弹未读；缺省 = 没静音。 */
  muted?: boolean
}

/**
 * 一条历史消息。基底真源：@ryharness/session 的 StoredMessage（GET messages 原样
 * 下发，自带 usage?/artifacts?）。唯一的偏差是 contentBlocks：存储层按 unknown[]
 * 存（不假设块形状），这里声明的是渲染层实际读的 `type`/`text` 读模型——其余块
 * 字段（如 tool-call 的 id/arguments）由读取点就地收窄（见 ChatView 的
 * toolArgumentsOf）。
 */
export type MessageRow = Omit<StoredMessage, 'contentBlocks'> & {
  contentBlocks: { type: string; text?: string }[]
}

/**
 * 记忆系统统计（/api/memory/stats）。
 *
 * 手抄原因：回包是路由把「enabled 分支 + memory store.stats()（内联返回类型）」
 * 就地拼出来的复合体，服务端没有为它定义过导出类型；字段按 routes/memory.ts 的
 * 两条 json() 分支核对（关闭时只有 enabled/recentLearned/consolidation）。
 */
export interface MemoryStats {
  enabled: boolean
  embeddings?: { label: string }
  /** 近 24 小时新增的 active 记忆数。 */
  recentLearned: number
  /** 巩固调度：intervalMs = 0 表示没开；lastRunAt 缺省表示本次运行还没巩固过。 */
  consolidation: { intervalMs: number; lastRunAt?: number }
  total?: number
  bySpace?: Record<string, number>
  byKind?: Record<string, number>
  byStatus?: Record<string, number>
}

/**
 * 本机用户的资料。`avatar` 是头像风格 key，空串表示还没挑过。
 *
 * 真源：@ryharness/server 的 routes/profile.ts——它同时被界面与内核读（服务端把它
 * 拼成系统提示里的身份句），渲染层拿一份是为了显示，不允许自己存第二份。
 */
export type { UserProfile }

/** WS 连接状态（断线重连提示用）。 */
export type WsConnectionStatus = 'open' | 'reconnecting'

export interface SubscribeOptions {
  /** 连接状态变化（断线 → reconnecting，恢复 → open）。 */
  onStatus?: (status: WsConnectionStatus) => void
  /** 检测到事件 seq 缺口或断线重连成功：调用方应重拉历史补齐。 */
  onGap?: () => void
  /** 重连退避序列（ms），超过末尾值后循环使用末值；默认 1s/2s/5s/10s 封顶。 */
  reconnectDelays?: number[]
  /**
   * 缺口检测基线：握手前已确认收到的最后一个事件 seq。缺省时退化为
   * 「本次发送消息的回执 seq」（见 postMessage），再缺省才是完全失明——
   * 那正是欢迎页首条消息丢在订阅建立之前的形态。
   */
  fromSeq?: number
}

// ---- 客户端 ----

/** 浏览器直连开发时的默认后端地址（生产由主进程经 ?api= 或启动事件注入）。 */
export const DEFAULT_API_BASE = 'http://127.0.0.1:32100'

/** 从窗口 URL 读主进程注入的 API 地址（?api=…）；没有则返回 undefined。 */
export function readApiBaseFromLocation(): string | undefined {
  const fromQuery = new URLSearchParams(window.location.search).get('api')
  return fromQuery !== null && fromQuery.length > 0 ? fromQuery : undefined
}

/** 解析 API 地址：query 优先，否则回退本机默认端口（同步场景用）。 */
export function resolveApiBase(): string {
  return readApiBaseFromLocation() ?? DEFAULT_API_BASE
}

// ---- 本次启动的 API token（主进程生成，渲染层每个请求都要带上） ----
//
// 后端强制校验：Electron 启动时主进程生成一个随机 token 交给 RyHarnessServer，
// 服务端对每个 HTTP 请求与 WS upgrade 都比对一次（缺 token 一律 401）。所以这不是
// 「带上更安全」，而是**不带就整个应用不可用**：渲染层拿不到会话列表、连不上 WS。
//
// 取值三条路，与 boot.ts 里 API 地址的三条路一一对应：URL query（?token=，
// 主进程已就绪）、窗口全局变量 __RYHARNESS_API_TOKEN__、ryharness:api-token 事件
// （窗口先行、后端并行启动时事件晚于监听注册）。
const API_TOKEN_EVENT = 'ryharness:api-token'
const API_TOKEN_GLOBAL = '__RYHARNESS_API_TOKEN__'

/** 当前 token（空串 = 本次启动未启用鉴权，浏览器直连开发即是）。 */
let apiToken = ''
const tokenListeners = new Set<(token: string) => void>()

/** 从窗口 URL query 读主进程注入的 token（?token=…）；没有则返回 undefined。 */
export function readApiTokenFromLocation(): string | undefined {
  const fromQuery = new URLSearchParams(window.location.search).get('token')
  return fromQuery !== null && fromQuery.length > 0 ? fromQuery : undefined
}

/** 当前生效的 token；请求与 WS 建链时现读（token 可能晚于客户端构造才到）。 */
export function currentApiToken(): string {
  return apiToken
}

/** 记下 token 并通知在听的客户端。空串表示「本次启动不鉴权」。 */
export function setApiToken(token: string): void {
  apiToken = token
  for (const listener of tokenListeners) listener(token)
}

/** 订阅 token 变化（组件据此在 token 到位后重试此前 401 的动作）。 */
export function onApiToken(listener: (token: string) => void): () => void {
  tokenListeners.add(listener)
  return () => {
    tokenListeners.delete(listener)
  }
}

function globalApiToken(): string | undefined {
  const value = (window as unknown as Record<string, unknown>)[API_TOKEN_GLOBAL]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 接上主进程的 token 下发通道。渲染层入口调一次即可（幂等）。
 *
 * 三条取值路按「越确定越优先」排：query（主进程加载 URL 时就带上了）> 事件
 * （窗口先行、后端并行启动）> 全局变量（事件早于监听注册时的兜底）。
 * 先扫一遍 query 与全局变量再挂监听——事件可能在监听注册之前就派发过了。
 */
let tokenSyncStarted = false
export function startApiTokenSync(): void {
  const fromQuery = readApiTokenFromLocation()
  if (fromQuery !== undefined) setApiToken(fromQuery)
  if (!tokenSyncStarted) {
    tokenSyncStarted = true
    window.addEventListener(API_TOKEN_EVENT, (event) => {
      const detail = (event as CustomEvent<unknown>).detail
      if (typeof detail !== 'string') return
      setApiToken(detail)
    })
  }
  const global = globalApiToken()
  if (global !== undefined) setApiToken(global)
}

/**
 * REST 失败：保留 HTTP 状态与机器码，message 说的是人话。
 *
 * 界面有些降级是按状态分支的（待办插件关闭后 `/api/todos` 回 404，侧栏据此显示
 * 「插件已关闭」而不是报错），只留一句 message 的话调用方只能去解析中文——所以
 * `status` 与 `code` 一个都不能少。
 *
 * message 与 raw 是同一件事的两副面孔：`message` 是给用户看的那一句（过去这里直接
 * 摆的是服务端 `{error}` 的英文原话，于是聊天区红条说着「这条消息没发出去」，三步
 * 之后一个 toast 蹦出 `conversation not found`），`raw` 是服务端原文，交给折叠的
 * 「详情」——AsyncState / HistoryFailure 那套既有 affordance 要的就是它。
 */
export class ApiRequestError extends Error {
  /** 服务端 `{error}` 的原话；没有 body 时是 `HTTP <status>`。折叠详情里给的就是它。 */
  readonly raw: string

  constructor(
    raw: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(humanError(raw, REST_HINT))
    this.raw = raw
    this.name = 'ApiRequestError'
  }
}

export class ApiClient {
  constructor(readonly base: string) {}

  /**
   * 已发出消息的会话基线：POST 回执里的 streamSeq（见 postMessage）。
   * 只被下一次 subscribe 取用一次就丢弃，避免过期基线在下次进会话时误报缺口。
   */
  private readonly pendingBaselines = new Map<string, number>()

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      ...init,
      // token 现读而非构造时取：窗口先于后端起来时，客户端早于 token 到达就建好了。
      headers: {
        'content-type': 'application/json',
        ...(apiToken.length === 0 ? {} : { authorization: `Bearer ${apiToken}` }),
        ...init?.headers,
      },
    })
    const body = (await response.json().catch(() => {
      return {}
    })) as T & { error?: string; code?: string }
    if (!response.ok) {
      throw new ApiRequestError(body.error ?? `HTTP ${response.status}`, response.status, body.code)
    }
    return body
  }

  listAgents(): Promise<{ agents: AgentDef[] }> {
    return this.request('/api/agents')
  }

  createAgent(input: Record<string, unknown>): Promise<{ agent: AgentDef }> {
    return this.request('/api/agents', { method: 'POST', body: JSON.stringify(input) })
  }

  patchAgent(id: string, patch: Record<string, unknown>): Promise<{ agent: AgentDef }> {
    return this.request(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
  }

  deleteAgent(id: string): Promise<{ deleted: string }> {
    return this.request(`/api/agents/${id}`, { method: 'DELETE' })
  }

  /** 本机用户的资料（在「我的」页可改）。服务端是唯一真源，界面不另存一份。 */
  profile(): Promise<{ profile: UserProfile }> {
    return this.request('/api/profile')
  }

  /** 改资料。只带要改的字段，没带的保持原样。 */
  saveProfile(patch: Partial<UserProfile>): Promise<{ profile: UserProfile }> {
    return this.request('/api/profile', { method: 'PATCH', body: JSON.stringify(patch) })
  }

  deleteConversation(id: string): Promise<{ deleted: string }> {
    return this.request(`/api/conversations/${id}`, { method: 'DELETE' })
  }

  /**
   * 撤销删除：把软删的会话放回列表。
   *
   * 删除是**软删**（服务端只打标记，消息还在库里），所以撤销就是把标记清掉。
   */
  restoreConversation(id: string): Promise<{ conversation?: Conversation }> {
    return this.request(`/api/conversations/${id}/restore`, { method: 'POST', body: '{}' })
  }

  /** 中止该会话在途的一轮生成。 */
  cancelTurn(conversationId: string): Promise<{ cancelled: boolean }> {
    return this.request(`/api/conversations/${conversationId}/cancel`, { method: 'POST' })
  }

  /**
   * 工具执行审批的决议（shell_exec 这类命令等的就是它）。
   * 404 = 这张卡已被超时/取消收口，渲染层按 approval-resolved 事件撤卡即可。
   */
  decideApproval(
    conversationId: string,
    approvalId: string,
    decision: 'allow' | 'deny',
    remember = false,
  ): Promise<{ approvalId: string; decision: 'allow' | 'deny' }> {
    return this.request(`/api/conversations/${conversationId}/approvals/${approvalId}`, {
      method: 'POST',
      body: JSON.stringify({ decision, remember }),
    })
  }

  /** 应用内保存 API key（后端写 0600 文件，不回显明文）。 */
  setApiKey(providerId: string, apiKey: string): Promise<{ providerId: string; configured: boolean }> {
    return this.request('/api/settings/api-key', {
      method: 'POST',
      body: JSON.stringify({ providerId, apiKey }),
    })
  }

  /**
   * 移除已存的凭据（换 Key 前先清除、或彻底不用这家了）。
   *
   * 响应体只有两个字段：`{ providerId, configured: false }`——服务端没有别处那些
   * `{ deleted }` 回执，「已经删掉」这件事就是 configured 翻回 false，调用方据此
   * 重拉供应商清单。
   */
  deleteApiKey(providerId: string): Promise<DeletedApiKeyResult> {
    return this.request(`/api/settings/api-key/${encodeURIComponent(providerId)}`, { method: 'DELETE' })
  }

  /** 测连接：真正打一次供应商，拿到是否通过与往返延迟。 */
  verifyProvider(providerId: string): Promise<ProviderVerifyResult> {
    return this.request(`/api/providers/${encodeURIComponent(providerId)}/verify`, { method: 'POST' })
  }

  templates(): Promise<{ templates: AgentTemplate[] }> {
    return this.request('/api/agent-templates')
  }

  providers(): Promise<{ providers: ProviderInfo[] }> {
    return this.request('/api/providers')
  }

  /** 插件清单（服务端运行时的真实状态；渲染层不在本地维护插件表）。 */
  plugins(): Promise<{ plugins: PluginView[] }> {
    return this.request('/api/plugins')
  }

  /**
   * 开一次 RyVibe：一句话进，小队开始盘问。
   *
   * 服务端会建一个群会话并把它挂上「grill me」方法与盘问工具；页面靠
   * {@link vibe} 轮询进度，不订阅 WS。
   */
  startVibe(requirement: string): Promise<{ session: VibeSessionView }> {
    return this.request('/api/vibe', { method: 'POST', body: JSON.stringify({ requirement }) })
  }

  /** RyVibe 的当前状态：问到哪、还差几个答案、方案出来没有。`after` 之后的新产出才回传。 */
  vibe(
    id: string,
    after?: number,
  ): Promise<{
    session: VibeSessionView
    questions: VibeQuestionView[]
    output: VibeOutputView[]
    /** 落盘时写进待办的任务清单。 */
    todos: TodoItem[]
  }> {
    const query = after === undefined ? '' : `?after=${after}`
    return this.request(`/api/vibe/${encodeURIComponent(id)}${query}`)
  }

  /**
   * 读项目骨架里的一个文件。
   *
   * 只认服务端记下的那份文件清单：目录名与文件名都来自模型，这条路不能变成
   * 任意文件读取的口子。
   */
  vibeProjectFile(id: string, name: string): Promise<{ name: string; size: number; content: string }> {
    return this.request(`/api/vibe/${encodeURIComponent(id)}/file?name=${encodeURIComponent(name)}`)
  }

  /**
   * 回答这张盘问卡：一次交上全部答案。
   *
   * `skipped` = 用户点了「按你们的默认方案来」——答案照旧是预选项，只是给小队
   * 的话术不同。
   */
  answerVibe(
    id: string,
    input: { answers: { questionId: string; selected: string[] }[]; skipped?: boolean },
  ): Promise<{ session: VibeSessionView }> {
    return this.request(`/api/vibe/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  /** 最近几次 RyVibe（页面上的「回到上次」）。 */
  vibeSessions(): Promise<{ sessions: VibeSessionView[] }> {
    return this.request('/api/vibe')
  }

  /** 失败后重来一次：把这一轮重新排一遍。 */
  retryVibe(id: string): Promise<{ session: VibeSessionView }> {
    return this.request(`/api/vibe/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' })
  }

  /**
   * 开关插件：服务端会真实卸载/重挂该插件，不是只写配置。
   * 回包是该插件切换后的视图，调用方直接替换列表项即可。
   */
  setPluginEnabled(id: string, enabled: boolean): Promise<{ plugin: PluginView }> {
    return this.request(`/api/plugins/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    })
  }

  /**
   * 当前会话的待办清单（`todo` 插件的路由）。
   *
   * 声明成「函数或 undefined」而不是普通方法：待办由插件提供，旧版服务端或组件
   * 测试的最小替身没有这组接口时，右栏据 `=== undefined` 整块跳过，而不是在
   * 运行时对着一个不存在的函数调用。
   */
  listTodos: ((conversationId: string) => Promise<TodoGroup>) | undefined = (conversationId) => {
    return this.request(`/api/todos?conversationId=${encodeURIComponent(conversationId)}`)
  }
  setTodoDone: ((conversationId: string, id: string, done: boolean) => Promise<TodoGroup>) | undefined = (
    conversationId,
    id,
    done,
  ) => {
    return this.request(`/api/todos/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ conversationId, done }),
    })
  }
  clearTodos: ((conversationId: string) => Promise<TodoGroup>) | undefined = (conversationId) => {
    return this.request(`/api/todos?conversationId=${encodeURIComponent(conversationId)}`, { method: 'DELETE' })
  }

  /**
   * 撤销清空：把被清掉的那批待办原样写回（id 与勾选状态都不变）。
   *
   * 服务端未实现该路由时回 404 + { error: 'not found: POST /api/todos/restore' }。
   */
  restoreTodos: ((conversationId: string, items: TodoItem[]) => Promise<TodoGroup>) | undefined = (
    conversationId,
    items,
  ) => {
    return this.request('/api/todos/restore', {
      method: 'POST',
      body: JSON.stringify({ conversationId, items }),
    })
  }

  /**
   * 供应商预设（添加供应商向导的可选项）。
   * 服务端未实现该路由时回 404 + { error: 'not found: GET /api/provider-presets' }，
   * 调用方据此降级（向导只剩「自定义」一格）。
   */
  providerPresets(): Promise<{ presets: ProviderPreset[] }> {
    return this.request('/api/provider-presets')
  }

  /** 新增自定义供应商；服务端未实现时同 providerPresets 走 404 分支。 */
  createProvider(input: CreateProviderInput): Promise<{ provider: ProviderInfo }> {
    return this.request('/api/providers', { method: 'POST', body: JSON.stringify(input) })
  }

  /**
   * 向一份**还没保存**的供应商草稿问模型目录（POST /api/providers/discover）。
   *
   * 请求里的 Key 是一次性的：服务端只拿它打那一次模型列表端点，不落盘、不回显、
   * 不注册路由——所以用户可以先问再决定要不要存这家。
   *
   * 与 verify 一样永远回 200 + 中文结论：连不上、看不成目录都看 `ok` 与 `message`，
   * 不是等 catch（只有入参非法才会 400）。
   */
  discoverProvider(input: { baseUrl: string; protocol: string; apiKey?: string }): Promise<ProviderDiscoveryResponse> {
    return this.request('/api/providers/discover', { method: 'POST', body: JSON.stringify(input) })
  }

  /** 删除自定义供应商（内置供应商后端会拒绝）；未实现时 404。 */
  deleteProvider(id: string): Promise<{ deleted: string }> {
    return this.request(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  /**
   * 改供应商：名称 / 协议 / Base URL / 模型列表，改完热注册，不用重启。
   *
   * 回包里的 provider 是服务端重算的真值（含新的 usedBy），调用方据此重拉清单。
   * 409 有两种：baseUrl 撞上另一条路由，或删掉的模型仍被某个 agent 引用——都带着
   * 中文说明直接弹给用户即可。
   */
  updateProvider(id: string, patch: UpdateProviderInput): Promise<{ provider: ProviderInfo }> {
    return this.request(`/api/providers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
  }

  /** 改会话元信息（重命名 / 置顶 / 静音）。 */
  patchConversation(conversationId: string, patch: ConversationState): Promise<{ conversation: Conversation }> {
    return this.request(`/api/conversations/${conversationId}`, { method: 'PATCH', body: JSON.stringify(patch) })
  }

  /**
   * 编辑并重发：改写一条用户消息的正文，删掉它之后的一切，用新正文重跑这一轮。
   *
   * 库里那条用户消息是**原地改写**的（seq 不变），因此界面重拉历史后"我说的
   * 那句话"还是那句话，只是内容换了。
   */
  editMessage(conversationId: string, seq: number, text: string): Promise<{ accepted: boolean; streamSeq: number }> {
    return this.request(`/api/conversations/${conversationId}/messages/${seq}/edit`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
  }

  /**
   * 重新生成：把一条 agent 消息换成同一句提示词重新答一遍。
   *
   * 被换掉的只有那条回复与它之后的一切；用户那句话原地不动。
   */
  regenerateMessage(conversationId: string, seq: number): Promise<{ accepted: boolean; streamSeq: number }> {
    return this.request(`/api/conversations/${conversationId}/messages/${seq}/regenerate`, {
      method: 'POST',
      body: '{}',
    })
  }

  /**
   * 从此处分支：把会话在第 N 条消息处的状态复制成一个新会话。
   *
   * 分支**不重跑**任何一轮——它只是把上下文带走，之后两边各走各的。
   */
  branchConversation(conversationId: string, atSeq: number, title?: string): Promise<{ conversation: Conversation }> {
    return this.request(`/api/conversations/${conversationId}/branch`, {
      method: 'POST',
      body: JSON.stringify({ atSeq, ...(title === undefined ? {} : { title }) }),
    })
  }

  /**
   * 改群设置（群名 / 成员 / 调度员）。
   *
   * 与 patchConversation 分开是因为「发出去」和「成了」在这里不是一回事：服务端
   * 当前只落 title 与 memberAgentIds，dispatcherAgentId 会被忽略。所以回包里的
   * conversation 才是真值——调用方拿它跟用户要的调度员比对，别自己宣布成功。
   */
  patchGroup(
    conversationId: string,
    input: { title?: string; memberAgentIds?: string[]; dispatcherAgentId?: string },
  ): Promise<{ conversation: Conversation }> {
    return this.patchConversation(conversationId, input)
  }

  /** 全文搜索：搜会话名之外还搜消息正文，命中按会话分组回。 */
  searchMessages(params: { q: string; conversationId?: string }): Promise<{ results: SearchResultRow[] }> {
    const query = new URLSearchParams()
    query.set('q', params.q)
    if (params.conversationId !== undefined) query.set('conversationId', params.conversationId)
    return this.request(`/api/search?${query.toString()}`)
  }

  conversations(): Promise<{ conversations: Conversation[] }> {
    return this.request('/api/conversations')
  }

  /** 会话详情：会话元信息 + 该会话累计 token 用量。 */
  conversationDetail(conversationId: string): Promise<{ conversation: Conversation; usage: UsageTotals }> {
    return this.request(`/api/conversations/${conversationId}`)
  }

  /** 记忆系统统计（最近学到多少、巩固节奏）。 */
  memoryStats(): Promise<MemoryStats> {
    return this.request('/api/memory/stats')
  }

  /** 该会话当前的事件序号（握手前读一次当缺口检测基线）。 */
  streamSeq(conversationId: string): Promise<{ seq: number }> {
    return this.request(`/api/conversations/${conversationId}/stream-seq`)
  }

  createConversation(
    input:
      | { kind: 'direct'; agentId: string }
      | { kind: 'group'; memberAgentIds: string[]; dispatcherAgentId?: string; title?: string },
  ): Promise<{ conversation: Conversation }> {
    return this.request('/api/conversations', { method: 'POST', body: JSON.stringify(input) })
  }

  messages(
    conversationId: string,
    opts: { limit?: number; before?: number } = {},
  ): Promise<{ messages: MessageRow[] }> {
    const params = new URLSearchParams()
    params.set('limit', String(opts.limit ?? 50))
    if (opts.before !== undefined) params.set('before', String(opts.before))
    return this.request(`/api/conversations/${conversationId}/messages?${params.toString()}`)
  }

  /**
   * 发一条消息。202 回执里的 streamSeq 存成缺口检测基线：欢迎页是「先切会话、
   * 后建 WS 订阅」，而服务端在 202 之前就把这一轮的事件发出去了——没有这个
   * 基线，订阅建立之前丢掉的事件对客户端完全隐形。
   */
  postMessage(conversationId: string, text: string): Promise<{ accepted: boolean; streamSeq?: number }> {
    return this.request<{ accepted: boolean; streamSeq?: number }>(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }).then((body) => {
      if (typeof body.streamSeq === 'number') this.pendingBaselines.set(conversationId, body.streamSeq)
      return body
    })
  }

  /** 标记会话已读（未读徽标归零）。 */
  markRead(conversationId: string): Promise<{ conversationId: string; lastReadSeq: number }> {
    return this.request(`/api/conversations/${conversationId}/read`, { method: 'POST', body: '{}' })
  }

  /** 调度事件历史。 */
  listDispatchEvents(
    conversationId: string,
  ): Promise<{ events: { fromAgent?: string; toAgent: string; reason: string; turnIndex: number }[] }> {
    return this.request(`/api/conversations/${conversationId}/dispatch`)
  }

  /** 某 agent 的记忆（私有空间 + 共享画像）。 */
  listAgentMemories(agentId: string): Promise<{ agent: MemoryRow[]; shared: MemoryRow[] }> {
    return this.request(`/api/agents/${agentId}/memories`)
  }

  /** 软删一条记忆。 */
  deleteMemory(id: string): Promise<{ deleted: string }> {
    return this.request(`/api/memories/${id}`, { method: 'DELETE' })
  }

  /** 就地编辑一条记忆的内容（过时事实改字，而不是整条删掉重学）。 */
  updateMemory(id: string, content: string): Promise<{ memory: MemoryRow }> {
    return this.request(`/api/memories/${id}`, { method: 'PATCH', body: JSON.stringify({ content }) })
  }

  /** 已归档的记忆（全量返回，调用方按 agent 过滤）。 */
  listArchivedMemories(): Promise<{ items: MemoryRow[] }> {
    return this.request('/api/memory/archived')
  }

  /** 把一条归档记忆恢复到活跃列表。 */
  restoreMemory(id: string): Promise<{ restored: string }> {
    return this.request('/api/memory/restore', { method: 'POST', body: JSON.stringify({ id }) })
  }

  /** 重建向量索引：embedding 模型变更后为存量记忆回填向量。 */
  reembedMemories(): Promise<{ reembedded: number }> {
    return this.request('/api/memory/reembed', { method: 'POST' })
  }

  /**
   * 用户反馈：👎 即时反思；👍 归因 helpful。
   *
   * 亲密度 bump 由服务端在这条路由里内联做（反馈被接受才涨），因此这里
   * 只此一个入口；回包里的 agent 是更新后的真值，调用方据此刷新界面上的亲密度。
   * 同一消息同一信号重复提交会幂等返回 { recorded:false, duplicate:true }。
   */
  sendFeedback(input: {
    conversationId: string
    agentId: string
    signal: 'thumb_up' | 'thumb_down'
    userText?: string
    assistantText?: string
    /** 来源消息 id（服务端按 messageId+signal 去重，防连刷）。 */
    messageId?: string
  }): Promise<{ recorded: boolean; duplicate?: boolean; agent?: AgentDef }> {
    return this.request('/api/feedback', { method: 'POST', body: JSON.stringify(input) })
  }

  /** 某 agent 的经验手册。 */
  getPlaybook(agentId: string): Promise<{ entries: PlaybookEntryRow[]; reflections: ReflectionRow[] }> {
    return this.request(`/api/agents/${agentId}/playbook`)
  }

  /** 手动 deprecate / 恢复手册条目。 */
  setPlaybookStatus(id: string, status: 'active' | 'deprecated'): Promise<{ id: string; status: string }> {
    return this.request(`/api/playbook/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) })
  }

  /**
   * 产物/附件文件的可打开 URL。
   *
   * token 必须走查询串：这里的结果喂给 `<a href>` 与 `<img src>`，浏览器不会（也不能）
   * 给它们加 Authorization 头，服务端 presentedToken 认 `?token=`。生产模式下没有它，
   * 每张文件卡片都会 401——图片裂开、点开是 JSON 错误页。
   */
  fileUrl(name: string): string {
    const path = `/api/files/${encodeURIComponent(name)}`
    const token = currentApiToken()
    return token.length === 0 ? `${this.base}${path}` : `${this.base}${path}?token=${encodeURIComponent(token)}`
  }

  /** 产物预览的元数据（GET /api/files/:name/info）。 */
  fileInfo(name: string): Promise<ArtifactInfo> {
    return this.request(`/api/files/${encodeURIComponent(name)}/info`)
  }

  /**
   * 产物原始字节的 URL：内嵌预览的 `<img src>` / `<iframe src>` 直接吃它。
   *
   * token 同样只能走查询串（理由同 fileUrl）。download=true 时服务端回
   * Content-Disposition: attachment——「下载」必须是一次显式动作，不是内嵌的副作用。
   */
  fileRawUrl(name: string, download = false): string {
    const flag = download ? 'download=1' : ''
    const suffix = flag.length === 0 ? '' : `?${flag}`
    const path = `/api/files/${encodeURIComponent(name)}/raw${suffix}`
    const token = currentApiToken()
    const glue = flag.length === 0 ? '?' : '&'
    return token.length === 0 ? `${this.base}${path}` : `${this.base}${path}${glue}token=${encodeURIComponent(token)}`
  }

  /**
   * 把产物读成文本（Markdown / 代码预览用）。
   *
   * 走 raw 端点而不是拼字符串：符号链接逃逸与体积上限都在服务端那道闸后面，
   * 渲染层不需要也不该再实现一遍。
   */
  async fileText(name: string): Promise<string> {
    const response = await fetch(this.fileRawUrl(name))
    if (!response.ok) throw new ApiRequestError(`HTTP ${response.status}`, response.status)
    return response.text()
  }

  /** 工作区目录（agent 读写文件的默认位置；由服务端解析，渲染层不猜路径）。 */
  workspace(): Promise<{ path: string }> {
    return this.request('/api/workspace')
  }

  /**
   * 一键备份整库（会话+记忆+进化，同一个 SQLite 文件）。
   *
   * 备份路径由服务端定死在 dataDir/backups 内：渲染层不给路径参数，也就没有
   * 「让服务端往任意位置写文件」的面。回包只带真实落盘的 path。
   */
  backup(): Promise<{ path: string }> {
    return this.request('/api/backup', { method: 'POST', body: '{}' })
  }

  /**
   * 订阅会话事件；返回退订函数。
   * 断线自动指数退避重连（默认 1s/2s/5s/10s 封顶）；事件 seq 出现缺口或
   * 重连成功时回调 onGap（调用方重拉历史补齐，断线期间的事件服务器不重放）。
   * 缺口检测的基线见 SubscribeOptions.fromSeq。
   */
  subscribe(conversationId: string, onEvent: (event: StampedWsEvent) => void, opts: SubscribeOptions = {}): () => void {
    const delays = opts.reconnectDelays ?? [1000, 2000, 5000, 10000]
    const url = `${this.base.replace('http', 'ws')}/ws?conversationId=${conversationId}`
    let closed = false
    let attempts = 0
    // 基线：显式传入 > 本次发送的回执 seq > 未知（首条事件之前查不出缺口）。
    const baseline = opts.fromSeq ?? this.pendingBaselines.get(conversationId)
    this.pendingBaselines.delete(conversationId)
    let lastSeq: number | undefined = baseline
    let reconnecting = false
    let socket: WebSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const setReconnecting = (value: boolean): void => {
      if (reconnecting === value) return
      reconnecting = value
      opts.onStatus?.(value ? 'reconnecting' : 'open')
    }

    const connect = (): void => {
      if (closed) return
      // 浏览器 WS 不能带自定义头，token 只能走查询串（服务端 presentedToken 也收头，
      // 这里与主进程自己的 websocketUrl 保持同一条路）。重连时现读：token 可能比
      // 第一次连接晚到，那时服务端会以 401 拒掉 upgrade，不带上就永远连不上。
      const wsUrl =
        apiToken.length === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(apiToken)}`
      const ws = new WebSocket(wsUrl)
      socket = ws
      ws.onmessage = (message) => {
        const event = JSON.parse(String(message.data)) as StampedWsEvent
        if (typeof event.seq === 'number') {
          if (lastSeq !== undefined && event.seq > lastSeq + 1) opts.onGap?.()
          lastSeq = event.seq
        }
        onEvent(event)
      }
      ws.onopen = () => {
        // 重连成功：断开期间的事件已丢失，要求调用方补齐。
        if (attempts > 0) opts.onGap?.()
        attempts = 0
        setReconnecting(false)
      }
      ws.onclose = () => {
        if (closed) return
        setReconnecting(true)
        const delay = delays[Math.min(attempts, delays.length - 1)] ?? 10000
        attempts += 1
        timer = setTimeout(connect, delay)
      }
      ws.onerror = () => {
        ws.close()
      }
    }
    connect()

    return () => {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      socket?.close()
    }
  }

  /** 运行时计量快照：轮次耗时（首 token 延迟 / 总耗时 / 记忆召回计量）与请求计时。 */
  telemetry(limit?: number): Promise<TelemetrySnapshot> {
    const query = limit === undefined ? '' : `?limit=${Math.trunc(limit)}`
    return this.request(`/api/telemetry${query}`)
  }

  /**
   * playbook 条目的来源证据链（这条经验从哪次对话 / 哪条教训 / 哪次反馈来）。
   * 服务端未注册该路由时回 404 + { error: 'not found: ...' }，调用方据此降级。
   */
  explainPlaybookEntry(id: string): Promise<EntryExplanation> {
    return this.request(`/api/evolve/entries/${encodeURIComponent(id)}/explain`)
  }

  /**
   * 会话消息里的 usage 行（每条 assistant 消息挂一次模型调用的 token 用量）。
   * 按供应商归因只能从这里拿——服务端把 usage 挂在消息行上，会话级汇总并不保留
   * "哪个 agent 花的"这一维。limit 省略时按服务端单页上限取。
   */
  listUsageRows(conversationId: string, limit: number = USAGE_PAGE_LIMIT): Promise<{ messages: MessageUsageRow[] }> {
    return this.request(`/api/conversations/${conversationId}/messages?limit=${Math.trunc(limit)}`)
  }

  /**
   * 用量账单（GET /api/usage）：按会话与按供应商两维聚合的累计 token。
   *
   * 两个维度由服务端从**同一批消息**算出，合计恒等于 totals——渲染层不再逐会话
   * 翻消息自己加总（那会让两栏各算各的，加总对不上）。`since`（Unix 毫秒）把窗口
   * 收到该时刻之后，换模型前后比花销看的就是这个增量。
   */
  usage(since?: number): Promise<UsageReport> {
    const query = since === undefined ? '' : `?since=${Math.trunc(since)}`
    return this.request(`/api/usage${query}`)
  }

  /**
   * 记忆库整体健康度（GET /api/memory/health）：总数 / 已归档 / 缺向量 / 各空间
   * 分布 / 存储体积 / embedding 状态 / 最近一次召回，一次请求拿全。
   * 记忆系统关闭时服务端回 `{enabled:false}`（面板每次打开都拉，不该因此报错）。
   */
  memoryHealth(): Promise<MemoryHealthReport> {
    return this.request('/api/memory/health')
  }

  /**
   * 进化管线指标（GET /api/evolve/stats）：最近 limit 轮（新的在前）+ 各类轮次合计。
   * 进化在服务端是后台异步跑的，坏掉时界面上没有任何提示——这是唯一的观测面。
   */
  evolveStats(limit?: number): Promise<EvolveStatsReport> {
    const query = limit === undefined ? '' : `?limit=${Math.trunc(limit)}`
    return this.request(`/api/evolve/stats${query}`)
  }
}

/** 用量账单单会话拉取的消息条数上限（与服务端 MAX_MESSAGE_PAGE 对齐）。 */
const USAGE_PAGE_LIMIT = 200

// ---- 记忆健康度 / 用量账单 / 经验溯源：这三块面板要读的服务端形状 ----
// （TurnTiming / TelemetrySnapshot / MemoryRecall 已改为对 @ryharness/server 的
// 纯类型导入，见顶部 re-export 区。）

/** 带 usage 的消息行：服务端在消息行上带 usage，MessageRow 未声明这一维。 */
export interface MessageUsageRow extends MessageRow {
  usage?: TurnUsage
}

/** 一条溯源记录：这条经验是从哪儿来的。 */
export interface EntryOriginRow {
  kind: 'trajectory' | 'reflection' | 'feedback' | 'memory' | 'seed'
  /** 溯源对象 id：会话 id / 教训 id / 反馈事件 id / 记忆 id / 模板 key。 */
  refId: string
  /** 一句话说明（UI 直接显示；服务端缺失时留空）。 */
  detail?: string
  createdAt?: number
}

/** playbook 条目的证据链（GET /api/evolve/entries/:id/explain）。 */
export interface EntryExplanation {
  entry: PlaybookEntryRow
  origins: EntryOriginRow[]
  /** 服务端生成的一句话来源摘要（中文）。 */
  summary: string
}

/** 从消息行提取展示文本。 */
export function messageText(row: MessageRow): string {
  return row.contentBlocks
    .filter((block) => {
      return block.type === 'text' && typeof block.text === 'string'
    })
    .map((block) => {
      return block.text ?? ''
    })
    .join('\n')
}

// ---- 观测面：用量账单 / 记忆健康度 / 进化指标（GET /api/usage、/api/memory/health、
// /api/evolve/stats）三块面板的真实数据面。形状与 apps/server 对应路由的返回体
// 一一对齐；服务端关闭某子系统时回 {enabled:false} 而不是报错，面板据此说明原因。
// 用量账单那组 DTO 已随顶部一起改为对 @ryharness/server 的纯类型导入。 ----

/** GET /api/memory/health：记忆系统关闭时只有 enabled:false。 */
export type MemoryHealthReport =
  | { enabled: false }
  | {
      enabled: true
      /** 记忆总行数（含归档与软删链）。 */
      total: number
      /** 已归档条数。 */
      archived: number
      /** 缺当前 embedding 向量的条数（active + inactive）。 */
      missingVectors: number
      /** 各空间（agent 私有 + 共享画像）的记忆条数。 */
      bySpace: Record<string, number>
      /** 记忆库文件占用字节（含 WAL）。 */
      dbBytes: number
      embeddings: { label: string; model: string; dim?: number }
      lastRecall?: MemoryRecall
    }

/** 进化轮次种类：对话轮计分 / 反馈归因 / 定期巩固。 */
export type EvolveRoundKind = 'turn' | 'feedback' | 'consolidate'

/** 一轮进化工作的记账（耗时 + 处理条数 + 成败）。 */
export interface EvolutionRoundMetrics {
  kind: EvolveRoundKind
  startedAt: number
  durationMs: number
  /** 处理条目数：轮=计分/写库条目，consolidate=扫描的向量与记忆行。 */
  processed: number
  ok: boolean
  error?: string
}

/** 累计口径（按种类分列）。 */
export interface RoundTotals {
  rounds: number
  failures: number
  durationMs: number
  processed: number
}

/** GET /api/evolve/stats：进化系统关闭时只有 enabled:false。 */
export type EvolveStatsReport =
  | { enabled: false }
  | {
      enabled: true
      last?: EvolutionRoundMetrics
      /** 最近若干轮，新的在前。 */
      rounds: EvolutionRoundMetrics[]
      totals: RoundTotals
      byKind: Record<EvolveRoundKind, RoundTotals>
      /** 因环形缓冲上限被丢弃的轮数。 */
      droppedTurns?: number
    }
