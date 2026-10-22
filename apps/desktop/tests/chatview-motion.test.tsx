// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, ApiClient, Conversation, MessageRow, WsEvent } from '../renderer/src/api.ts'
import { ChatView } from '../renderer/src/components/ChatView.tsx'
import { toast } from '../renderer/src/lib/toast.ts'
import { LEAVE_MS } from '../renderer/src/lib/useLeaving.ts'
import { bucketOf, ChatStore, type ConversationBucket } from '../renderer/src/store.ts'

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

function historyRow(id: string): MessageRow {
  return {
    id,
    seq: Number(id.slice(1)),
    conversationId: 'c1',
    senderType: 'agent',
    senderId: 'ryen',
    contentBlocks: [{ type: 'text', text: '历史消息' }],
    mentions: [],
    turnIndex: 0,
    createdAt: 1000,
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let store: ChatStore
let bucket: ConversationBucket
/** 由测试驱动的 WS 事件泵。 */
let push: (event: WsEvent) => void
/** 由测试驱动的连接状态。 */
let setStatus: (status: 'open' | 'reconnecting') => void

function fakeApi(): ApiClient {
  return {
    messages: () => {
      return Promise.resolve({ messages: [historyRow('m1')] })
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
    cancelTurn: () => {
      return Promise.resolve({ cancelled: true })
    },
    fileUrl: (name: string) => {
      return `/api/files/${name}`
    },
    subscribe: (
      _id: string,
      onEvent: (event: WsEvent) => void,
      opts?: { onStatus?: (status: 'open' | 'reconnecting') => void },
    ) => {
      push = onEvent
      setStatus = (status) => {
        opts?.onStatus?.(status)
      }
      return () => {}
    },
  } as unknown as ApiClient
}

async function render(): Promise<void> {
  // 历史/调度事件的请求在 Promise 里落地，用 async act 等它们 resolve 后再断言。
  await act(async () => {
    root = createRoot(container)
    root.render(<ChatView api={fakeApi()} conversation={conversation} agents={[agent]} bucket={bucket} />)
    await Promise.resolve()
  })
}

/** store 的 40ms 合并通知 + 渲染。 */
function emit(event: WsEvent): void {
  act(() => {
    push(event)
    vi.advanceTimersByTime(50)
  })
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  store = new ChatStore()
  bucket = bucketOf(store)
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
  vi.useRealTimers()
})

describe('ChatView 退场接线', () => {
  it('历史气泡不播进场动画（只有本次会话新到的消息有 is-new）', async () => {
    await render()
    expect(container.querySelectorAll('.bubble-row.is-new')).toHaveLength(0)
    emit({ type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 1 })
    expect(container.querySelectorAll('.bubble-row.is-new')).toHaveLength(1)
  })

  it('生成结束后打字指示器先退场再卸载', async () => {
    await render()
    emit({ type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 1 })
    expect(container.querySelector('.typing-indicator')).not.toBeNull()

    emit({ type: 'message-done', conversationId: 'c1', senderId: 'ryen', turnIndex: 1 })
    const leaving = container.querySelector('.typing-indicator')
    expect(leaving?.className).toBe('typing-indicator is-leaving')
    expect(leaving?.textContent).toContain('Ryen')

    advance(LEAVE_MS - 1)
    expect(container.querySelector('.typing-indicator')).not.toBeNull()
    advance(1)
    expect(container.querySelector('.typing-indicator')).toBeNull()
  })

  it('错误横幅消失时先退场再卸载', async () => {
    await render()
    emit({ type: 'error', conversationId: 'c1', message: '上游超时', code: 'UPSTREAM' })
    expect(container.querySelector('.error-banner')).not.toBeNull()

    // 下一轮开始即视为错误过期
    emit({ type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 1 })
    expect(container.querySelector('.error-banner.is-leaving')).not.toBeNull()
    advance(LEAVE_MS)
    expect(container.querySelector('.error-banner')).toBeNull()
  })

  it('断线提示条出现/消失都走退场体系', async () => {
    await render()
    act(() => {
      setStatus('reconnecting')
    })
    expect(container.querySelector('.conn-banner')).not.toBeNull()

    act(() => {
      setStatus('open')
    })
    expect(container.querySelector('.conn-banner.is-leaving')).not.toBeNull()
    advance(LEAVE_MS)
    expect(container.querySelector('.conn-banner')).toBeNull()
  })

  it('toast 挂在输入区上沿（composer 变高也不会压住发送键）', async () => {
    await render()
    act(() => {
      toast.info('已复制')
    })
    const wrap = container.querySelector('.chat-input-wrap')!
    expect(wrap.querySelector('.toast-host')).not.toBeNull()
    expect(wrap.querySelector('.toast')).not.toBeNull()
  })
})
