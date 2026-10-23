/**
 * Agent 定义路由：CRUD + 内置模板清单。
 * @module @ryharness/server/routes/agents
 */

import type { AgentDefinition } from '@ryharness/agent'
import type { AgentPersona, SessionStore } from '@ryharness/session'
import { VOICE_PRESETS } from '@ryharness/session'
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

/**
 * 名字不能重：通讯录、群成员选择、气泡署名全都按名字认人，两个都叫"CodeBot"
 * 的 Agent 根本没法区分。内置 Agent 也在名单里，所以叫"Ryen"同样被挡。
 *
 * 比较时忽略首尾空白与大小写——"CodeBot" 与 "codebot " 在界面上看着是两个人，
 * 实际上分不清。
 *
 * @param store - 会话存储（读 Agent 列表）
 * @param name - 要检查的名字
 * @param selfId - 自己的 id（改名时排除自己）
 */
function assertNameFree(store: SessionStore, name: string, selfId: string): void {
  const wanted = name.trim().toLowerCase()
  if (wanted.length === 0) return
  const clash = store.listAgents().find((agent) => {
    return agent.id !== selfId && agent.name.trim().toLowerCase() === wanted
  })
  if (clash !== undefined) {
    throw new HttpRequestError(409, `已经有叫「${name.trim()}」的 Agent 了，换个名字`)
  }
}

