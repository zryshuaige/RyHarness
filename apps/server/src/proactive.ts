/**
 * 主动消息（每日回顾）：把内核已有的产物外化成一条用户能看见的 assistant 消息。
 *
 * 固化、反思、巩固、记忆抽取全都在后台跑，界面上一个数字都看不到——本地优先的
 * 产品最难证明的一件事恰恰是「它真的住在你电脑里」。这里每天挑一次，把**确实
 * 发生过**的变化（手册里新增了什么、记住了几条、巩固合并了多少、哪个会话还没看）
 * 写成一条 assistant 消息，落在用户与 Ryen 的单聊里。
 *
 * 三条硬规则：
 * 1. **内容只来自内核已有的数据**（{@link collectProactiveFacts}）：一个数字都对不上
 *    就整条不发。凭空写一句「今天学到了很多」比不发更糟——那是编的。
 * 2. **一天一次**，判重按**本地日期**而不是「距上次满 24 小时」：后者会让凌晨启动的
 *    应用在同一天发两次。
 * 3. **安静优先**：没内容就不发（{@link composeProactiveMessage} 返回 undefined），
 *    「今天没什么新鲜的」这种凑数句只会让人觉得吵。
 * @module @ryagent/server/proactive
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConsolidationResult, EvolveService } from '@ryagent/evolve'
import type { MemoryService } from '@ryagent/memory'
import type { Conversation, SessionStore } from '@ryagent/session'

/** 主动消息的发言者：内置总管 Ryen（只跟它单聊，不打扰别的小队成员）。 */
export const PROACTIVE_AGENT_ID = 'ryen'

/**
 * 主动消息在 `contentBlocks` 里的标记块类型。
 *
 * 刻意做成一个**独立于 text 的块**而不是正文里的哨兵字符串：正文要原样喂给模型
 * （Ryen 要看得见自己说过什么），哨兵会跟着进 prompt；而未知类型的块在各家的
 * 序列化器里都会被安静忽略（只取 text 块），正文仍然是干净的全文。
 */
export const PROACTIVE_BLOCK_TYPE = 'proactive'

/** 主动消息的设置文件（<dataDir>/proactive.json）。 */
const PROACTIVE_SETTINGS_FILE = 'proactive.json'

/** 首次主动消息之前，回顾的默认时间窗（毫秒）：最近 24 小时。 */
export const PROACTIVE_DEFAULT_WINDOW_MS = 24 * 3_600_000

/** 默认发送时刻（本地小时）：早上九点。错过这一档就在当天后面的检查里补发。 */
export const DEFAULT_PROACTIVE_HOUR = 9

/** 默认检查间隔（毫秒）：半小时一次，够细又不至于变成轮询。 */
export const DEFAULT_PROACTIVE_INTERVAL_MS = 30 * 60_000

/** 主动消息的设置（落盘；缺省即默认开）。 */
export interface ProactiveSettings {
  /** 关闭后连启动那一次也不发。 */
  enabled: boolean
  /** 每日发送时刻（本地小时 0-23）。 */
  hour: number
}

/** 默认设置：开。 */
export const DEFAULT_PROACTIVE_SETTINGS: ProactiveSettings = { enabled: true, hour: DEFAULT_PROACTIVE_HOUR }

/** GET /api/proactive 与 /api/telemetry.proactive 的形状。 */
export interface ProactiveSnapshot {
  /** 是否启用（关掉后一次都不发）。 */
  enabled: boolean
  /** 每日发送时刻（本地小时 0-23）。 */
  hour: number
  /** 检查间隔（毫秒）；0 = 只有启动那一次，没有定时检查。 */
  intervalMs: number
  /** 上次发出主动消息的时刻；缺省 = 本次运行还没发过。 */
  lastSentAt?: number
  /** 上次发送那天的本地日期键（YYYY-MM-DD），判重用。 */
  lastSentDay?: string
  /** 今天是否已经发过（判重的真值，重启后重置为 false）。 */
  sentToday: boolean
  /** 消息落在哪个会话；还没发过时缺省。 */
  conversationId?: string
}

