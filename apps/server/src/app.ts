/**
 * RyAgent 本地后端：HTTP API + WS 推送，可被 Electron 主进程内嵌
 * （`RyAgentServer.create`），也可独立启动（src/main.ts）。
 *
 * 组装：cordis Context → LlmRuntime + OpenAI 适配器（providers.json）→
 * SessionStore（SQLite）→ 工具 → 种子 Ryen → SessionCoordinator + EventHub。
 * @module @ryagent/server/app
 */

import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http'
import { existsSync, mkdirSync, createReadStream } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@ryagent/cordis'
import LlmRuntime from '@ryagent/llm'
import type { AgentDefinition } from '@ryagent/agent'
import { apply as applyOpenAi } from '@ryagent/llm-openai'
import { ARTIFACTS_DIR, fileProduce, fsRead, fsWrite, guessMime, shellExec } from '@ryagent/tools'
import { SessionCoordinator, SessionStore } from '@ryagent/session'
import { WebSocketServer } from 'ws'
import { EventHub } from './bus.ts'
import type { WsEvent } from './events.ts'
import { loadProvidersConfig, providerKeyConfigured, toAdapterConfig } from './config.ts'
import type { ProvidersConfigFile } from './config.ts'
import { AGENT_TEMPLATES, ensureSeedAgents, instantiateTemplate } from './seed.ts'
import { Router, json, strField } from './router.ts'

/** 工具全集：协调器按各 agent 定义白名单过滤。 */
const ALL_TOOLS = [fsRead, fsWrite, shellExec, fileProduce]

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
}

const DEFAULT_PORT = 32100
const DEFAULT_HOST = '127.0.0.1'

/** RyAgent 本地后端服务。 */
export class RyAgentServer {
  private constructor(
    readonly store: SessionStore,
    readonly coordinator: SessionCoordinator,
    private readonly http: Server,
    private readonly wss: WebSocketServer,
    private readonly hub: EventHub,
    readonly dataDir: string,
    readonly workspaceRoot: string,
    private readonly providers: ProvidersConfigFile,
  ) {}

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
    ensureSeedAgents((input) => { store.upsertAgent(input) })

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    if (options.mountLlm !== undefined) {
      options.mountLlm(ctx)
    } else {
      const providers = options.providersConfig ?? loadProvidersConfig(join(dataDir, 'config', 'providers.json'))
      applyOpenAi(ctx, toAdapterConfig(providers))
    }
    const providers = options.providersConfig
      ?? (options.mountLlm !== undefined
        ? { providers: {} }
        : loadProvidersConfig(join(dataDir, 'config', 'providers.json')))

