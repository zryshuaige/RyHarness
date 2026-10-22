/**
 * 主动消息的两处真问题：判重不落盘、定时路径只写库不推 WS。
 *
 * - 判重只在内存里记 → **每次重启都重发当天那份回顾**：用户早上九点收到一次，
 *   中午重启一下应用，下午又收到一次——同一件事说两遍，比不说更糟。
 * - 只往库里写、不推事件 → 用户正开着那个会话也看不到它，得切走再切回来才发现
 *   "它主动找过我"，功能等于没上线。
 *
 * @module @ryharness/server/tests/proactive-persistence
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@ryharness/llm'
import { LlmAdapter } from '@ryharness/llm'
import { MemoryService as MemoryServiceImpl } from '@ryharness/memory'
import type { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startMockServer } from './helpers/server.ts'
import { eventsOfType, watchConversation } from './helpers/ws.ts'

const tmpDirs: string[] = []
const running: RyHarnessServer[] = []

/** 一个新数据目录（重启同一个目录就能测"重启后发生了什么"）。 */
function newDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-proactive-persist-'))
  tmpDirs.push(dir)
  return dir
}

/** 只假 Date：定时器保持真身，否则 HTTP 与 setInterval 都跑不起来。 */
function freezeAt(isoLocal: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(isoLocal))
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

  override async *stream(_options: GenerateOptions): AsyncGenerator<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: '好' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '好' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface ConversationRow {
  id: string
  kind: string
  memberAgentIds: string[]
}

interface MessageRow {
  id: string
  senderType: string
  senderId?: string
  contentBlocks: { type: string; text?: string }[]
}

/** 会话清单。 */
async function conversationsOf(base: string): Promise<ConversationRow[]> {
  const response = await fetch(`${base}/api/conversations`)
  return ((await response.json()) as { conversations: ConversationRow[] }).conversations
}

/** Ryen 单聊里的消息（会话不存在时回空数组——「还没说过话」也是一种状态）。 */
async function ryenMessages(base: string): Promise<MessageRow[]> {
  const chat = (await conversationsOf(base)).find((row) => {
    return row.kind === 'direct' && row.memberAgentIds.length === 1 && row.memberAgentIds[0] === 'ryen'
  })
  if (chat === undefined) return []
  const response = await fetch(`${base}/api/conversations/${chat.id}/messages?limit=50`)
  return ((await response.json()) as { messages: MessageRow[] }).messages
}

/** Ryen 单聊的会话 id（还没发过时是 undefined）。 */
async function ryenChatId(base: string): Promise<string | undefined> {
  const chat = (await conversationsOf(base)).find((row) => {
    return row.kind === 'direct' && row.memberAgentIds.length === 1 && row.memberAgentIds[0] === 'ryen'
  })
  return chat?.id
}

/**
 * 起一个带记忆库的服务（记忆与进化是回顾的事实来源）。
 *
 * `facts` 里的记忆在**服务起来之前**就记好：启动检查是在 create() 里跑的，晚一步
 * 这一轮窗口就轮不到它了。
 */
async function boot(
  dataDir: string,
  facts: string[] = [],
): Promise<{ server: RyHarnessServer; base: string; memory: MemoryServiceImpl }> {
  const memory = new MemoryServiceImpl({ dbPath: join(dataDir, 'ryharness.db') })
  for (const fact of facts) {
    memory.store.insert({ agentId: 'ryen', kind: 'fact', content: fact })
  }
  const handle = await startMockServer({ adapter: new QuietAdapter(), dataDir, memory, proactiveIntervalMs: 20 })
  running.push(handle.server)
  return { server: handle.server, base: handle.base, memory }
}

afterEach(async () => {
  while (running.length > 0) {
    const server = running.pop()
    await server?.close()
  }
  vi.useRealTimers()
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 句柄释放可能滞后；残留目录在临时区。
    }
  }
})

