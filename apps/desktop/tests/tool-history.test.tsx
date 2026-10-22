// @vitest-environment jsdom
/**
 * 历史消息里的工具过程与时间线顺序。
 *
 * 两个曾经只对"实时"成立的事实：
 * 1. **工具正文与失败态**。实时链路早就把 tool-result 的正文与 isError 渲染成可展开的
 *    过程行，而从历史加载的旧消息走另一条路径，只剩一行「已读文件」——用户回看三天前
 *    的会话，"当时它读了什么、错在哪"全没了。
 * 2. **断口续接之后的一条发言只有一份**。补回的缺口按 seq 归位进历史，而流式气泡固定
 *    排在历史之后：补回同一轮的行会让时间线倒着走、同一轮被切成两块（React 还会因为两块
 *    用了同一个 turnIndex 做 key 打出 duplicate key 警告），而补回的那条与屏上已经收口的
 *    流式气泡其实是**同一条发言的两份**（key 一个 hist: 一个 stream:，按 key 去重拦不住），
 *    于是同一句话在屏上出现两遍。
 *
 * 块类型字面量（`tool-error`）在渲染层与内核各写一份（内核入口会把 node:sqlite 拖进
 * 浏览器包，不能直接 import），这里逐字比对一次：两边一旦漂了，历史里的失败态就静默
 * 失效，而且没有任何报错。
 */

import { TOOL_ERROR_BLOCK_TYPE as KERNEL_TOOL_ERROR_BLOCK_TYPE } from '@ryharness/session/src/coordinator.ts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, ApiClient, Conversation, MessageRow, WsEvent } from '../renderer/src/api.ts'
import { ChatView, fromHistory } from '../renderer/src/components/ChatView.tsx'
import { MessageBubble } from '../renderer/src/components/MessageBubble.tsx'
import type { UiMessage } from '../renderer/src/store.ts'
import { bucketOf, ChatStore, mergeTimeline, TOOL_ERROR_BLOCK_TYPE } from '../renderer/src/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agent: AgentDef = {
  id: 'ryen',
  name: 'Ryen',
  avatar: 'cat',
  systemPrompt: '你是 Ryen。',
  provider: 'siliconflow',
  model: 'deepseek-ai/DeepSeek-V3',
  tools: [],
  isBuiltin: true,
}

const conversation: Conversation = {
  id: 'c1',
  kind: 'direct',
  title: 'Ryen',
  memberAgentIds: ['ryen'],
  lastReadSeq: 1,
  createdAt: 1,
  updatedAt: 2,
}

const nameOf = (id: string): string => {
  return id
}

/** 历史行（seq 与 turnIndex 默认一一对应，够大多数用例用）。 */
function row(partial: Partial<MessageRow> & Pick<MessageRow, 'id' | 'seq'>): MessageRow {
  return {
    conversationId: 'c1',
    senderType: 'agent',
    senderId: 'ryen',
    contentBlocks: [{ type: 'text', text: '你好' }],
    mentions: [],
    turnIndex: partial.seq - 1,
    createdAt: 1000 + partial.seq,
    ...partial,
  }
}

/** 一条工具调用历史：assistant 的 tool_call 行 + 工具结果行。 */
function toolRows(options: { callId: string; name: string; output: string; isError?: boolean }): MessageRow[] {
  return [
    row({
      id: 'call-assistant',
      seq: 10,
      contentBlocks: [
        { type: 'tool-call', id: options.callId, name: options.name, arguments: '{"path":"a.ts"}' } as never,
      ],
    }),
    row({
      id: 'call-result',
      seq: 11,
      toolCallId: options.callId,
      contentBlocks: [
        { type: 'text', text: `〔tool〕${options.name}: ${options.output}` },
        ...(options.isError === true ? [{ type: TOOL_ERROR_BLOCK_TYPE }] : []),
      ],
    }),
  ]
}