    const coordinator = new SessionCoordinator({ store, llm: ctx.llm, tools: ALL_TOOLS })
    const hub = new EventHub()
    const server = new RyAgentServer(
      store, coordinator, createServer(), new WebSocketServer({ noServer: true }), hub,
      dataDir, workspaceRoot, providers,
    )
    server.http.on('request', (req, res) => { server.onRequest(req, res).catch((error: unknown) => {
      if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      res.end()
    }) })
    server.attachWs()
    await new Promise<void>((resolve) => {
      server.http.listen(options.port ?? DEFAULT_PORT, options.host ?? DEFAULT_HOST, resolve)
    })
    return server
  }

  /** 优雅停机：断开 WS 客户端、关 HTTP、关数据库。 */
  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate()
    this.wss.close()
    await new Promise<void>((resolve, reject) => {
      this.http.close((error) => { return error === undefined || error === null ? resolve() : reject(error) })
    })
    this.store.close()
  }

  // ---- WS ----

  private attachWs(): void {
    this.http.on('upgrade', (req, socket, head) => {
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
        const unsubscribe = this.hub.subscribe(conversationId, (event) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event))
        })
        ws.on('close', unsubscribe)
        ws.on('error', unsubscribe)
      })
    })
  }

  private publish(event: WsEvent): void {
    this.hub.publish(event)
  }

  // ---- HTTP ----

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const handled = await this.router().dispatch(req, res, url.pathname + url.search)
    if (!handled) json(res, 404, { error: `not found: ${req.method} ${url.pathname}` })
  }

  private routerLazy: Router | undefined

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
      const overrides: Partial<Omit<AgentDefinition, 'id' | 'isBuiltin'>> = {}
      if (typeof body === 'object' && body !== null) {
        const record = body as Record<string, unknown>
        for (const key of ['name', 'avatar', 'systemPrompt', 'provider', 'model'] as const) {
          if (typeof record[key] === 'string') (overrides as Record<string, unknown>)[key] = record[key]
        }
        if (typeof record.temperature === 'number') overrides.temperature = record.temperature
        if (Array.isArray(record.tools)) overrides.tools = record.tools as string[]
      }
      try {
        const definition: AgentDefinition = templateKey !== undefined
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
      const body = (await req.body()) as Partial<AgentDefinition> | undefined
      const merged: AgentDefinition = {
        ...existing,
        ...body ?? {},
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

    // ---- conversations ----

    router.get('/api/conversations', async (_req, res) => {
      const conversations = store.listConversations().map((conversation) => {
        const last = store.listMessages(conversation.id, { limit: 1 }).at(-1)
        const preview = last === undefined
          ? ''
          : (last.contentBlocks[0] as { text?: string } | undefined)?.text ?? ''
        return {
          ...conversation,
          lastMessagePreview: preview.slice(0, 120),
          unreadCount: 0,
        }
      })
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
            title: strField(body, 'title') ?? (store.getAgent(agentId)?.name ?? ''),
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
        ...before === null || before.length === 0 ? {} : { beforeSeq: Number(before) },
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
        type: 'message-start', conversationId, senderId: 'user', senderName: '用户',
        turnIndex: store.nextTurnIndex(conversationId),
      })
      // 202：处理异步进行，过程经 WS 推送。
      void this.runTurn(conversation, text)
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
            ...model.name === undefined ? {} : { name: model.name },
            ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
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
          type: 'message-start', conversationId: conversation.id,
          senderId: agentId, senderName, turnIndex: store.nextTurnIndex(conversation.id) - 1,
        })
        for await (const event of coordinator.chatDirect(conversation.id, agentId, text, runContext)) {
          switch (event.type) {
            case 'text-delta':
              this.publish({ type: 'text-delta', conversationId: conversation.id, senderId: agentId, text: event.text })
              break
            case 'tool-call-start':
              this.publish({
                type: 'tool-call-start', conversationId: conversation.id, senderId: agentId,
                callId: event.callId, name: event.name, arguments: event.arguments,
              })
              break
            case 'tool-result':
              this.publish({
                type: 'tool-result', conversationId: conversation.id, senderId: agentId,
                callId: event.callId, name: event.name, isError: event.isError, content: event.result.content,
              })
              if (event.result.produce !== undefined) {
                this.publish({
                  type: 'produce-card', conversationId: conversation.id, senderId: agentId,
                  callId: event.callId, card: event.result.produce,
                })
              }
              break
            case 'done':
              this.publish({
                type: 'message-done', conversationId: conversation.id, senderId: agentId,
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
          type: 'message-start', conversationId: conversation.id,
          senderId: agentId, senderName: store.getAgent(agentId)?.name ?? agentId,
          turnIndex: store.nextTurnIndex(conversation.id) - 1,
        })
      }
      for await (const event of coordinator.chatGroup(conversation.id, text, runContext)) {
        switch (event.type) {
          case 'dispatch':
            this.publish({
              type: 'dispatch', conversationId: conversation.id,
              ...event.fromAgent === undefined ? {} : { fromAgent: event.fromAgent },
              toAgent: event.toAgent, reason: event.reason, turnIndex: event.turnIndex,
            })
            break
          case 'text-delta':
            ensureStart(event.agentId)
            this.publish({
              type: 'text-delta', conversationId: conversation.id,
              senderId: event.agentId, text: event.text,
            })
            break
          case 'tool-call-start':
            ensureStart(event.agentId)
            this.publish({
              type: 'tool-call-start', conversationId: conversation.id, senderId: event.agentId,
              callId: event.callId, name: event.name, arguments: event.arguments,
            })
            break
          case 'tool-result':
            ensureStart(event.agentId)
            this.publish({
              type: 'tool-result', conversationId: conversation.id, senderId: event.agentId,
              callId: event.callId, name: event.name, isError: event.isError, content: event.result.content,
            })
            if (event.result.produce !== undefined) {
              this.publish({
                type: 'produce-card', conversationId: conversation.id, senderId: event.agentId,
                callId: event.callId, card: event.result.produce,
              })
            }
            break
          case 'agent-message':
            ensureStart(event.agentId)
            this.publish({
              type: 'message-done', conversationId: conversation.id,
              senderId: event.agentId, turnIndex: store.nextTurnIndex(conversation.id) - 1,
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
        type: 'error', conversationId: conversation.id,
        message: error instanceof Error ? error.message : String(error), code: 'INTERNAL',
      })
    }
  }
}
