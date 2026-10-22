// @vitest-environment jsdom
/**
 * 波次8 接线复核：上一波留下的跨文件契约，逐条钉死。
 *
 * 这一组测的都是「组件 / 客户端 / 样式表之间有没有真的连上」——它们不会因为某一方
 * 改了名字而编译失败，只会在界面上悄悄退化：动画重播、编辑按钮变灰、每个请求 401、
 * 响应里多出几千个向量字段。静态护栏挡不住这些，只有真跑一遍才看得见。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, currentApiToken, onApiToken, setApiToken, startApiTokenSync } from '../renderer/src/api.ts'
import type { ProviderApi, UpdateProviderInput } from '../renderer/src/components/ProviderSettings.tsx'

const BASE = 'http://127.0.0.1:9'

/** 记录每次 fetch 的 URL / 方法 / 头，按测试需要回包。 */
function stubFetch(reply: (url: string, init: RequestInit | undefined) => Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const stub = vi.fn(async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return reply(String(input), init)
  })
  vi.stubGlobal('fetch', stub)
  return calls
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => {
      return Promise.resolve(body)
    },
  } as Response
}

/** 可控的假 WebSocket：只记下自己被要求连到哪个 URL。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  close(): void {}
}

describe('本地 API token：渲染层每个请求都得带上', () => {
  const realWs = globalThis.WebSocket

  beforeEach(() => {
    FakeWebSocket.instances = []
    ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
    setApiToken('')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    ;(globalThis as { WebSocket?: unknown }).WebSocket = realWs
    setApiToken('')
  })

  it('HTTP 请求带上 Authorization: Bearer <token>——后端对每个请求强制校验，缺了就是一片 401', async () => {
    setApiToken('tok-abc')
    const calls = stubFetch(() => {
      return jsonResponse({ agents: [] })
    })

    await new ApiClient(BASE).listAgents()

    expect(calls).toHaveLength(1)
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok-abc')
    // 既有的 content-type 不能被顶掉：后端按 JSON 解析请求体。
    expect(headers['content-type']).toBe('application/json')
  })

  it('本次启动不启用鉴权时不带这个头（浏览器直连开发）', async () => {
    const calls = stubFetch(() => {
      return jsonResponse({ agents: [] })
    })

    await new ApiClient(BASE).listAgents()

    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
  })

  it('token 晚于客户端构造才到时也照样带上（窗口先行、后端并行启动的那条路）', async () => {
    const calls = stubFetch(() => {
      return jsonResponse({ agents: [] })
    })
    const api = new ApiClient(BASE)

    setApiToken('late-token')
    await api.listAgents()

    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer late-token')
  })

  it('WS 握手把 token 放进查询串（浏览器 WS 不能带自定义头）', () => {
    setApiToken('ws-token')
    new ApiClient(BASE).subscribe('c1', () => {})

    const url = new URL(FakeWebSocket.instances[0]?.url as string)
    expect(url.searchParams.get('token')).toBe('ws-token')
    expect(url.searchParams.get('conversationId')).toBe('c1')
  })

  it('startApiTokenSync 接上事件与全局变量两条下发路', () => {
    const globals = window as unknown as Record<string, unknown>
    const seen: string[] = []
    const off = onApiToken((token) => {
      seen.push(token)
    })
    // 幂等：重复调用只再扫一遍现值，不会把监听器叠成多份。
    startApiTokenSync()
    startApiTokenSync()

    window.dispatchEvent(new CustomEvent('ryharness:api-token', { detail: 'from-event' }))
    expect(currentApiToken()).toBe('from-event')
    expect(seen).toEqual(['from-event'])

    globals.__RYHARNESS_API_TOKEN__ = 'from-global'
    startApiTokenSync()
    expect(currentApiToken()).toBe('from-global')

    off()
    delete globals.__RYHARNESS_API_TOKEN__
  })

  it('URL 上的 ?token= 也认（主进程加载窗口时就已经带上）', () => {
    window.history.replaceState({}, '', '/?token=from-query')
    setApiToken('')
    startApiTokenSync()
    expect(currentApiToken()).toBe('from-query')
    window.history.replaceState({}, '', '/')
  })
})

describe('供应商编辑：api.ts 补上 PATCH 方法', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('updateProvider 打 PATCH，字段名与端点白名单一致', async () => {
    const calls = stubFetch(() => {
      return jsonResponse({ provider: { id: 'deepseek' } })
    })
    const patch: UpdateProviderInput = {
      displayName: 'DeepSeek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat'],
    }

    const body = await new ApiClient(BASE).updateProvider('deepseek', patch)

    const call = calls[0]
    expect(call?.url).toBe(`${BASE}/api/providers/deepseek`)
    expect(call?.init?.method).toBe('PATCH')
    expect(JSON.parse(String(call?.init?.body))).toEqual(patch)
    expect(body.provider).toEqual({ id: 'deepseek' })
  })

  it('id 里的特殊字符要转义（供应商 id 可由用户自定义）', async () => {
    const calls = stubFetch(() => {
      return jsonResponse({ provider: {} })
    })

    await new ApiClient(BASE).updateProvider('a/b c', {
      displayName: 'x',
      protocol: 'openai',
      baseUrl: 'https://x.dev/v1',
      models: ['m'],
    })

    expect(calls[0]?.url).toBe(`${BASE}/api/providers/a%2Fb%20c`)
  })

  it('服务端 409 不被吞掉：调用方要拿得到原因（端点冲突 / 模型仍被引用）', async () => {
    stubFetch(() => {
      return jsonResponse({ error: 'provider "x" is used by 1 agent(s)' }, 409)
    })

    // status / raw 是调用方要的（前者判 409，后者对得上服务端日志）；message 给人话。
    await expect(
      new ApiClient(BASE).updateProvider('x', {
        displayName: 'x',
        protocol: 'openai',
        baseUrl: 'https://x.dev/v1',
        models: ['m'],
      }),
    ).rejects.toMatchObject({
      status: 409,
      raw: 'provider "x" is used by 1 agent(s)',
      message: '还有助理在用这家模型服务，先去通讯录改绑再删。',
    })
  })

  it('真实的 ApiClient 满足 ProviderApi：编辑入口在真应用里不是「后端未跟上」', () => {
    // ProviderSettings 用 api.updateProvider === undefined 决定「编辑」按钮给不给。
    // 少了这个方法，生产里整条编辑链会静默降级成一句「服务端还不支持编辑供应商」。
    const client: ProviderApi = new ApiClient(BASE)
    expect(typeof client.updateProvider).toBe('function')
  })
})
