/**
 * RyHarness 本地后端：HTTP API + WS 推送，可被 Electron 主进程内嵌
 * （`RyHarnessServer.create`），也可独立启动（src/main.ts）。
 *
 * 本文件只做**组合根与生命周期**：cordis Context → LlmRuntime + OpenAI 适配器
 * （providers.json）→ SessionStore（SQLite）→ 工具 → 种子 Ryen →
 * SessionCoordinator + EventHub → HTTP/WS 出口。路由按域拆在 `routes/` 下
 * （会话 / agent / 供应商 / 设置 / 记忆 / 进化 / 主动消息 / 遥测 / 用量 / 语音）；
 * 轮次调度（排队/取消/历史改写）抽在 `turn-engine.ts`，事件翻译抽在
 * `turn-events.ts`——它们跨越多个域，不属于任何单一路由域，由本文件装配进来。
 * @module @ryharness/server/app
 */

import { timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import type { AgentEvolutionHooks, AgentMemoryHooks } from '@ryharness/agent'
import { Context } from '@ryharness/cordis'
import { ChatEvolveLlm, EvolveService, seedIfEmpty } from '@ryharness/evolve'
import type { AdapterRegistrationHandle } from '@ryharness/llm'
import { isHarnessError, LlmRuntime } from '@ryharness/llm'
import type { OpenAiAdapterConfig, OpenAiPluginConfig } from '@ryharness/llm-openai'
import { OpenAiAdapter } from '@ryharness/llm-openai'
import {
  ChatMemoryLlm,
  DEFAULT_EMBEDDING_MODEL,
  MemoryService,
  NullEmbeddings,
  OpenAiCompatibleEmbeddings,
} from '@ryharness/memory'
import { SessionCoordinator, SessionStore } from '@ryharness/session'
import { ToolRegistry } from '@ryharness/tools'
import type { WebSocket as WsSocket } from 'ws'
import { WebSocketServer } from 'ws'
import { ApprovalBroker } from './approvals.ts'
import { EventHub } from './bus.ts'
import type { ProvidersConfigFile } from './config.ts'
import {
  DEFAULT_PROVIDER_BASE_URL,
  loadApiKeys,
  loadProvidersConfig,
  mergeApiKeys,
  resolveSidecarLlm,
  toAdapterConfig,
} from './config.ts'
import { envValue } from './env.ts'
import type { WsEvent } from './events.ts'
import { askUserPlugin } from './plugins/ask-user.ts'
import { QuestionStore, renderQuestionContext } from './plugins/ask-user-store.ts'
import { coreToolsPlugin } from './plugins/core-tools.ts'
import { grillMePlugin } from './plugins/grill-me.ts'
import type { PluginEntry } from './plugins/host.ts'
import { PluginHost } from './plugins/host.ts'
import { llmOpenAiPlugin } from './plugins/llm-openai.ts'
import { RouteRegistry } from './plugins/routes.ts'
import { todoPlugin } from './plugins/todo.ts'
import { TodoStore } from './plugins/todo-store.ts'
import { voicePlugin } from './plugins/voice.ts'
import { voicePiperPlugin } from './plugins/voice-piper.ts'
import { webReadPlugin } from './plugins/web-read.ts'
import { ProactiveDigest } from './proactive.ts'
import { retargetBuiltinAgents } from './provider-routing.ts'
import { HttpRequestError, json, Router } from './router.ts'
import { registerAgentRoutes } from './routes/agents.ts'
import { registerBackupRoutes } from './routes/backup.ts'
import { type ConversationState, registerConversationRoutes } from './routes/conversations.ts'
import { type ConsolidationRun, registerEvolveRoutes } from './routes/evolve.ts'
import { registerMemoryRoutes } from './routes/memory.ts'
import { registerPluginRoutes } from './routes/plugins.ts'
import { registerProactiveRoutes } from './routes/proactive.ts'
import { identityLine, readProfile, registerProfileRoutes } from './routes/profile.ts'
import { registerProviderRoutes } from './routes/providers.ts'
import { registerSettingsRoutes } from './routes/settings.ts'
import { registerTelemetryRoutes } from './routes/telemetry.ts'
import { registerUsageRoutes } from './routes/usage.ts'
import { registerVibeRoutes } from './routes/vibe.ts'
import { ensureSeedAgents } from './seed.ts'
import { Telemetry } from './telemetry.ts'
import { TurnEngine } from './turn-engine.ts'
import { VibeStore } from './vibe/store.ts'

export type { PluginEntry, PluginStatus, PluginView } from './plugins/host.ts'
export type { ProviderUsage } from './routes/providers.ts'

const DEFAULT_PORT = 32100
const DEFAULT_HOST = '127.0.0.1'
/** WS 心跳间隔：每 30s ping 一次，连续两次未 pong 的连接 terminate。 */
const DEFAULT_WS_HEARTBEAT_MS = 30_000
/** WS 发送缓冲上限：超过说明是慢消费者，断开防止内存堆积。 */
const MAX_WS_BUFFERED_BYTES = 1_048_576
/** 供应商连通性探测超时（毫秒）。 */
const DEFAULT_VERIFY_TIMEOUT_MS = 8000
/** 会话界面态文件（置顶/静音/改名/群成员覆盖）：SQLite 会话表没有这些列。 */
const CONVERSATION_STATE_FILE = 'conversation-state.json'
/** 优雅停机等待在途 turn 的上限。 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000
/** 巩固（合并/归档/教训过期）默认周期：6 小时。 */
const DEFAULT_CONSOLIDATION_INTERVAL_MS = 6 * 3_600_000

/**
 * Origin 白名单：空 Origin（curl/Node 客户端）、file://（Electron 渲染层）
 * 或回环地址（127.0.0.1 / localhost / ::1，覆盖 Vite dev server）。
 */
function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined || origin.length === 0 || origin === 'null') return true
  try {
    const url = new URL(origin)
    if (url.protocol === 'file:') return true
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  } catch {
    return false
  }
}

/** 定长比较，避免按字节提前返回把 token 猜出来。 */
function secretEquals(provided: string | undefined, expected: string): boolean {
  if (provided === undefined || provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))
}

/**
 * 从请求里取 token：Authorization: Bearer、x-ryharness-token 头，或 ?token= 查询串。
 *
 * 查询串是 WebSocket 唯一可行的通道——浏览器 WS API 不能自定义请求头，渲染层的
 * 订阅就是这么连的。三处都收，CLI/curl 与测试不必知道桌面端走哪条。
 */
function presentedToken(req: IncomingMessage, url: URL): string | undefined {
  const authorization = req.headers.authorization
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length)
  }
  const header = req.headers['x-ryharness-token']
  if (typeof header === 'string' && header.length > 0) return header
  const query = url.searchParams.get('token')
  return query !== null && query.length > 0 ? query : undefined
}

