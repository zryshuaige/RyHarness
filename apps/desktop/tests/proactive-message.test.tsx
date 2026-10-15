// @vitest-environment jsdom
/**
 * 主动消息（服务端每日的回顾）在界面上的三件事：
 * 1. 那条消息带「Ryen 主动找你」标识——它不是用户问出来的，长得跟用户消息一样就说清了；
 * 2. 会话列表给一个「主动」角标，点进去就是那条回顾；
 * 3. 未读角标照常（主动消息是 agent 消息，落在会话里就该算未读）。
 *
 * api 全是替身：这里要验的是渲染层怎么认出「这条是它主动说的」，不是服务端怎么写。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, ApiClient, Conversation, MessageRow } from '../renderer/src/api.ts'
import { ChatView, fromHistory } from '../renderer/src/components/ChatView.tsx'
import { ConversationList, type ConversationRow } from '../renderer/src/components/ConversationList.tsx'
import { WelcomeHome } from '../renderer/src/components/WelcomeHome.tsx'
import { ChatStore, isProactiveRow, PROACTIVE_BLOCK_TYPE } from '../renderer/src/store.ts'

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
  lastReadSeq: 0,
  createdAt: 1,
  updatedAt: 2,
}

/** 服务端写出来的主动消息：标记块 + 正文（正文里没有任何哨兵字符串）。 */
function proactiveRow(seq: number): MessageRow {
  return {
    id: `p${seq}`,
    seq,
    conversationId: 'c1',
    senderType: 'agent',
    senderId: 'ryen',
    contentBlocks: [
      { type: PROACTIVE_BLOCK_TYPE },
      { type: 'text', text: '早上好，有几件事想跟你说：\n- 新记住了 1 条：「咖啡机在阳台左边」' },
    ],
    mentions: [],
    turnIndex: seq - 1,
    createdAt: 1000 + seq,
  }
}

function agentRow(seq: number): MessageRow {
  return {
    id: `m${seq}`,
    seq,
    conversationId: 'c1',
    senderType: 'agent',
    senderId: 'ryen',
    contentBlocks: [{ type: 'text', text: '在的，随时说' }],
    mentions: [],
    turnIndex: seq - 1,
    createdAt: 1000 + seq,
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let store: ChatStore
let history: MessageRow[]
/** 带主动标记的会话行（服务端 GET /api/conversations 附带的 proactive 那一维）。 */
const rows: ConversationRow[] = [
  { ...conversation, lastMessagePreview: '早上好，有几件事想跟你说', proactive: true, unreadCount: 1 },
]

function fakeApi(): ApiClient {
  return {
    base: 'http://api.test',
    messages: () => {
      return Promise.resolve({ messages: history })
    },
    markRead: () => {
      return Promise.resolve({ conversationId: 'c1', lastReadSeq: 0 })
    },
    listDispatchEvents: () => {
      return Promise.resolve({ events: [] })
    },
    postMessage: () => {
      return Promise.resolve({ accepted: true })
    },
    cancelTurn: () => {
      return Promise.resolve({ cancelled: true })
    },
    fileUrl: (name: string) => {
      return `/api/files/${name}`
    },
    subscribe: () => {
      return () => {}
    },
  } as unknown as ApiClient
}

async function renderChat(): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<ChatView api={fakeApi()} conversation={conversation} agents={[agent]} store={store} />)
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  store = new ChatStore()
  history = [agentRow(1)]
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container.remove()
})

describe('从消息行认出「这条是它主动说的」', () => {
  it('标记块在正文之外：正文干净，标识靠内容块本身', () => {
    expect(isProactiveRow(proactiveRow(1))).toBe(true)
    expect(isProactiveRow(agentRow(1))).toBe(false)
  })

  it('fromHistory 把它标成 proactive，普通 agent 消息不带这个标记', () => {
    const rows = fromHistory([agentRow(1), proactiveRow(2)], (id) => {
      return id
    })
    expect(rows.map((row) => row.proactive)).toEqual([undefined, true])
    // 正文照常进 text 部件（模型与全文搜索读到的都是它，不含任何哨兵）。
    expect(rows[1]?.parts).toEqual([
      { kind: 'text', text: '早上好，有几件事想跟你说：\n- 新记住了 1 条：「咖啡机在阳台左边」' },
    ])
  })
})

describe('聊天区里的主动标识', () => {
  it('主动消息上方有一行「Ryen 主动找你」，普通回复没有', async () => {
    history = [agentRow(1), proactiveRow(2)]
    await renderChat()

    const badges = [...container.querySelectorAll('[data-proactive="true"]')].map((node) => node.textContent)
    expect(badges).toHaveLength(1)
    expect(badges[0]).toContain('Ryen 主动找你')
    // 标识在气泡之前：它标的是「下面这条是它主动开口的」。
    const badge = container.querySelector('[data-proactive="true"]') as HTMLElement
    expect(badge.nextElementSibling?.className).toContain('bubble-row')
    // 气泡本身仍是 agent 气泡（左侧、带 Ryen 名字），不是用户那条右对齐的气泡。
    expect(container.querySelectorAll('.bubble-row.from-user')).toHaveLength(0)
  })

  it('整个会话没有主动消息时，一行标识都不出现', async () => {
    history = [agentRow(1), agentRow(2)]
    await renderChat()
    expect(container.querySelectorAll('[data-proactive="true"]')).toHaveLength(0)
  })
})

describe('会话列表与首屏', () => {
  async function renderList(onSelect: (id: string) => void): Promise<void> {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <ConversationList conversations={rows} agents={[agent]} activeId={undefined} onSelect={onSelect} api={{}} />,
      )
      await Promise.resolve()
    })
  }

  it('行上有「主动」角标，未读角标照常；点这一行进那个会话', async () => {
    const selected: string[] = []
    await renderList((id) => {
      selected.push(id)
    })

    const flag = container.querySelector('.conversation-item [data-proactive="true"]')
    expect(flag?.textContent).toBe('主动')
    expect(container.querySelector('.unread-badge')?.textContent).toBe('1')

    const main = container.querySelector('.conversation-item-main') as HTMLButtonElement
    act(() => {
      main.click()
    })
    expect(selected).toEqual(['c1'])
  })

  it('没有主动消息的会话不给角标', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <ConversationList
          conversations={[{ ...conversation, lastMessagePreview: '在的，随时说' }]}
          agents={[agent]}
          activeId={undefined}
          onSelect={() => {}}
          api={{}}
        />,
      )
      await Promise.resolve()
    })
    expect(container.querySelector('.conversation-item [data-proactive="true"]')).toBeNull()
  })

  it('首屏最近会话同样标出来，点它就打开那个会话', async () => {
    const opened: string[] = []
    await act(async () => {
      root = createRoot(container)
      root.render(
        <WelcomeHome
          ryen={agent}
          agents={[agent]}
          conversations={[...rows].slice(0, 1)}
          providers={[]}
          onSaveApiKey={() => {
            return Promise.resolve()
          }}
          onSend={() => {}}
          onOpenConversation={(id) => {
            opened.push(id)
          }}
        />,
      )
      await Promise.resolve()
    })

    const item = container.querySelector('.welcome-recent-item') as HTMLButtonElement
    expect(item.querySelector('[data-proactive="true"]')?.textContent).toBe('主动')
    act(() => {
      item.click()
    })
    expect(opened).toEqual(['c1'])
  })
})
