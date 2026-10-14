/**
 * 用量账单路由（GET /api/usage）：把消息行上的 token 用量按两个维度聚合。
 *
 * 数据源只有两处：messages.usage（每条 assistant 消息挂一次模型调用的开销）与
 * agents.provider（发言 agent 绑定的供应商路由）。**按会话**与**按供应商**两维
 * 从同一批消息算出，两栏的合计必须能对上——对不上时用户没法判断是数据错了还是
 * 自己看错了。
 * @module @ryagent/server/routes/usage
 */

import type { Conversation, SessionStore, StoredMessage } from '@ryagent/session'
import type { ProvidersConfigFile } from '../config.ts'
import { HttpRequestError, json, type Router } from '../router.ts'
import type { ConversationState } from './conversations.ts'

/** 用量路由的依赖。 */
export interface UsageRoutes {
  store: SessionStore
  /** 进程内的供应商配置（供应商显示名的来源，与 GET /api/providers 同一份）。 */
  providers: ProvidersConfigFile
  /** 会话界面态覆盖（改名另存 JSON，会话表里没有这一列）。 */
  conversationStates: Map<string, ConversationState>
}

/** 按会话聚合的一行。 */
export interface ConversationUsageRow {
  conversationId: string
  title: string
  kind: Conversation['kind']
  input: number
  output: number
  total: number
  /** 带 usage 的消息条数（= 模型调用次数）。 */
  messages: number
}

/** 某家供应商下某个发言 agent 的累计 token。 */
export interface ProviderAgentUsage {
  agentId: string
  name: string
  total: number
}

/** 按供应商聚合的一行（agents 按花费倒序，UI 直接取前几条即可）。 */
export interface ProviderUsageRow {
  provider: string
  displayName: string
  input: number
  output: number
  total: number
  agents: ProviderAgentUsage[]
}

/** GET /api/usage 的返回体。 */
export interface UsageReport {
  byConversation: ConversationUsageRow[]
  byProvider: ProviderUsageRow[]
  totals: { input: number; output: number; total: number }
}

/** 聚合时回看的会话上限（与全文搜索同量级：本地会话表不会超过这个规模）。 */
const MAX_USAGE_CONVERSATIONS = 1000
/** 单页消息条数（store.listMessages 的分页大小）。 */
const USAGE_SCAN_PAGE = 200
/** 每个会话回看的消息条数上限：用量是累计的，窗口得比搜索宽得多。 */
const USAGE_SCAN_PER_CONVERSATION = 5000
/** 发言方查不到 agent 定义时归到的桶（agent 被删了，花费本身仍然成立）。 */
const UNKNOWN_AGENT = 'unknown'
/** 供应商展示名（发给渲染层的中文文案）。 */
const UNKNOWN_PROVIDER_NAME = '未知供应商'

/** 累加器：两个维度共用的口径。 */
interface UsageBucket {
  input: number
  output: number
  total: number
  messages: number
}

/** 供应商聚合过程中的可变状态。 */
interface ProviderBucket extends UsageBucket {
  displayName: string
  agents: Map<string, { name: string; bucket: UsageBucket }>
}

function emptyBucket(): UsageBucket {
  return { input: 0, output: 0, total: 0, messages: 0 }
}

function addInto(target: UsageBucket, row: UsageBucket): void {
  target.input += row.input
  target.output += row.output
  target.total += row.total
  target.messages += row.messages
}

/** 会话标题取界面态视图：改过名的会话在账单里就该显示改后的名字。 */
function titleOf(conversation: Conversation, states: Map<string, ConversationState>): string {
  return states.get(conversation.id)?.title ?? conversation.title
}

/**
 * 单条消息的用量；没有 usage 或落在 since 窗口之外时返回 undefined。
 *
 * total 缺失时按 input+output 兜底——各家供应商回 usage 的字段并不一致，缺
 * total 时把这轮当 0 会让账单凭空少一截。
 */
function usageOf(message: StoredMessage, since: number | undefined): UsageBucket | undefined {
  const usage = message.usage
  if (usage === undefined) return undefined
  if (since !== undefined && message.createdAt < since) return undefined
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    total: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
    messages: 1,
  }
}

/**
 * 扫一个会话的消息（倒序翻页，上限 {@link USAGE_SCAN_PER_CONVERSATION}），
 * 同时产出两个维度：会话合计与每个发言 agent 的花费。
 *
 * store.conversationUsage 是单条 SQL 聚合，但它不带 since 过滤。账单的两维必须
 * 来自同一批消息——一边走 SQL、一边走扫描，迟早会在加总时对不上，所以统一扫描。
 */
