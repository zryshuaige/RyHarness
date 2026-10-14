/**
 * RyAgent 本地后端：HTTP API + WS 推送，可被 Electron 主进程内嵌
 * （`RyAgentServer.create`），也可独立启动（src/main.ts）。
 *
 * 组装：cordis Context → LlmRuntime + OpenAI 适配器（providers.json）→
 * SessionStore（SQLite）→ 工具 → 种子 Ryen → SessionCoordinator + EventHub。
 * @module @ryagent/server/app
 */

import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { AgentDefinition, AgentEvolutionHooks, AgentMemoryHooks } from '@ryagent/agent'
import { Context } from '@ryagent/cordis'
import { ChatEvolveLlm, EvolveService, seedIfEmpty } from '@ryagent/evolve'
import type { AdapterRegistrationHandle } from '@ryagent/llm'
import LlmRuntime from '@ryagent/llm'
import type { OpenAiAdapterConfig } from '@ryagent/llm-openai'
import { OpenAiAdapter } from '@ryagent/llm-openai'
import type { MemoryRow } from '@ryagent/memory'
import {
  ChatMemoryLlm,
  DEFAULT_EMBEDDING_MODEL,
  MemoryService,
  NullEmbeddings,
  OpenAiCompatibleEmbeddings,
} from '@ryagent/memory'
import type { RunContext, StoredMessage, StoredUsage } from '@ryagent/session'
import { SessionCoordinator, SessionStore } from '@ryagent/session'
import { ARTIFACTS_DIR, fileProduce, fsRead, fsWrite, guessMime, shellExec } from '@ryagent/tools'
import type { WebSocket as WsSocket } from 'ws'
import { WebSocketServer } from 'ws'
import { EventHub } from './bus.ts'
import type { ProviderConfig, ProviderProtocol, ProvidersConfigFile } from './config.ts'
import {
  DEFAULT_PROVIDER_BASE_URL,
  deleteApiKey,
  loadApiKeys,
  loadProvidersConfig,
  mergeApiKeys,
  PROVIDER_PRESETS,
  providerKeyConfigured,
  providerPreset,
  saveApiKey,
  toAdapterConfig,
  writeProvidersConfig,
} from './config.ts'
import type { WsEvent } from './events.ts'
import { HttpRequestError, json, Router, strField } from './router.ts'
import { AGENT_TEMPLATES, ensureSeedAgents, instantiateTemplate } from './seed.ts'

/** 工具全集：协调器按各 agent 定义白名单过滤。 */
const ALL_TOOLS = [fsRead, fsWrite, shellExec, fileProduce]

const DEFAULT_PORT = 32100
const DEFAULT_HOST = '127.0.0.1'
/** WS 心跳间隔：每 30s ping 一次，连续两次未 pong 的连接 terminate。 */
const DEFAULT_WS_HEARTBEAT_MS = 30_000
/** WS 发送缓冲上限：超过说明是慢消费者，断开防止内存堆积。 */
const MAX_WS_BUFFERED_BYTES = 1_048_576
/** 消息列表单页条数上限（?limit 的上限，也用作 ?since= 的翻页步长）。 */
const MAX_MESSAGE_PAGE = 200
/** 优雅停机等待在途 turn 的上限。 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000
/** 巩固（合并/归档/教训过期）默认周期：6 小时。 */
const DEFAULT_CONSOLIDATION_INTERVAL_MS = 6 * 3_600_000
/** 「最近学到」统计窗口：近 24 小时新增的长期记忆。 */
const RECENT_LEARNED_WINDOW_MS = 86_400_000

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

/** POST/PATCH 共用的 agent 字段白名单校验：类型不符抛 400，未知键丢弃。 */
function agentFieldOverrides(body: unknown): Partial<Omit<AgentDefinition, 'id' | 'isBuiltin'>> {
  const overrides: Partial<Omit<AgentDefinition, 'id' | 'isBuiltin'>> = {}
  if (typeof body !== 'object' || body === null) return overrides
  const record = body as Record<string, unknown>
  for (const key of ['name', 'avatar', 'systemPrompt', 'provider', 'model'] as const) {
    const value = record[key]
    if (value === undefined) continue
    if (typeof value !== 'string') throw new HttpRequestError(400, `field "${key}" must be a string`)
    overrides[key] = value
  }
  if (record.temperature !== undefined) {
    if (typeof record.temperature !== 'number' || !Number.isFinite(record.temperature)) {
      throw new HttpRequestError(400, 'field "temperature" must be a finite number')
    }
    overrides.temperature = record.temperature
  }
  if (record.tools !== undefined) {
    if (
      !Array.isArray(record.tools) ||
      record.tools.some((tool) => {
        return typeof tool !== 'string'
      })
    ) {
      throw new HttpRequestError(400, 'field "tools" must be an array of strings')
    }
    overrides.tools = record.tools as string[]
  }
  return overrides
}

/** POST /api/providers 的入参（校验后）。 */
interface NewProviderInput {
  displayName: string
  protocol: ProviderProtocol
  baseUrl: string
  models: string[]
  /** 免 key 协议（Ollama）允许不填；其余也允许留空——用户可以稍后在设置里补。 */
  apiKey?: string
  /** 从哪个预设建起（图标/文档链接回溯）。 */
  presetId?: string
}

/** 接入协议白名单：目前适配器只有 OpenAI 兼容一路，Ollama 走同一套协议只是免 key。 */
const PROVIDER_PROTOCOLS: readonly ProviderProtocol[] = ['openai', 'ollama']

