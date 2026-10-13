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
import LlmRuntime from '@ryagent/llm'
import { apply as applyOpenAi } from '@ryagent/llm-openai'
import { ChatMemoryLlm, MemoryService, NullEmbeddings, SiliconFlowEmbeddings } from '@ryagent/memory'
import { SessionCoordinator, SessionStore } from '@ryagent/session'
import { ARTIFACTS_DIR, fileProduce, fsRead, fsWrite, guessMime, shellExec } from '@ryagent/tools'
import type { WebSocket as WsSocket } from 'ws'
import { WebSocketServer } from 'ws'
import { EventHub } from './bus.ts'
import type { ProvidersConfigFile } from './config.ts'
import { loadProvidersConfig, providerKeyConfigured, toAdapterConfig } from './config.ts'
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
/** 优雅停机等待在途 turn 的上限。 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000

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
): { apiKey: string; baseURL: string; model: string } | undefined {
  for (const provider of Object.values(providers.providers)) {
    const apiKey =
      provider.apiKey ??
      (provider.apiKeyEnv === undefined ? undefined : process.env[provider.apiKeyEnv])
    if (apiKey === undefined || apiKey.length === 0) continue
    const model = provider.models[0]?.id
    if (model === undefined) continue
    return { apiKey, baseURL: provider.baseURL, model }
  }
  return undefined
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
  return new MemoryService({
    dbPath: join(dataDir, 'ryagent.db'),
    embeddings: new SiliconFlowEmbeddings({ apiKey: process.env.SILICONFLOW_API_KEY ?? '' }),
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
    private readonly wsHeartbeatMs: number,
    private readonly shutdownTimeoutMs: number,
  ) {}

  /** 第二次及以后的 close() 直接复用首次的停机 Promise（幂等）。 */
  private closing: Promise<void> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  /** 每个 WS 客户端的 pong 存活标记（心跳两轮未响应即断开）。 */
  private readonly wsAlive = new Map<WsSocket, boolean>()

  /** 实际监听地址（端口 0 时取系统分配值）。 */
  get url(): string {
    const address = this.http.address() as { port: number; address: string }
    return `http://${address.address}:${address.port}`
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

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    if (options.mountLlm !== undefined) {
      options.mountLlm(ctx)
    } else {
      const providers = options.providersConfig ?? loadProvidersConfig(join(dataDir, 'config', 'providers.json'))
      applyOpenAi(ctx, toAdapterConfig(providers))
    }
    const providers =
      options.providersConfig ??
      (options.mountLlm !== undefined
        ? { providers: {} }
        : loadProvidersConfig(join(dataDir, 'config', 'providers.json')))

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
          return memoryService.store.listActiveEmbeddings(spaceId).map((row) => {
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
    if (evolutionService !== undefined && options.consolidationIntervalMs !== 0) {
      evolutionService.startConsolidation(options.consolidationIntervalMs ?? 6 * 3_600_000)
    }
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
      options.wsHeartbeatMs ?? DEFAULT_WS_HEARTBEAT_MS,
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    )
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

  private async doClose(): Promise<void> {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
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
        const definition: AgentDefinition =
          templateKey !== undefined
            ? instantiateTemplate(templateKey, overrides)
            : {
                id: strField(body, 'id') ?? crypto.randomUUID(),
                name: overrides.name ?? '未命名 Agent',
                systemPrompt: overrides.systemPrompt ?? '你是一个乐于助人的助手。',
                provider: overrides.provider ?? 'siliconflow',
                model: overrides.model ?? 'deepseek-ai/DeepSeek-V3',
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
      store.deleteAgent(existing.id)
      json(res, 200, { deleted: existing.id })
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
        json(res, 200, { enabled: false })
        return
      }
      json(res, 200, {
        enabled: true,
        embeddings: {
          label: this.memoryService.embeddingsAvailable ? 'configured' : 'none:fts-only',
        },
        ...this.memoryService.store.stats(),
      })
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
      json(res, 200, this.evolutionService.runOnce())
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
          for (const id of memberIds as string[]) {
            if (store.getAgent(id) === undefined) throw new Error(`unknown agent "${id}"`)
          }
          const conversation = store.createConversation({
            kind: 'group',
            title: strField(body, 'title') ?? '群聊',
            memberAgentIds: memberIds as string[],
            dispatcherAgentId: strField(body, 'dispatcherAgentId') ?? 'ryen',
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
      const conversation = store.getConversation(req.params.id as string)
      if (conversation === undefined) json(res, 404, { error: 'conversation not found' })
      else json(res, 200, { conversation })
    })

    router.delete('/api/conversations/:id', async (req, res) => {
      if (store.getConversation(req.params.id as string) === undefined) {
        json(res, 404, { error: 'conversation not found' })
        return
      }
      store.deleteConversation(req.params.id as string)
      json(res, 200, { deleted: req.params.id })
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
      const limit = Number(req.query.get('limit') ?? '50')
      const before = req.query.get('before')
      const rows = store.listMessages(conversationId, {
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50,
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
      json(res, 202, { accepted: true, conversationId })
    })

    // ---- providers ----

    router.get('/api/providers', async (_req, res) => {
      json(res, 200, {
        providers: Object.entries(this.providers.providers).map(([id, provider]) => ({
          id,
          displayName: provider.displayName ?? id,
          apiKeyConfigured: providerKeyConfigured(provider),
          models: provider.models.map((model) => ({
            id: model.id,
            ...(model.name === undefined ? {} : { name: model.name }),
            ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          })),
        })),
      })
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
  private enqueueTurn(conversation: { id: string; kind: string; memberAgentIds: string[] }, text: string): void {
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
    conversation: { id: string; kind: string; memberAgentIds: string[] },
    text: string,
  ): Promise<void> {
    const { coordinator, store } = this
    const runContext = { workspaceRoot: this.workspaceRoot }
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
              })
              break
            case 'error':
              this.publish({ type: 'error', conversationId: conversation.id, message: event.message, code: event.code })
              break
          }
        }
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
      this.publish({
        type: 'error',
        conversationId: conversation.id,
        message: error instanceof Error ? error.message : String(error),
        code: 'INTERNAL',
      })
    }
  }
}