/** 一次主动消息发送的结果。 */
export interface ProactiveRun {
  /** 是否真的发出了一条消息（false = 被设置挡下 / 今天已发 / 没有内容）。 */
  sent: boolean
  /** 不发送的原因（sent=true 时缺省）：`disabled` | `already-sent` | `before-hour` | `empty` | `no-agent` */
  reason?: string
  conversationId?: string
  messageId?: string
}

/** 本地日期键（YYYY-MM-DD）：判重只看「哪一天」，不看具体时刻。 */
export function localDayKey(now: number = Date.now()): string {
  const date = new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 时刻问候（与渲染层欢迎页同一套口径，两个运行时各留一份纯函数）。 */
function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 11) return '早上好'
  if (hour >= 11 && hour < 14) return '中午好'
  if (hour >= 14 && hour < 18) return '下午好'
  if (hour >= 18) return '晚上好'
  return '夜深了'
}

/** 读取落盘设置：文件缺失或损坏时按默认起（坏设置不该让服务起不来）。 */
export function loadProactiveSettings(dataDir: string): ProactiveSettings {
  const path = join(dataDir, PROACTIVE_SETTINGS_FILE)
  if (!existsSync(path)) return { ...DEFAULT_PROACTIVE_SETTINGS }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { enabled?: unknown; hour?: unknown }
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_PROACTIVE_SETTINGS.enabled,
      hour: isProactiveHour(parsed.hour) ? parsed.hour : DEFAULT_PROACTIVE_SETTINGS.hour,
    }
  } catch {
    return { ...DEFAULT_PROACTIVE_SETTINGS }
  }
}

