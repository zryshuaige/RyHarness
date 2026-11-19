/**
 * 云成员（Kimi Hosted Agents）的 HTTP 面。
 *
 * 这里只做三件事：把设置写进本地配置、把"雇佣"翻译成"远端 agent + 本地 agents 行
 * + 雇佣契约"、把"解雇"翻译成远端归档 + 本地状态。真正跑对话的是
 * {@link HostedRuntime}，它由组合根创建并交给协调器。
 * @module @ryharness/server/routes/hosted
 */

import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import z from '@ryharness/schemastery'
import {
  type AgentPersona,
  composePersonaPrompt,
  normalizePersona,
  type SessionStore,
  type StoredAgent,
} from '@ryharness/session'
import { PersonaPatchBody } from '../contract/agents.ts'
import type { HostedClient } from '../hosted/client.ts'
import {
  HOSTED_DEFAULT_BASE_URL,
  readHostedApiKey,
  readHostedConfig,
  writeHostedApiKey,
  writeHostedConfig,
} from '../hosted/config.ts'
import type { HostedRuntime } from '../hosted/service.ts'
import { withBody } from '../route.ts'
import { type Handler, HttpRequestError, json } from '../router.ts'

/** 雇佣对话框的默认模型（远端不指定时用它）。 */
const DEFAULT_HOSTED_MODEL = 'kimi-k3.1-pro'

/** 路由依赖。 */
export interface HostedRouteDeps {
  dataDir: string
  store: SessionStore
  runtime: HostedRuntime
  /** 现取客户端：设置页改完 Key 之后下一次调用就该用新的。 */
  client: () => HostedClient
}

const SettingsBody = z.object({
  apiKey: z.string(),
  baseUrl: z.string(),
  environmentId: z.string(),
})

const HireBody = z.object({
  source: z.string(),
  remoteAgentId: z.string(),
  environmentId: z.string(),
  name: z.string(),
  avatar: z.string(),
  systemPrompt: z.string(),
  model: z.string(),
  persona: PersonaPatchBody,
})

/** 名字不能重：通讯录、群成员选择、气泡署名都按名字认人。 */
function assertNameFree(store: SessionStore, name: string): void {
  const wanted = name.trim().toLowerCase()
  if (wanted.length === 0) return
  const clash = store.listAgents().find((agent) => {
    return agent.name.trim().toLowerCase() === wanted
  })
  if (clash !== undefined) throw new HttpRequestError(409, `已经有叫「${name.trim()}」的成员了，换个名字`)
}

/** 等环境镜像构建完成：最多 90 秒，超时也返回 id（建会话时会给出明确原因）。 */
async function ensureEnvironment(client: HostedClient, dataDir: string): Promise<string> {
  const cached = readHostedConfig(dataDir).environmentId
  if (cached !== undefined) return cached
  const existing = await client.listEnvironments()
  const usable = existing.find((env) => {
    return env.configType === undefined || env.configType === 'cloud'
  })
  if (usable !== undefined && usable.status !== 'failed') {
    writeHostedConfig(dataDir, { environmentId: usable.id })
    return usable.id
  }
  const created = await client.createEnvironment({ name: 'RyHarness 云同事' })
  for (let attempt = 0; attempt < 45; attempt++) {
    const env = await client.getEnvironment(created.id)
    if (env.status === undefined || env.status === 'ready') {
      writeHostedConfig(dataDir, { environmentId: env.id })
      return env.id
    }
    if (env.status === 'failed') throw new HttpRequestError(502, '云环境的镜像构建失败，请到 Kimi 控制台查看')
    await new Promise((resolve) => {
      setTimeout(resolve, 2000)
    })
  }
  writeHostedConfig(dataDir, { environmentId: created.id })
  return created.id
}

/** 创建本地成员行 + 雇佣契约。 */
function bindMember(
  store: SessionStore,
  input: {
    name: string
    avatar?: string
    systemPrompt: string
    model: string
    persona?: Partial<AgentPersona>
    remoteAgentId: string
    environmentId: string
    scope: 'official' | 'custom'
    agentVersion?: string
  },
): { agent: StoredAgent; member: ReturnType<SessionStore['upsertHostedMember']> } {
  assertNameFree(store, input.name)
  const agentId = randomUUID()
  const agent = store.upsertAgent({
    id: agentId,
    name: input.name,
    ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
    systemPrompt: input.systemPrompt,
    provider: 'kimi-hosted',
    model: input.model,
    // 工具在远端；本地这一列只影响设置页的"能力"展示与权限档位反推。
    tools: [],
    persona: input.persona,
    runtime: 'hosted',
    isBuiltin: false,
  })
  const member = store.upsertHostedMember({
    agentId,
    remoteAgentId: input.remoteAgentId,
    environmentId: input.environmentId,
    ...(input.agentVersion === undefined ? {} : { agentVersion: input.agentVersion }),
    scope: input.scope,
    status: 'active',
  })
  return { agent, member }
}

