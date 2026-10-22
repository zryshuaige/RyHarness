// @vitest-environment jsdom
/**
 * 回归：api 是**类实例**时，供应商区块的交互不能丢 `this`。
 *
 * 背景（真机 P0）：ProviderSettings 曾把 `api.verifyProvider` / `api.discoverProvider`
 * 裸取出来放进闭包再调用。生产环境里 api 是 `ApiClient` 类实例，方法内部走
 * `this.request`——裸取出来调用时 this 是 undefined，整棵 React 树被这次渲染期异常
 * 掀掉，#root 变成零子节点，窗口只剩一片空白（现由 ErrorBoundary 兜住，但那只是止损）。
 *
 * 为什么既有测试没拦住：provider-settings.test.tsx 的替身全是**对象字面量**，字面量的
 * 方法调用不带 this，于是"丢了 this 一样能跑"。这里换一个真类：每个方法内部真的读
 * `this.token` / `this.requests`，裸取出来调用必然在第一行炸掉。
 *
 * 断言也不看"有没有抛"（异步链上的抛出可能被吞掉），而是看**请求真的发出去了**：
 * `requests` 里必须出现带 token 的路径，界面上必须出现这条请求的结果。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderInfo, ProviderPreset } from '../renderer/src/api.ts'
import type { ProviderApi } from '../renderer/src/components/ProviderSettings.tsx'
import { ProviderSettings } from '../renderer/src/components/ProviderSettings.tsx'
import type { ProviderDiscoveryResponse, ProviderVerifyResponse } from '../renderer/src/lib/provider-health.ts'
import { getToasts, toast } from '../renderer/src/lib/toast.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ollamaProvider: ProviderInfo = {
  id: 'ollama',
  displayName: 'Ollama',
  apiKeyConfigured: false,
  protocol: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  models: [{ id: 'qwen2.5:7b' }],
}

const presets: ProviderPreset[] = [
  {
    id: 'ollama',
    displayName: 'Ollama',
    protocol: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5:7b'],
  },
]

/**
 * 真类替身：方法内部真的走 `this`。
 *
 * `request` 同时读 `this.requests` 与 `this.token`，所以「方法被拆出来单独调用」不再是
 * 一个能混过去的写法——它会在第一行抛 TypeError，而那次抛会顺着渲染路径掀掉整棵树。
 */
class ClassApi {
  /** 凭据每次请求现取（与真 ApiClient 同一形状，也是丢 this 的第一现场）。 */
  token = 'class-token'

  /** 每次 request() 记一条 'token 路径'：没有它就说明请求压根没发出去。 */
  readonly requests: string[] = []

  private async request(path: string): Promise<unknown> {
    this.requests.push(`${this.token} ${path}`)
    if (path.endsWith('/verify')) {
      return { ok: true, message: 'ollama is running', latencyMs: 7 }
    }
    if (path.endsWith('/discover')) {
      return { ok: true, models: [{ id: 'qwen2.5:7b' }] }
    }
    if (path.endsWith('/key')) {
      return { providerId: 'ollama', configured: true }
    }
    return { presets }
  }

  async setApiKey(providerId: string, _apiKey: string): Promise<{ providerId: string; configured: boolean }> {
    const body = await this.request(`/api/providers/${providerId}/key`)
    return body as { providerId: string; configured: boolean }
  }

  async providerPresets(): Promise<{ presets: ProviderPreset[] }> {
    const body = await this.request('/api/providers/presets')
    return body as { presets: ProviderPreset[] }
  }

  async verifyProvider(id: string): Promise<ProviderVerifyResponse> {
    const body = await this.request(`/api/providers/${id}/verify`)
    return body as ProviderVerifyResponse
  }

  async discoverProvider(_input: {
    baseUrl: string
    protocol: string
    apiKey?: string
  }): Promise<ProviderDiscoveryResponse> {
    const body = await this.request('/api/providers/discover')
    return body as ProviderDiscoveryResponse
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  // jsdom 没有 matchMedia，弹窗的退场动画要它。
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
  for (const item of getToasts()) toast.dismiss(item.id)
  vi.unstubAllGlobals()
})

/** 类实例直接交给组件：结构化类型上它就是合法的 ProviderApi，不需要任何断言。 */
async function renderSettings(api: ClassApi, providers: ProviderInfo[]): Promise<void> {
  const prop: ProviderApi = api
  await act(async () => {
    root = createRoot(container)
    root.render(<ProviderSettings api={prop} providers={providers} onChanged={() => {}} />)
    await Promise.resolve()
  })
}

function buttonByText(text: string, scope: ParentNode = container): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((node) => {
    return node.textContent?.includes(text)
  })
  if (found === undefined) throw new Error(`找不到按钮：${text}`)
  return found
}

describe('api 是类实例：裸取方法再调用会丢 this', () => {
  it('探活（verifyProvider）走的是 this.request，请求真的发出去了', async () => {
    const api = new ClassApi()
    await renderSettings(api, [ollamaProvider])
    await act(async () => {
      await Promise.resolve()
    })

    // 这条路径在 useEffect 里把方法取出来放进闭包（ProviderSettings 的 probe）。
    // 丢了 this 的话第一行就炸，请求不会出现在 requests 里，界面也永远停在「检测中」。
    expect(api.requests).toContain('class-token /api/providers/ollama/verify')
    const head = container.querySelector('.provider-head')?.textContent ?? ''
    expect(head).toContain('本地服务 · 在线 · 7ms')
  })

  it('手动重探（行内按钮）同样走 this.request', async () => {
    const api = new ClassApi()
    await renderSettings(api, [ollamaProvider])
    await act(async () => {
      await Promise.resolve()
    })
    api.requests.length = 0

    act(() => {
      buttonByText('Ollama').click()
    })
    await act(async () => {
      buttonByText('重新检测', container.querySelector('.provider-body') ?? container).click()
      await Promise.resolve()
    })
    expect(api.requests).toContain('class-token /api/providers/ollama/verify')
  })

  it('添加向导里的模型发现（discoverProvider）走的是 this.request', async () => {
    const api = new ClassApi()
    // 列表给空：同一个 baseUrl 已经配过的话，预设格是禁用的（不允许重复添加）。
    await renderSettings(api, [])
    await act(async () => {
      buttonByText('添加供应商').click()
      await Promise.resolve()
    })
    await act(async () => {
      buttonByText('Ollama', container.querySelector('.provider-preset-grid') ?? container).click()
      await Promise.resolve()
      await Promise.resolve()
    })

    // 表单里的「从供应商拉取模型」：这条同样是被取出来放进闭包调用的（runDiscovery）。
    await act(async () => {
      buttonByText('从供应商拉取模型', container.querySelector('.provider-form') ?? container).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.requests).toContain('class-token /api/providers/discover')
    // 结果落进面板：证明这一条真的跑完了，而不是在第一行就散了。
    const discovery = container.querySelector('.provider-discovery')?.textContent ?? ''
    expect(discovery).toContain('qwen2.5:7b')
  })

  it('实例上的方法被拆出来单独调用必然崩（守住这条测试自身的前提）', async () => {
    const api = new ClassApi()
    // 复现当初那个写法：把方法取出来，不 bind。
    const { verifyProvider } = api
    await expect(async () => {
      await verifyProvider('ollama')
    }).rejects.toThrow()
    // bind 之后同一个方法同一个实例就正常了。
    await expect(api.verifyProvider('ollama')).resolves.toMatchObject({ ok: true })
  })
})