describe('判重落盘', () => {
  it('重启应用不会把当天那份回顾再发一遍', async () => {
    freezeAt('2026-03-02T09:30:00')
    const dataDir = newDataDir()
    const first = await boot(dataDir, ['咖啡机在阳台左边'])
    expect(await ryenMessages(first.base)).toHaveLength(1)
    await first.server.close()
    running.pop()

    // 同一个数据目录再起一次：重启不是"新的一天"，今天已经发过了。
    const second = await boot(dataDir)
    await ticks(20, 5)
    expect(await ryenMessages(second.base)).toHaveLength(1)
    // 观测面也要如实：今天已经发过。
    const snapshot = await (await fetch(`${second.base}/api/proactive`)).json()
    expect((snapshot as { sentToday: boolean }).sentToday).toBe(true)
  })

  it('跨到第二天该发第二条（落盘没有把发送卡死）', async () => {
    freezeAt('2026-03-02T09:30:00')
    const dataDir = newDataDir()
    const first = await boot(dataDir, ['咖啡机在阳台左边'])
    expect(await ryenMessages(first.base)).toHaveLength(1)
    await first.server.close()
    running.pop()

    const second = await boot(dataDir)
    // 新事实要落在窗口里：时钟先拨到第二天早上，再记这一条。
    vi.setSystemTime(new Date('2026-03-03T08:00:00'))
    second.memory.store.insert({ agentId: 'ryen', kind: 'fact', content: '备用钥匙在玄关第二个抽屉' })
    vi.setSystemTime(new Date('2026-03-03T09:05:00'))
    for (let round = 0; round < 10; round += 1) {
      await ticks(20, 2)
      if ((await ryenMessages(second.base)).length > 1) break
    }
    expect(await ryenMessages(second.base)).toHaveLength(2)
  })

  it('用户在设置里改设置不会把判重状态抹掉', async () => {
    freezeAt('2026-03-02T09:30:00')
    const dataDir = newDataDir()
    const first = await boot(dataDir, ['咖啡机在阳台左边'])
    expect(await ryenMessages(first.base)).toHaveLength(1)
    // 改一次发送时刻（写盘的那条路径与判重状态在同一个文件里）。
    await fetch(`${first.base}/api/proactive`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hour: 10 }),
    })
    await first.server.close()
    running.pop()

    const second = await boot(dataDir)
    await ticks(20, 5)
    expect(await ryenMessages(second.base)).toHaveLength(1)
  })
})

describe('定时路径推 WS', () => {
  it('发出去的那一刻，订阅该会话的客户端收到了那几条事件', async () => {
    freezeAt('2026-03-02T09:30:00')
    const dataDir = newDataDir()
    const { base, memory } = await boot(dataDir, ['咖啡机在阳台左边'])

    // 启动那一次已经发过：会话存在了。
    expect(await ryenMessages(base)).toHaveLength(1)
    const chatId = await ryenChatId(base)
    expect(chatId).toBeDefined()

    const window = watchConversation(base, chatId ?? '', 2500)
    await window.ready

    // 第二天有新东西 → 定时器再发一条。
    vi.setSystemTime(new Date('2026-03-03T08:00:00'))
    memory.store.insert({ agentId: 'ryen', kind: 'fact', content: '备用钥匙在玄关第二个抽屉' })
    vi.setSystemTime(new Date('2026-03-03T09:05:00'))
    const events = await window.events

    // 主动消息的标记要带上：气泡上方那行「它 主动找你」实时就得在。
    const starts = eventsOfType(events, 'message-start')
    expect(
      starts.some((event) => {
        return event.proactive === true
      }),
    ).toBe(true)
    // 正文也跟着推出去（否则气泡是空的）。
    expect(eventsOfType(events, 'text-delta').length).toBeGreaterThan(0)
    expect(eventsOfType(events, 'message-done').length).toBeGreaterThan(0)
  })
})