describe('历史工具行：正文、失败态、参数都留着', () => {
  it('工具结果带着正文回到气泡（不是一行"已读文件"）', () => {
    const messages = fromHistory(toolRows({ callId: 'c1', name: 'fs_read', output: 'export const a = 1' }), nameOf)
    // 纯 tool_call 的 assistant 行没有可展示内容，fromHistory 跳过它：结果行在 [0]。
    const tool = messages[0]?.parts[0]
    expect(tool).toMatchObject({ kind: 'tool', callId: 'c1', name: 'fs_read', status: 'done' })
    expect(tool).toMatchObject({ content: 'export const a = 1' })
  })

  it('失败标记块还原成失败态（历史里的报错仍然看得见）', () => {
    const messages = fromHistory(
      toolRows({ callId: 'c2', name: 'shell_exec', output: 'command not found: ryan', isError: true }),
      nameOf,
    )
    const tool = messages[0]?.parts[0]
    expect(tool).toMatchObject({ isError: true, content: 'command not found: ryan' })
  })

  it('调用参数从前一条 assistant 的 tool_call 块里取回', () => {
    const messages = fromHistory(toolRows({ callId: 'c3', name: 'fs_read', output: 'ok' }), nameOf)
    expect(messages[0]?.parts[0]).toMatchObject({ arguments: '{"path":"a.ts"}' })
  })

  it('正文里的冒号不参与切分（命令与 JSON 里都有冒号）', () => {
    const messages = fromHistory(
      [
        row({
          id: 'm9',
          seq: 9,
          toolCallId: 'c4',
          contentBlocks: [{ type: 'text', text: '〔tool〕shell_exec: {"a":1}' }],
        }),
      ],
      nameOf,
    )
    expect(messages[0]?.parts[0]).toMatchObject({ name: 'shell_exec', content: '{"a":1}' })
  })

  it('找不到参数时留空串而不是编一个（工具行仍可展开看结果）', () => {
    const messages = fromHistory(
      [row({ id: 'm8', seq: 8, toolCallId: 'c5', contentBlocks: [{ type: 'text', text: '〔tool〕fs_read: ok' }] })],
      nameOf,
    )
    expect(messages[0]?.parts[0]).toMatchObject({ arguments: '', content: 'ok' })
  })

  it('渲染层与内核的失败块字面量逐字相同（漂了就静默失效）', () => {
    expect(TOOL_ERROR_BLOCK_TYPE).toBe(KERNEL_TOOL_ERROR_BLOCK_TYPE)
  })
})

describe('历史工具行的渲染', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('失败的历史工具行默认展开，且展开区里有参数与错误原文', () => {
    const [message] = fromHistory(
      toolRows({ callId: 'c6', name: 'shell_exec', output: 'ENOENT: a.ts', isError: true }),
      nameOf,
    )
    act(() => {
      root.render(
        <MessageBubble
          message={message as UiMessage}
          fileUrl={(name) => {
            return `/api/files/${name}`
          }}
        />,
      )
    })
    const rowButton = container.querySelector<HTMLButtonElement>('.tool-row')
    expect(rowButton?.getAttribute('aria-expanded')).toBe('true')
    expect(rowButton?.className).toContain('is-error')
    const detail = container.querySelector('.tool-detail')?.textContent ?? ''
    // 报错正文正是用户要点开这一行的唯一理由：默认展开就是为了这个。
    expect(detail).toContain('ENOENT: a.ts')
    expect(detail).toContain('a.ts')
  })

  it('成功但有正文的历史工具行折叠成一行，可点开看结果', () => {
    const [message] = fromHistory(toolRows({ callId: 'c7', name: 'fs_read', output: 'export const a = 1' }), nameOf)
    act(() => {
      root.render(
        <MessageBubble
          message={message as UiMessage}
          fileUrl={(name) => {
            return `/api/files/${name}`
          }}
        />,
      )
    })
    const rowButton = container.querySelector<HTMLButtonElement>('.tool-row')!
    expect(rowButton.getAttribute('aria-expanded')).toBe('false')
    act(() => {
      rowButton.click()
    })
    expect(container.querySelector('.tool-detail')?.textContent).toContain('export const a = 1')
  })
})

