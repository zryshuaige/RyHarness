/**
 * 主动消息（每日回顾）：一天一次、关闭后不发、没有内容就安静，以及内容确实来自
 * 内核的真实数据。
 *
 * 时间全部走假时钟（只假 Date，定时器是真的）：服务内部还要真的跑 setInterval 与
 * HTTP，请求侧不能用全假定时器。要断言的判据是**事实**：消息条数、会话列表里的
 * 标记块、以及 GET /api/proactive 的观测字段。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@ryharness/cordis'
import type { EvolveService } from '@ryharness/evolve'
import { EvolveService as EvolveServiceImpl } from '@ryharness/evolve'
import type { GenerateOptions, StreamChunk } from '@ryharness/llm'
import { LlmAdapter } from '@ryharness/llm'
import { MemoryService as MemoryServiceImpl } from '@ryharness/memory'
import type { ServerOptions } from '@ryharness/server'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeProactiveMessage, localDayKey, PROACTIVE_BLOCK_TYPE } from '../src/proactive.ts'

const tmpDirs: string[] = []
const running: RyHarnessServer[] = []

function tempDataDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ryharness-proactive-${prefix}-`))
  tmpDirs.push(dir)
  return dir
}

/** 只假 Date：定时器保持真身，否则 HTTP 与 setInterval 都跑不起来。 */
function freezeAt(isoLocal: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(isoLocal))
}

/**
 * 轮询到条件成立（最多 attempts 次 × delayMs）。
 *
 * 不能用 Date.now() 算超时——时钟正是被假掉的那一个，真用它会永远等不到超时。
 */
async function waitFor(condition: () => boolean | Promise<boolean>, attempts = 200, delayMs = 10): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await condition()) return
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs)
    })
  }
  expect(await condition()).toBe(true)
}

/** 睡够 N 个检查周期（定时器是真的：真的等它们跑过去）。 */
async function ticks(intervalMs: number, rounds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, intervalMs * rounds + 30)
  })
}

class QuietAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'Quiet' }
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: '好' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '好' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

interface ConversationRow {
  id: string
  title: string
  kind: string
  memberAgentIds: string[]
  lastMessagePreview?: string
  unreadCount?: number
  proactive?: boolean
}

interface MessageRow {
  id: string
  senderType: string
  senderId?: string
  contentBlocks: { type: string; text?: string }[]
  createdAt: number
}

