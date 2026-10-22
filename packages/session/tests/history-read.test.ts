import { trimHistoryToBudget } from '@ryharness/agent'
import type { ContentBlock, Message } from '@ryharness/llm'
import { estimateTokens } from '@ryharness/llm'
import { groupHistoryRowWeight, historyRowWeight, SessionStore, type StoredMessage } from '@ryharness/session'
import { describe, expect, it } from 'vitest'

/**
 * 历史增量读（listMessagesForHistory）的等价性与边界测试。
 *
 * 「旧实现」指改动前的 coordinator 路径：整读最新 1000 行 → 重建（system 行丢弃）
 * → trimHistoryToBudget / buildGroupContext 式贪心裁剪。重建与条目格式化在测试里
 * 用副本函数复刻（与生产 rebuildMessage / toGroupEntry 逐行对齐），但裁剪器用
 * 真实的 trimHistoryToBudget、权重用生产的 historyRowWeight / groupHistoryRowWeight
 * ——权重口径漂移会直接打破等价断言。
 *
 * 口径是 token 不是字符（AgentLoop 侧已迁过来）：这里的每条消息按生产权重函数
 * 实测得出预算边界，断言里写死的那几个数字是「ASCII 4 字符 ≈ 1 token + 块开销 4
 * + role 开销 4」的换算结果。
 */

const BUDGET = 30_000

/**
 * 群聊那组要更小的预算：旧实现整读最新 1000 行，预算必须小到 1000 行装不下，
 * 否则两侧的差异来自"旧实现读不满预算"而不是裁剪口径本身（token 口径下 1000 行
 * 的群历史已经不到 30k 了）。
 */
const GROUP_BUDGET = 5_000

type RebuiltMessage = { id: string; role: string; toolCallId?: string; content: unknown[] }
type GroupEntry = { speaker: string; text: string }

function appendUser(store: SessionStore, conversationId: string, text: string, turnIndex = 0): StoredMessage {
  return store.appendMessage({
    conversationId,
    senderType: 'user',
    senderId: 'user',
    contentBlocks: [{ type: 'text', text }],
    turnIndex,
  })
}

function appendAgentText(
  store: SessionStore,
  conversationId: string,
  senderId: string,
  text: string,
  turnIndex = 0,
): StoredMessage {
  return store.appendMessage({
    conversationId,
    senderType: 'agent',
    senderId,
    contentBlocks: [{ type: 'text', text }],
    turnIndex,
  })
}

/** 追加一对 tool_call（assistant 块）+ tool_result（toolCallId 行），返回两行。 */
function appendToolPair(
  store: SessionStore,
  conversationId: string,
  callId: string,
  turnIndex = 0,
): [StoredMessage, StoredMessage] {
  const call = store.appendMessage({
    conversationId,
    senderType: 'agent',
    senderId: 'a1',
    contentBlocks: [{ type: 'tool-call', id: callId, name: 'fs_read', arguments: `{"path":"f-${callId}.txt"}` }],
    turnIndex,
  })
  const result = store.appendMessage({
    conversationId,
    senderType: 'agent',
    senderId: 'a1',
    contentBlocks: [{ type: 'text', text: `〔tool〕fs_read: ok (${callId})` }],
    toolCallId: callId,
    turnIndex,
  })
  return [call, result]
}

/**
 * coordinator.ts rebuildMessage 的测试副本（只保留裁剪与配对断言需要的字段）。
 * reasoning 与生产一样不回填：它不上送（llm/openai/serialize.ts），留着只会让
 * 副本与生产的权重漂移。
 */
function rebuildReplica(row: StoredMessage): RebuiltMessage | undefined {
  const content = (row.contentBlocks as ContentBlock[]).filter((block) => {
    return block.type !== 'reasoning'
  })
  if (row.senderType === 'user') {
    return { id: row.id, role: 'user', content }
  }
  if (row.senderType === 'agent') {
    if (row.toolCallId !== undefined) {
      return { id: row.id, role: 'tool', toolCallId: row.toolCallId, content }
    }
    return { id: row.id, role: 'assistant', content }
  }
  return undefined
}