describe('mergeTimeline：补回的缺口按时间归位', () => {
  const streamed = (key: string, turnIndex: number): UiMessage => {
    return {
      key,
      senderType: 'agent',
      senderId: 'ryen',
      senderName: 'Ryen',
      turnIndex,
      parts: [{ kind: 'text', text: key }],
      done: true,
    }
  }

  it('已收口的流式气泡不再被补回的历史行挤到末尾', () => {
    const history: UiMessage[] = [
      { ...streamed('hist:a', 1), seq: 1 },
      { ...streamed('hist:b', 3), seq: 3 },
      { ...streamed('hist:c', 4), seq: 4 },
    ]
    const live = [streamed('stream:ryen:2', 2), streamed('stream:ryen:3', 3)]
    // 断线时 turn 3 的气泡已经在屏上；缺口补回后 turn 2/3 的历史行也到了。
    const merged = mergeTimeline(history, live)
    expect(
      merged.map((message) => {
        return message.turnIndex
      }),
    ).toEqual([1, 2, 3, 3, 4])
    // 同一轮内：历史按 seq 在前，流式在后（它们本来就是这一轮最后到的）。
    expect(merged[2]?.key).toBe('hist:b')
    expect(merged[3]?.key).toBe('stream:ryen:3')
  })

  it('turn 单调不减（React 的 turn 块 key 因此不会撞）', () => {
    const history = [streamed('hist:a', 1), streamed('hist:b', 3)]
    const live = [streamed('stream:ryen:2', 2)]
    const turns = new Set(
      mergeTimeline(history, live).map((message) => {
        return message.turnIndex
      }),
    )
    const order = [...turns]
    expect(order).toEqual(
      [...order].sort((a, b) => {
        return a - b
      }),
    )
  })

  it('空的一侧不改变另一侧的顺序', () => {
    const history = [streamed('hist:a', 2), streamed('hist:b', 1)]
    expect(mergeTimeline([], history)).toEqual(history)
    expect(mergeTimeline(history, [])).toEqual(
      [...history].sort((a, b) => {
        return a.turnIndex - b.turnIndex
      }),
    )
  })

  it('常态（历史已排好、流式在尾上）与「整条重排」结果一致', () => {
    // 流式期间走的正是这条路径：历史按轮次排好，屏上那几条是当前这一轮，
    // 排在历史后面。它免掉了一次整条重排——但结果必须一模一样。
    const history = [streamed('hist:a', 1), streamed('hist:b', 3), streamed('hist:c', 4)]
    const live = [streamed('stream:ryen:5', 5), streamed('stream:ryen:5b', 5)]
    expect(mergeTimeline(history, live)).toEqual(
      [...history, ...live].sort((a, b) => {
        return a.turnIndex - b.turnIndex
      }),
    )
  })

  it('流式里混进更早的一轮时仍然按轮次归位（不能因为"历史已排好"就放它过去）', () => {
    // 断口续接补回的那一段可能比屏上现有的更早——这条路径不能走"不排序"的快车道。
    const history = [streamed('hist:a', 1), streamed('hist:b', 3)]
    const live = [streamed('stream:ryen:2', 2)]
    const merged = mergeTimeline(history, live)
    expect(
      merged.map((message) => {
        return message.turnIndex
      }),
    ).toEqual([1, 2, 3])
  })
})