async function getJson(base: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`)
  return (await response.json()) as Record<string, unknown>
}

async function patchJson(
  base: string,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function conversationsOf(base: string): Promise<ConversationRow[]> {
  return (await getJson(base, '/api/conversations')).conversations as ConversationRow[]
}

/** Ryen 单聊里的消息（会话不存在时回空数组——「还没说过话」也是一种状态）。 */
async function ryenMessages(base: string): Promise<MessageRow[]> {
  const chat = (await conversationsOf(base)).find((row) => {
    return row.kind === 'direct' && row.memberAgentIds.length === 1 && row.memberAgentIds[0] === 'ryen'
  })
  if (chat === undefined) return []
  return (await getJson(base, `/api/conversations/${chat.id}/messages?limit=50`)).messages as MessageRow[]
}

/** 起一个服务；记忆与进化可以由调用方先塞进数据再传进来。 */
async function startServer(
  options: {
    dataDir?: string
    memory?: MemoryServiceImpl | null
    evolution?: EvolveServiceImpl | null
  } & Partial<ServerOptions> = {},
): Promise<{ server: RyHarnessServer; memory?: MemoryServiceImpl; evolution?: EvolveServiceImpl }> {
  const dataDir = options.dataDir ?? tempDataDir('server')
  const server = await RyHarnessServer.create({
    port: 0,
    dataDir,
    memory: options.memory === undefined ? null : options.memory,
    evolution: options.evolution === undefined ? null : options.evolution,
    consolidationIntervalMs: 0,
    proactiveIntervalMs: 20,
    mountLlm: (ctx: Context) => {
      ctx.llm.registerAdapter(['mock'], new QuietAdapter())
    },
    ...options,
  })
  running.push(server)
  return {
    server,
    ...(options.memory === undefined || options.memory === null ? {} : { memory: options.memory }),
    ...(options.evolution === undefined || options.evolution === null ? {} : { evolution: options.evolution }),
  }
}

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close()
  vi.useRealTimers()
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

describe('回顾文案：只说事实，没内容就不说话', () => {
  it('一个事实都没有时不合成任何文案（安静优先）', () => {
    expect(
      composeProactiveMessage({ playbookNew: [], memories: { total: 0, samples: [] }, unread: [] }),
    ).toBeUndefined()
    // 巩固跑过但一条都没处理，也不值得说一句——那不是「有话要说」。
    expect(
      composeProactiveMessage({
        playbookNew: [],
        consolidation: { mergedMemories: 0, archivedDormant: 0, expiredReflections: 0 },
        memories: { total: 0, samples: [] },
        unread: [],
      }),
    ).toBeUndefined()
  })

  it('每条数据对应一行，行里的数字就是给的那个数字', () => {
    const text = composeProactiveMessage(
      {
        playbookNew: [{ label: 'strategy', content: '先复述一遍需求再动手' }],
        consolidation: { mergedMemories: 3, archivedDormant: 2, expiredReflections: 0 },
        memories: { total: 2, samples: [{ label: 'ryen', content: '咖啡机在阳台左边' }] },
        unread: [{ title: '阿码', count: 2 }],
      },
      new Date('2026-03-02T09:30:00').getTime(),
    )
    expect(text).toBeDefined()
    expect(text).toContain('早上好')
    expect(text).toContain('经验手册新增 1 条：「先复述一遍需求再动手」')
    // 归档数与合并数各归各；0 条的过期教训整行不出现。
    expect(text).toContain('合并了 3 条重复记忆、归档了 2 条久未使用的记忆')
    expect(text).not.toContain('过期教训')
    expect(text).toContain('新记住了 2 条：「咖啡机在阳台左边」')
    expect(text).toContain('「阿码」2 条')
  })

  it('本地日期键只看哪一天，不看时刻（判重的口径）', () => {
    expect(localDayKey(new Date('2026-03-02T00:30:00').getTime())).toBe('2026-03-02')
    expect(localDayKey(new Date('2026-03-02T23:59:00').getTime())).toBe('2026-03-02')
    expect(localDayKey(new Date('2026-03-03T00:01:00').getTime())).toBe('2026-03-03')
  })
})

describe('启动那一次：有内容就发', () => {
  it('把真实发生的事写成一条带标记块的 assistant 消息，落在 Ryen 的单聊里', async () => {
    freezeAt('2026-03-02T09:30:00')
    const dataDir = tempDataDir('facts')
    // 先把「昨天发生的事」摆好：一条新记忆 + 一条经验手册条目（都要在服务起来之前，
    // 启动检查就在 create() 里跑，晚一步就轮不到这一轮窗口了）。
    const memory = new MemoryServiceImpl({ dbPath: join(dataDir, 'ryharness.db') })
    memory.store.insert({ agentId: 'ryen', kind: 'fact', content: '咖啡机在阳台左边' })
    const evolution = new EvolveServiceImpl({ dbPath: join(dataDir, 'ryharness.db') })
    evolution.store.insertEntry({ agentId: 'ryen', section: 'strategy', content: '先复述一遍需求再动手' })

    const { server } = await startServer({ dataDir, memory, evolution })

    const messages = await ryenMessages(server.url)
    expect(messages).toHaveLength(1)
    const message = messages[0] as MessageRow
    expect(message.senderType).toBe('agent')
    expect(message.senderId).toBe('ryen')
    // 标记块是独立于正文的一个块：正文里不该混进任何哨兵字符串。
    expect(message.contentBlocks[0]?.type).toBe(PROACTIVE_BLOCK_TYPE)
    const text = message.contentBlocks.find((block) => block.type === 'text')?.text ?? ''
    expect(text).toContain('咖啡机在阳台左边')
    expect(text).toContain('先复述一遍需求再动手')
    expect(text).not.toContain(PROACTIVE_BLOCK_TYPE)

    // 未读回顾也会带上：另一个会话里 agent 说过话且用户没读。
    const other = await getJson(server.url, '/api/conversations')
    expect((other as { conversations: unknown[] }).conversations).toHaveLength(1)
  })

  it('别的会话里有未读时，回顾里报出来的那一条是真有未读', async () => {
    freezeAt('2026-03-02T07:00:00')
    const dataDir = tempDataDir('unread')
    const memory = new MemoryServiceImpl({ dbPath: join(dataDir, 'ryharness.db') })
    const { server } = await startServer({ dataDir, memory })
    // 启动那一刻还没有任何未读（检查是无内容的静默通过），补一条再把时钟拨到发送时刻。
    const coding = server.store.createConversation({
      kind: 'direct',
      title: '阿码',
      memberAgentIds: ['ryen-team-coding'],
    })
    server.store.appendMessage({
      conversationId: coding.id,
      senderType: 'agent',
      senderId: 'ryen-team-coding',
      contentBlocks: [{ type: 'text', text: '脚本写好了，跑一下就能看' }],
      turnIndex: 0,
    })

    vi.setSystemTime(new Date('2026-03-02T09:05:00'))
    await ticks(20, 5)

    const messages = await ryenMessages(server.url)
    expect(messages).toHaveLength(1)
    const text = messages[0]?.contentBlocks.find((block) => block.type === 'text')?.text ?? ''
    expect(text).toContain('「阿码」1 条')
  })
})

describe('一天一次', () => {
  it('启动那一次先发；同一天再查也不重发，跨到第二天且过了发送时刻才发第二条', async () => {
    freezeAt('2026-03-02T07:00:00')
    const dataDir = tempDataDir('daily')
    const memory = new MemoryServiceImpl({ dbPath: join(dataDir, 'ryharness.db') })
    memory.store.insert({ agentId: 'ryen', kind: 'fact', content: '咖啡机在阳台左边' })
    const { server } = await startServer({ dataDir, memory })
    // 启动那一次不等发送时刻：应用刚起来就该把上一次的回顾补上。
    expect(await ryenMessages(server.url)).toHaveLength(1)

    // 同一天的十几次检查：一条都不许再多。
    for (const hour of [8, 9, 13, 19, 23]) {
      vi.setSystemTime(new Date(`2026-03-02T${String(hour).padStart(2, '0')}:30:00`))
      await ticks(20, 2)
    }
    expect(await ryenMessages(server.url)).toHaveLength(1)

    // 第二天：默认九点之前不发（发送时刻那一档还没到）。
    vi.setSystemTime(new Date('2026-03-03T08:00:00'))
    await ticks(20, 4)
    expect(await ryenMessages(server.url)).toHaveLength(1)
    expect((await getJson(server.url, '/api/proactive')).sentToday).toBe(false)

    // 第二天真有新东西（新记住一条），过发送时刻才发第二条。
    memory.store.insert({ agentId: 'ryen', kind: 'fact', content: '备用钥匙在玄关第二个抽屉' })
    vi.setSystemTime(new Date('2026-03-03T09:05:00'))
    await waitFor(async () => {
      return (await ryenMessages(server.url)).length === 2
    })
    // 两条都在同一个单聊里，没有另起炉灶。
    const chat = (await conversationsOf(server.url)).find((row) => row.memberAgentIds[0] === 'ryen')
    expect(await ryenMessages(server.url)).toHaveLength(2)
    expect((await conversationsOf(server.url)).filter((row) => row.kind === 'direct')).toHaveLength(1)
    expect(chat?.proactive).toBe(true)
  })
})

describe('没有内容就安静', () => {
  it('记忆与进化都关闭、也没有未读时，一天里发不出任何消息', async () => {
    freezeAt('2026-03-02T09:30:00')
    const { server } = await startServer()
    await ticks(20, 8)

    // 连会话都不建：没有话说的时候不凭空造一个会话出来。
    expect(await conversationsOf(server.url)).toHaveLength(0)
    expect(await ryenMessages(server.url)).toHaveLength(0)
    const status = await getJson(server.url, '/api/proactive')
    expect(status.sentToday).toBe(false)
    expect(status.lastSentAt).toBeUndefined()
  })

  it('时间窗口内的事都发生在上次发送之前，就不再重复报一次', async () => {
    freezeAt('2026-03-02T07:00:00')
    const dataDir = tempDataDir('window')
    const memory = new MemoryServiceImpl({ dbPath: join(dataDir, 'ryharness.db') })
    memory.store.insert({ agentId: 'ryen', kind: 'fact', content: '咖啡机在阳台左边' })
    const { server } = await startServer({ dataDir, memory })
    vi.setSystemTime(new Date('2026-03-02T09:05:00'))
    await ticks(20, 5)
    expect(await ryenMessages(server.url)).toHaveLength(1)

    // 第二天：上一条记忆落在「上次发送」之前，窗口里没有新东西 → 安静。
    vi.setSystemTime(new Date('2026-03-03T09:05:00'))
    await ticks(20, 6)
    expect(await ryenMessages(server.url)).toHaveLength(1)
    expect((await getJson(server.url, '/api/proactive')).sentToday).toBe(false)
  })
})

describe('用户可以关掉', () => {
  it('启动就关掉：连启动那一次也不发', async () => {
    freezeAt('2026-03-02T09:30:00')
    const dataDir = tempDataDir('off')
    const memory = new MemoryServiceImpl({ dbPath: join(dataDir, 'ryharness.db') })
    memory.store.insert({ agentId: 'ryen', kind: 'fact', content: '咖啡机在阳台左边' })
    const { server } = await startServer({ dataDir, memory, proactive: false })

    await ticks(20, 6)
    expect(await ryenMessages(server.url)).toHaveLength(0)
    expect((await getJson(server.url, '/api/proactive')).enabled).toBe(false)
  })

  it('运行中关掉：之后几天都不再发', async () => {
    freezeAt('2026-03-02T07:00:00')
    const dataDir = tempDataDir('off-later')
    const memory = new MemoryServiceImpl({ dbPath: join(dataDir, 'ryharness.db') })
    const { server } = await startServer({ dataDir, memory })
    memory.store.insert({ agentId: 'ryen', kind: 'fact', content: '咖啡机在阳台左边' })
    vi.setSystemTime(new Date('2026-03-02T09:05:00'))
    await ticks(20, 5)
    expect(await ryenMessages(server.url)).toHaveLength(1)

    const patched = await patchJson(server.url, '/api/proactive', { enabled: false })
    expect(patched.status).toBe(200)
    expect(patched.body.enabled).toBe(false)

    // 第二天照旧检查：关了就是不发。
    vi.setSystemTime(new Date('2026-03-03T09:05:00'))
    await ticks(20, 6)
    expect(await ryenMessages(server.url)).toHaveLength(1)

    // 关掉的那份设置落盘了：重启也不会又自己打开。
    // 重新起一个服务（新的记忆连接），并补一条新内容——真发出去才说明设置没留住。
    const restartedMemory = new MemoryServiceImpl({ dbPath: join(dataDir, 'ryharness.db') })
    restartedMemory.store.insert({ agentId: 'ryen', kind: 'fact', content: '换机之后重新学到的偏好' })
    const restarted = await startServer({ dataDir, memory: restartedMemory })
    await ticks(20, 4)
    expect((await getJson(restarted.server.url, '/api/proactive')).enabled).toBe(false)
    expect(await ryenMessages(restarted.server.url)).toHaveLength(1)
  })
})

describe('观测面', () => {
  it('GET /api/proactive 回答「上次什么时候发的、今天发过没有」', async () => {
    freezeAt('2026-03-02T07:00:00')
    const dataDir = tempDataDir('observe')
    const memory = new MemoryServiceImpl({ dbPath: join(dataDir, 'ryharness.db') })
    const { server } = await startServer({ dataDir, memory })

    // 启动那一刻还没发生任何事：快照如实说「今天还没发」。
    const before = await getJson(server.url, '/api/proactive')
    expect(before).toEqual({
      enabled: true,
      hour: 9,
      intervalMs: 20,
      sentToday: false,
    })

    memory.store.insert({ agentId: 'ryen', kind: 'fact', content: '咖啡机在阳台左边' })
    vi.setSystemTime(new Date('2026-03-02T09:05:00'))
    await ticks(20, 5)

    const after = await getJson(server.url, '/api/proactive')
    expect(after.sentToday).toBe(true)
    expect(after.lastSentDay).toBe('2026-03-02')
    expect(after.lastSentAt).toBe(new Date('2026-03-02T09:05:00').getTime())
    const chat = (await conversationsOf(server.url)).find((row) => row.memberAgentIds[0] === 'ryen')
    expect(after.conversationId).toBe(chat?.id)

    // 同一份快照也挂在遥测上：不必为了这个问题再发一条请求。
    const telemetry = await getJson(server.url, '/api/telemetry')
    expect((telemetry.proactive as { sentToday: boolean }).sentToday).toBe(true)
    expect(Array.isArray(telemetry.turns)).toBe(true)
  })

  it('PATCH 只认 enabled 与 hour，写错的键与越界的时刻回 400', async () => {
    const { server } = await startServer()
    expect((await patchJson(server.url, '/api/proactive', { hour: 21 })).body.hour).toBe(21)
    expect((await getJson(server.url, '/api/proactive')).hour).toBe(21)
    expect((await patchJson(server.url, '/api/proactive', { enabled: 'yes' })).status).toBe(400)
    expect((await patchJson(server.url, '/api/proactive', { hour: 24 })).status).toBe(400)
    expect((await patchJson(server.url, '/api/proactive', { unknown: 1 })).status).toBe(400)
    // 敲错的键不该把上一次改好的设置带回去。
    expect((await getJson(server.url, '/api/proactive')).hour).toBe(21)
  })
})