/** 旧实现（单聊）：整读最新 1000 行 → 重建 → trimHistoryToBudget。 */
function oldDirectHistory(store: SessionStore, conversationId: string, budget: number): RebuiltMessage[] {
  const messages: RebuiltMessage[] = []
  for (const row of store.listMessages(conversationId, { limit: 1000 })) {
    const rebuilt = rebuildReplica(row)
    if (rebuilt !== undefined) messages.push(rebuilt)
  }
  return trimHistoryToBudget(messages as unknown as readonly Message[], budget) as unknown as RebuiltMessage[]
}

/** 新读路径（单聊）：listMessagesForHistory + 生产权重函数。 */
function newDirectHistory(store: SessionStore, conversationId: string, budget: number): RebuiltMessage[] {
  const rows = store.listMessagesForHistory(conversationId, budget, { weightOf: historyRowWeight })
  const messages: RebuiltMessage[] = []
  for (const row of rows) {
    const rebuilt = rebuildReplica(row)
    if (rebuilt !== undefined) messages.push(rebuilt)
  }
  return messages
}

/** 断言窗口内每个 tool 结果的 tool_call 都在窗口内且位于其前（配对完整）。 */
function expectCompleteToolPairs(messages: RebuiltMessage[]): void {
  const calls = new Set<string>()
  for (const message of messages) {
    for (const block of message.content as ContentBlock[]) {
      if (block.type === 'tool-call') calls.add(block.id)
    }
    if (message.role === 'tool') {
      expect(calls.has(message.toolCallId ?? '')).toBe(true)
    }
  }
}

/** coordinator.ts toGroupEntry 的测试副本（与生产函数逐行对齐）。 */
function groupEntryReplica(row: StoredMessage, agentNames: Map<string, string>): GroupEntry | undefined {
  if (row.senderType === 'system' || row.toolCallId !== undefined) return undefined
  const text = (row.contentBlocks as ContentBlock[])
    .filter((block) => {
      return block.type === 'text'
    })
    .map((block) => {
      return block.type === 'text' ? block.text : ''
    })
    .join('\n')
  if (text.trim().length === 0) return undefined
  const speaker =
    row.senderType === 'user'
      ? '用户'
      : row.senderId !== undefined
        ? (agentNames.get(row.senderId) ?? row.senderId)
        : 'agent'
  return { speaker, text }
}

/** 旧实现（群聊）：整读最新 1000 行、break 在本 turn、buildGroupContext 式贪心裁剪。 */
function oldGroupHistory(
  store: SessionStore,
  conversationId: string,
  agentNames: Map<string, string>,
  currentTurnIndex: number,
  budget: number,
): GroupEntry[] {
  const entries: GroupEntry[] = []
  for (const row of store.listMessages(conversationId, { limit: 1000 })) {
    if (row.turnIndex === currentTurnIndex) break
    const entry = groupEntryReplica(row, agentNames)
    if (entry !== undefined) entries.push(entry)
  }
  let total = entries.reduce((sum, entry) => {
    return sum + estimateTokens(`${entry.speaker}: ${entry.text}`) + 1
  }, 0)
  let start = 0
  while (total > budget && start < entries.length) {
    const dropped = entries[start] as GroupEntry
    total -= estimateTokens(`${dropped.speaker}: ${dropped.text}`) + 1
    start++
  }
  return entries.slice(start)
}

