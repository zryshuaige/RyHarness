/**
 * Agent 定义路由：CRUD + 内置模板清单。
 * @module @ryagent/server/routes/agents
 */

import type { AgentDefinition } from '@ryagent/agent'
import type { SessionStore } from '@ryagent/session'
import type { ProvidersConfigFile } from '../config.ts'
import { resolveSidecarLlm } from '../config.ts'
import { HttpRequestError, json, type Router, strField } from '../router.ts'
import { AGENT_TEMPLATES, instantiateTemplate } from '../seed.ts'

/** Agent 路由的依赖。 */
export interface AgentRoutes {
  store: SessionStore
  /** 进程内的供应商配置（新建 agent 时据此挑默认供应商/模型）。 */
  providers: ProvidersConfigFile
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

/** Agent 定义与模板清单的路由。 */
export function registerAgentRoutes(router: Router, deps: AgentRoutes): void {
  const { store } = deps

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
      const fallback = resolveSidecarLlm(deps.providers)
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
}
