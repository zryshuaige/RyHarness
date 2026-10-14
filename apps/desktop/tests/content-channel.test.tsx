// @vitest-environment jsdom
/**
 * 输入区与内容渲染的接线验收网：
 *   1) 排队期间输入框继续可写可发（旧的 disabled 会把输入静默吞掉）；
 *   2) 首个 token 到达后「正在输入」消失，但这一轮仍在跑——停止按钮不能跟着没；
 *   3) 附件从拖放到落库再到消息上屏是一条完整通道；
 *
 * 样式约定（token 单源 / 不重画既有选择器）见 content-styles.test.ts——
 * 那份要读文件，跑在 node 环境里。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, ApiClient, Conversation, MessageRow, WsEvent } from '../renderer/src/api.ts'
import { ChatView, toBase64 } from '../renderer/src/components/ChatView.tsx'
import { LEAVE_MS } from '../renderer/src/lib/useLeaving.ts'
import { ChatStore } from '../renderer/src/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom 的 Blob 没有 arrayBuffer()（Electron/浏览器有），上传通道要读字节，先补上。
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    value(this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          resolve(reader.result as ArrayBuffer)
        }
        reader.onerror = () => {
          reject(reader.error)
        }
        reader.readAsArrayBuffer(this)
      })
    },
  })
}

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

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined
let store: ChatStore
let push: (event: WsEvent) => void
let posted: { conversationId: string; text: string }[]

function historyRow(): MessageRow {
  return {
    id: 'm1',
    seq: 1,
    conversationId: 'c1',
    senderType: 'agent',
    senderId: 'ryen',
    contentBlocks: [{ type: 'text', text: '历史消息' }],
    mentions: [],
    turnIndex: 0,
    createdAt: 1000,
  }
}

function fakeApi(): ApiClient {
  return {
    base: 'http://127.0.0.1:32100',
    messages: () => {
      return Promise.resolve({ messages: [historyRow()] })
    },
    markRead: () => {
      return Promise.resolve({ conversationId: 'c1', lastReadSeq: 1 })
    },
    listDispatchEvents: () => {
      return Promise.resolve({ events: [] })
    },
    postMessage: (conversationId: string, text: string) => {
      posted.push({ conversationId, text })
      return Promise.resolve({ accepted: true })
    },
    cancelTurn: () => {
      return Promise.resolve({ cancelled: true })
    },
    fileUrl: (name: string) => {
      return `/api/files/${name}`
    },
    subscribe: (_id: string, onEvent: (event: WsEvent) => void) => {
      push = onEvent
      return () => {}
    },
  } as unknown as ApiClient
}

async function render(): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<ChatView api={fakeApi()} conversation={conversation} agents={[agent]} store={store} />)
    await Promise.resolve()
  })
}

function emit(event: WsEvent): void {
  act(() => {
    push(event)
    vi.advanceTimersByTime(50)
  })
}

function typeInto(node: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function dropEvent(files: File[]): Event {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files, items: [], types: ['Files'] } })
  return event
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  store = new ChatStore()
  posted = []
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = undefined
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('排队期间输入不被吞', () => {
  it('queued 状态下 textarea 仍可写可发', async () => {
    await render()
    emit({ type: 'queued', conversationId: 'c1', senderId: 'user', turnIndex: 1 })
    expect(store.getSnapshot().queueing).toBe(true)

    const textarea = container.querySelector('textarea')!
    expect(textarea.disabled).toBe(false)
    typeInto(textarea, '排队时也要能说话')
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(posted.map((item) => item.text)).toEqual(['排队时也要能说话'])
  })
})

describe('「正在输入」与流式气泡不再自相矛盾', () => {
  it('首个 token 到达后打字指示器消失，停止按钮与秒表留着', async () => {
    await render()
    emit({ type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 1 })
    expect(container.querySelector('.typing-indicator')).not.toBeNull()
    expect(container.querySelector('.stop-btn')).not.toBeNull()

    emit({ type: 'text-delta', conversationId: 'c1', senderId: 'ryen', text: '周报' })
    // 气泡已经在出字了
    expect(container.querySelectorAll('.bubble-text')[1]?.textContent).toContain('周报')
    // 但「正在输入」与它并存就是自相矛盾
    expect(store.getSnapshot().typing).toEqual({})
    act(() => {
      vi.advanceTimersByTime(LEAVE_MS)
    })
    expect(container.querySelector('.typing-indicator')).toBeNull()
    // 这一轮还在跑：停止按钮绝不能跟着打字指示器一起消失
    expect(container.querySelector('.stop-btn')).not.toBeNull()

    emit({ type: 'message-done', conversationId: 'c1', senderId: 'ryen', turnIndex: 1 })
    act(() => {
      vi.advanceTimersByTime(LEAVE_MS)
    })
    expect(container.querySelector('.stop-btn')).toBeNull()
  })
})

describe('附件通道接线', () => {
  it('拖放 → 落库 → 用户气泡出文件卡片，正文带附件记述', async () => {
    const requests: { url: string; body: { name: string; data: string } }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        requests.push({ url, body: JSON.parse(String(init.body)) })
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => {
            return Promise.resolve({ name: 'shot.png', size: 2048, mime: 'image/png' })
          },
        })
      }),
    )
    await render()
    const zone = container.querySelector('.attach-zone')!
    await act(async () => {
      zone.dispatchEvent(dropEvent([new File([new Uint8Array(2048)], 'shot.png', { type: 'image/png' })]))
      await Promise.resolve()
      // FileReader 走 jsdom 的排队任务，假计时器下要放行才读得到字节
      vi.advanceTimersByTime(10)
      await Promise.resolve()
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('http://127.0.0.1:32100/api/conversations/c1/files')
    expect(requests[0]?.body.name).toBe('shot.png')

    const textarea = container.querySelector('textarea')!
    typeInto(textarea, '这张图对吗')
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    act(() => {
      vi.advanceTimersByTime(60)
    })

    expect(posted.map((item) => item.text)).toEqual(['这张图对吗\n[附件] shot.png（2.0 KB，image/png）'])
    const message = store.getSnapshot().messages.at(-1)
    expect(message?.parts.some((part) => part.kind === 'file')).toBe(true)
    expect(container.querySelector('.file-card')?.textContent).toContain('shot.png')
  })

  it('上传失败如实报错，文字仍能照发', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => {
            return Promise.resolve({ error: 'not found: POST /api/conversations/c1/files' })
          },
        })
      }),
    )
    await render()
    await act(async () => {
      container
        .querySelector('.attach-zone')!
        .dispatchEvent(dropEvent([new File(['x'], 'a.png', { type: 'image/png' })]))
      await Promise.resolve()
      vi.advanceTimersByTime(10)
      await Promise.resolve()
    })
    expect(container.querySelector('.attach-item.is-error')?.textContent).toContain('not found')

    const textarea = container.querySelector('textarea')!
    typeInto(textarea, '先不管附件')
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(posted.map((item) => item.text)).toEqual(['先不管附件'])
  })
})

describe('toBase64', () => {
  it('分块编码二进制', () => {
    expect(toBase64(new Uint8Array([104, 105]))).toBe(btoa('hi'))
    expect(toBase64(new Uint8Array(0))).toBe('')
  })
})
