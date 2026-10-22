// @vitest-environment jsdom
/**
 * 左栏搜索：一个输入框、同一套结果（"会话"与"消息"两节）。
 *
 * 修掉的那个毛病：搜索框里输满两个字，整棵左栏就被换成"消息搜索结果"视图，
 * 于是"按会话名找会话"根本没法用——想找叫"周报"的会话，输入"周"看不见会话，
 * 输入"周报"就跳去消息模式，会话名结果根本看不到。
 *
 * 钉的是：输入一个字与输入两个字是同一套结果（两节同时在）；会话名能命中会话；
 * 两处都没命中时给的是一句人话；消息命中的跳转老路没坏。
 *
 * @module @ryharness/desktop/tests/conversation-list-search
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, Conversation, SearchResultRow } from '../renderer/src/api.ts'
import {
  type ConversationApi,
  ConversationList,
  matchConversation,
} from '../renderer/src/components/ConversationList.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agents: AgentDef[] = [
  { id: 'ryen', name: 'Ryen', avatar: 'cat', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: true },
  { id: 'coder', name: '小码', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: false },
]

const conversations: Conversation[] = [
  {
    id: 'c1',
    kind: 'direct',
    title: '周报',
    memberAgentIds: ['ryen'],
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 2,
    lastMessagePreview: '把周报整理好了',
  },
  {
    id: 'c2',
    kind: 'direct',
    title: '小码',
    memberAgentIds: ['coder'],
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 3,
    lastMessagePreview: '脚本写好了',
  },
]

const hits: SearchResultRow[] = [
  {
    conversationId: 'c1',
    conversationTitle: '周报',
    messageId: 'm1',
    snippet: '周报里的第三点…',
    agentId: 'ryen',
    createdAt: 100,
  },
]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
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
    root?.unmount()
  })
  root = undefined
  container.remove()
  vi.unstubAllGlobals()
})

function fakeApi(results: SearchResultRow[]): ConversationApi {
  return {
    searchMessages: () => {
      return Promise.resolve({ results })
    },
    patchConversation: () => {
      return Promise.resolve({ conversation: undefined })
    },
    deleteConversation: () => {
      return Promise.resolve({ deleted: '' })
    },
  }
}

async function renderList(
  api: ConversationApi,
  extras: {
    onSelect?: (id: string) => void
    onJumpToMessage?: (conversationId: string, messageId: string) => void
  } = {},
): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(
      createElement(ConversationList, {
        conversations,
        agents,
        activeId: 'c1',
        api,
        onSelect: extras.onSelect ?? (() => {}),
        ...(extras.onJumpToMessage === undefined ? {} : { onJumpToMessage: extras.onJumpToMessage }),
      }),
    )
    await Promise.resolve()
  })
}

function typeQuery(value: string): void {
  const input = container.querySelector<HTMLInputElement>('.search-box')
  if (input === null) throw new Error('找不到搜索框')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('拿不到 value 的 setter')
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 搜索是防抖的：推进定时器让请求真的发出去，再等它落地。 */
async function settleSearch(ms = 300): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** 两节的名字（顺序固定：会话在前，消息在后）。 */
function sectionNames(): string[] {
  return [...container.querySelectorAll('.search-section')].map((node) => {
    return node.getAttribute('data-section') ?? ''
  })
}

describe('搜索：同一个输入框，同一套两节结果', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('输入一个字与输入两个字是同一套结果：两节同时在，没有模式突变', async () => {
    await renderList(fakeApi(hits))
    typeQuery('周')
    expect(sectionNames()).toEqual(['conversations', 'messages'])
    // 一个字时"会话"那节照样能命中（会话名不需要两个字）
    expect(container.querySelector('[data-section="conversations"]')?.textContent).toContain('周报')

    typeQuery('周报')
    await settleSearch()
    // 满两个字之后还是那两节：整棵左栏没有被换成另一种视图
    expect(sectionNames()).toEqual(['conversations', 'messages'])
    expect(container.querySelector('[data-section="messages"]')?.textContent).toContain('周报里的第三点')
  })

  it('搜会话名能命中会话：命中片段被标出来，点它就是进那个会话', async () => {
    const selected: string[] = []
    await renderList(fakeApi(hits), {
      onSelect: (id: string) => {
        selected.push(id)
      },
    })
    typeQuery('周报')
    await settleSearch()
    const section = container.querySelector('[data-section="conversations"]')
    const row = section?.querySelector<HTMLButtonElement>('.conversation-item-main')
    expect(row?.textContent).toContain('周报')
    // 命中的那两个字被标出来（标在标题上，不是标在别处）
    expect(section?.querySelector('.search-title-mark')?.textContent).toBe('周报')
    act(() => {
      row?.click()
    })
    expect(selected).toEqual(['c1'])
  })

  it('标题没命中时用摘要兜底（用户记得的是那句话，不是那个标题）', async () => {
    await renderList(fakeApi([]))
    typeQuery('整理好了')
    await settleSearch()
    const section = container.querySelector('[data-section="conversations"]')
    expect(section?.querySelectorAll('.conversation-item')).toHaveLength(1)
    expect(section?.querySelector('.search-title-mark')?.textContent).toBe('整理好了')
  })

  it('两处都没命中时给一句人话，不是干巴巴的"无结果"', async () => {
    await renderList(fakeApi([]))
    typeQuery('查无此物')
    await settleSearch()
    const text = container.textContent ?? ''
    expect(text).toContain('换个词试试')
    expect(text).not.toContain('无结果')
  })

  it('消息命中的跳转老路没坏：切会话 + 定位那条消息', async () => {
    const selected: string[] = []
    const jumped: Array<[string, string]> = []
    await renderList(fakeApi(hits), {
      onSelect: (id: string) => {
        selected.push(id)
      },
      onJumpToMessage: (conversationId: string, messageId: string) => {
        jumped.push([conversationId, messageId])
      },
    })
    typeQuery('周报')
    await settleSearch()
    const hit = container.querySelector<HTMLButtonElement>('.search-hit')
    act(() => {
      hit?.click()
    })
    expect(selected).toEqual(['c1'])
    expect(jumped).toEqual([['c1', 'm1']])
  })

  it('没有全文搜索接口时降级：会话名照找，消息那节说清原因', async () => {
    await renderList({
      patchConversation: () => {
        return Promise.resolve({ conversation: undefined })
      },
    })
    typeQuery('周报')
    await settleSearch()
    expect(container.textContent).toContain('全文搜索暂不可用')
    expect(sectionNames()).toEqual(['conversations', 'messages'])
    expect(container.querySelectorAll('.conversation-item')).toHaveLength(1)
  })
})

describe('会话匹配（纯函数）', () => {
  const conversation = conversations[0] as Conversation
  /** 标题是"周报"、成员却是"小码"：这种会话只能靠成员名命中。 */
  const titledByOthers: Conversation = { ...conversation, id: 'c3', memberAgentIds: ['coder'] }
  const memberName = (id: string): string => {
    return (
      agents.find((agent) => {
        return agent.id === id
      })?.name ?? id
    )
  }

  it('标题命中优先；标题没命中就用摘要兜底；成员名也算', () => {
    expect(matchConversation(conversation, '周报', memberName)).toBe('title')
    expect(matchConversation(conversation, '整理好了', memberName)).toBe('summary')
    // 成员助理的名字里也有这个词：算命中（老口径一直有）
    expect(matchConversation(titledByOthers, '小码', memberName)).toBe('member')
    expect(matchConversation(conversation, '查无此物', memberName)).toBeNull()
    expect(matchConversation(conversation, '   ', memberName)).toBeNull()
  })
})
