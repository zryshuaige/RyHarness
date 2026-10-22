/**
 * 历史消息的 tool_call 配对修复（启动/加载期崩溃恢复）。
 *
 * 背景：agent 可能在「assistant 消息已落库（含 tool_call 块）但工具结果消息还没
 * 落库」之间崩溃。下次加载历史时，模型上下文里出现没有对应 tool 结果的 tool_call，
 * OpenAI/DeepSeek 等供应商会直接 400 拒绝整个请求。这里在把历史喂给模型之前做
 * 配对修复（语义对齐 dsh 的 repair.ts）：
 *
 * - 孤立 tool_call：assistant 消息里的 tool_call 块走完整个历史都没有对应的
 *   工具结果行 → 在该 assistant 消息之后立刻合成一条占位工具结果消息，正文说明
 *   工具执行被中断、并按工具语义给出重试指引（对齐 dsh 的 interrupted 文案）。
 *   插在所属 assistant 消息之后而不是追加到末尾：供应商要求 tool 消息紧跟在
 *   携带 tool_calls 的 assistant 消息之后，崩溃后新用户消息可能已落在同一段历史里。
 * - 孤儿工具结果：toolCallId 对不上任何未应答的 tool_call（结果被重复落库、
 *   配对的 assistant 行被删、顺序颠倒）→ 丢弃该行。与 store.finishHistoryWindow
 *   「宁少一条，不给模型断掉的配对」同一口径；dsh 侧同理：没有 pending 记录的
 *   tool/result 不被应答、也不产生合成事件。
 * - 正常配对的历史原样通过：返回的行保持原对象引用（字节级内容不变），
 *   只有出现断配对时才新建合成行。
 *
 * 纯函数：不读写库，可单测；合成行不落库、不进游标（seq 仅保证输出内单调）。
 * @module @ryharness/session/repair
 */

import type { StoredMessage } from './types.ts'

/**
 * 合成工具结果的正文（模型可见，对齐 dsh repair.ts interrupted 语义的要点：
 * 结果未知、按工具语义决定是否重试、副作用操作先核实）。
 */
const INTERRUPTED_RESULT_TEXT =
  '该工具调用的结果在落库前进程就被中断，本次调用没有可用结果。是否重试取决于工具语义：只读或幂等的操作可以直接重试；可能有副作用的操作先核实外部状态或询问用户，不要盲目重试。'

/** 内容块里的 tool_call id/name 的未知形状读取（contentBlocks 是 unknown[]）。 */
function toolCallOf(raw: unknown): { id: string; name: string } | undefined {
  const block = raw as { type?: unknown; id?: unknown; name?: unknown }
  if (block.type !== 'tool-call' || typeof block.id !== 'string') return undefined
  return { id: block.id, name: typeof block.name === 'string' ? block.name : '' }
}

/** 一行 assistant 消息里登记的 tool_call（按块顺序，幂等去重）。 */
function announcedCalls(row: StoredMessage): { id: string; name: string }[] {
  const calls: { id: string; name: string }[] = []
  const seen = new Set<string>()
  for (const raw of row.contentBlocks) {
    const call = toolCallOf(raw)
    if (call === undefined || seen.has(call.id)) continue
    seen.add(call.id)
    calls.push(call)
  }
  return calls
}

/**
 * 修复一段历史消息的 tool_call 配对，返回可直接重建给模型的行序列。
 *
 * @param rows - 按 seq 升序的历史窗口（listMessagesForHistory 的输出）。
 * @returns 修复后的行：正常行原样保留（原引用），孤立 tool_call 之后插入合成
 *   工具结果行，孤儿工具结果行被移除；已配对的历史返回与输入逐行相同的序列。
 */
export function repairToolCallPairing(rows: readonly StoredMessage[]): StoredMessage[] {
  // callId → 宣布它的 assistant 行（Map 插入序即历史里的声明序）；同一 id 只认第一次
  // 声明（重复块幂等），应答以「第一个未应答的同名 call」为准。
  const announcer = new Map<string, StoredMessage>()
  // 未应答的 callId → 工具名 + 所属行。
  const pending = new Map<string, { name: string; row: StoredMessage }>()
  // 孤儿工具结果行（下标）：toolCallId 对不上任何未应答的 tool_call。
  const orphanResults = new Set<number>()
  rows.forEach((row, index) => {
    if (row.toolCallId !== undefined) {
      if (pending.delete(row.toolCallId)) return
      orphanResults.add(index)
      return
    }
    if (row.senderType !== 'agent') return
    for (const call of announcedCalls(row)) {
      if (announcer.has(call.id)) continue
      announcer.set(call.id, row)
      pending.set(call.id, { name: call.name, row })
    }
  })

  if (pending.size === 0 && orphanResults.size === 0) return [...rows]

  // 合成结果的落点：必须在「携带 tool_calls 的 assistant 消息」与「它的应答结果」
  // 全部之后——插在行自身与该行最后一个已应答结果行（同消息其余 call 的结果也
  // 算，取其大者）之后；一个 assistant 消息声明多个 call 时，已应答的部分保持
  // 原位，只把缺失的补在最末一个真实结果之后。
  const kept = rows.filter((_row, index) => {
    return !orphanResults.has(index)
  })
  const keptIndex = new Map<StoredMessage, number>()
  const answeredAt = new Map<string, number>()
  kept.forEach((row, index) => {
    keptIndex.set(row, index)
    if (row.toolCallId !== undefined) answeredAt.set(row.toolCallId, index)
  })
  // 每条 assistant 行声明的 callId（保持块顺序）：算落点时要算上兄弟 call 的结果行。
  const repairedRows = new Set<StoredMessage>(
    [...pending.values()].map((entry) => {
      return entry.row
    }),
  )
  const rowCalls = new Map<StoredMessage, string[]>()
  for (const [id, row] of announcer) {
    if (!repairedRows.has(row)) continue
    const calls = rowCalls.get(row)
    if (calls === undefined) rowCalls.set(row, [id])
    else calls.push(id)
  }
  const synthesizedAt = new Map<number, { id: string; name: string }[]>()
  for (const [id, { name, row }] of pending) {
    const ownIndex = keptIndex.get(row) ?? 0
    let at = ownIndex
    for (const sibling of rowCalls.get(row) ?? []) {
      const answered = answeredAt.get(sibling)
      if (answered !== undefined && answered > at) at = answered
    }
    const calls = synthesizedAt.get(at)
    if (calls === undefined) synthesizedAt.set(at, [{ id, name }])
    else calls.push({ id, name })
  }

  const repaired: StoredMessage[] = []
  let seq = 0
  kept.forEach((row, index) => {
    repaired.push(row)
    seq = Math.max(seq, row.seq)
    const synthesized = synthesizedAt.get(index)
    if (synthesized === undefined) return
    for (const call of synthesized) {
      repaired.push({
        // 确定性 id：同一份断配对历史每次加载合成出同一行。
        id: `repair-tool-result-${call.id}`,
        seq: ++seq,
        conversationId: row.conversationId,
        senderType: 'agent',
        ...(row.senderId === undefined ? {} : { senderId: row.senderId }),
        // 前缀与 coordinator 的 TOOL_RESULT_PREFIX 同一格式，模型看到的工具行形态一致。
        contentBlocks: [{ type: 'text', text: `〔tool〕${call.name}: ${INTERRUPTED_RESULT_TEXT}` }],
        mentions: [],
        toolCallId: call.id,
        turnIndex: row.turnIndex,
        createdAt: row.createdAt,
      })
    }
  })
  return repaired
}