/**
 * WS upgrade 的拒绝应答：必须先写一帧完整的 HTTP 响应再 destroy。
 *
 * 直接 destroy 的话客户端只看到连接被重置，拿不到 401 与错误码，排查时无从下手。
 */
function rejectUpgrade(socket: Duplex, status: number, code: string): void {
  const body = JSON.stringify({ error: code, code })
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n` +
      'content-type: application/json; charset=utf-8\r\n' +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      'connection: close\r\n\r\n' +
      body,
  )
  socket.destroy()
}

/** 上游供应商故障的码 → HTTP 状态。其余按 500/502 处理。 */
const UPSTREAM_STATUS: Record<string, number> = {
  RATE_LIMIT: 429,
  TIMEOUT: 502,
  TRANSPORT: 502,
  SERVER: 502,
  EMPTY_RESPONSE: 502,
  QUOTA: 502,
  INVALID_CREDENTIAL: 502,
  ABORTED: 499,
}

/** 一次失败的统一形状：错误响应恒为 `{error, code}`。 */
export interface FailureDescription {
  status: number
  code: string
  message: string
}

/**
 * 巩固记账：最近一轮的结果与时刻。
 *
 * 组合根与主动消息调度器共用这一份（两者都由 create() 组装，直接互相持有会绕成
 * 一个循环初始化）。主动消息报的是「真跑出来的那些数字」，不另记一份账。
 */
export interface ConsolidationLog {
  last?: { result: Awaited<ReturnType<EvolveService['runUntilIdle']>>; at: number }
}

/**
 * 把抛出的东西翻译成 HTTP 边缘的错误形状。
 *
 * - `HttpRequestError`：调用方自己抛的 4xx，状态与机器码都是它定的。
 * - `HarnessError`（packages/llm 的 taxonomy）：**保留它自己的 code**——`RATE_LIMIT`
 *   与 `QUOTA` 对调用方是完全不同的处置（退避重试 vs 换 key），压成 500 就等于
 *   把内核已经分好的类又揉回一团。
 * - 其余：500 INTERNAL，消息只进日志与响应体，不再假装是请求方的错。
 */
export function describeFailure(error: unknown): FailureDescription {
  if (error instanceof HttpRequestError) {
    return { status: error.status, code: error.code, message: error.message }
  }
  if (isHarnessError(error)) {
    return { status: UPSTREAM_STATUS[error.code] ?? 502, code: error.code, message: error.message }
  }
  return {
    status: 500,
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
  }
}

/** 服务构造选项。 */
export interface ServerOptions {
  /** 监听端口，默认 32100；传 0 由系统分配（测试用）。 */
  port?: number
  /** 监听地址，默认 127.0.0.1。 */
  host?: string
  /** 数据目录（SQLite、config、workspace），默认 <cwd>/data。 */
  dataDir?: string
  /** 覆盖 providers.json（测试注入 mock 时用）。 */
  providersConfig?: ProvidersConfigFile
  /**
   * 自定义 LLM 挂载：提供时替代默认的 OpenAI 适配器挂载（测试注入
   * mock 适配器）；在 LlmRuntime 插件加载后调用。
   */
  mountLlm?: (ctx: Context) => void
  /**
   * 长期记忆：'default'（按环境构建：有 key → SiliconFlow embedding +
   * 抽取 LLM；无 key → 纯 FTS5、无抽取）、自定义实现，或 null（禁用）。
   */
  memory?: AgentMemoryHooks | null
  /**
   * 自我进化：'default'（有 key → Curator/Reflector LLM；无 key → 仅确定性
   * 计数与手动管理）、自定义实现，或 null（禁用）。
   */
  evolution?: AgentEvolutionHooks | null
  /** 巩固调度间隔毫秒；0/undefined = 关闭（默认 6 小时）。 */
  consolidationIntervalMs?: number
  /**
   * 主动消息（每日回顾）：默认开。`false` = 整体关闭，连启动那一次也不发；
   * `true`/省略 = 按 <dataDir>/proactive.json 的设置（默认开）。
   */
  proactive?: boolean
  /**
   * 主动消息的检查间隔毫秒；0 = 不起定时器（只保留启动那一次），省略 = 默认 30 分钟。
   * 测试用小值把每日检查拉成毫秒级。
   */
  proactiveIntervalMs?: number
  /** 主动消息的发送时刻（本地小时 0-23）；落盘设置优先。默认 9 点。 */
  proactiveHour?: number
  /** WS 心跳间隔毫秒（默认 30s；测试可调小）。两次未 pong 即断开。 */
  wsHeartbeatMs?: number
  /** 优雅停机等待在途 turn 的超时毫秒（默认 10s）。 */
  shutdownTimeoutMs?: number
  /** 供应商连通性探测超时毫秒（默认 8s；测试可调小）。 */
  verifyTimeoutMs?: number
  /**
   * API 一次性 token：给了就**强制**校验（HTTP 中间件 + WS upgrade，失败 401）。
   *
   * 桌面端由主进程在启动时随机生成并推给渲染层（见 pushApiBase）。留空时退回
   * 环境变量 RYHARNESS_API_TOKEN；两者都没有则不鉴权，只在日志里喊一声——那只适用于
   * 独立开发进程与测试，不适用于发布版。
   */
  authToken?: string
  /**
   * 在内置插件之后追加的插件（按数组顺序装配）。
   *
   * 生产清单是 core-tools / llm-openai / voice / todo / ask-user / web-read；这个口子是
   * 测试注入探针与
   * 非 core 用户插件的地方（开关的真实挂载/卸载需要至少一个可关的插件才能验证）。
   */
  plugins?: readonly PluginEntry[]
}

/**
 * 解析长期记忆的向量模型：baseURL/凭据与生成侧同一个供应商（用户换服务商时
 * 记忆跟着换），模型 id 必须显式——向量模型不通用，猜一个错的会让余弦在
 * 跨模型空间里静默塌成 -1，检索质量无声下降。只有命中的供应商就是
 * SiliconFlow 时才套用它的默认向量模型，其余情况退回纯 FTS5。
 */
function resolveSidecarEmbedding(
  providers: ProvidersConfigFile,
): { apiKey: string; baseURL: string; model: string } | undefined {
  const configured = providers.embedding
  if (configured !== undefined) {
    const provider = providers.providers[configured.providerId]
    const apiKey = provider?.apiKey ?? (provider?.apiKeyEnv === undefined ? undefined : process.env[provider.apiKeyEnv])
    if (provider === undefined || apiKey === undefined || apiKey.length === 0) return undefined
    return { apiKey, baseURL: provider.baseURL, model: configured.model }
  }
  const sidecar = resolveSidecarLlm(providers)
  if (sidecar === undefined || !sidecar.baseURL.startsWith(DEFAULT_PROVIDER_BASE_URL)) return undefined
  return { apiKey: sidecar.apiKey, baseURL: sidecar.baseURL, model: DEFAULT_EMBEDDING_MODEL }
}

/** 按环境构建默认进化服务。 */
function createDefaultEvolve(dataDir: string, providers: ProvidersConfigFile): EvolveService {
  const llmConfig = resolveSidecarLlm(providers)
  return new EvolveService({
    dbPath: join(dataDir, 'ryharness.db'),
    llm: llmConfig === undefined ? undefined : new ChatEvolveLlm(llmConfig),
  })
}

/** 按环境构建默认记忆服务。 */
function createDefaultMemory(dataDir: string, providers: ProvidersConfigFile): MemoryService {
  const llmConfig = resolveSidecarLlm(providers)
  const embeddingConfig = resolveSidecarEmbedding(providers)
  return new MemoryService({
    dbPath: join(dataDir, 'ryharness.db'),
    embeddings: embeddingConfig === undefined ? new NullEmbeddings() : new OpenAiCompatibleEmbeddings(embeddingConfig),
    llm: llmConfig === undefined ? undefined : new ChatMemoryLlm(llmConfig),
  })
}

/**
 * 给记忆钩子套一层计时：召回耗时与注入条数喂给遥测。
 *
 * 召回钩子的契约只有 (agentId, inputText)，拿不到会话 id——计量归属由组合根
 * 建立的一轮异步上下文（{@link Telemetry.scopedTurn}）决定，多会话并发时不会记串。
 * 注入块形如 `[记忆] 用户画像：\n- …\n相关记忆：\n- …`，条目行数即本轮注入的记忆条数。
 *
 * 只包计时的活，**两段式通道（recallSync/recallRefine）必须条件透传**：coordinator
 * 的 bindMemory 与群调度器的 FanoutMemory 都按"底层有没有这两个方法"决定是否把同步
 * 通道交给 AgentLoop——这里漏掉它们，生产上首 token 就静默退回 await 召回（embedding
 * 网络往返排进首 token），而 recallRefine 的回灌断掉后语义通道在下一轮也等于没有。
 * 补一个恒定存在的 recallSync 更糟：循环会以为同步路径跑过而跳过 await 兜底，记忆
 * 整个静默失效。
 *
 * recallSync 同步通道**也计量**（耗时 + 注入条数）：两段式接线后，真正完成本轮注入的
 * 往往是同步通道——只计量 await 通道会让 /api/memory/health 的"最近一次召回"在两段式
 * 路径下永远空白。
 */
export function timedMemoryHooks(hooks: AgentMemoryHooks, telemetry: Telemetry): AgentMemoryHooks {
  const sync = hooks.recallSync
  const refine = hooks.recallRefine
  return {
    recall: async (agentId, inputText) => {
      const startedAt = Date.now()
      const injected = await hooks.recall(agentId, inputText)
      telemetry.recallTurn()?.addRecall(Date.now() - startedAt, countInjectedMemories(injected))
      return injected
    },
    enqueueExtraction: (agentId, agentName, conversationId, turnText) => {
      hooks.enqueueExtraction(agentId, agentName, conversationId, turnText)
    },
    // .call(hooks, ...) 保住 this：生产上传入的是 MemoryService 实例（原型方法），
    // 裸透传解绑后落库向量缓存那一摊 this.* 全炸。
    ...(sync === undefined
      ? {}
      : {
          recallSync: (agentId: string, inputText: string) => {
            const startedAt = Date.now()
            const injected = sync.call(hooks, agentId, inputText)
            telemetry.recallTurn()?.addRecall(Date.now() - startedAt, countInjectedMemories(injected))
            return injected
          },
        }),
    ...(refine === undefined
      ? {}
      : {
          recallRefine: (agentId: string, inputText: string, deadlineMs?: number) => {
            return refine.call(hooks, agentId, inputText, deadlineMs)
          },
        }),
  }
}

/** 注入块里的记忆条目数（`[记忆]` 之后的 `- ` 条目行）。 */
function countInjectedMemories(injected: string | undefined): number {
  if (injected === undefined) return 0
  let count = 0
  for (const line of injected.split('\n')) {
    if (line.startsWith('- ')) count += 1
  }
  return count
}

/**
 * 构造 RyHarnessServer 所需的依赖。
 *
 * 过去这里是 22 个位置参数：加一个依赖就得改签名，而位置参数里 `providers` 与
 * `dataDir` 长得一样、`memory` 与 `memoryService` 只差一个"是不是 MemoryService"，
 * 传错顺序编译器一句话都不会说。组合根本来就一次性掌握全部依赖，对象参数把
 * "谁是谁"写进字段名，零行为变化。
 */
export interface RyHarnessServerOptions {
  readonly store: SessionStore
  readonly coordinator: SessionCoordinator
  /** 给 AgentLoop 的记忆钩子（可能是自定义实现，也可能 undefined）。 */
  readonly memory: AgentMemoryHooks | undefined
  /** 真正的 MemoryService 实例（巩固与主动消息要直接用它的 store）；自定义实现时缺省。 */
  readonly memoryService: MemoryService | undefined
  /** 给 AgentLoop 的进化钩子（可能是自定义实现，也可能 undefined）。 */
  readonly evolution: AgentEvolutionHooks | undefined
  /** 真正的 EvolveService 实例（巩固调度与种子要用）；自定义实现时缺省。 */
  readonly evolutionService: EvolveService | undefined
  readonly http: Server
  readonly wss: WebSocketServer
  readonly hub: EventHub
  readonly dataDir: string
  readonly workspaceRoot: string
  readonly providers: ProvidersConfigFile
  readonly llm: LlmRuntime
  readonly wsHeartbeatMs: number
  readonly shutdownTimeoutMs: number
  readonly telemetry: Telemetry
  readonly verifyTimeoutMs: number
  /** API token；undefined = 不鉴权（仅独立开发进程与测试）。 */
  readonly authToken: string | undefined
  /** 巩固记账（组合根与主动消息调度器共用一份，见 {@link ConsolidationLog}）。 */
  readonly consolidationLog: ConsolidationLog
  /** 主动消息调度器（每日回顾：定时器、设置与「今天发过没有」都在它那里）。 */
  readonly proactiveDigest: ProactiveDigest
  /** 工具注册表：协调器按名解析，插件卸载时工具随之消失。 */
  readonly tools: ToolRegistry
  /** 插件路由注册表：插件自行挂载的 HTTP 面，卸载时一起撤销。 */
  readonly routes: RouteRegistry
  /** 插件宿主：清单、开关与卸载顺序都在它那里。 */
  readonly plugins: PluginHost
  /** RyVibe 会话存储：vibe 路由与协调器的 skill 注入共用同一份。 */
  readonly vibeStore: VibeStore
  /** 提问存储：ask-user 插件、协调器的问答注入与 vibe 路由共用同一份。 */
  readonly questionStore: QuestionStore
  /** 待办存储：待办插件与 vibe 路由（RyVibe 落盘）共用同一份。 */
  readonly todoStore: TodoStore
  /** 工具执行审批桥：决议路由与 cancelTurn 的撤卡共用。 */
  readonly approvals: ApprovalBroker
  /**
   * 轮次引擎：会话内串行的排队/取消/历史改写与事件翻译（turn-engine.ts）。
   * 依赖由本组合根显式注入；server 只保留生命周期与路由装配。
   */
  readonly turnEngine: TurnEngine
}

/** RyHarness 本地后端服务。 */
export class RyHarnessServer {
  /** 公开可见的依赖（路由注册与 server 测试要直接取用）。 */
  readonly store: SessionStore
  readonly coordinator: SessionCoordinator
  readonly memory: AgentMemoryHooks | undefined
  readonly evolution: AgentEvolutionHooks | undefined
  readonly dataDir: string
  readonly workspaceRoot: string
  readonly llm: LlmRuntime
  /** 工具注册表：测试与路由可直接查当前注册了哪些工具。 */
  readonly tools: ToolRegistry
  /** 插件路由注册表：测试据此确认插件装卸时路由真的增删。 */
  readonly routes: RouteRegistry
  /** 插件宿主：清单、开关与生命周期。 */
  readonly plugins: PluginHost
  /** RyVibe 会话存储（vibe 路由要读它，协调器的 skill 注入也要读它）。 */
  readonly vibeStore: VibeStore
  /** 提问存储（ask-user 插件、问答注入、vibe 路由三边共用）。 */
  readonly questionStore: QuestionStore
  /** 待办存储（待办插件与 RyVibe 落盘共用同一份清单）。 */
  readonly todoStore: TodoStore
  /** 工具执行审批桥（routes 决议、cancelTurn 撤卡共用）。 */
  readonly approvals: ApprovalBroker
  /** 轮次引擎：路由回调与优雅停机经由它驱动轮次链（见 turn-engine.ts）。 */
  readonly turnEngine: TurnEngine

  private readonly memoryService: MemoryService | undefined
  private readonly evolutionService: EvolveService | undefined
  private readonly http: Server
  private readonly wss: WebSocketServer
  private readonly hub: EventHub
  private readonly providers: ProvidersConfigFile
  private readonly wsHeartbeatMs: number
  private readonly shutdownTimeoutMs: number
  private readonly telemetry: Telemetry
  private readonly verifyTimeoutMs: number
  private readonly authToken: string | undefined
  private readonly consolidationLog: ConsolidationLog
  private readonly proactiveDigest: ProactiveDigest

  private constructor(options: RyHarnessServerOptions) {
    this.store = options.store
    this.coordinator = options.coordinator
    this.memory = options.memory
    this.memoryService = options.memoryService
    this.evolution = options.evolution
    this.evolutionService = options.evolutionService
    this.http = options.http
    this.wss = options.wss
    this.hub = options.hub
    this.dataDir = options.dataDir
    this.workspaceRoot = options.workspaceRoot
    this.providers = options.providers
    this.llm = options.llm
    this.tools = options.tools
    this.routes = options.routes
    this.plugins = options.plugins
    this.vibeStore = options.vibeStore
    this.questionStore = options.questionStore
    this.todoStore = options.todoStore
    this.wsHeartbeatMs = options.wsHeartbeatMs
    this.shutdownTimeoutMs = options.shutdownTimeoutMs
    this.telemetry = options.telemetry
    this.verifyTimeoutMs = options.verifyTimeoutMs
    this.authToken = options.authToken
    this.consolidationLog = options.consolidationLog
    this.proactiveDigest = options.proactiveDigest
    this.approvals = options.approvals
    this.turnEngine = options.turnEngine
  }

  /** 第二次及以后的 close() 直接复用首次的停机 Promise（幂等）。 */
  private closing: Promise<void> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  /** 每个 WS 客户端的 pong 存活标记（心跳两轮未响应即断开）。 */
  private readonly wsAlive = new Map<WsSocket, boolean>()
  /**
   * OpenAI 兼容适配器的配置对象：整个进程共用这一份，供应商增删时原地换掉它的
   * providers 内容（适配器每次调用现读），用户不用重启就能用上新供应商。
   */
  private adapterConfig: OpenAiAdapterConfig | undefined
  /** 上面那份适配器的路由注册句柄：replace 可原子换掉它持有的路由集合。 */
  private adapterRegistration: AdapterRegistrationHandle | undefined
  /** 巩固调度由 server 自己持有：/api/memory/stats 要如实回答"上次巩固"，
   *  调度权与时间戳得在同一处，交给 EvolveService 的定时器就无从回答了。 */
  private consolidationTimer: ReturnType<typeof setInterval> | undefined
  private consolidationIntervalMs = DEFAULT_CONSOLIDATION_INTERVAL_MS
  private lastConsolidatedAt: number | undefined
  /** 正在跑的那一轮巩固：并发触发复用同一个 Promise，绝不叠加第二轮。 */
  private consolidationRun: Promise<ConsolidationRun> | undefined
  /**
   * 会话界面态覆盖（置顶/静音/改名/群成员）：会话表里没有这些列，另存
   * <dataDir>/conversation-state.json，启动时读入。删会话/删 agent 时同步清理。
   */
  private readonly conversationStates = new Map<string, ConversationState>()

  /** 实际监听地址（端口 0 时取系统分配值）。 */
  get url(): string {
    const address = this.http.address() as { port: number; address: string }
    return `http://${address.address}:${address.port}`
  }

  /** 本次启动的 API token；不鉴权的实例返回 undefined。 */
  get apiToken(): string | undefined {
    return this.authToken
  }

  /** 请求是否带着本次启动的 token；未启用鉴权时恒为 true。 */
  private tokenAuthorized(req: IncomingMessage, url: URL): boolean {
    if (this.authToken === undefined) return true
    return secretEquals(presentedToken(req, url), this.authToken)
  }

  /**
   * 挂载 OpenAI 兼容适配器（providers.json 的每条路由）。
   *
   * 首次挂载走 llm-openai 插件的 apply；这个方法是**补挂**路径：启动时一条
   * 路由都没有（插件 dormant），用户后来加了第一个供应商，此时才需要新建并
   * 注册适配器。重复调用 registerAdapter 会撞 DUPLICATE_ADAPTER，所以只有
   * 没有既有句柄时才会走到这里。
   */
  private mountOpenAiAdapters(config: OpenAiAdapterConfig): void {
    this.adapterConfig = config
    const routes = Object.keys(config.providers)
    if (routes.length === 0) return
    this.adapterRegistration = this.llm.registerAdapter(routes, new OpenAiAdapter(config))
  }

  /**
   * 接住 llm-openai 插件交回的路由注册句柄。
   *
   * 首次注册必须留在插件里（这样卸载插件能清掉路由），而供应商热增删又只能对
   * 同一个句柄 replace；两边共用这一份句柄与配置对象，就不会重复注册。
   */
  private adoptOpenAiRegistration(handle: AdapterRegistrationHandle, config: OpenAiAdapterConfig): void {
    this.adapterRegistration = handle
    this.adapterConfig = config
  }

  /**
   * 换一份供应商配置并热注册：路由集合与适配器看到的配置同时更新，
   * 正在进行的 turn 不受影响（每个请求在发请求那一刻现读配置）。
   */
  private refreshProviders(next: ProvidersConfigFile): void {
    this.providers.providers = next.providers
    if (next.embedding !== undefined) this.providers.embedding = next.embedding
    const config = toAdapterConfig(next)
    if (this.adapterRegistration === undefined) {
      this.mountOpenAiAdapters(config)
      return
    }
    if (this.adapterConfig !== undefined) this.adapterConfig.providers = config.providers
    this.adapterRegistration.replace(Object.keys(config.providers))
  }

  /** 组装并启动服务。 */
  static async create(options: ServerOptions = {}): Promise<RyHarnessServer> {
    const dataDir = options.dataDir ?? join(process.cwd(), 'data')
    const workspaceRoot = join(dataDir, 'workspace')
    mkdirSync(join(dataDir, 'config'), { recursive: true })
    mkdirSync(workspaceRoot, { recursive: true })

    const store = new SessionStore(join(dataDir, 'ryharness.db'))
    // 内置 agent 只补齐缺的那几个。upsertAgent 是全字段覆盖（ON CONFLICT DO UPDATE
    // 把 name/avatar/system_prompt/provider/model/tools 全刷成模板值），照原样每次
    // 启动都写一遍，用户改过的名字、头像、模型、工具就全没了——「我的」页里给 Ryen
    // 改昵称的功能在界面上明明是有的，重启一次就没。模板升级不该悄悄改写用户数据。
    ensureSeedAgents((input) => {
      if (store.getAgent(input.id) !== undefined) return
      store.upsertAgent(input)
    })
    // 提问文件由组合根与 ask-user 插件共用：插件负责工具/路由，协调器负责在
    // 下一轮把已回答的问答注入模型；两边必须读写同一份数据。
    const questionStore = new QuestionStore(join(dataDir, 'questions.json'))
    // RyVibe 的会话记录由组合根持有：盘问插件、vibe 路由与协调器的 skill 注入
    // 三边读写同一份数据（和提问存储一样的道理）。
    const vibeStore = new VibeStore(dataDir)
    // 待办清单同样由组合根持有：待办插件的路由/工具与 RyVibe 的落盘工具写的是
    // 同一份（RyVibe 落盘时把任务清单写进清单，用户在聊天页右侧就能勾）。
    const todoStore = new TodoStore(join(dataDir, 'todos.json'))

    // 供应商配置解析一次：显式注入 > 挂载自定义 runtime > 配置文件（含应用内 key 合并）。
    const providers =
      options.providersConfig ??
      (options.mountLlm !== undefined
        ? { providers: {} }
        : mergeApiKeys(loadProvidersConfig(join(dataDir, 'config', 'providers.json')), loadApiKeys(dataDir)))

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    // 工具注册表先于协调器挂载：协调器拿到的是注册表本身，工具由 core-tools 插件
    // 稍后注册；按名解析发生在每一轮，因此装载顺序不影响首个 turn。
    await ctx.plugin(ToolRegistry)
    // 路由注册表同样先于插件挂载：插件 apply 里 `ctx.routes.register` 才有地方落表。
    await ctx.plugin(RouteRegistry)
    if (options.mountLlm !== undefined) {
      options.mountLlm(ctx)
    }

    // 内置插件 + 调用方追加的插件。llm-openai 只在没有自定义 LLM 挂载时装：
    // 测试的 mock 适配器与真实供应商路由会撞同一个 route id。
    const pluginEntries: PluginEntry[] = [coreToolsPlugin]
    let adoptOpenAi: ((handle: AdapterRegistrationHandle, config: OpenAiAdapterConfig) => void) | undefined
    if (options.mountLlm === undefined) {
      const openAiConfig: OpenAiPluginConfig = toAdapterConfig(providers)
      // 插件负责首次注册，组合根接住句柄做后续 replace：两边必须是同一份配置对象，
      // 否则供应商热增删只改到了副本，适配器仍在读启动时的路由。
      openAiConfig.onRegistered = (handle) => {
        adoptOpenAi?.(handle, openAiConfig)
      }
      pluginEntries.push(llmOpenAiPlugin(openAiConfig))
    }
    // voice 与 todo 都是可关的非 core 插件：路由与工具归各自 fiber，开关即真实装卸。
    pluginEntries.push(
      voicePlugin(providers),
      // 离线语音依赖 ctx.voice（provider 注册进同一个目录），所以必须排在 voice 之后。
      voicePiperPlugin({ dataDir }),
      todoPlugin({
        store: todoStore,
        conversationExists: (conversationId) => {
          return store.getConversation(conversationId) !== undefined
        },
      }),
      // ask-user 与 web-read 都是可关的非 core 插件：问答数据由组合根持有，
      // 插件卸载只撤工具/路由，文件留给下一次挂载与协调器注入。
      askUserPlugin({
        store: questionStore,
        conversationExists: (conversationId) => {
          return store.getConversation(conversationId) !== undefined
        },
      }),
      // 盘问与落地（grill me）：RyVibe 用的工作法、盘问工具与落盘工具。关掉它，
      // RyVibe 仍在，只是既不问用户也不落盘——它会按自己的理解直接给一段方案。
      grillMePlugin({
        questions: questionStore,
        vibe: vibeStore,
        todos: todoStore,
        workspaceRoot,
      }),
      webReadPlugin(),
    )
    pluginEntries.push(...(options.plugins ?? []))
    const pluginHost = new PluginHost(ctx, pluginEntries, dataDir)

    const memoryOption =
      options.memory === null ? undefined : (options.memory ?? createDefaultMemory(dataDir, providers))
    const memoryService = memoryOption instanceof MemoryService ? memoryOption : undefined
    const evolutionOption =
      options.evolution === null ? undefined : (options.evolution ?? createDefaultEvolve(dataDir, providers))
    const evolutionService = evolutionOption instanceof EvolveService ? evolutionOption : undefined
    // 冷启动种子：内置 Ryen 播通用模板手册。
    if (evolutionService !== undefined) seedIfEmpty(evolutionService.store, 'ryen', 'general')
    // 记忆清扫面接线（runOnce 判重合并用）。
    if (evolutionService !== undefined && memoryService !== undefined) {
      evolutionService.attachMemorySweep({
        listSpaces: () => {
          const spaces = new Set<string>()
          for (const [space] of Object.entries(memoryService.store.stats().bySpace)) spaces.add(space)
          return [...spaces]
        },
        listActiveEmbeddings: (spaceId) => {
          // 按当前 embedding 模型过滤：跨模型的向量同维也能算出 >0.95，
          // 混在一起判重会把毫不相干的记忆当成重复软删。
          return memoryService.store.listActiveEmbeddings(spaceId, memoryService.embeddingModel).map((row) => {
            return {
              id: row.id,
              content: row.content,
              embedding: row.embedding,
              accessCount: row.accessCount,
              updatedAt: row.updatedAt,
            }
          })
        },
        supersede: (id) => {
          memoryService.store.supersede(id, 'superseded')
        },
        archiveDormant: (dormantAfterMs, now) => {
          return memoryService.store.archiveDormant(dormantAfterMs, now)
        },
        archiveColdSuperseded: (maxAgeMs, now) => {
          return memoryService.store.archiveColdSuperseded(maxAgeMs, now)
        },
      })
    }
    const telemetry = new Telemetry()
    const authToken = options.authToken ?? envValue(process.env, 'API_TOKEN')
    // 端口固定 + 零鉴权意味着本机任何进程都能驱动 shellExec。桌面端一定会传
    // token（主进程随机生成），所以只提醒，不阻断：独立开发进程与测试不传。
    // 随机端口（测试）不喊——端口猜不到，喊了只是噪音。
    if ((authToken === undefined || authToken.length === 0) && (options.port ?? DEFAULT_PORT) !== 0) {
      console.warn('@ryharness/server: API token 未启用，HTTP/WS 不鉴权（仅限开发环境）')
    }
    // 记忆钩子套一层计时：召回耗时/条数是首 token 路径上最值得盯的一段。
    const coordinatorMemory = memoryOption === undefined ? undefined : timedMemoryHooks(memoryOption, telemetry)
    // hub 与审批桥先于协调器建：协调器的 approver 挂点要用它发 approval-request。
    const hub = new EventHub()
    const approvals = new ApprovalBroker(hub)
    const coordinator = new SessionCoordinator({
      store,
      llm: ctx.llm,
      tools: ctx.tools,
      // 下一轮注入：只取「已回答、还没送达」的问答；commit 在对应 agent 真的
      // 跑过之后才落 deliveredAt，群聊里没发言的成员不会把答案吃掉。
      questionContext: (conversationId, agentId) => {
        // RyVibe 会话不走这条注入：答案已经被写进小队共同看到的那条消息里，
        // 谁都读得到。再注入一遍等于同一件事说两次——而且只回到提问者手里，
        // 没提问的那几位下一轮又缺同一块信息，用户就得被问两遍。
        if (vibeStore.byConversation(conversationId) !== undefined) return undefined
        const entries = questionStore.pendingAnswers(conversationId, agentId)
        if (entries.length === 0) return undefined
        return {
          text: renderQuestionContext(entries),
          commit: () => {
            questionStore.markDelivered(
              entries.map((entry) => {
                return entry.id
              }),
            )
          },
        }
      },
      /**
       * 会话级工作法：只在「正在进行的那次 RyVibe」里装上它要用的方法。
       *
       * 方法随插件的开关走——盘问插件被关掉，RyVibe 就不再有盘问方法（方法正文
       * 从启用中的插件里找，找不到就不装）。方法与它依赖的工具一起走，组合根里
       * 不出现任何具体工具名。
       */
      conversationMethod: (conversationId) => {
        const session = vibeStore.byConversation(conversationId)
        if (session === undefined) return undefined
        const skill = pluginHost.skills().find((candidate) => {
          return candidate.id === session.skillId
        })
        if (skill === undefined) return undefined
        return { skill: skill.body, tools: skill.tools ?? [] }
      },
      ...(coordinatorMemory === undefined ? {} : { memory: coordinatorMemory }),
      ...(evolutionOption === undefined ? {} : { evolution: evolutionOption }),
      // 身份句每轮现取：用户在「我的」页改了名字，下一句就该生效，不需要重启。
      identity: () => {
        return identityLine(readProfile(store))
      },
      // shell_exec 这类工具的逐条审批：单聊与群聊成员走同一条闸（见 approvals.ts）。
      approver: (input, ctx) => {
        // 无会话上下文的调用没有审批卡可挂：聊天链路恒有 conversationId，这里
        // 兜的是装配缺口，不是绕过审批的口子（shell 只在聊天轮次里可达）。
        if (ctx.conversationId === undefined) return Promise.resolve(true)
        return approvals.request({
          conversationId: ctx.conversationId,
          agentId: ctx.agentId ?? '',
          toolName: input.name,
          args: input.arguments,
        })
      },
    })
    // 巩固记账与主动消息调度器由组合根共享：回顾里报的合并条数必须来自真跑出来的那
    // 一轮，而不是另记一份会漂移的账。
    const consolidationLog: ConsolidationLog = {}
    const proactiveDigest = new ProactiveDigest({
      store,
      memoryService,
      evolutionService,
      dataDir,
      lastConsolidation: () => {
        return consolidationLog.last
      },
      initial: {
        // 只有显式关掉才带 enabled：省略时由调度器回落读落盘设置，用户在设置里
        // 关掉的，重启不能又自己打开。
        ...(options.proactive === false ? { enabled: false } : {}),
        ...(options.proactiveHour === undefined ? {} : { hour: options.proactiveHour }),
      },
      intervalMs: options.proactiveIntervalMs,
      /**
       * 主动消息也要推给界面：只写库的话，用户正开着那个会话也看不到它，得切走
       * 再切回来才发现"它主动找过我"——功能等于没上线。
       *
       * hub 在这里已经建好，直接用它（组合根是唯一持有它的地方）。
       */
      publish: (event) => {
        hub.publish(event)
      },
    })
    /**
     * 轮次引擎：依赖在这里显式注入（store / 协调器 / hub / 遥测 / vibe / 提问 /
     * 审批桥），engine 不反向依赖 server 类；路由回调与优雅停机都经由它驱动。
     */
    const turnEngine = new TurnEngine({
      store,
      coordinator,
      hub,
      telemetry,
      workspaceRoot,
      vibeStore,
      ...(memoryService === undefined ? {} : { memory: memoryService }),
      questionStore,
      approvals,
    })
    const server = new RyHarnessServer({
      store,
      coordinator,
      memory: memoryOption,
      memoryService,
      evolution: evolutionOption,
      evolutionService,
      http: createServer(),
      wss: new WebSocketServer({ noServer: true }),
      hub,
      dataDir,
      workspaceRoot,
      providers,
      llm: ctx.llm,
      wsHeartbeatMs: options.wsHeartbeatMs ?? DEFAULT_WS_HEARTBEAT_MS,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      telemetry,
      verifyTimeoutMs: options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      authToken: authToken === undefined || authToken.length === 0 ? undefined : authToken,
      consolidationLog,
      proactiveDigest,
      approvals,
      turnEngine,
      tools: ctx.tools,
      routes: ctx.routes,
      plugins: pluginHost,
      vibeStore,
      questionStore,
      todoStore,
    })
    adoptOpenAi = (handle, config) => {
      server.adoptOpenAiRegistration(handle, config)
    }
    server.loadConversationStates()
    // 先装核心路由再挂插件：路由表在插件注册那一刻就必须已经存在，冲突才能变成
    // 该插件的挂载错误（而不是等第一个 HTTP 请求才炸）。
    server.router()
    // 插件按清单顺序挂载；core 失败会在这里抛出去，非 core 失败只记录状态。
    await pluginHost.start()
    if (evolutionService !== undefined && options.consolidationIntervalMs !== 0) {
      server.startConsolidation(options.consolidationIntervalMs ?? DEFAULT_CONSOLIDATION_INTERVAL_MS)
    }
    server.http.on('request', (req, res) => {
      server.onRequest(req, res).catch((error: unknown) => {
        const failure = describeFailure(error)
        console.error(`[ryharness] ${req.method ?? 'GET'} failed:`, failure.message)
        if (!res.headersSent) json(res, failure.status, { error: failure.message, code: failure.code })
        res.end()
      })
    })
    server.attachWs()
    // 启动那一次的主动消息排在 listen 之前：桌面端是先起服务再开窗口，渲染层的
    // 第一次 `GET /api/conversations` 就该看见这条回顾，而不是等下一轮刷新才冒出来。
    proactiveDigest.start()
    await new Promise<void>((resolve) => {
      server.http.listen(options.port ?? DEFAULT_PORT, options.host ?? DEFAULT_HOST, resolve)
    })
    return server
  }

  /**
   * 优雅停机（幂等）：先等在途 turn 完成（超时兜底），再断 WS 客户端、
   * 关 HTTP、关数据库——在途 turn 的收尾事件还能推到客户端，且不会写
   * 已关闭的 SQLite。
   */
  close(): Promise<void> {
    this.closing ??= this.doClose()
    return this.closing
  }

  /** 启动周期巩固（默认 6 小时）。定时器不拖住进程退出，与 WS 心跳一致。 */
  private startConsolidation(intervalMs: number): void {
    this.consolidationIntervalMs = intervalMs
    this.consolidationTimer = setInterval(() => {
      void this.runConsolidation()
    }, intervalMs)
    this.consolidationTimer.unref()
  }

  /**
   * 跑一整轮巩固并记账时间。
   *
   * 用 runUntilIdle 而不是 runOnce：巩固是分片的（一次同步只做 ≤12ms 的一片，
   * 剩下的后台续跑），runOnce 返回的只是**第一片**的快照，拿它当"整轮结果"记
   * 账等于把没做完的事报成做完了。
   *
   * 撞上正在跑的一轮时复用它的 Promise，不叠加第二轮：扫描游标是跨调用共享的，
   * 两轮交替会把状态搅乱；手动触发撞上定时任务时也该拿到同一个结果，而不是一次
   * 莫名其妙的失败。
   */
  private runConsolidation(): Promise<ConsolidationRun> {
    if (this.evolutionService === undefined) return Promise.resolve({ ok: false })
    this.consolidationRun ??= this.consolidateOnce().finally(() => {
      this.consolidationRun = undefined
    })
    return this.consolidationRun
  }

  /**
   * 真跑一轮巩固。失败只记日志：巩固是后台 housekeeping，不该把整个服务带下去，
   * 下次周期还会再试。
   */
  private async consolidateOnce(): Promise<ConsolidationRun> {
    const service = this.evolutionService
    if (service === undefined) return { ok: false }
    try {
      const result = await service.runUntilIdle()
      this.lastConsolidatedAt = Date.now()
      // 主动消息的回顾要用「真跑出来的这一轮」：合并了多少条、归档了多少条都从这里
      // 取，不另记一份账。
      this.consolidationLog.last = { result, at: this.lastConsolidatedAt }
      return { ok: true, result }
    } catch (error) {
      console.warn(`@ryharness/server: consolidation failed: ${error instanceof Error ? error.message : String(error)}`)
      return { ok: false }
    }
  }

  /** 巩固状态（/api/memory/stats 用）：上次巩固时间 + 周期。 */
  private consolidationSnapshot(): { intervalMs: number; lastRunAt?: number } {
    return this.consolidationIntervalMs === 0 || this.evolutionService === undefined
      ? { intervalMs: 0 }
      : {
          intervalMs: this.consolidationIntervalMs,
          ...(this.lastConsolidatedAt === undefined ? {} : { lastRunAt: this.lastConsolidatedAt }),
        }
  }

  // ---- 会话界面态（置顶/静音/改名/群成员）----

  /** 会话界面态文件路径（<dataDir>/conversation-state.json）。 */
  private get conversationStatePath(): string {
    return join(this.dataDir, CONVERSATION_STATE_FILE)
  }

  /** 读入界面态覆盖；文件缺失或损坏时按"没有覆盖"起（不阻塞启动）。 */
  private loadConversationStates(): void {
    const path = this.conversationStatePath
    if (!existsSync(path)) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      const entries = (parsed as { conversations?: Record<string, ConversationState> })?.conversations
      if (typeof entries !== 'object' || entries === null) return
      for (const [id, state] of Object.entries(entries)) {
        if (typeof state !== 'object' || state === null) continue
        this.conversationStates.set(id, state)
      }
    } catch {
      // 坏文件等于没有覆盖：置顶/静音丢了不该让服务起不来。
    }
  }

  /** 落盘界面态覆盖（原子写：先 .tmp 再 rename）。 */
  private saveConversationStates(): void {
    const tmp = `${this.conversationStatePath}.tmp`
    writeFileSync(
      tmp,
      `${JSON.stringify({ conversations: Object.fromEntries(this.conversationStates) }, null, 2)}\n`,
      'utf8',
    )
    renameSync(tmp, this.conversationStatePath)
  }

  private async doClose(): Promise<void> {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    if (this.consolidationTimer !== undefined) clearInterval(this.consolidationTimer)
    this.proactiveDigest.close()
    const pending = this.turnEngine.pendingTurns()
    if (pending.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.shutdownTimeoutMs)
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
    }
    for (const client of this.wss.clients) client.terminate()
    this.wss.close()
    await new Promise<void>((resolve, reject) => {
      this.http.close((error) => {
        return error === undefined || error === null ? resolve() : reject(error)
      })
    })
    // 插件在数据库关闭之前逆序卸载：工具/路由的 disposer 里若还要读 store，
    // 此时仍拿得到连接。
    await this.plugins.close()
    this.store.close()
    this.memoryService?.close()
    this.evolutionService?.close()
  }

  // ---- WS ----

  private attachWs(): void {
    this.heartbeat = setInterval(() => {
      for (const [ws, alive] of this.wsAlive) {
        if (!alive) {
          // 上一轮 ping 未收到 pong：半死连接，断开释放订阅与缓冲区。
          ws.terminate()
          continue
        }
        this.wsAlive.set(ws, false)
        if (ws.readyState === ws.OPEN) ws.ping()
      }
    }, this.wsHeartbeatMs)
    // 心跳不应拖住进程退出（测试与内嵌模式）。
    this.heartbeat.unref()

    this.http.on('upgrade', (req, socket, head) => {
      if (!originAllowed(req.headers.origin)) {
        rejectUpgrade(socket, 403, 'ORIGIN_NOT_ALLOWED')
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/ws') {
        rejectUpgrade(socket, 404, 'NOT_FOUND')
        return
      }
      const conversationId = url.searchParams.get('conversationId')
      if (conversationId === null || conversationId.length === 0) {
        rejectUpgrade(socket, 400, 'conversationId is required')
        return
      }
      // 浏览器 WS 不能带自定义头，token 只能走查询串（presentedToken 也收头，
      // CLI 用 ?token= 之外的写法时不必另开一条路）。
      if (!this.tokenAuthorized(req, url)) {
        rejectUpgrade(socket, 401, 'UNAUTHORIZED')
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wsAlive.set(ws, true)
        ws.on('pong', () => {
          this.wsAlive.set(ws, true)
        })
        const unsubscribe = this.hub.subscribe(conversationId, (event) => {
          if (ws.readyState !== ws.OPEN) return
          // 慢消费者背压：缓冲堆积超上限说明客户端跟不上，断开比堆积内存安全。
          if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
            ws.terminate()
            return
          }
          ws.send(JSON.stringify(event))
        })
        const drop = (): void => {
          this.wsAlive.delete(ws)
          unsubscribe()
        }
        ws.on('close', drop)
        ws.on('error', drop)
      })
    })
  }

  private publish(event: WsEvent): void {
    this.hub.publish(event)
  }

  // ---- HTTP ----

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!originAllowed(req.headers.origin)) {
      json(res, 403, { error: 'origin not allowed' })
      return
    }
    const origin = req.headers.origin
    // 渲染层现在由回环 HTTP 伺服（不再是 file://），与后端不同源：JSON 之类的
    // 非简单请求会先发 OPTIONS 预检。这里补齐 CORS 头 + 预检应答，来源仍走
    // 上面的回环白名单，不是开放反射。
    if (origin !== undefined && origin.length > 0 && origin !== 'null') {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'Origin')
      res.setHeader('access-control-allow-headers', 'content-type, authorization')
      res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
      res.setHeader('access-control-max-age', '600')
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      json(res, 400, { error: 'malformed request URL', code: 'BAD_REQUEST' })
      return
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    // 请求计时：只记方法/路径/状态码/耗时，**不记查询串与请求体**（搜索词与消息
    // 正文会随 query 进来，遥测快照是要原样发给渲染层的，不能带正文）。
    const startedAt = Date.now()
    res.on('finish', () => {
      this.telemetry.recordRequest({
        method: req.method ?? 'GET',
        path: url.pathname,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        at: Date.now(),
      })
    })
    // 鉴权放在 Origin 白名单之后、CORS 头之后：预检与跨源读到的 401 都要带 CORS
    // 头，否则渲染层只看到"网络错误"，排查时看不到 401 与 UNAUTHORIZED。
    // 又放在计时之后——被拒的请求同样是一次请求，不该在遥测里凭空消失。
    if (!this.tokenAuthorized(req, url)) {
      json(res, 401, { error: 'missing or invalid API token', code: 'UNAUTHORIZED' })
      return
    }
    const handled = await this.router().dispatch(req, res, url.pathname + url.search)
    if (!handled) json(res, 404, { error: `not found: ${req.method} ${url.pathname}`, code: 'NOT_FOUND' })
  }

  private routerLazy: Router | undefined

  private router(): Router {
    this.routerLazy ??= this.buildRouter()
    return this.routerLazy
  }

  /**
   * 路由装配：按域分七块注册，请求/响应形状与拆分前逐条一致。
   *
   * 路由模块只拿到显式声明的依赖（store / 服务 / 少量回调），不反向依赖
   * RyHarnessServer——这样"某条路由读到了什么"一眼可见，也让路由可以被单独测试。
   */
  private buildRouter(): Router {
    const router = new Router()
    const store = this.store

    registerAgentRoutes(router, { store, providers: this.providers })
    registerProfileRoutes(router, { store })

    registerMemoryRoutes(router, {
      store,
      memoryService: this.memoryService,
      consolidation: () => {
        return this.consolidationSnapshot()
      },
      dataDir: this.dataDir,
      telemetry: this.telemetry,
    })

    registerEvolveRoutes(router, {
      store,
      evolutionService: this.evolutionService,
      consolidate: () => {
        return this.runConsolidation()
      },
    })

    registerConversationRoutes(router, {
      store,
      workspaceRoot: this.workspaceRoot,
      conversationStates: this.conversationStates,
      persistConversationStates: () => {
        this.saveConversationStates()
      },
      lastSeq: (conversationId) => {
        return this.hub.lastSeq(conversationId)
      },
      publish: (event) => {
        this.publish(event)
      },
      enqueueTurn: (conversation, text, options) => {
        return this.turnEngine.enqueueTurn(conversation, text, options)
      },
      rewriteHistory: (conversation, plan) => {
        return this.turnEngine.rewriteHistory(conversation, plan)
      },
      cancelTurn: (conversationId) => {
        return this.turnEngine.cancelTurn(conversationId)
      },
      approvals: this.approvals,
    })

    registerProviderRoutes(router, {
      store,
      dataDir: this.dataDir,
      providers: this.providers,
      refreshProviders: (next) => {
        this.refreshProviders(next)
      },
      verifyTimeoutMs: this.verifyTimeoutMs,
      onProviderConfigured: (providerId) => {
        return retargetBuiltinAgents(store, this.providers, providerId)
      },
    })

    registerSettingsRoutes(router, {
      dataDir: this.dataDir,
      providers: this.providers,
      refreshProviders: (next) => {
        this.refreshProviders(next)
      },
      workspaceRoot: this.workspaceRoot,
      onProviderConfigured: (providerId) => {
        return retargetBuiltinAgents(store, this.providers, providerId)
      },
    })

    registerBackupRoutes(router, { dataDir: this.dataDir, store })

    registerPluginRoutes(router, { plugins: this.plugins })

    registerProactiveRoutes(router, { proactive: this.proactiveDigest })

    registerTelemetryRoutes(router, {
      telemetry: this.telemetry,
      proactive: () => {
        return this.proactiveDigest.snapshot()
      },
    })

    registerUsageRoutes(router, {
      store,
      providers: this.providers,
      conversationStates: this.conversationStates,
    })

    registerVibeRoutes(router, {
      store,
      vibe: this.vibeStore,
      questions: this.questionStore,
      todos: this.todoStore,
      enqueueTurn: (conversation, text) => {
        return this.turnEngine.enqueueTurn(conversation, text)
      },
      // 「这个会话此刻有没有在跑」：RyVibe 页面靠它区分「还在做」与「做完了」。
      isTurnActive: (conversationId) => {
        return this.turnEngine.isTurnActive(conversationId)
      },
    })

    // 核心路由先全部落表，再挂插件路由：后注册的一方撞上核心路径会显式报错；
    // 插件之后装入/卸载的路由由注册表同步到同一个 Router，不必重建。
    this.routes.attach(router)

    return router
  }
}