/** 处理函数集合。 */
export function createHostedHandlers(deps: HostedRouteDeps) {
  const status = async (_req: unknown, res: ServerResponse): Promise<void> => {
    const config = readHostedConfig(deps.dataDir)
    json(res, 200, {
      configured: readHostedApiKey(deps.dataDir) !== undefined,
      baseUrl: config.baseUrl ?? HOSTED_DEFAULT_BASE_URL,
      ...(config.environmentId === undefined ? {} : { environmentId: config.environmentId }),
      members: deps.store.listHostedMembers(),
      sessions: deps.store.listHostedSessions(),
    })
  }

  const updateSettings = withBody({ body: SettingsBody }, async (req, res) => {
    const input = await req.body()
    if (input.apiKey !== undefined) {
      if (typeof input.apiKey !== 'string') throw new HttpRequestError(400, 'apiKey 必须是字符串')
      writeHostedApiKey(deps.dataDir, input.apiKey.trim())
    }
    if (input.baseUrl !== undefined) {
      if (typeof input.baseUrl !== 'string') throw new HttpRequestError(400, 'baseUrl 必须是字符串')
      const value = input.baseUrl.trim()
      if (value.length === 0) writeHostedConfig(deps.dataDir, { baseUrl: undefined })
      else if (!/^https?:\/\//i.test(value)) throw new HttpRequestError(400, 'baseUrl 必须是 http(s) 地址')
      else writeHostedConfig(deps.dataDir, { baseUrl: value })
    }
    if (input.environmentId !== undefined) {
      if (typeof input.environmentId !== 'string') throw new HttpRequestError(400, 'environmentId 必须是字符串')
      const value = input.environmentId.trim()
      writeHostedConfig(deps.dataDir, value.length === 0 ? { environmentId: undefined } : { environmentId: value })
    }
    const config = readHostedConfig(deps.dataDir)
    json(res, 200, {
      configured: readHostedApiKey(deps.dataDir) !== undefined,
      baseUrl: config.baseUrl ?? HOSTED_DEFAULT_BASE_URL,
      ...(config.environmentId === undefined ? {} : { environmentId: config.environmentId }),
    })
  })

  /** 远端正版清单：没配 Key 时也给 200，让界面能显示"去配置"而不是一条 500。 */
  const catalog: Handler = async (_req, res) => {
    if (readHostedApiKey(deps.dataDir) === undefined) {
      json(res, 200, { configured: false, agents: [], environments: [] })
      return
    }
    try {
      const client = deps.client()
      const [agents, environments] = await Promise.all([client.listAgents(), client.listEnvironments()])
      json(res, 200, { configured: true, agents, environments })
    } catch (error) {
      json(res, 200, {
        configured: true,
        agents: [],
        environments: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const hire = withBody({ body: HireBody }, async (req, res) => {
    if (readHostedApiKey(deps.dataDir) === undefined) {
      throw new HttpRequestError(409, '还没配置 Kimi Open Platform 的 API Key')
    }
    const input = await req.body()
    const source = input.source
    if (source !== 'official' && source !== 'custom') {
      throw new HttpRequestError(400, 'source 只能是 official 或 custom')
    }
    const client = deps.client()
    const environmentId =
      typeof input.environmentId === 'string' && input.environmentId.length > 0
        ? input.environmentId
        : await ensureEnvironment(client, deps.dataDir)
    const model = typeof input.model === 'string' && input.model.length > 0 ? input.model : DEFAULT_HOSTED_MODEL
    const persona = input.persona

    if (source === 'official') {
      if (typeof input.remoteAgentId !== 'string' || input.remoteAgentId.length === 0) {
        throw new HttpRequestError(400, 'official 需要 remoteAgentId')
      }
      const remote = await client.getAgent(input.remoteAgentId)
      const name = typeof input.name === 'string' && input.name.trim().length > 0 ? input.name.trim() : remote.name
      const bound = bindMember(deps.store, {
        name,
        ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
        systemPrompt:
          typeof input.systemPrompt === 'string' && input.systemPrompt.length > 0
            ? input.systemPrompt
            : (remote.description ?? `官方云成员：${remote.name}（配置由 Kimi 维护，只读）`),
        model: remote.model ?? model,
        ...(persona === undefined ? {} : { persona }),
        remoteAgentId: remote.id,
        environmentId,
        scope: 'official',
      })
      writeHostedConfig(deps.dataDir, { defaultAgentId: remote.id })
      json(res, 201, bound)
      return
    }

    const basePrompt =
      typeof input.systemPrompt === 'string' && input.systemPrompt.length > 0
        ? input.systemPrompt
        : '你是一个在云端工作的助理。你能在云沙箱里读写文件、跑命令、上网检索，并把成果作为产物交付。'
    const name = typeof input.name === 'string' && input.name.trim().length > 0 ? input.name.trim() : '云同事'
    assertNameFree(deps.store, name)
    const system = composePersonaPrompt(basePrompt, normalizePersona(persona))
    const remote = await client.createAgent({
      name,
      model: { id: model },
      system,
      description: 'RyHarness 雇佣的云成员',
    })
    const bound = bindMember(deps.store, {
      name,
      ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
      systemPrompt: basePrompt,
      model,
      ...(persona === undefined ? {} : { persona }),
      remoteAgentId: remote.id,
      environmentId,
      scope: 'custom',
      ...(remote.version === undefined ? {} : { agentVersion: remote.version }),
    })
    writeHostedConfig(deps.dataDir, { defaultAgentId: remote.id })
    json(res, 201, bound)
  })

  const fire: Handler = async (req, res) => {
    const agentId = req.params.agentId
    if (agentId === undefined) throw new HttpRequestError(400, '缺少 agentId')
    const member = await deps.runtime.fire(agentId)
    json(res, 200, { member })
  }

  /** 手动对账：界面上的"刷新云会话"按钮。 */
  const sync: Handler = async (_req, res) => {
    await deps.runtime.reconcileAll()
    json(res, 200, { ok: true, sessions: deps.store.listHostedSessions() })
  }

  const sessions: Handler = async (_req, res) => {
    json(res, 200, { sessions: deps.store.listHostedSessions() })
  }

  return { status, updateSettings, catalog, hire, fire, sync, sessions }
}