/** 落盘设置（原子写：先 .tmp 再 rename）。 */
export function saveProactiveSettings(dataDir: string, settings: ProactiveSettings): void {
  const path = join(dataDir, PROACTIVE_SETTINGS_FILE)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/** 发送时刻是否合法（0-23 的整数）。 */
export function isProactiveHour(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23
}

/** 一条「新学到的东西」样本（带一句人话的标签，正文可能很长，展示前要截断）。 */
export interface ProactiveSample {
  label: string
  content: string
}

/** 收集事实的依赖。 */
export interface ProactiveSources {
  store: SessionStore
  /** undefined = 长期记忆关闭（那一段就当没有，不编）。 */
  memoryService: MemoryService | undefined
  /** undefined = 进化关闭（手册与巩固那一段就没有）。 */
  evolutionService: EvolveService | undefined
  /** 最近一轮巩固的结果与时刻（组合根持有定时器，这里只读）。 */
  lastConsolidation: () => { result: ConsolidationResult; at: number } | undefined
  /** 统计未读时排除的会话（主动消息自己所在的会话）。 */
  excludeConversationId?: string
  /** 窗口起点：上次主动消息的时刻；没有就退回最近 24 小时。 */
  since: number
  now: number
}

/** 一轮回顾用到的全部事实（没有的项留空，不填默认值——空就是「没有」）。 */
export interface ProactiveFacts {
  /** 窗口内新增的经验手册条目；种子条目不算（它不是学到的）。 */
  playbookNew: ProactiveSample[]
  /** 窗口内的巩固结果。 */
  consolidation?: { mergedMemories: number; archivedDormant: number; expiredReflections: number }
  /** 窗口内新记住的长期记忆：总数 + 样本。 */
  memories: { total: number; samples: ProactiveSample[] }
  /** 别的会话里还没看的消息。 */
  unread: { title: string; count: number }[]
}

/** 回顾里最多列几条样本：再多就成流水账了。 */
const MAX_PLAYBOOK_SAMPLES = 2
const MAX_MEMORY_SAMPLES = 2
const MAX_UNREAD_CONVERSATIONS = 3
/** 样本正文的展示长度（超出截断加省略号）。 */
const SAMPLE_MAX_CHARS = 36

/** 截一段样本正文；单行（换行会撑坏气泡里的列表）。 */
function sampleText(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > SAMPLE_MAX_CHARS ? `${flat.slice(0, SAMPLE_MAX_CHARS)}…` : flat
}

/** 会话在列表里的名字（没改名就用成员 agent 的名字，都没有就用 id）。 */
function conversationTitle(store: SessionStore, conversation: Conversation): string {
  if (conversation.title.trim().length > 0) return conversation.title
  const agentId = conversation.memberAgentIds[0]
  if (agentId === undefined) return conversation.id
  return store.getAgent(agentId)?.name ?? agentId
}

/**
 * 从内核的真实数据里收集这一轮回顾的事实。
 *
 * 窗口是「上次主动消息到现在」：同一件事不会被回顾两次，没有上次就看最近 24 小时。
 * 手册条目只认 curator / reflection / manual 三种来源——`seed` 是冷启动时种进去的
 * 模板，把它当成「昨天学到的东西」等于每次启动都报一条假新闻。
 */
export function collectProactiveFacts(sources: ProactiveSources): ProactiveFacts {
  const { store, since, now } = sources
  const inWindow = (at: number): boolean => {
    return at >= since && at <= now
  }

  const playbookNew: ProactiveSample[] = []
  const evolutionService = sources.evolutionService
  if (evolutionService !== undefined) {
    for (const entry of evolutionService.store.listEntries(PROACTIVE_AGENT_ID)) {
      if (entry.source === 'seed') continue
      if (!inWindow(entry.createdAt)) continue
      playbookNew.push({ label: entry.section, content: entry.content })
    }
  }

  const memories: ProactiveFacts['memories'] = { total: 0, samples: [] }
  const memoryService = sources.memoryService
  if (memoryService !== undefined) {
    const rows = [
      ...memoryService.store.listSharedProfile(),
      ...memoryService.store.listActiveForAgent(PROACTIVE_AGENT_ID),
    ].filter((row) => {
      return inWindow(row.createdAt)
    })
    memories.total = rows.length
    memories.samples = rows.slice(0, MAX_MEMORY_SAMPLES).map((row) => {
      return { label: row.agentId, content: row.content }
    })
  }

  const unread: ProactiveFacts['unread'] = []
  for (const conversation of store.listConversations(MAX_UNREAD_CONVERSATIONS * 10)) {
    if (conversation.id === sources.excludeConversationId) continue
    const count = store.unreadCount(conversation.id, conversation.lastReadSeq)
    if (count === 0) continue
    unread.push({ title: conversationTitle(store, conversation), count })
    if (unread.length >= MAX_UNREAD_CONVERSATIONS) break
  }

  const consolidation = sources.lastConsolidation()
  const facts: ProactiveFacts = { playbookNew, memories, unread }
  if (consolidation !== undefined && inWindow(consolidation.at)) {
    facts.consolidation = {
      mergedMemories: consolidation.result.mergedMemories,
      archivedDormant: consolidation.result.archivedDormant,
      expiredReflections: consolidation.result.expiredReflections,
    }
  }
  return facts
}

/**
 * 把事实合成一条消息正文；没有任何可说的事时返回 undefined（安静）。
 *
 * 每一行都对应一个事实项，没有数据的项整行不出现——宁可短，不许出现对不上库里的
 * 数字。开头的问候按时辰选，其余全是陈述句：这条消息是它在**报告事实**，不是在表演
 * 心情。
 */
export function composeProactiveMessage(facts: ProactiveFacts, now: number = Date.now()): string | undefined {
  const lines: string[] = []

  if (facts.playbookNew.length > 0) {
    const samples = facts.playbookNew.slice(0, MAX_PLAYBOOK_SAMPLES).map((entry) => {
      return `「${sampleText(entry.content)}」`
    })
    const rest = facts.playbookNew.length - samples.length
    lines.push(`经验手册新增 ${facts.playbookNew.length} 条：${samples.join('、')}${rest > 0 ? ` 等 ${rest} 条` : ''}`)
  }

  const consolidation = facts.consolidation
  if (consolidation !== undefined) {
    const parts: string[] = []
    if (consolidation.mergedMemories > 0) parts.push(`合并了 ${consolidation.mergedMemories} 条重复记忆`)
    if (consolidation.archivedDormant > 0) parts.push(`归档了 ${consolidation.archivedDormant} 条久未使用的记忆`)
    if (consolidation.expiredReflections > 0) parts.push(`清理了 ${consolidation.expiredReflections} 条过期教训`)
    if (parts.length > 0) lines.push(`巩固跑完，${parts.join('、')}`)
  }

  if (facts.memories.total > 0) {
    const samples = facts.memories.samples.map((memory) => {
      return `「${sampleText(memory.content)}」`
    })
    const rest = facts.memories.total - samples.length
    lines.push(`新记住了 ${facts.memories.total} 条：${samples.join('、')}${rest > 0 ? ` 等 ${rest} 条` : ''}`)
  }

  if (facts.unread.length > 0) {
    const total = facts.unread.reduce((sum, row) => {
      return sum + row.count
    }, 0)
    const titles = facts.unread.map((row) => {
      return `「${row.title}」${row.count} 条`
    })
    lines.push(`你还有 ${total} 条没看：${titles.join('、')}`)
  }

  if (lines.length === 0) return undefined
  const hour = new Date(now).getHours()
  return [`${greetingForHour(hour)}，有几件事想跟你说：`, ...lines.map((line) => `- ${line}`)].join('\n')
}

/** 主动消息调度器的依赖（组合根注入，调度器自己不碰 HTTP）。 */
export interface ProactiveDeps extends Omit<ProactiveSources, 'since' | 'now' | 'excludeConversationId'> {
  dataDir: string
  /** 落盘设置优先；没有落盘设置时才用这里的初始值。 */
  initial?: { enabled?: boolean; hour?: number }
  /** 检查间隔（毫秒）；0 = 不起定时器，只保留启动那一次。 */
  intervalMs?: number
}

/**
 * 主动消息调度器：启动那一次 + 每日定时检查 + 一天一次的判重。
 *
 * 全程同步（读的都是本地 SQLite），因此不存在并发叠加第二轮的可能：定时器回调
 * 里直接做完，不排队也不 await。
 */
export class ProactiveDigest {
  private readonly store: SessionStore
  private readonly memoryService: MemoryService | undefined
  private readonly evolutionService: EvolveService | undefined
  private readonly lastConsolidation: () => { result: ConsolidationResult; at: number } | undefined
  private readonly dataDir: string
  private readonly settings: ProactiveSettings
  private intervalMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private lastSentAt: number | undefined
  private lastSentDay: string | undefined
  private conversationId: string | undefined

  constructor(deps: ProactiveDeps) {
    this.store = deps.store
    this.memoryService = deps.memoryService
    this.evolutionService = deps.evolutionService
    this.lastConsolidation = deps.lastConsolidation
    this.dataDir = deps.dataDir
    this.intervalMs = Math.max(0, Math.trunc(deps.intervalMs ?? DEFAULT_PROACTIVE_INTERVAL_MS))
    // 落盘设置优先于构造参数：用户在设置里关掉的，重启不能又打开。
    const stored = loadProactiveSettings(deps.dataDir)
    this.settings = {
      enabled: deps.initial?.enabled ?? stored.enabled,
      hour: isProactiveHour(deps.initial?.hour) ? deps.initial.hour : stored.hour,
    }
  }

  /** 启动：先补一次（应用刚起来就把昨天的回顾补上），再挂每日定时检查。 */
  start(): void {
    this.runSafely(Date.now(), true)
    if (this.intervalMs === 0) return
    this.timer = setInterval(() => {
      this.runSafely(Date.now(), false)
    }, this.intervalMs)
    // 定时器不拖住进程退出（与 WS 心跳、巩固调度一致）。
    this.timer.unref()
  }

  /**
   * 跑一次检查，但绝不把异常冒给调用方。
   *
   * 主动消息是锦上添花：它挂了（库读不出来、磁盘满）不该把服务带下去，更不该让
   * 启动那一次直接把应用卡在起不来的状态里。失败只记日志，下次检查还会再试。
   */
  private runSafely(now: number, ignoreHour: boolean): ProactiveRun {
    try {
      return this.check(now, ignoreHour)
    } catch (error) {
      console.warn(
        `@ryagent/server: proactive message failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return { sent: false, reason: 'error' }
    }
  }

  /** 停机：清定时器（幂等）。 */
  close(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 当前设置。 */
  getSettings(): ProactiveSettings {
    return { ...this.settings }
  }

  /** 改设置并落盘（设置页与 PATCH 路由共用）。 */
  updateSettings(patch: { enabled?: boolean; hour?: number }): ProactiveSettings {
    if (patch.enabled !== undefined) this.settings.enabled = patch.enabled
    if (isProactiveHour(patch.hour)) this.settings.hour = patch.hour
    saveProactiveSettings(this.dataDir, this.getSettings())
    return this.getSettings()
  }

  /** 观测快照（/api/proactive 与 /api/telemetry 共用同一份，避免两处口径）。 */
  snapshot(now: number = Date.now()): ProactiveSnapshot {
    return {
      enabled: this.settings.enabled,
      hour: this.settings.hour,
      intervalMs: this.intervalMs,
      ...(this.lastSentAt === undefined ? {} : { lastSentAt: this.lastSentAt }),
      ...(this.lastSentDay === undefined ? {} : { lastSentDay: this.lastSentDay }),
      sentToday: this.lastSentDay === localDayKey(now),
      ...(this.conversationId === undefined ? {} : { conversationId: this.conversationId }),
    }
  }

  /**
   * 跑一次检查（同步）。
   *
   * @param ignoreHour 启动那一次：不等配置的发送时刻——应用刚起来就该把上一次的
   *   回顾补上，否则用户要等到当天九点才看见「昨天发生了什么」。
   */
  check(now: number = Date.now(), ignoreHour = false): ProactiveRun {
    if (!this.settings.enabled) return { sent: false, reason: 'disabled' }
    const day = localDayKey(now)
    if (this.lastSentDay === day) return { sent: false, reason: 'already-sent' }
    if (!ignoreHour && new Date(now).getHours() < this.settings.hour) return { sent: false, reason: 'before-hour' }
    // Ryen 是内置 agent（删不掉），但仍以存储为准：它不在场就没有发言的人。
    if (this.store.getAgent(PROACTIVE_AGENT_ID) === undefined) return { sent: false, reason: 'no-agent' }
    const existing = this.findRyenConversation()
    // 窗口从上次发出那一毫秒**之后**起算：与上次同时刻落库的东西已经被报过一次，
    // 再报一遍就成了每天重复的假新闻。
    const since = this.lastSentAt === undefined ? now - PROACTIVE_DEFAULT_WINDOW_MS : this.lastSentAt + 1
    const text = composeProactiveMessage(
      collectProactiveFacts({
        store: this.store,
        memoryService: this.memoryService,
        evolutionService: this.evolutionService,
        lastConsolidation: this.lastConsolidation,
        excludeConversationId: existing?.id,
        since,
        now,
      }),
      now,
    )
    // 没有话说的时候连会话都不建：为了发一句话而在列表里凭空多一个空会话，
    // 比不说更让人困惑。
    if (text === undefined) return { sent: false, reason: 'empty' }
    const conversation = existing ?? this.createRyenConversation()
    const message = this.store.appendMessage({
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: PROACTIVE_AGENT_ID,
      contentBlocks: [
        { type: PROACTIVE_BLOCK_TYPE, day },
        { type: 'text', text },
      ],
      turnIndex: this.store.nextTurnIndex(conversation.id),
    })
    this.lastSentAt = now
    this.lastSentDay = day
    this.conversationId = conversation.id
    return { sent: true, conversationId: conversation.id, messageId: message.id }
  }

  /** 与 Ryen 的单聊（只找，不建）。 */
  private findRyenConversation(): Conversation | undefined {
    return this.store.listConversations(200).find((conversation) => {
      return (
        conversation.kind === 'direct' &&
        conversation.memberAgentIds.length === 1 &&
        conversation.memberAgentIds[0] === PROACTIVE_AGENT_ID
      )
    })
  }

  /**
   * 建一个与 Ryen 的单聊。
   *
   * 首次启动时用户可能一句还没说过，那正是「它主动开口」最该发生的时刻——没有会话
   * 就无处可落。会话标题取 agent 名字，与前端的单聊一致。
   */
  private createRyenConversation(): Conversation {
    return this.store.createConversation({
      kind: 'direct',
      title: this.store.getAgent(PROACTIVE_AGENT_ID)?.name ?? PROACTIVE_AGENT_ID,
      memberAgentIds: [PROACTIVE_AGENT_ID],
    })
  }
}