/** POST/PATCH 共用的 agent 字段白名单校验：类型不符抛 400，未知键丢弃。 */
function agentFieldOverrides(
  body: unknown,
): Partial<Omit<AgentDefinition, 'id' | 'isBuiltin'>> & { persona?: Partial<AgentPersona> } {
  const overrides: Partial<Omit<AgentDefinition, 'id' | 'isBuiltin'>> & { persona?: Partial<AgentPersona> } = {}
  if (typeof body !== 'object' || body === null) return overrides
  const record = body as Record<string, unknown>
  for (const key of ['name', 'avatar', 'systemPrompt', 'provider', 'model', 'reasoningEffort'] as const) {
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
  if (record.persona !== undefined) {
    overrides.persona = personaOverrides(record.persona)
  }
  return overrides
}

/** 人格字段：按 partial 收，类型不对抛 400。归一在存储层做（缺字段按旧值/默认值补）。 */
function personaOverrides(value: unknown): Partial<AgentPersona> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpRequestError(400, 'field "persona" must be an object')
  }
  const record = value as Record<string, unknown>
  const persona: Partial<AgentPersona> = {}
  for (const key of ['extroversion', 'rigor', 'humor', 'initiative', 'affinity'] as const) {
    const trait = record[key]
    if (trait === undefined) continue
    if (typeof trait !== 'number' || !Number.isFinite(trait)) {
      throw new HttpRequestError(400, `persona.${key} must be a finite number`)
    }
    persona[key] = trait
  }
  for (const key of ['birthday', 'catchphrase', 'appearance', 'voiceId'] as const) {
    const field = record[key]
    if (field === undefined) continue
    if (typeof field !== 'string') throw new HttpRequestError(400, `persona.${key} must be a string`)
    persona[key] = field
  }
  return persona
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
    // 不写死供应商与模型：新建 agent 默认跟随配置里第一个已配凭据的
    // 供应商，写死 SiliconFlow + DeepSeek 会让"配置了别家服务商"的
    // 用户建出来的 agent 直接不可用。
    // 模板不存在是**调用方**的错（400），但落库失败不是（500）——所以只把
    // instantiateTemplate 包起来，不整段 catch：那正是此前把数据库写失败也
    // 报成 400 的根源。
    const fallback = resolveSidecarLlm(deps.providers)
    let definition: AgentDefinition
    let persona: Partial<AgentPersona> | undefined = overrides.persona
    if (templateKey !== undefined) {
      try {
        // 模板的默认 provider/model 是写死的那一家（模板要能在**没有任何供应商**
        // 配置时也能落库）。但用户已经配好别家时，照抄模板就等于建出一个用不了的
        // 助理——所以这两个字段在用户没显式指定时，改跟"第一个有凭据的供应商"。
        const instantiated = instantiateTemplate(templateKey, {
          ...overrides,
          ...(overrides.provider === undefined && fallback !== undefined ? { provider: fallback.providerId } : {}),
          ...(overrides.model === undefined && fallback !== undefined ? { model: fallback.model } : {}),
        })
        definition = instantiated
        persona =
          overrides.persona === undefined ? instantiated.persona : { ...instantiated.persona, ...overrides.persona }
      } catch (error) {
        throw new HttpRequestError(400, error instanceof Error ? error.message : String(error))
      }
    } else {
      definition = {
        id: strField(body, 'id') ?? crypto.randomUUID(),
        name: overrides.name ?? '未命名 Agent',
        systemPrompt: overrides.systemPrompt ?? '你是一个乐于助人的助手。',
        provider: overrides.provider ?? fallback?.providerId ?? '',
        model: overrides.model ?? fallback?.model ?? '',
        tools: overrides.tools ?? [],
      }
    }
    // **重名要拦住**：通讯录、群成员选择、气泡上全都按名字认人，两个都叫
    // "CodeBot"的 Agent 根本没法区分。内置 Agent 也在名单里，所以叫"Ryen"
    // 同样会被挡下。
    // 没给名字又没给模板时用的是占位名「未命名 Agent」——那是服务端的默认值，
    // 不是用户挑的名字，不拿来当重名的由头（界面那边总是会传名字）。
    if (templateKey !== undefined || overrides.name !== undefined) {
      assertNameFree(store, definition.name, definition.id)
    }
    const stored = store.upsertAgent({
      ...definition,
      ...(persona === undefined ? {} : { persona }),
      isBuiltin: false,
    })
    json(res, 201, { agent: stored })
  })
  router.patch('/api/agents/:id', async (req, res) => {
    const existing = store.getAgent(req.params.id as string)
    if (existing === undefined) {
      json(res, 404, { error: `agent not found: ${req.params.id}` })
      return
    }
    // 与 POST 同款白名单：类型不符 400（dispatch 统一捕获），未知键丢弃。
    // persona 只在 body 给了时才写：不给就得原样留着旧值（含亲密度）。
    const overrides = agentFieldOverrides(await req.body())
    const merged: AgentDefinition = {
      ...existing,
      ...overrides,
      id: existing.id,
      isBuiltin: existing.isBuiltin,
    }
    // 改名也要查重：编辑一个 Agent 时把它改成别人的名字，同样会让列表认不出人。
    if (overrides.name !== undefined) {
      assertNameFree(store, merged.name, existing.id)
    }
    json(res, 200, {
      agent: store.upsertAgent({
        ...merged,
        ...(overrides.persona === undefined ? {} : { persona: { ...existing.persona, ...overrides.persona } }),
      }),
    })
  })

  /**
   * 亲密度原始入口：按 nextAffinity 的同一套规则加减速（对话轮数由协调器直接调
   * store，不走 HTTP）。界面上的 👍/👎 不从这里走——/api/feedback 接受反馈后内联
   * bump（反馈被接受才涨，且按 messageId+signal 去重）；这条留给手动调参与外部脚本。
   * 回包是更新后的 agent——界面据此刷新卡片上的亲密度，不用再拉一次列表。
   */
  router.post('/api/agents/:id/affinity', async (req, res) => {
    const body = await req.body()
    const signal = strField(body, 'signal')
    if (signal !== 'thumb_up' && signal !== 'thumb_down') {
      json(res, 400, { error: 'signal(thumb_up|thumb_down) is required' })
      return
    }
    const agent = store.bumpAgentAffinity(req.params.id as string, {
      ...(signal === 'thumb_up' ? { likes: 1 } : { dislikes: 1 }),
    })
    if (agent === undefined) {
      json(res, 404, { error: `agent not found: ${req.params.id}` })
      return
    }
    json(res, 200, { agent })
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

  /**
   * 旧版音色清单：`none` + @ryharness/voice 的实测目录（由 session 派生）。
   *
   * 新界面走 GET /api/voice/catalog（带引擎可用性与试听句）；这条留给旧客户端与
   * 外部脚本，返回的 id 与目录同源，不会出现两套命名。
   */
  router.get('/api/agent-voices', async (_req, res) => {
    json(res, 200, { voices: VOICE_PRESETS })
  })
}