/** POST /api/providers 的白名单校验：类型/取值不合法抛错（调用方回 400）。 */
function parseNewProviderInput(body: unknown): NewProviderInput {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const displayName = typeof record.displayName === 'string' ? record.displayName.trim() : ''
  if (displayName.length === 0) throw new HttpRequestError(400, 'displayName is required')
  const protocol = record.protocol === undefined ? 'openai' : String(record.protocol).trim().toLowerCase()
  if (!PROVIDER_PROTOCOLS.includes(protocol as ProviderProtocol)) {
    throw new HttpRequestError(400, `protocol must be one of ${PROVIDER_PROTOCOLS.join('|')}`)
  }
  const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : ''
  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    throw new HttpRequestError(400, 'baseUrl must be an absolute http(s) URL')
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new HttpRequestError(400, 'baseUrl must be an absolute http(s) URL')
  }
  if (!Array.isArray(record.models) || record.models.length === 0) {
    throw new HttpRequestError(400, 'models must be a non-empty array of model ids')
  }
  const models: string[] = []
  for (const model of record.models) {
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new HttpRequestError(400, 'models must be a non-empty array of model ids')
    }
    const id = model.trim()
    if (!models.includes(id)) models.push(id)
  }
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : ''
  const presetId =
    typeof record.presetId === 'string' && record.presetId.trim().length > 0 ? record.presetId.trim() : undefined
  return {
    displayName,
    protocol: protocol as ProviderProtocol,
    baseUrl: parsedUrl.toString().replace(/\/+$/, ''),
    models,
    ...(apiKey.length === 0 ? {} : { apiKey }),
    ...(presetId === undefined ? {} : { presetId }),
  }
}

/**
 * GET /api/providers 的对外形状。
 *
 * protocol/baseUrl/custom 是 UI 分组与徽标（内置 / 自定义 / 免 key）与展开后
 * 显示端点的依据；凭据只回答"配没配"，绝不回显值。
 */
function providerInfo(
  id: string,
  provider: ProviderConfig,
): {
  id: string
  displayName: string
  protocol: string
  baseUrl: string
  custom: boolean
  apiKeyConfigured: boolean
  models: { id: string; name?: string; contextWindow?: number }[]
} {
  return {
    id,
    displayName: provider.displayName ?? id,
    protocol: provider.protocol ?? 'openai',
    baseUrl: provider.baseURL,
    custom: provider.custom === true,
    apiKeyConfigured: providerKeyConfigured(provider),
    models: provider.models.map((model) => ({
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    })),
  }
}

/**
 * 记忆的对外形状（渲染层 MemoryRow）。
 *
 * 只挑展示与恢复需要的字段：MemoryRow 上的 `embedding` 是 Float32Array，
 * 直接序列化会变成 `{"0":…,"1":…}` 的一坨数字——归档列表是全量返回的，带着
 * 向量既把响应撑大，又把检索内部状态泄给前端。
 */
function publicMemoryRow(row: MemoryRow): {
  id: string
  agentId: string
  kind: MemoryRow['kind']
  content: string
  createdAt: number
  updatedAt: number
  accessCount: number
  sourceConversationId?: string
} {
  return {
    id: row.id,
    agentId: row.agentId,
    kind: row.kind,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    accessCount: row.accessCount,
    ...(row.sourceConversationId === undefined ? {} : { sourceConversationId: row.sourceConversationId }),
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
  /** WS 心跳间隔毫秒（默认 30s；测试可调小）。两次未 pong 即断开。 */
  wsHeartbeatMs?: number
  /** 优雅停机等待在途 turn 的超时毫秒（默认 10s）。 */
  shutdownTimeoutMs?: number
}

/**
 * 解析记忆/进化管线要用的 LLM 连接：取第一个凭据已配置的供应商，
 * 模型取该供应商的第一个。这样用户在 providers.json 里换成别家服务商后，
 * 记忆与进化也跟着走，而不是写死 SiliconFlow。
 */
function resolveSidecarLlm(
  providers: ProvidersConfigFile,
): { providerId: string; apiKey: string; baseURL: string; model: string } | undefined {
  for (const [providerId, provider] of Object.entries(providers.providers)) {
    const apiKey = provider.apiKey ?? (provider.apiKeyEnv === undefined ? undefined : process.env[provider.apiKeyEnv])
    if (apiKey === undefined || apiKey.length === 0) continue
    const model = provider.models[0]?.id
    if (model === undefined) continue
    return { providerId, apiKey, baseURL: provider.baseURL, model }
  }
  return undefined
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
    dbPath: join(dataDir, 'ryagent.db'),
    llm: llmConfig === undefined ? undefined : new ChatEvolveLlm(llmConfig),
  })
}

/** 按环境构建默认记忆服务。 */
function createDefaultMemory(dataDir: string, providers: ProvidersConfigFile): MemoryService {
  const llmConfig = resolveSidecarLlm(providers)
  const embeddingConfig = resolveSidecarEmbedding(providers)
  return new MemoryService({
    dbPath: join(dataDir, 'ryagent.db'),
    embeddings: embeddingConfig === undefined ? new NullEmbeddings() : new OpenAiCompatibleEmbeddings(embeddingConfig),
    llm: llmConfig === undefined ? undefined : new ChatMemoryLlm(llmConfig),
  })
}

/** RyAgent 本地后端服务。 */
export class RyAgentServer {
  private constructor(
    readonly store: SessionStore,
    readonly coordinator: SessionCoordinator,
    readonly memory: AgentMemoryHooks | undefined,
    private readonly memoryService: MemoryService | undefined,
    readonly evolution: AgentEvolutionHooks | undefined,
    private readonly evolutionService: EvolveService | undefined,
    private readonly http: Server,
    private readonly wss: WebSocketServer,
    private readonly hub: EventHub,
    readonly dataDir: string,
    readonly workspaceRoot: string,
    private readonly providers: ProvidersConfigFile,
    readonly llm: LlmRuntime,
    private readonly wsHeartbeatMs: number,
    private readonly shutdownTimeoutMs: number,
  ) {}

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

  /** 实际监听地址（端口 0 时取系统分配值）。 */
  get url(): string {
    const address = this.http.address() as { port: number; address: string }
    return `http://${address.address}:${address.port}`
  }