function scanConversation(
  store: SessionStore,
  conversationId: string,
  since: number | undefined,
): { bucket: UsageBucket; byAgent: Map<string, UsageBucket> } {
  const bucket = emptyBucket()
  const byAgent = new Map<string, UsageBucket>()
  let scanned = 0
  let beforeSeq: number | undefined
  for (;;) {
    const page = store.listMessages(conversationId, {
      limit: USAGE_SCAN_PAGE,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    })
    if (page.length === 0) break
    for (const message of page) {
      const usage = usageOf(message, since)
      if (usage === undefined) continue
      addInto(bucket, usage)
      const agentId = message.senderId ?? UNKNOWN_AGENT
      let agentBucket = byAgent.get(agentId)
      if (agentBucket === undefined) {
        agentBucket = emptyBucket()
        byAgent.set(agentId, agentBucket)
      }
      addInto(agentBucket, usage)
    }
    scanned += page.length
    const oldest = page[0]
    if (scanned >= USAGE_SCAN_PER_CONVERSATION || oldest === undefined) break
    beforeSeq = oldest.seq
  }
  return { bucket, byAgent }
}

/**
 * 供应商桶：发言 agent → 它绑定的供应商（agent 已删则记未知）。
 *
 * 显示名取自 GET /api/providers 的同一份配置——账单里写路由 id、界面里写
 * "DeepSeek"，两处对不上号，用户没法据此换模型。
 */
function providerBucket(
  providers: ProvidersConfigFile,
  buckets: Map<string, ProviderBucket>,
  providerId: string,
): ProviderBucket {
  const existing = buckets.get(providerId)
  if (existing !== undefined) return existing
  const bucket: ProviderBucket = {
    ...emptyBucket(),
    displayName:
      providerId === UNKNOWN_AGENT
        ? UNKNOWN_PROVIDER_NAME
        : (providers.providers[providerId]?.displayName ?? providerId),
    agents: new Map(),
  }
  buckets.set(providerId, bucket)
  return bucket
}

/** `?since=`：缺省或空串 = 不限；未知参数与非数字/负数回 400。 */
function parseSince(query: URLSearchParams): number | undefined {
  for (const key of query.keys()) {
    if (key !== 'since') throw new HttpRequestError(400, `unknown query parameter: ${key}`)
  }
  const raw = (query.get('since') ?? '').trim()
  if (raw.length === 0) return undefined
  const since = Number(raw)
  if (!Number.isFinite(since) || since < 0) {
    throw new HttpRequestError(400, 'since must be a unix millisecond timestamp')
  }
  return since
}

/**
 * GET /api/usage：按会话与按供应商两维聚合的累计 token。
 *
 * 只回有消耗的会话/供应商——空账本回空数组，不是一屏 0。`?since=<毫秒时间戳>`
 * 把窗口收到该时刻之后（换模型前后比花销看的就是这个增量）。两个维度都按花费
 * 倒序，合计恒等于 totals。
 */
export function registerUsageRoutes(router: Router, deps: UsageRoutes): void {
  const { store } = deps
  router.get('/api/usage', async (req, res) => {
    const since = parseSince(req.query)
    const totals = emptyBucket()
    const byConversation: ConversationUsageRow[] = []
    const providerBuckets = new Map<string, ProviderBucket>()
    for (const conversation of store.listConversations(MAX_USAGE_CONVERSATIONS)) {
      const { bucket, byAgent } = scanConversation(store, conversation.id, since)
      if (bucket.messages === 0) continue
      addInto(totals, bucket)
      byConversation.push({
        conversationId: conversation.id,
        title: titleOf(conversation, deps.conversationStates),
        kind: conversation.kind,
        ...bucket,
      })
      for (const [agentId, agentBucket] of byAgent) {
        const agent = store.getAgent(agentId)
        const target = providerBucket(deps.providers, providerBuckets, agent?.provider ?? UNKNOWN_AGENT)
        addInto(target, agentBucket)
        const entry = target.agents.get(agentId)
        if (entry === undefined) {
          target.agents.set(agentId, { name: agent?.name ?? agentId, bucket: agentBucket })
        } else {
          addInto(entry.bucket, agentBucket)
        }
      }
    }
    const report: UsageReport = {
      byConversation: byConversation.sort((a, b) => {
        return b.total - a.total
      }),
      byProvider: [...providerBuckets]
        .sort((a, b) => {
          return b[1].total - a[1].total
        })
        .map(([provider, bucket]) => {
          return {
            provider,
            displayName: bucket.displayName,
            input: bucket.input,
            output: bucket.output,
            total: bucket.total,
            agents: [...bucket.agents]
              .map(([agentId, entry]) => {
                return { agentId, name: entry.name, total: entry.bucket.total }
              })
              .sort((a, b) => {
                return b.total - a.total
              }),
          }
        }),
      totals: { input: totals.input, output: totals.output, total: totals.total },
    }
    json(res, 200, report)
  })
}
