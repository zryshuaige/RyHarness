// @vitest-environment jsdom
/**
 * 组件层直连必须带 token（R0）。
 *
 * 生产（Electron 已启用鉴权）下主进程为每次启动生成 256 位 token，服务端对每个 HTTP
 * 请求都比对一次，缺 token 一律 401。此前 ChatView 里有两处裸 fetch：
 *   1. fetchMessageWindow（搜索命中的定位窗口）——401 之后弹的是「没能定位到这条消息，
 *      检查一下本地服务是否在运行」，把用户引向完全错误的排查方向；
 *   2. uploadAttachment（附件落库）——服务端 401 的英文原文 missing or invalid API token
 *      会原样贴到附件卡片上。
 *
 * 两条断言都直接读**发出去的那个请求的头**：token 只在 ApiClient.request 里注入，
 * 而这两条调用刻意不走 ApiClient（around 游标不在 messages() 的口径里，附件端点
 * 也没有对应方法），所以只能断言请求本身。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AgentDef, ApiClient, type Conversation, type MessageRow, setApiToken } from '../renderer/src/api.ts'
import { ChatView, fetchMessageWindow } from '../renderer/src/components/ChatView.tsx'
import { bucketOf, ChatStore } from '../renderer/src/store.ts'

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

function windowRow(): MessageRow {
  return {
    id: 'm9',
    seq: 9,
    conversationId: 'c1',
    senderType: 'agent',
    senderId: 'ryen',
    contentBlocks: [{ type: 'text', text: '命中那条' }],
    mentions: [],
    turnIndex: 8,
    createdAt: 1000,
  }
}

/** 一次请求的头（RequestInit.headers 是联合类型，统一读成 Headers 再取值）。 */
function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name)
}

/** 录下每次 fetch 的 url / method / 头，body 交给各用例自己断言。 */
function recordFetch(respond: (url: string) => unknown): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(respond(url))
  })
  return calls
}

function okResponse(body: unknown): unknown {
  return { ok: true, status: 200, json: () => Promise.resolve(body) }
}

/** 只实现 ChatView 首屏用到的那几个方法的客户端（其余走真实现，不会发请求）。 */
function stubApi(): ApiClient {
  const api = new ApiClient('http://127.0.0.1:32100')
  api.messages = () => {
    return Promise.resolve({ messages: [] })
  }
  api.markRead = () => {
    return Promise.resolve({ conversationId: 'c1', lastReadSeq: 0 })
  }
  api.listDispatchEvents = () => {
    return Promise.resolve({ events: [] })
  }
  api.postMessage = () => {
    return Promise.resolve({ accepted: true })
  }
  api.fileUrl = (name: string) => {
    return `/api/files/${name}`
  }
  api.subscribe = () => {
    return () => {}
  }
  return api
}

describe('fetchMessageWindow：定位窗口的请求带 token', () => {
  afterEach(() => {
    setApiToken('')
    vi.unstubAllGlobals()
  })

  it('带上 Authorization 头（缺了它生产环境必然 401）', async () => {
    setApiToken('token-abc')
    const calls = recordFetch(() => okResponse({ messages: [windowRow()] }))
    const rows = await fetchMessageWindow(new ApiClient('http://api.test'), 'c1', 'm9')
    expect(rows).toHaveLength(1)
    expect(headerOf(calls[0]?.init, 'authorization')).toBe('Bearer token-abc')
  })

  it('token 是现读的：晚于客户端构造到达的那一个也会被带上', async () => {
    const api = new ApiClient('http://api.test')
    setApiToken('first-token')
    setApiToken('later-token')
    const calls = recordFetch(() => okResponse({ messages: [] }))
    await fetchMessageWindow(api, 'c1', 'm9')
    expect(headerOf(calls[0]?.init, 'authorization')).toBe('Bearer later-token')
  })

  it('本次启动未启用鉴权时不加这个头（浏览器直连开发的既有行为不变）', async () => {
    setApiToken('')
    const calls = recordFetch(() => okResponse({ messages: [] }))
    await fetchMessageWindow(new ApiClient('http://api.test'), 'c1', 'm9')
    expect(headerOf(calls[0]?.init, 'authorization')).toBeNull()
  })

  it('around 游标与 404 语义都还在（加 token 不能顺手改了行为）', async () => {
    setApiToken('token-abc')
    const calls = recordFetch(() => ({ ok: false, status: 404, json: () => Promise.resolve({}) }))
    await expect(fetchMessageWindow(new ApiClient('http://api.test'), 'c1', 'gone')).resolves.toEqual([])
    expect(calls[0]?.url).toBe('http://api.test/api/conversations/c1/messages?around=gone&window=25')
  })
})

describe('附件上传：落库请求带 token', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot> | undefined

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = undefined
    container.remove()
    setApiToken('')
    vi.unstubAllGlobals()
  })

  /** 拖一个文件进输入区，等它走完上传。 */
  async function dropFile(): Promise<void> {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <ChatView api={stubApi()} conversation={conversation} agents={[agent]} bucket={bucketOf(new ChatStore())} />,
      )
      await Promise.resolve()
    })
    const zone = container.querySelector('.attach-zone')
    expect(zone).not.toBeNull()
    const file = new File([new Uint8Array(8)], 'shot.png', { type: 'image/png' })
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { files: [file], items: [], types: ['Files'] } })
    await act(async () => {
      zone?.dispatchEvent(event)
      await Promise.resolve()
      // FileReader 走 jsdom 的排队任务，放行才读得到字节
      vi.advanceTimersByTime(10)
      await Promise.resolve()
    })
  }

  it('POST 落库带上 Authorization 头（此前 401 的英文原文会贴到卡片上）', async () => {
    vi.useFakeTimers()
    setApiToken('token-upload')
    const calls = recordFetch(() => okResponse({ name: 'shot.png', size: 8, mime: 'image/png' }))
    try {
      await dropFile()
    } finally {
      vi.useRealTimers()
    }
    const upload = calls.filter((call) => {
      return call.url.endsWith('/files')
    })
    expect(upload).toHaveLength(1)
    expect(upload[0]?.init?.method).toBe('POST')
    expect(headerOf(upload[0]?.init, 'authorization')).toBe('Bearer token-upload')
    // 上传真的成了：附件条上是 ready 态而不是错误态（此前这里是 401 的英文原文）。
    expect(container.querySelector('.attach-item.is-ready')?.textContent).toContain('shot.png')
  })
  it('fileUrl 把 token 拼进查询串（<a>/<img> 带不了 Authorization 头，只能走 ?token=）', () => {
    setApiToken('token-file')
    const client = new ApiClient('http://127.0.0.1:32100')
    // 生产模式没有它，每张文件卡片都是 401：图裂开、点开是 JSON 错误页。
    expect(client.fileUrl('report.md')).toBe('http://127.0.0.1:32100/api/files/report.md?token=token-file')
    setApiToken('')
    // 未启用鉴权的启动（浏览器直连开发）不该凭空多一个空 token 参数。
    expect(client.fileUrl('report.md')).toBe('http://127.0.0.1:32100/api/files/report.md')
  })

  it('fileUrl 对带中文与空格的文件名做编码，token 也要编码', () => {
    setApiToken('a b+c')
    const client = new ApiClient('http://127.0.0.1:32100')
    const url = client.fileUrl('周报 终稿.md')
    expect(url).toContain('/api/files/%E5%91%A8%E6%8A%A5%20%E7%BB%88%E7%A8%BF.md')
    expect(url.endsWith('?token=a%20b%2Bc')).toBe(true)
    setApiToken('')
  })
})