  /**
   * 挂载 OpenAI 兼容适配器（providers.json 的每条路由）。
   *
   * 自己注册而不是用插件的 apply，是为了拿到路由注册句柄：供应商增删要能在
   * 不重启进程的前提下换掉路由集合，而重复调用 registerAdapter 会撞
   * DUPLICATE_ADAPTER。零条路由时保持 dormant（与插件行为一致），等用户加了
   * 第一个供应商再补挂。
   */
  private mountOpenAiAdapters(config: OpenAiAdapterConfig): void {
    this.adapterConfig = config
    const routes = Object.keys(config.providers)
    if (routes.length === 0) return
    this.adapterRegistration = this.llm.registerAdapter(routes, new OpenAiAdapter(config))
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
  static async create(options: ServerOptions = {}): Promise<RyAgentServer> {
    const dataDir = options.dataDir ?? join(process.cwd(), 'data')
    const workspaceRoot = join(dataDir, 'workspace')
    mkdirSync(join(dataDir, 'config'), { recursive: true })
    mkdirSync(workspaceRoot, { recursive: true })

    const store = new SessionStore(join(dataDir, 'ryagent.db'))
    ensureSeedAgents((input) => {
      store.upsertAgent(input)
    })

    // 供应商配置解析一次：显式注入 > 挂载自定义 runtime > 配置文件（含应用内 key 合并）。
    const providers =
      options.providersConfig ??
      (options.mountLlm !== undefined
        ? { providers: {} }
        : mergeApiKeys(loadProvidersConfig(join(dataDir, 'config', 'providers.json')), loadApiKeys(dataDir)))

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    if (options.mountLlm !== undefined) {
      options.mountLlm(ctx)
    }

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
    const coordinator = new SessionCoordinator({
      store,
      llm: ctx.llm,
      tools: ALL_TOOLS,
      ...(memoryOption === undefined ? {} : { memory: memoryOption }),
      ...(evolutionOption === undefined ? {} : { evolution: evolutionOption }),
    })
    const hub = new EventHub()
    const server = new RyAgentServer(
      store,
      coordinator,
      memoryOption,
      memoryService,
      evolutionOption,
      evolutionService,
      createServer(),
      new WebSocketServer({ noServer: true }),
      hub,
      dataDir,
      workspaceRoot,
      providers,
      ctx.llm,
      options.wsHeartbeatMs ?? DEFAULT_WS_HEARTBEAT_MS,
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    )
    if (options.mountLlm === undefined) {
      server.mountOpenAiAdapters(toAdapterConfig(providers))
    }
    if (evolutionService !== undefined && options.consolidationIntervalMs !== 0) {
      server.startConsolidation(options.consolidationIntervalMs ?? DEFAULT_CONSOLIDATION_INTERVAL_MS)
    }
    server.http.on('request', (req, res) => {
      server.onRequest(req, res).catch((error: unknown) => {
        if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) })
        res.end()
      })
    })
    server.attachWs()
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
      this.runConsolidation()
    }, intervalMs)
    this.consolidationTimer.unref()
  }

  /**
   * 跑一轮巩固并记账时间。失败只记日志：巩固是后台 housekeeping，
   * 不该把整个服务带下去，下次周期还会再试。
   */
  private runConsolidation(): { ok: boolean; result?: ReturnType<EvolveService['runOnce']> } {
    if (this.evolutionService === undefined) return { ok: false }
    try {
      const result = this.evolutionService.runOnce()
      this.lastConsolidatedAt = Date.now()
      return { ok: true, result }
    } catch (error) {
      console.warn(`@ryagent/server: consolidation failed: ${error instanceof Error ? error.message : String(error)}`)
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

  /**
   * 「最近学到 N 条」：近 24 小时内新增的 active 记忆数（各 agent 私有空间 +
   * 共享画像）。口径写在这里而不是散在 UI 上，免得用户看到的数字无从对账。
   */
  private countRecentLearned(now = Date.now()): number {
    const memoryStore = this.memoryService?.store
    if (memoryStore === undefined) return 0
    const since = now - RECENT_LEARNED_WINDOW_MS
    let count = 0
    const fresh = (createdAt: number): boolean => {
      return createdAt >= since
    }
    for (const row of memoryStore.listSharedProfile()) {
      if (fresh(row.createdAt)) count += 1
    }
    for (const agent of this.store.listAgents()) {
      for (const row of memoryStore.listActiveForAgent(agent.id)) {
        if (fresh(row.createdAt)) count += 1
      }
    }
    return count
  }

  /**
   * `?since=` 增量拉取：只要 seq 比游标大的消息，按 seq 升序、取最新 limit 条。
   *
   * store.listMessages 只有 beforeSeq（向过去翻页）这一个游标，没有"取某 seq
   * 之后"的语义，所以从最新一页往回走，攒够 limit 条或越过 since 为止。正常
   * 情况（一页 200 条之内）就是一次查询；断线很久也只多走几页。
   */
  private listMessagesSince(conversationId: string, sinceSeq: number, limit: number): StoredMessage[] {
    const pageSize = MAX_MESSAGE_PAGE
    const collected: StoredMessage[] = []
    let beforeSeq: number | undefined
    for (;;) {
      const page = this.store.listMessages(conversationId, {
        limit: pageSize,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      })
      if (page.length === 0) break
      for (const message of page) {
        if (message.seq > sinceSeq) collected.push(message)
      }
      // 页内按 seq 升序：首条是本页最旧的一条，越过游标（或取空）就说明扫完了。
      const oldest = page[0]
      if (oldest === undefined || oldest.seq <= sinceSeq) break
      beforeSeq = oldest.seq
    }
    // 页是从新往旧取的，跨页拼回来的顺序是乱的：统一排成 seq 升序后取末尾
    // limit 条（末尾即最新）。
    collected.sort((a, b) => {
      return a.seq - b.seq
    })
    return collected.slice(-limit)
  }

  private async doClose(): Promise<void> {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    if (this.consolidationTimer !== undefined) clearInterval(this.consolidationTimer)
    const pending = [...this.turnChains.values()]
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
        socket.destroy()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/ws') {
        socket.destroy()
        return
      }
      const conversationId = url.searchParams.get('conversationId')
      if (conversationId === null || conversationId.length === 0) {
        socket.destroy()
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
      json(res, 400, { error: 'malformed request URL' })
      return
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    const handled = await this.router().dispatch(req, res, url.pathname + url.search)
    if (!handled) json(res, 404, { error: `not found: ${req.method} ${url.pathname}` })
  }

  private routerLazy: Router | undefined

  /** 每个会话一条 turn 链：同会话消息串行处理，新消息在上一 turn 结束后运行。 */
  private readonly turnChains = new Map<string, Promise<void>>()
  /** 在途轮次的中止器（取消端点用它打断 LLM 流与工具执行）。 */
  private readonly activeTurns = new Map<string, AbortController>()

  private router(): Router {
    this.routerLazy ??= this.buildRouter()
    return this.routerLazy
  }

  private buildRouter(): Router {
    const router = new Router()
    const { store } = this

    // ---- agents ----

    router.get('/api/agents', async (_req, res) => {
      json(res, 200, { agents: store.listAgents() })
    })

    router.post('/api/agents', async (req, res) => {
      const body = await req.body()
      const templateKey = strField(body, 'templateKey')
      // 白名单校验失败抛 HttpRequestError，由 dispatch 统一回 400。
      const overrides = agentFieldOverrides(body)
      try {
        // 不写死供应商与模型：新建 agent 默认跟随配置里第一个已配凭据的
        // 供应商，写死 SiliconFlow + DeepSeek 会让"配置了别家服务商"的
        // 用户建出来的 agent 直接不可用。
        const fallback = resolveSidecarLlm(this.providers)
        const definition: AgentDefinition =
          templateKey !== undefined
            ? instantiateTemplate(templateKey, overrides)
            : {
                id: strField(body, 'id') ?? crypto.randomUUID(),
                name: overrides.name ?? '未命名 Agent',
                systemPrompt: overrides.systemPrompt ?? '你是一个乐于助人的助手。',
                provider: overrides.provider ?? fallback?.providerId ?? '',
                model: overrides.model ?? fallback?.model ?? '',
                tools: overrides.tools ?? [],
              }
        const stored = store.upsertAgent({ ...definition, isBuiltin: false })
        json(res, 201, { agent: stored })
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    })

    router.patch('/api/agents/:id', async (req, res) => {
      const existing = store.getAgent(req.params.id as string)
      if (existing === undefined) {
        json(res, 404, { error: `agent not found: ${req.params.id}` })
        return
      }
      // 与 POST 同款白名单：类型不符 400（dispatch 统一捕获），未知键丢弃。
      const overrides = agentFieldOverrides(await req.body())
      const merged: AgentDefinition = {
        ...existing,
        ...overrides,
        id: existing.id,
        isBuiltin: existing.isBuiltin,
      }
      json(res, 200, { agent: store.upsertAgent(merged) })
    })

    router.delete('/api/agents/:id', async (req, res) => {
      const existing = store.getAgent(req.params.id as string)
      if (existing === undefined) {
        json(res, 404, { error: `agent not found: ${req.params.id}` })
        return
      }
      if (existing.isBuiltin) {
        json(res, 409, { error: `builtin agent "${existing.id}" cannot be deleted` })
        return
      }
      // 级联（记忆、playbook、教训、反馈、会话成员）由 store 在一次事务里完成，
      // 回执带上各处的清理条数，便于确认没有留下孤儿行。
      json(res, 200, { deleted: existing.id, removed: store.deleteAgent(existing.id) })
    })

    router.get('/api/agent-templates', async (_req, res) => {
      json(res, 200, { templates: Object.values(AGENT_TEMPLATES) })
    })

    // ---- memories（长期记忆）----

    /** 某 agent 的记忆：私有空间 active + 共享画像。 */
    router.get('/api/agents/:id/memories', async (req, res) => {
      if (store.getAgent(req.params.id as string) === undefined) {
        json(res, 404, { error: 'agent not found' })
        return
      }
      if (this.memoryService === undefined) {
        json(res, 200, { agent: [], shared: [] })
        return
      }
      const memoryStore = this.memoryService.store
      json(res, 200, {
        agent: memoryStore.listActiveForAgent(req.params.id as string),
        shared: memoryStore.listSharedProfile(),
      })
    })

    /** 软删一条记忆。 */
    router.delete('/api/memories/:id', async (req, res) => {
      if (this.memoryService === undefined) {
        json(res, 409, { error: 'memory system disabled' })
        return
      }
      const existing = this.memoryService.store.get(req.params.id as string)
      if (existing === undefined) {
        json(res, 404, { error: 'memory not found' })
        return
      }
      this.memoryService.store.supersede(existing.id, 'deleted')
      json(res, 200, { deleted: existing.id })
    })

    /** 记忆统计。 */
    router.get('/api/memory/stats', async (_req, res) => {
      if (this.memoryService === undefined) {
        json(res, 200, { enabled: false, recentLearned: 0, consolidation: this.consolidationSnapshot() })
        return
      }
      json(res, 200, {
        enabled: true,
        embeddings: {
          label: this.memoryService.embeddingsAvailable ? 'configured' : 'none:fts-only',
        },
        recentLearned: this.countRecentLearned(),
        consolidation: this.consolidationSnapshot(),
        ...this.memoryService.store.stats(),
      })
    })

    /**
     * 已归档的记忆（巩固任务判定长期零访问而移出检索面的那些）。
     *
     * 全量返回、由调用方按 agent 过滤：归档分区在每个 agent 的记忆面板里都要能
     * 看到"这个 agent 有什么被归档了"，按 agent 分组查询反而更贵。记忆系统关闭
     * 时回空列表而不是报错——面板每次打开都会拉一次，不该因此弹红条。
     */
    router.get('/api/memory/archived', async (_req, res) => {
      if (this.memoryService === undefined) {
        json(res, 200, { items: [] })
        return
      }
      json(res, 200, { items: this.memoryService.store.listArchived().map(publicMemoryRow) })
    })

    /** 恢复一条归档记忆：回到 active，重新参与检索与注入。 */
    router.post('/api/memory/restore', async (req, res) => {
      if (this.memoryService === undefined) {
        json(res, 409, { error: 'memory system disabled' })
        return
      }
      const id = strField(await req.body(), 'id')
      if (id === undefined) {
        json(res, 400, { error: 'id is required' })
        return
      }
      const memoryStore = this.memoryService.store
      const existing = memoryStore.get(id)
      if (existing === undefined) {
        json(res, 404, { error: 'memory not found' })
        return
      }
      // 只救归档：deleted / superseded 是用户或记忆管理器的软删决定，
      // 拿到 id 就能复活它们等于绕过软删语义。
      if (existing.status !== 'inactive') {
        json(res, 409, { error: `memory is not archived (status=${existing.status})` })
        return
      }
      if (!memoryStore.restore(id)) {
        json(res, 500, { error: 'restore failed' })
        return
      }
      json(res, 200, { restored: id })
    })

    /**
     * 重建向量索引：换 embedding 模型后为存量记忆回填向量（换模型时旧向量会被
     * 检索侧排除，不回填等于旧记忆静默退化成只走 BM25）。
     *
     * 没有 embedding 凭据（纯 FTS5）时回 409 而不是"重建成功 0 条"：那个按钮
     * 在这种安装下按下去没有意义，UI 需要如实看到它不可用。
     */
    router.post('/api/memory/reembed', async (_req, res) => {
      if (this.memoryService === undefined) {
        json(res, 409, { error: 'memory system disabled' })
        return
      }
      if (!this.memoryService.embeddingsAvailable) {
        json(res, 409, { error: 'embeddings are not configured; nothing to rebuild' })
        return
      }
      json(res, 200, { reembedded: await this.memoryService.reembedAll() })
    })

    // ---- 自我进化（playbook / reflections / 反馈闭环）----

    /** 用户反馈：👎 即时反思 + 归因 harmful；👍 归因 helpful。 */
    router.post('/api/feedback', async (req, res) => {
      if (this.evolutionService === undefined) {
        json(res, 409, { error: 'evolution system disabled' })
        return
      }
      const body = await req.body()
      const conversationId = strField(body, 'conversationId')
      const agentId = strField(body, 'agentId')
      const signal = strField(body, 'signal')
      if (conversationId === undefined || agentId === undefined || (signal !== 'thumb_up' && signal !== 'thumb_down')) {
        json(res, 400, { error: 'conversationId, agentId and signal(thumb_up|thumb_down) are required' })
        return
      }
      this.evolutionService.recordFeedback({
        agentId,
        conversationId,
        signal,
        userText: strField(body, 'userText'),
        assistantText: strField(body, 'assistantText'),
      })
      json(res, 200, { recorded: true })
    })

    /** 某 agent 的经验手册：playbook 条目（含 deprecated）+ 待验证教训。 */
    router.get('/api/agents/:id/playbook', async (req, res) => {
      if (store.getAgent(req.params.id as string) === undefined) {
        json(res, 404, { error: 'agent not found' })
        return
      }
      if (this.evolutionService === undefined) {
        json(res, 200, { entries: [], reflections: [] })
        return
      }
      json(res, 200, {
        entries: this.evolutionService.store.listEntries(req.params.id as string),
        reflections: this.evolutionService.store.listPendingReflections(req.params.id as string, 50),
      })
    })

    /** 手动 deprecate / 恢复条目。 */
    router.post('/api/playbook/:id/status', async (req, res) => {
      if (this.evolutionService === undefined) {
        json(res, 409, { error: 'evolution system disabled' })
        return
      }
      const existing = this.evolutionService.store.getEntry(req.params.id as string)
      if (existing === undefined) {
        json(res, 404, { error: 'entry not found' })
        return
      }
      const status = strField(await req.body(), 'status')
      if (status !== 'active' && status !== 'deprecated') {
        json(res, 400, { error: 'status must be active|deprecated' })
        return
      }
      this.evolutionService.setEntryStatus(existing.id, status)
      json(res, 200, { id: existing.id, status })
    })

    /** 手动触发巩固任务（周期调度之外的即时入口）。 */
    router.post('/api/evolve/consolidate', async (_req, res) => {
      if (this.evolutionService === undefined) {
        json(res, 409, { error: 'evolution system disabled' })
        return
      }
      const run = this.runConsolidation()
      if (!run.ok) {
        json(res, 500, { error: 'consolidation failed' })
        return
      }
      json(res, 200, run.result)
    })

    // ---- conversations ----

    router.get('/api/conversations', async (_req, res) => {
      const conversations = store.listConversationsWithPreview()
      json(res, 200, { conversations })
    })

    router.post('/api/conversations', async (req, res) => {
      const body = await req.body()
      const kind = strField(body, 'kind')
      try {
        if (kind === 'direct') {
          const agentId = strField(body, 'agentId')
          if (agentId === undefined) throw new Error('direct conversation requires agentId')
          if (store.getAgent(agentId) === undefined) throw new Error(`unknown agent "${agentId}"`)
          const conversation = store.createConversation({
            kind: 'direct',
            title: strField(body, 'title') ?? store.getAgent(agentId)?.name ?? '',
            memberAgentIds: [agentId],
          })
          json(res, 201, { conversation })
          return
        }
        if (kind === 'group') {
          const memberIds = (body as { memberAgentIds?: unknown })?.memberAgentIds
          if (!Array.isArray(memberIds) || memberIds.length === 0) {
            throw new Error('group conversation requires non-empty memberAgentIds')
          }
          if (
            memberIds.some((id) => {
              return typeof id !== 'string'
            })
          ) {
            throw new Error('memberAgentIds must be an array of agent ids')
          }
          const members = memberIds as string[]
          for (const id of members) {
            if (store.getAgent(id) === undefined) throw new Error(`unknown agent "${id}"`)
          }
          const dispatcherAgentId = strField(body, 'dispatcherAgentId') ?? 'ryen'
          // 调度员必须在成员名单里：群聊第一轮就是由它派工，不在名单里的话每条
          // 消息都会以 UNKNOWN_AGENT 报错（"群一进去就哑"）。前端勾选成员与选
          // 调度员是两处独立状态，这里是最后一道闸——不合法直接 400，不建群。
          if (!members.includes(dispatcherAgentId)) {
            throw new Error(`dispatcher "${dispatcherAgentId}" must be one of memberAgentIds`)
          }
          const conversation = store.createConversation({
            kind: 'group',
            title: strField(body, 'title') ?? '群聊',
            memberAgentIds: members,
            dispatcherAgentId,
          })
          json(res, 201, { conversation })
          return
        }
        throw new Error('kind must be "direct" or "group"')
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    })

    router.get('/api/conversations/:id', async (req, res) => {
      const conversationId = req.params.id as string
      const conversation = store.getConversation(conversationId)
      // 会话级累计 token：从各条消息的 usage 求和，成本随历史一起可查。
      if (conversation === undefined) json(res, 404, { error: 'conversation not found' })
      else json(res, 200, { conversation, usage: store.conversationUsage(conversationId) })
    })

    router.delete('/api/conversations/:id', async (req, res) => {
      if (store.getConversation(req.params.id as string) === undefined) {
        json(res, 404, { error: 'conversation not found' })
        return
      }
      store.deleteConversation(req.params.id as string)
      json(res, 200, { deleted: req.params.id })
    })

    /** 取消生成：中止该会话在途的一轮（LLM 流 + 工具执行）。 */
    router.post('/api/conversations/:id/cancel', async (req, res) => {
      const conversationId = req.params.id as string
      if (store.getConversation(conversationId) === undefined) {
        json(res, 404, { error: 'conversation not found' })
        return
      }
      const controller = this.activeTurns.get(conversationId)
      if (controller === undefined) {
        json(res, 200, { cancelled: false })
        return
      }
      controller.abort()
      json(res, 200, { cancelled: true })
    })

    /** 应用内配置 API key：写 config/api-keys.json（0600）并热注册适配器。 */
    router.post('/api/settings/api-key', async (req, res) => {
      const body = await req.body()
      const record = body as Record<string, unknown>
      const providerId = typeof record.providerId === 'string' ? record.providerId : ''
      const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : ''
      if (providerId.length === 0 || apiKey.length === 0) {
        json(res, 400, { error: 'providerId and apiKey are required' })
        return
      }
      if (!saveApiKey(this.dataDir, providerId, apiKey)) {
        json(res, 404, { error: `unknown provider: ${providerId}` })
        return
      }
      // 热更新：把新 key 合并进配置并重新注册适配器，用户不用重启。
      this.refreshProviders(mergeApiKeys(this.providers, loadApiKeys(this.dataDir)))
      json(res, 200, { providerId, configured: true })
    })

    /** 标记已读：lastReadSeq 推进到最新 seq。 */
    router.post('/api/conversations/:id/read', async (req, res) => {
      const conversationId = req.params.id as string
      if (store.getConversation(conversationId) === undefined) {
        json(res, 404, { error: 'conversation not found' })
        return
      }
      const lastReadSeq = store.markConversationRead(conversationId)
      json(res, 200, { conversationId, lastReadSeq })
    })

    /** 调度事件历史（右栏调度轨迹）。 */
    router.get('/api/conversations/:id/dispatch', async (req, res) => {
      const conversationId = req.params.id as string
      if (store.getConversation(conversationId) === undefined) {
        json(res, 404, { error: 'conversation not found' })
        return
      }
      json(res, 200, { events: store.listDispatchEvents(conversationId) })
    })

    router.get('/api/conversations/:id/messages', async (req, res) => {
      const conversationId = req.params.id as string
      if (store.getConversation(conversationId) === undefined) {
        json(res, 404, { error: 'conversation not found' })
        return
      }
      const rawLimit = Number(req.query.get('limit') ?? '50')
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_MESSAGE_PAGE) : 50
      const before = req.query.get('before')
      const since = req.query.get('since')
      if (since !== null && since.length > 0) {
        // since 是 seq 游标（客户端断线重连后补齐缺口用），非法数字直接 400：
        // 悄悄当成 0 会把整段历史当增量发过去。
        const sinceSeq = Number(since)
        if (!Number.isFinite(sinceSeq)) {
          json(res, 400, { error: 'since must be a seq number' })
          return
        }
        json(res, 200, { messages: this.listMessagesSince(conversationId, sinceSeq, limit) })
        return
      }
      const rows = store.listMessages(conversationId, {
        limit,
        ...(before === null || before.length === 0 ? {} : { beforeSeq: Number(before) }),
      })
      json(res, 200, { messages: rows })
    })

    router.post('/api/conversations/:id/messages', async (req, res) => {
      const conversationId = req.params.id as string
      const conversation = store.getConversation(conversationId)
      if (conversation === undefined) {
        json(res, 404, { error: 'conversation not found' })
        return
      }
      const text = strField(await req.body(), 'text')
      if (text === undefined) {
        json(res, 400, { error: 'body.text is required' })
        return
      }
      this.publish({
        type: 'message-start',
        conversationId,
        senderId: 'user',
        senderName: '用户',
        turnIndex: store.nextTurnIndex(conversationId),
      })
      // 202：处理异步进行，过程经 WS 推送；同会话消息串行排队。
      this.enqueueTurn(conversation, text)
      // 回执带上此刻的事件 seq：客户端的订阅可能晚于这次发送建立（欢迎页就是
      // 先 setActiveId 再 postMessage），拿着这个基线才能算出订阅期间漏了几条。
      json(res, 202, { accepted: true, conversationId, streamSeq: this.hub.lastSeq(conversationId) })
    })

    /**
     * 该会话当前的事件序号：客户端握手前读一次当缺口检测基线。
     * 与 POST /messages 回执里的 streamSeq 同源，区别只是这里可以随时单独读。
     */
    router.get('/api/conversations/:id/stream-seq', async (req, res) => {
      const conversationId = req.params.id as string
      if (store.getConversation(conversationId) === undefined) {
        json(res, 404, { error: 'conversation not found' })
        return
      }
      json(res, 200, { seq: this.hub.lastSeq(conversationId) })
    })

    // ---- providers ----

    // 工作区：助理读写文件的根目录。「我的」页要展示它、打开它，
    // 欢迎页的「看看工作区里都有什么文件」也要落地到真实路径上。
    router.get('/api/workspace', async (_req, res) => {
      json(res, 200, { path: this.workspaceRoot })
    })

    router.get('/api/providers', async (_req, res) => {
      json(res, 200, {
        providers: Object.entries(this.providers.providers).map(([id, provider]) => {
          return providerInfo(id, provider)
        }),
      })
    })

    /** 添加供应商向导的预设目录（协议 / baseURL / 推荐模型 / 文档链接）。 */
    router.get('/api/provider-presets', async (_req, res) => {
      json(res, 200, { presets: PROVIDER_PRESETS })
    })

    /**
     * 新增供应商：写 providers.json（路由）+ api-keys.json（明文 key，0600），
     * 再热注册适配器——加完立刻能选，不重启。
     */
    router.post('/api/providers', async (req, res) => {
      // 白名单校验失败抛 HttpRequestError，由 dispatch 统一回 400。
      const input = parseNewProviderInput(await req.body())
      const preset = input.presetId === undefined ? undefined : providerPreset(input.presetId)
      if (input.presetId !== undefined && preset === undefined) {
        json(res, 400, { error: `unknown preset: ${input.presetId}` })
        return
      }
      const next: ProvidersConfigFile = {
        ...this.providers,
        providers: { ...this.providers.providers },
      }
      // 预设 id 优先（图标/文档链接能对上品牌），已占用则退化成随机 id。
      const preferredId = input.presetId ?? `custom-${crypto.randomUUID().slice(0, 8)}`
      const providerId =
        next.providers[preferredId] === undefined ? preferredId : `custom-${crypto.randomUUID().slice(0, 8)}`
      const provider: ProviderConfig = {
        // baseUrl 已在校验里归一（绝对 URL + 去尾部斜杠）。
        baseURL: input.baseUrl,
        protocol: input.protocol,
        displayName: input.displayName,
        models: input.models.map((modelId) => {
          return { id: modelId }
        }),
        custom: true,
        ...(input.presetId === undefined ? {} : { presetId: input.presetId }),
      }
      next.providers[providerId] = provider
      writeProvidersConfig(this.dataDir, next)
      // key 先落盘再热注册：热注册读的是合并后的内存配置。
      if (input.apiKey !== undefined) saveApiKey(this.dataDir, providerId, input.apiKey)
      this.refreshProviders(mergeApiKeys(next, loadApiKeys(this.dataDir)))
      json(res, 201, { provider: providerInfo(providerId, this.providers.providers[providerId] as ProviderConfig) })
    })

    /** 删除供应商：仅限用户自己加的（内置条目是应用的一部分，删了没法恢复）。 */
    router.delete('/api/providers/:id', async (req, res) => {
      const providerId = req.params.id as string
      const provider = this.providers.providers[providerId]
      if (provider === undefined) {
        json(res, 404, { error: `provider not found: ${providerId}` })
        return
      }
      if (provider.custom !== true) {
        json(res, 409, { error: `builtin provider "${providerId}" cannot be deleted` })
        return
      }
      const next: ProvidersConfigFile = {
        ...this.providers,
        providers: { ...this.providers.providers },
      }
      delete next.providers[providerId]
      // key 先清（不留孤儿 key 在 0600 文件里），再落盘路由。
      deleteApiKey(this.dataDir, providerId)
      writeProvidersConfig(this.dataDir, next)
      this.refreshProviders(mergeApiKeys(next, loadApiKeys(this.dataDir)))
      json(res, 200, { deleted: providerId })
    })

    // ---- files（产物下载，白名单=工作区产物目录）----

    router.get('/api/files/:name', async (req, res) => {
      const name = req.params.name as string
      if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
        json(res, 400, { error: 'file name must be a leaf name' })
        return
      }
      const target = join(this.workspaceRoot, ARTIFACTS_DIR, name)
      if (!existsSync(target)) {
        json(res, 404, { error: `file not found: ${name}` })
        return
      }
      res.writeHead(200, { 'content-type': guessMime(name) })
      createReadStream(target).pipe(res)
    })

    return router
  }

  /** 把一轮对话排进该会话的串行链；上一 turn 未结束时先发 queued 事件。 */
  private enqueueTurn(
    conversation: { id: string; kind: string; memberAgentIds: string[]; dispatcherAgentId?: string },
    text: string,
  ): void {
    const tail = this.turnChains.get(conversation.id)
    if (tail !== undefined) {
      this.publish({
        type: 'queued',
        conversationId: conversation.id,
        senderId: 'user',
        turnIndex: this.store.nextTurnIndex(conversation.id),
      })
    }
    const run = (tail ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        return this.runTurn(conversation, text)
      })
    const chain = run.then(
      () => {
        if (this.turnChains.get(conversation.id) === chain) this.turnChains.delete(conversation.id)
      },
      () => {
        if (this.turnChains.get(conversation.id) === chain) this.turnChains.delete(conversation.id)
      },
    )
    this.turnChains.set(conversation.id, chain)
  }

  /** 执行一轮对话（异步）：消费协调器事件流并发布 WS 事件。 */
  private async runTurn(
    conversation: { id: string; kind: string; memberAgentIds: string[]; dispatcherAgentId?: string },
    text: string,
  ): Promise<void> {
    const { coordinator, store } = this
    // 每轮一个 AbortController：取消端点通过它中止 LLM 流与工具执行。
    const controller = new AbortController()
    this.activeTurns.set(conversation.id, controller)
    // 协调器在每次模型调用出账后回调；记下本轮累计，done 事件带给渲染层。
    let turnUsage: StoredUsage | undefined
    const runContext: RunContext = {
      workspaceRoot: this.workspaceRoot,
      signal: controller.signal,
      onUsage: (report) => {
        turnUsage = report.turnTotal
      },
    }
    try {
      if (conversation.kind === 'direct') {
        const agentId = conversation.memberAgentIds[0] as string
        const senderName = store.getAgent(agentId)?.name ?? agentId
        this.publish({
          type: 'message-start',
          conversationId: conversation.id,
          senderId: agentId,
          senderName,
          turnIndex: store.nextTurnIndex(conversation.id) - 1,
        })
        for await (const event of coordinator.chatDirect(conversation.id, agentId, text, runContext)) {
          switch (event.type) {
            case 'text-delta':
              this.publish({ type: 'text-delta', conversationId: conversation.id, senderId: agentId, text: event.text })
              break
            case 'tool-call-start':
              this.publish({
                type: 'tool-call-start',
                conversationId: conversation.id,
                senderId: agentId,
                callId: event.callId,
                name: event.name,
                arguments: event.arguments,
              })
              break
            case 'tool-result':
              this.publish({
                type: 'tool-result',
                conversationId: conversation.id,
                senderId: agentId,
                callId: event.callId,
                name: event.name,
                isError: event.isError,
                content: event.result.content,
              })
              if (event.result.produce !== undefined) {
                this.publish({
                  type: 'produce-card',
                  conversationId: conversation.id,
                  senderId: agentId,
                  callId: event.callId,
                  card: event.result.produce,
                })
              }
              break
            case 'done':
              this.publish({
                type: 'message-done',
                conversationId: conversation.id,
                senderId: agentId,
                turnIndex: store.nextTurnIndex(conversation.id) - 1,
                ...(turnUsage === undefined ? {} : { usage: turnUsage }),
              })
              break
            case 'error':
              this.publish({ type: 'error', conversationId: conversation.id, message: event.message, code: event.code })
              break
          }
        }
        return
      }

      // 群聊第一轮由调度员派工。老数据里可能有「调度员已被移出成员」的群（建群
      // 时前端只校验成员存在、不校验调度员是否在名单内）：与其让每条消息都以
      // UNKNOWN_AGENT 报错，不如在第一轮就说明白要怎么修。
      const dispatcherId = conversation.dispatcherAgentId
      if (dispatcherId !== undefined && !conversation.memberAgentIds.includes(dispatcherId)) {
        this.publish({
          type: 'error',
          conversationId: conversation.id,
          message: `这个群的调度员「${dispatcherId}」不在成员名单里，没法派工。请把它加回成员，或在通讯录里重建一个群。`,
          code: 'DISPATCHER_NOT_MEMBER',
        })
        return
      }

      const started = new Set<string>()
      const ensureStart = (agentId: string): void => {
        if (started.has(agentId)) return
        started.add(agentId)
        this.publish({
          type: 'message-start',
          conversationId: conversation.id,
          senderId: agentId,
          senderName: store.getAgent(agentId)?.name ?? agentId,
          turnIndex: store.nextTurnIndex(conversation.id) - 1,
        })
      }
      for await (const event of coordinator.chatGroup(conversation.id, text, runContext)) {
        switch (event.type) {
          case 'dispatch':
            this.publish({
              type: 'dispatch',
              conversationId: conversation.id,
              ...(event.fromAgent === undefined ? {} : { fromAgent: event.fromAgent }),
              toAgent: event.toAgent,
              reason: event.reason,
              turnIndex: event.turnIndex,
            })
            break
          case 'text-delta':
            ensureStart(event.agentId)
            this.publish({
              type: 'text-delta',
              conversationId: conversation.id,
              senderId: event.agentId,
              text: event.text,
            })
            break
          case 'tool-call-start':
            ensureStart(event.agentId)
            this.publish({
              type: 'tool-call-start',
              conversationId: conversation.id,
              senderId: event.agentId,
              callId: event.callId,
              name: event.name,
              arguments: event.arguments,
            })
            break
          case 'tool-result':
            ensureStart(event.agentId)
            this.publish({
              type: 'tool-result',
              conversationId: conversation.id,
              senderId: event.agentId,
              callId: event.callId,
              name: event.name,
              isError: event.isError,
              content: event.result.content,
            })
            if (event.result.produce !== undefined) {
              this.publish({
                type: 'produce-card',
                conversationId: conversation.id,
                senderId: event.agentId,
                callId: event.callId,
                card: event.result.produce,
              })
            }
            break
          case 'agent-message':
            ensureStart(event.agentId)
            this.publish({
              type: 'message-done',
              conversationId: conversation.id,
              senderId: event.agentId,
              turnIndex: store.nextTurnIndex(conversation.id) - 1,
              ...(turnUsage === undefined ? {} : { usage: turnUsage }),
            })
            break
          case 'error':
            this.publish({ type: 'error', conversationId: conversation.id, message: event.message, code: event.code })
            break
          default:
            break
        }
      }
    } catch (error) {
      // 取消不是故障：给一个明确的 code，渲染层据此显示"已停止"而不是红条报错。
      if (controller.signal.aborted) {
        this.publish({
          type: 'error',
          conversationId: conversation.id,
          message: '已停止生成',
          code: 'ABORTED',
        })
      } else {
        this.publish({
          type: 'error',
          conversationId: conversation.id,
          message: error instanceof Error ? error.message : String(error),
          code: 'INTERNAL',
        })
      }
    } finally {
      if (this.activeTurns.get(conversation.id) === controller) {
        this.activeTurns.delete(conversation.id)
      }
    }
  }
}