/** 新读路径（群聊）：keepNewest=false + beforeTurnIndex + 生产权重函数。 */
function newGroupHistory(
  store: SessionStore,
  conversationId: string,
  agentNames: Map<string, string>,
  currentTurnIndex: number,
  budget: number,
): GroupEntry[] {
  const rows = store.listMessagesForHistory(conversationId, budget, {
    weightOf: (row) => {
      return groupHistoryRowWeight(row, agentNames)
    },
    keepNewest: false,
    beforeTurnIndex: currentTurnIndex,
  })
  const entries: GroupEntry[] = []
  for (const row of rows) {
    const entry = groupEntryReplica(row, agentNames)
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

describe('历史增量读 listMessagesForHistory', () => {
  it('单聊长会话（>1000 行）：增量读窗口与旧实现裁剪结果逐条相同', () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    for (let i = 0; i < 1200; i++) {
      if (i % 25 === 12) {
        appendToolPair(store, conversation.id, `call-${i}`)
      } else if (i % 25 === 13) {
        store.appendMessage({
          conversationId: conversation.id,
          senderType: 'system',
          contentBlocks: [{ type: 'text', text: `[error:boom] 第 ${i} 轮系统提示` }],
        })
      } else if (i % 2 === 0) {
        appendUser(store, conversation.id, `u${i} ${'x'.repeat(60 + (i % 90))}`)
      } else {
        appendAgentText(store, conversation.id, 'a1', `a${i} ${'y'.repeat(50 + (i % 110))}`)
      }
    }
    const expected = oldDirectHistory(store, conversation.id, BUDGET)
    const actual = newDirectHistory(store, conversation.id, BUDGET)
    // 预算真的截断了（不是整库都在窗口里）。
    expect(expected.length).toBeGreaterThan(10)
    expect(expected.length).toBeLessThan(1200)
    expect(actual.map((message) => message.id)).toEqual(expected.map((message) => message.id))
    expect(actual.map((message) => message.role)).toEqual(expected.map((message) => message.role))
    expectCompleteToolPairs(actual)
    // 窗口是全量历史行（剔除 system）的无重复升序连续段，且末端到最新一行。
    const allRows = store.listMessages(conversation.id, { limit: 100_000 })
    const historyRowIds = allRows
      .filter((row) => {
        return row.senderType !== 'system'
      })
      .map((row) => {
        return row.id
      })
    const expectedIds = expected.map((message) => message.id)
    const start = historyRowIds.indexOf(expectedIds[0])
    expect(start).toBeGreaterThanOrEqual(0)
    expect(expectedIds).toEqual(historyRowIds.slice(start, start + expectedIds.length))
    expect(start + expectedIds.length).toBe(historyRowIds.length)
    store.close()
  })

  it('预算截断落在 tool 配对中间时不产生孤立 tool 行（宁少不破对）', () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    // 行序（旧→新）：user(50) → call → result(30) → user(60)，权重在落库后实测。
    const r1 = appendUser(store, conversation.id, 'x'.repeat(50))
    const [r2] = appendToolPair(store, conversation.id, 'call-7')
    const r3 = store.listMessages(conversation.id, { limit: 1 })[0]
    const r4 = appendUser(store, conversation.id, 'z'.repeat(60))
    const weightOf = new Map([
      [r1.id, historyRowWeight(r1)],
      [r2.id, historyRowWeight(r2)],
      [r3 === undefined ? '' : r3.id, r3 === undefined ? undefined : historyRowWeight(r3)],
      [r4.id, historyRowWeight(r4)],
    ])
    const w2 = weightOf.get(r2.id) ?? 0
    const w3 = weightOf.get(r3 === undefined ? '' : r3.id) ?? 0
    const w4 = weightOf.get(r4.id) ?? 0
    expect(r3?.toolCallId).toBe('call-7')

    // 场景 A：预算恰好装下 r4+r3、装不下 r2 —— 旧实现丢弃配对（call 在窗外，
    // result 成孤儿 → 头部跳过）；新读路径同口径，返回 [r4]。
    const budgetA = w4 + w3 + 1
    const expectedA = oldDirectHistory(store, conversation.id, budgetA)
    const actualA = newDirectHistory(store, conversation.id, budgetA)
    expect(w2).toBeGreaterThan(1)
    expect(actualA.map((message) => message.id)).toEqual([r4.id])
    expect(actualA.map((message) => message.id)).toEqual(expectedA.map((message) => message.id))
    expectCompleteToolPairs(actualA)

    // 场景 B：预算恰好装下 r4+r3+r2（配对完整、收在 call 上）—— 两侧都保留整对。
    const budgetB = w4 + w3 + w2
    const expectedB = oldDirectHistory(store, conversation.id, budgetB)
    const actualB = newDirectHistory(store, conversation.id, budgetB)
    expect(actualB.map((message) => message.id)).toEqual([r2.id, r3?.id, r4.id])
    expect(actualB.map((message) => message.id)).toEqual(expectedB.map((message) => message.id))
    expectCompleteToolPairs(actualB)
    store.close()
  })

  it('边界：空会话、单条超预算、恰好等于预算、Infinity', () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })

    // 空会话。
    expect(newDirectHistory(store, conversation.id, BUDGET)).toEqual([])
    expect(oldDirectHistory(store, conversation.id, BUDGET)).toEqual([])

    // 单条超长消息：自身超预算也保留（至少留最新一条，与裁剪器一致）。
    const huge = appendUser(store, conversation.id, 'x'.repeat(50_000))
    const expectedHuge = oldDirectHistory(store, conversation.id, BUDGET)
    const actualHuge = newDirectHistory(store, conversation.id, BUDGET)
    expect(actualHuge.map((message) => message.id)).toEqual([huge.id])
    expect(actualHuge.map((message) => message.id)).toEqual(expectedHuge.map((message) => message.id))

    // 恰好等于预算：三条 user 行（100/200/300 个 ASCII 字符）。
    // 权重 = ceil(字数/4) + 块开销 4 + role 开销 4 = 33 / 58 / 83，合计 174。
    const e1 = appendUser(store, conversation.id, 'a'.repeat(100))
    const e2 = appendUser(store, conversation.id, 'b'.repeat(200))
    const e3 = appendUser(store, conversation.id, 'c'.repeat(300))
    expect(historyRowWeight(e1)).toBe(33)
    expect(historyRowWeight(e2)).toBe(58)
    expect(historyRowWeight(e3)).toBe(83)
    const expectedFit = oldDirectHistory(store, conversation.id, 174)
    const actualFit = newDirectHistory(store, conversation.id, 174)
    expect(actualFit.map((message) => message.id)).toEqual([e1.id, e2.id, e3.id])
    expect(actualFit.map((message) => message.id)).toEqual(expectedFit.map((message) => message.id))
    // 差一个 token 就丢最旧一条。
    const expectedOver = oldDirectHistory(store, conversation.id, 173)
    const actualOver = newDirectHistory(store, conversation.id, 173)
    expect(actualOver.map((message) => message.id)).toEqual([e2.id, e3.id])
    expect(actualOver.map((message) => message.id)).toEqual(expectedOver.map((message) => message.id))

    // Infinity = 不设预算，读全量（与裁剪器口径一致）。
    const expectedAll = oldDirectHistory(store, conversation.id, Number.POSITIVE_INFINITY)
    const actualAll = newDirectHistory(store, conversation.id, Number.POSITIVE_INFINITY)
    expect(actualAll.map((message) => message.id)).toEqual([huge.id, e1.id, e2.id, e3.id])
    expect(actualAll.map((message) => message.id)).toEqual(expectedAll.map((message) => message.id))
    store.close()
  })

  it('群聊长会话：增量读条目与旧实现裁剪结果相同，且排除本轮消息', () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({
      kind: 'group',
      memberAgentIds: ['a1', 'a2'],
      dispatcherAgentId: 'a1',
    })
    const agentNames = new Map([
      ['a1', 'Alpha'],
      ['a2', 'Beta'],
    ])
    for (let i = 0; i < 1100; i++) {
      const turnIndex = Math.floor(i / 50)
      if (i % 37 === 5) {
        appendToolPair(store, conversation.id, `call-${i}`, turnIndex)
      } else if (i % 23 === 7) {
        store.appendMessage({
          conversationId: conversation.id,
          senderType: 'system',
          contentBlocks: [{ type: 'text', text: `[error:boom] 群内系统消息 ${i}` }],
          turnIndex,
        })
      } else if (i % 29 === 11) {
        appendAgentText(store, conversation.id, 'a1', '   ', turnIndex) // 纯空白行不入历史
      } else if (i % 2 === 0) {
        appendUser(store, conversation.id, `u${i} ${'x'.repeat(40 + (i % 80))}`, turnIndex)
      } else {
        const senderId = i % 4 === 1 ? 'a1' : 'a2'
        appendAgentText(
          store,
          conversation.id,
          senderId,
          `${senderId} 发言 ${i} ${'y'.repeat(30 + (i % 70))}`,
          turnIndex,
        )
      }
    }
    // 本轮（turnIndex 22）已落库的消息必须被排除。
    const currentTurn = 22
    appendUser(store, conversation.id, 'TURN22 用户本轮输入', currentTurn)
    appendToolPair(store, conversation.id, 'call-turn22', currentTurn)
    appendAgentText(store, conversation.id, 'a1', 'TURN22 成员本轮回复', currentTurn)

    const expected = oldGroupHistory(store, conversation.id, agentNames, currentTurn, GROUP_BUDGET)
    const actual = newGroupHistory(store, conversation.id, agentNames, currentTurn, GROUP_BUDGET)
    expect(expected.length).toBeGreaterThan(10)
    expect(expected.length).toBeLessThan(1100)
    expect(actual).toEqual(expected)
    expect(actual.every((entry) => !entry.text.includes('TURN22'))).toBe(true)
    store.close()
  })

  it('群聊边界：单条目超预算裁空、恰好等于预算保留（keepNewest=false 对齐贪心裁剪）', () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({ kind: 'group', memberAgentIds: ['a1'] })
    const agentNames = new Map<string, string>()
    // 条目行落在本轮（1）之前的 turn 0；权重由生产函数实测（`用户: ` + 100 个 ASCII）。
    const row = appendUser(store, conversation.id, 'x'.repeat(100), 0)
    const weight = groupHistoryRowWeight(row, agentNames) ?? 0
    expect(weight).toBe(29)
    expect(newGroupHistory(store, conversation.id, agentNames, 1, weight - 1)).toEqual([])
    expect(oldGroupHistory(store, conversation.id, agentNames, 1, weight - 1)).toEqual([])
    const kept = newGroupHistory(store, conversation.id, agentNames, 1, weight)
    expect(kept).toEqual(oldGroupHistory(store, conversation.id, agentNames, 1, weight))
    expect(kept).toEqual([{ speaker: '用户', text: 'x'.repeat(100) }])
    // 空会话同样返回空。
    const empty = store.createConversation({ kind: 'group', memberAgentIds: ['a1'] })
    expect(newGroupHistory(store, empty.id, agentNames, 0, BUDGET)).toEqual([])
    store.close()
  })

  it('小消息超长会话：窗口由预算而非 1000 行上限决定（P0-2 的行为变化留痕）', () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    for (let i = 0; i < 1400; i++) {
      if (i % 2 === 0) {
        appendUser(store, conversation.id, `u${String(i).padStart(4, '0')}`)
      } else {
        appendAgentText(store, conversation.id, 'a1', `a${String(i).padStart(4, '0')}`)
      }
    }
    // 每行同形，权重按生产函数实测（5 个 ASCII → ceil(5/4) + 4 + 4 = 10 token）。
    const newest = store.listMessages(conversation.id, { limit: 1 })[0] as StoredMessage
    const budget = (historyRowWeight(newest) ?? 0) * 1200
    // 旧实现取最新 1000 行（总重 10000 ≤ 预算 12000，裁剪不生效）；
    // 新读路径按预算装到 1200 行。
    const expected = oldDirectHistory(store, conversation.id, budget)
    const actual = newDirectHistory(store, conversation.id, budget)
    expect(expected.length).toBe(1000)
    expect(actual.length).toBe(1200)
    // 旧窗口（最新 1000 行）是新窗口的尾部，头部多出 200 行更旧的小消息。
    const actualIds = actual.map((message) => message.id)
    const expectedIds = expected.map((message) => message.id)
    expect(actualIds.slice(-1000)).toEqual(expectedIds)
    expect(new Set(actualIds).size).toBe(actualIds.length)
    // 窗口总重不超预算，且是全量行的升序后缀。
    const rows = store.listMessagesForHistory(conversation.id, BUDGET, { weightOf: historyRowWeight })
    const totalWeight = rows.reduce((sum, row) => {
      return sum + (historyRowWeight(row) ?? 0)
    }, 0)
    expect(totalWeight).toBeLessThanOrEqual(BUDGET)
    const allIds = store.listMessages(conversation.id, { limit: 100_000 }).map((row) => row.id)
    expect(rows.map((row) => row.id)).toEqual(allIds.slice(-rows.length))
    store.close()
  })

  it('reasoning 块不计预算：不上送的块既不占窗口，也不该把整条历史挤出去', () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const plain = appendAgentText(store, conversation.id, 'a1', '结论就是这一句。')
    const thought = store.appendMessage({
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: 'a1',
      contentBlocks: [
        { type: 'reasoning', text: '想'.repeat(20_000) },
        { type: 'text', text: '结论就是这一句。' },
      ],
    })
    // 正文相同的两行权重必须相同：一段不上送的思考不该凭空吃掉两万 token 预算。
    expect(historyRowWeight(thought)).toBe(historyRowWeight(plain))
    const budget = (historyRowWeight(plain) ?? 0) * 2
    expect(newDirectHistory(store, conversation.id, budget).map((message) => message.id)).toEqual([
      plain.id,
      thought.id,
    ])
    expect(oldDirectHistory(store, conversation.id, budget).map((message) => message.id)).toEqual([
      plain.id,
      thought.id,
    ])
    store.close()
  })
})