describe('断口续接：DOM 里的时间线按轮次排开', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let store: ChatStore
  let onGap: (() => void) | undefined
  /** 断口续接要补的那一段（seq 之后的新行）。 */
  let gapRows: MessageRow[]
  /** 首屏已加载的一页。 */
  let initialHistory: MessageRow[]
  const errors: string[] = []

  function historyRow(id: string, seq: number, text?: string): MessageRow {
    return row({ id, seq, contentBlocks: [{ type: 'text', text: text ?? `第 ${seq} 条` }] })
  }

  /**
   * 首屏加载与断口续接的第一页都是「无 before 的最新一页」，靠调用序区分：
   * 第一次无 before 调用是首屏（返回初始页），之后的是续接翻页（返回缺口段）。
   */
  let firstPageServed = false
  const api = {
    base: 'http://api.test',
    messages: (_id: string, opts: { limit?: number; before?: number } = {}) => {
      if (opts.before !== undefined) return Promise.resolve({ messages: [] })
      const rows = firstPageServed ? gapRows : initialHistory
      firstPageServed = true
      return Promise.resolve({ messages: rows })
    },
    markRead: () => {
      return Promise.resolve({ conversationId: 'c1', lastReadSeq: 1 })
    },
    listDispatchEvents: () => {
      return Promise.resolve({ events: [] })
    },
    postMessage: () => {
      return Promise.resolve({ accepted: true })
    },
    subscribe: (_id: string, _onEvent: (event: WsEvent) => void, handlers?: { onGap?: () => void }) => {
      onGap = handlers?.onGap
      return () => {}
    },
    fileUrl: (name: string) => {
      return `/api/files/${name}`
    },
  } as unknown as ApiClient

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    store = new ChatStore()
    initialHistory = [historyRow('m1', 1), historyRow('m2', 2)]
    gapRows = []
    firstPageServed = false
    errors.length = 0
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(
        args
          .map((arg) => {
            return String(arg)
          })
          .join(' '),
      )
    })
    vi.stubGlobal('matchMedia', (query: string) => {
      return {
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  /** DOM 里每一轮的标识（按 .turn-block 顺序）。 */
  function turnTexts(): string[] {
    return [...container.querySelectorAll('.turn-block')].map((node) => {
      return node.querySelector('.bubble-text')?.textContent ?? ''
    })
  }

  it('补回的缺口不把已收口的气泡排到末尾，同一条发言也只留一份', async () => {
    const bucket = bucketOf(store)
    // 断线前 turn 3 的发言已经在屏上（done=false，随后被 sealIncomplete 收口）。
    store.apply({ type: 'message-start', senderId: 'ryen', senderName: 'Ryen', turnIndex: 3 } as WsEvent)
    store.apply({ type: 'text-delta', senderId: 'ryen', text: 'turn 3 的回复' } as WsEvent)
    await act(async () => {
      root = createRoot(container)
      root.render(<ChatView api={api} conversation={conversation} agents={[agent]} bucket={bucket} />)
      await Promise.resolve()
    })
    // 断口续接：补回 turn 2、turn 3 的历史行（它们的 seq 在已加载那页之后）。
    // m4 就是屏上那条发言的服务端落库——正文与服务端存的一样（流式被掐断时只到一半，
    // 历史那份才是完整的）。
    gapRows = [historyRow('m3', 3), historyRow('m4', 4, 'turn 3 的回复')]
    await act(async () => {
      onGap?.()
      vi.advanceTimersByTime(50)
      await Promise.resolve()
      await Promise.resolve()
    })

    const texts = turnTexts()
    // 历史第一页（turn 1、2）之后是补回的行，再之后才是流式那条：轮次必须单调不减。
    const order = [...bucket.getView().history, ...store.getSnapshot().messages].map((message) => {
      return message.turnIndex
    })
    expect(order).toEqual(
      [...order].sort((a, b) => {
        return a - b
      }),
    )
    expect(texts[0]).toContain('第 1 条')
    expect(texts[1]).toContain('第 2 条')
    // turn 2 是补回的缺口行，按轮次归位排在中间。
    expect(texts[2]).toContain('第 3 条')
    // turn 3 那一块里同一条发言只有一份（此前 hist:m4 与 stream:ryen:3 并排出现两次）。
    const blocks = [...container.querySelectorAll('.turn-block')]
    expect(blocks.length).toBe(4)
    expect(blocks[3]?.querySelectorAll('.bubble-row')).toHaveLength(1)
    expect(texts[3]).toContain('turn 3 的回复')
    // 留下的是历史那一份：它带服务端消息 id，搜索定位（data-message-id）与反馈去重靠它，
    // 流式副本的 key 是 stream:<sender>:<turn>，压根没有这个 id。
    expect(blocks[3]?.querySelector('.bubble-row')?.getAttribute('data-message-id')).toBe('m4')
    // 断线时已收口的那条没有被排到末尾：它和 turn 3 的缺口行同处一块，
    // 同一轮没被切成两个 turn 块（旧行为下两块同用 turnIndex 做 key 会撞）。
    expect(
      errors.filter((line) => {
        return line.includes('same key')
      }),
    ).toEqual([])
  })
})
