// @vitest-environment jsdom
/**
 * 供应商设置区块（ProviderSettings / MePage 供应商区）：
 * 分组与徽标、未配置行内填 key、添加向导（预设网格 → 预填表单）、自定义删除确认。
 * api 全部 mock，钉住 POST/DELETE 的载荷形状。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateProviderInput, ProviderInfo, ProviderPreset } from '../renderer/src/api.ts'
import { MePage } from '../renderer/src/components/MePage.tsx'
import type { ProviderApi } from '../renderer/src/components/ProviderSettings.tsx'
import { ProviderSettings } from '../renderer/src/components/ProviderSettings.tsx'
import { getToasts, toast } from '../renderer/src/lib/toast.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const builtinProvider: ProviderInfo = {
  id: 'siliconflow',
  displayName: 'SiliconFlow',
  apiKeyConfigured: true,
  protocol: 'openai',
  baseUrl: 'https://api.siliconflow.cn/v1',
  models: [{ id: 'deepseek-ai/DeepSeek-V3' }, { id: 'Qwen/Qwen2.5-7B-Instruct' }],
}

const customProvider: ProviderInfo = {
  id: 'custom-abc',
  displayName: '我的私有服务',
  apiKeyConfigured: false,
  custom: true,
  protocol: 'openai',
  baseUrl: 'http://127.0.0.1:9000/v1',
  models: [{ id: 'my-model' }],
}

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
    id: 'deepseek',
    displayName: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    docsUrl: 'https://platform.deepseek.com',
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    protocol: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5:7b'],
  },
]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  // jsdom 没有 matchMedia，Modal 退场动画要它。
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
  // toast 是模块级单例，跨用例不清的话上一条成功提示会漏进下一条断言。
  for (const item of getToasts()) toast.dismiss(item.id)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function fakeApi(overrides: Partial<ProviderApi> = {}): ProviderApi {
  return {
    setApiKey: () => {
      return Promise.resolve({ providerId: 'x', configured: true })
    },
    ...overrides,
  }
}

async function renderSettings(
  api: ProviderApi,
  providers: ProviderInfo[],
  onChanged: () => void = () => {},
): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<ProviderSettings api={api} providers={providers} onChanged={onChanged} />)
    await Promise.resolve()
  })
}

/** 受控 input 输入：原生 setter + input 事件（React 受控组件标准打法）。 */
function typeInto(node: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!
  act(() => {
    setter.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function buttonByText(text: string, scope: ParentNode = container): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((node) => {
    return node.textContent?.trim() === text || node.textContent?.includes(text)
  })
  if (found === undefined) throw new Error(`找不到按钮：${text}`)
  return found
}

/**
 * 预设格的可见名字。
 * 刻意读 `.provider-preset-name` 而不是整块 textContent：图标里那个首字母标
 * （ProviderIcon 的内联 SVG <text>，aria-hidden 的装饰字符）也是文本节点，
 * 整块读会得到 'DDeepSeek' / '自自定义'——那是装饰，不是标题被拼了两遍。
 */
function presetTileNames(scope: ParentNode = container): Array<string | null | undefined> {
  return [...scope.querySelectorAll('.provider-preset-tile')].map((node) => {
    return node.querySelector('.provider-preset-name')?.textContent
  })
}

/** toast 是模块级单例，用例里按文案挑自己关心的那几条。 */
function toastTexts(): string[] {
  return getToasts().map((item) => {
    return item.text
  })
}

describe('供应商区块：分组与状态', () => {
  it('内置 / 自定义分组渲染，行上有图标、徽标、状态与模型数', async () => {
    await renderSettings(fakeApi(), [builtinProvider, customProvider, ollamaProvider])
    const labels = [...container.querySelectorAll('.provider-group-label')].map((node) => {
      return node.textContent
    })
    expect(labels).toEqual(['内置', '自定义供应商'])

    const heads = [...container.querySelectorAll('.provider-head')]
    const silicon = heads.find((node) => {
      return node.textContent?.includes('SiliconFlow')
    })!
    expect(silicon.textContent).toContain('内置')
    expect(silicon.textContent).toContain('openai')
    // 有 key 不等于这家认：没测过之前只能是「凭据已备（未验证）」，更不能给绿点。
    expect(silicon.textContent).toContain('凭据已备（未验证）')
    expect(silicon.textContent).not.toContain('已验证')
    expect(silicon.textContent).toContain('2 个模型')
    expect(silicon.querySelector('.status-dot.ok')).toBeNull()
    expect(silicon.querySelector('.status-dot.warn')).not.toBeNull()
    // 图标是内联 SVG 字母标，不引外部资源。
    expect(silicon.querySelector('.provider-logo svg')).not.toBeNull()

    const ollama = heads.find((node) => {
      return node.textContent?.includes('Ollama')
    })!
    expect(ollama.textContent).toContain('免 key')
    // 免 key 的本地服务换了一套说法，且不再挂绿点：它没经过任何凭据校验。
    expect(ollama.textContent).toContain('本地服务')
    expect(ollama.querySelector('.status-dot')).toBeNull()

    const custom = heads.find((node) => {
      return node.textContent?.includes('我的私有服务')
    })!
    expect(custom.textContent).toContain('自定义')
    expect(custom.textContent).toContain('未配置凭据')
    expect(custom.querySelector('.status-dot.warn')).not.toBeNull()
  })

  it('未配置的行展开后可直接填 key，保存走 setApiKey 并触发刷新', async () => {
    const saved: Array<[string, string]> = []
    let changed = 0
    const api = fakeApi({
      setApiKey: (providerId: string, apiKey: string) => {
        saved.push([providerId, apiKey])
        return Promise.resolve({ providerId, configured: true })
      },
    })
    await renderSettings(api, [customProvider], () => {
      changed += 1
    })
    act(() => {
      buttonByText('我的私有服务').click()
    })
    const input = container.querySelector<HTMLInputElement>('.provider-body input[type="password"]')!
    typeInto(input, 'sk-test-123')
    await act(async () => {
      buttonByText('保存', container.querySelector('.provider-body')!).click()
      await Promise.resolve()
    })
    expect(saved).toEqual([['custom-abc', 'sk-test-123']])
    expect(changed).toBe(1)
  })

  it('key 存好后有明确反馈：输入框清空 + toast，刷新把行变成已配置', async () => {
    const api = fakeApi()
    await renderSettings(api, [customProvider])
    act(() => {
      buttonByText('我的私有服务').click()
    })
    const input = container.querySelector<HTMLInputElement>('.provider-body input[type="password"]')!
    typeInto(input, 'sk-abc')
    await act(async () => {
      buttonByText('保存', container.querySelector('.provider-body')!).click()
      await Promise.resolve()
    })
    expect(input.value).toBe('')
    expect(toastTexts()).toContain('「我的私有服务」的 key 已存到本机')
  })

  it('保存失败时错误就地显示（role=alert），文案沿用服务端给的原因', async () => {
    const api = fakeApi({
      setApiKey: () => {
        return Promise.reject(new Error('unknown provider: custom-abc'))
      },
    })
    await renderSettings(api, [customProvider])
    act(() => {
      buttonByText('我的私有服务').click()
    })
    const body = container.querySelector('.provider-body')!
    typeInto(body.querySelector<HTMLInputElement>('input[type="password"]')!, 'sk-abc')
    await act(async () => {
      buttonByText('保存', body).click()
      await Promise.resolve()
    })
    const error = body.querySelector('.apikey-error')!
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toContain('unknown provider: custom-abc')
    expect(toastTexts()).not.toContain('「我的私有服务」的 key 已存到本机')
  })

  it('行内填 key 时按 Esc 收起这行并把焦点还给行标题（键盘用户不迷路）', async () => {
    await renderSettings(fakeApi(), [customProvider])
    const head = buttonByText('我的私有服务')
    act(() => {
      head.click()
    })
    const input = container.querySelector<HTMLInputElement>('.provider-body input[type="password"]')!
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('.provider-body')).toBeNull()
    expect(document.activeElement).toBe(head)
  })
})

describe('添加供应商向导', () => {
  it('先出预设网格（含「自定义」），选定后表单预填 baseURL 与推荐模型', async () => {
    const created: CreateProviderInput[] = []
    const api = fakeApi({
      providerPresets: () => {
        return Promise.resolve({ presets })
      },
      createProvider: (input: CreateProviderInput) => {
        created.push(input)
        return Promise.resolve({ provider: { ...customProvider, id: 'new-1' } })
      },
    })
    let changed = 0
    await renderSettings(api, [builtinProvider], () => {
      changed += 1
    })
    await act(async () => {
      buttonByText('添加供应商').click()
      await Promise.resolve()
    })
    // 网格：两个预设 + 「自定义」
    expect(presetTileNames(container)).toEqual(['DeepSeek', 'Ollama', '自定义'])
    // 副标题给出决策信息：协议 / 模型数，免 key 的直说。
    const subs = [...container.querySelectorAll('.provider-preset-sub')].map((node) => {
      return node.textContent
    })
    expect(subs).toEqual(['openai · 2 个模型', 'ollama · 免 key', '手动填写'])

    await act(async () => {
      buttonByText('DeepSeek', container.querySelector('.provider-preset-grid')!).click()
      await Promise.resolve()
    })
    const form = container.querySelector('.provider-form')!
    const inputs = [...form.querySelectorAll('input')]
    // 名称 / 协议 / Base URL / API Key：预设已预填前三项。
    expect(inputs[0]!.value).toBe('DeepSeek')
    expect(inputs[1]!.value).toBe('openai')
    expect(inputs[2]!.value).toBe('https://api.deepseek.com/v1')
    expect(form.querySelector('textarea')!.value).toBe('deepseek-chat\ndeepseek-reasoner')
    // 非免 key 预设：有 key 输入与官网链接。
    expect(form.querySelector('input[type="password"]')).not.toBeNull()
    expect(form.querySelector('a[href="https://platform.deepseek.com"]')).not.toBeNull()

    typeInto(form.querySelector('input[type="password"]')!, 'sk-deepseek')
    await act(async () => {
      buttonByText('保存', form).click()
      await Promise.resolve()
    })
    expect(created).toEqual([
      {
        displayName: 'DeepSeek',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat', 'deepseek-reasoner'],
        apiKey: 'sk-deepseek',
        presetId: 'deepseek',
      },
    ])
    expect(changed).toBe(1)
    // 保存成功后弹窗关闭（父组件直接卸载）。
    expect(container.querySelector('.modal')).toBeNull()
  })

  it('Ollama 预设（免 key）隐藏 key 输入，载荷不带 apiKey', async () => {
    const created: CreateProviderInput[] = []
    const api = fakeApi({
      providerPresets: () => {
        return Promise.resolve({ presets })
      },
      createProvider: (input: CreateProviderInput) => {
        created.push(input)
        return Promise.resolve({ provider: { ...ollamaProvider, id: 'new-2' } })
      },
    })
    await renderSettings(api, [])
    await act(async () => {
      buttonByText('添加供应商').click()
      await Promise.resolve()
    })
    await act(async () => {
      buttonByText('Ollama', container.querySelector('.provider-preset-grid')!).click()
      await Promise.resolve()
    })
    const form = container.querySelector('.provider-form')!
    expect(form.querySelector('input[type="password"]')).toBeNull()
    await act(async () => {
      buttonByText('保存', form).click()
      await Promise.resolve()
    })
    expect(created[0]).toEqual({
      displayName: 'Ollama',
      protocol: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: ['qwen2.5:7b'],
      presetId: 'ollama',
    })
    expect(created[0]).not.toHaveProperty('apiKey')
  })

  it('「自定义」一格给出空白表单；保存失败留在原地并显示原因', async () => {
    const api = fakeApi({
      providerPresets: () => {
        return Promise.resolve({ presets: [] })
      },
      createProvider: () => {
        return Promise.reject(new Error('baseUrl 无法连接'))
      },
    })
    await renderSettings(api, [])
    await act(async () => {
      buttonByText('添加供应商').click()
      await Promise.resolve()
    })
    await act(async () => {
      buttonByText('自定义', container.querySelector('.provider-preset-grid')!).click()
      await Promise.resolve()
    })
    const form = container.querySelector('.provider-form')!
    const inputs = [...form.querySelectorAll('input')]
    expect(inputs[0]!.value).toBe('')
    const save = buttonByText('保存', form)
    // 必填项为空时不可保存。
    expect(save.disabled).toBe(true)
    typeInto(inputs[0]!, '内部网关')
    typeInto(inputs[2]!, 'https://llm.internal/v1')
    typeInto(form.querySelector('textarea')!, 'model-a, model-b')
    await act(async () => {
      buttonByText('保存', form).click()
      await Promise.resolve()
    })
    expect(container.querySelector('.apikey-error')?.textContent).toContain('baseUrl 无法连接')
    expect(container.querySelector('.modal')).not.toBeNull()
  })

  it('后端还没跟上（方法缺失）时降级为只有「自定义」一格', async () => {
    await renderSettings(fakeApi(), [])
    act(() => {
      buttonByText('添加供应商').click()
    })
    expect(presetTileNames(container)).toEqual(['自定义'])
  })

  it('服务端没提供预设列表时说明原因，而不是留一块空网格', async () => {
    const api = fakeApi({
      providerPresets: () => {
        return Promise.resolve({ presets: [] })
      },
    })
    await renderSettings(api, [])
    await act(async () => {
      buttonByText('添加供应商').click()
      await Promise.resolve()
    })
    expect(presetTileNames(container)).toEqual(['自定义'])
    expect(container.querySelector('.provider-note')?.textContent).toContain('没有提供预设列表')
  })

  it('预设接口读失败时给出「可以先手填」的兜底说明', async () => {
    const api = fakeApi({
      providerPresets: () => {
        return Promise.reject(new Error('not found: GET /api/provider-presets'))
      },
    })
    await renderSettings(api, [])
    await act(async () => {
      buttonByText('添加供应商').click()
      await Promise.resolve()
    })
    expect(presetTileNames(container)).toEqual(['自定义'])
    expect(container.querySelector('.provider-note')?.textContent).toContain('预设列表没读到')
  })

  it('客户端没有 createProvider 时表单禁用保存并说明，而不是静默点了没反应', async () => {
    await renderSettings(fakeApi(), [])
    await act(async () => {
      buttonByText('添加供应商').click()
      await Promise.resolve()
    })
    await act(async () => {
      buttonByText('自定义', container.querySelector('.provider-preset-grid')!).click()
      await Promise.resolve()
    })
    const form = container.querySelector('form.provider-form')!
    typeInto(form.querySelectorAll('input')[0]!, '内部网关')
    typeInto(form.querySelectorAll('input')[2]!, 'https://llm.internal/v1')
    typeInto(form.querySelector('textarea')!, 'model-a')
    expect(buttonByText('保存', form).disabled).toBe(true)
    expect(form.querySelector('.apikey-error')?.textContent).toContain('还没有「新增供应商」的能力')
  })

  it('服务端没实现新增接口时，回的是中文且能照着做（不弹英文原始路径）', async () => {
    const api = fakeApi({
      providerPresets: () => {
        return Promise.resolve({ presets: [] })
      },
      createProvider: () => {
        return Promise.reject(new Error('not found: POST /api/providers'))
      },
    })
    await renderSettings(api, [])
    await act(async () => {
      buttonByText('添加供应商').click()
      await Promise.resolve()
    })
    await act(async () => {
      buttonByText('自定义', container.querySelector('.provider-preset-grid')!).click()
      await Promise.resolve()
    })
    const form = container.querySelector('form.provider-form')!
    typeInto(form.querySelectorAll('input')[0]!, '内部网关')
    typeInto(form.querySelectorAll('input')[2]!, 'https://llm.internal/v1')
    typeInto(form.querySelector('textarea')!, 'model-a')
    await act(async () => {
      buttonByText('保存', form).click()
      await Promise.resolve()
    })
    const message = container.querySelector('.apikey-error')?.textContent ?? ''
    expect(message).toContain('还不能新增供应商')
    expect(message).toContain('providers.json')
    expect(message).not.toContain('not found: POST')
    // 失败留在原地，用户能改了再存。
    expect(container.querySelector('.modal')).not.toBeNull()
  })
})

describe('自定义供应商删除', () => {
  it('展开后有删除入口，确认弹窗内才真的发 DELETE', async () => {
    const deleted: string[] = []
    let changed = 0
    const api = fakeApi({
      deleteProvider: (id: string) => {
        deleted.push(id)
        return Promise.resolve({ deleted: id })
      },
    })
    await renderSettings(api, [builtinProvider, customProvider], () => {
      changed += 1
    })
    act(() => {
      buttonByText('我的私有服务').click()
    })
    act(() => {
      buttonByText('删除供应商').click()
    })
    // 确认弹窗说明后果，确认前不发请求。
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('删除「我的私有服务」？')
    expect(deleted).toEqual([])
    await act(async () => {
      buttonByText('删除', dialog).click()
      await Promise.resolve()
    })
    expect(deleted).toEqual(['custom-abc'])
    expect(changed).toBe(1)
    expect(toastTexts()).toContain('「我的私有服务」已删除')
  })

  it('服务端没实现删除接口时给中文说明并收起弹窗（重试也不会变好）', async () => {
    let changed = 0
    const api = fakeApi({
      deleteProvider: () => {
        return Promise.reject(new Error('not found: DELETE /api/providers/custom-abc'))
      },
    })
    await renderSettings(api, [customProvider], () => {
      changed += 1
    })
    act(() => {
      buttonByText('我的私有服务').click()
    })
    act(() => {
      buttonByText('删除供应商').click()
    })
    await act(async () => {
      buttonByText('确认删除', container.querySelector('[role="dialog"]')!).click()
      await Promise.resolve()
    })
    const messages = toastTexts()
    expect(
      messages.some((text) => {
        return text.includes('还不能删除供应商') && !text.includes('not found')
      }),
    ).toBe(true)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(changed).toBe(0)
  })
})

describe('空态', () => {
  it('一个供应商都没读到时给出可操作的中文说明', async () => {
    await renderSettings(fakeApi(), [])
    expect(container.querySelector('.provider-empty')?.textContent).toContain('还没读到供应商')
    expect(container.querySelector('.provider-group')).toBeNull()
  })

  it('有供应商时不出现空态', async () => {
    await renderSettings(fakeApi(), [builtinProvider])
    expect(container.querySelector('.provider-empty')).toBeNull()
  })
})

describe('MePage 集成', () => {
  it('供应商区块出现在「我的」页，带添加供应商入口', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <MePage
          api={{
            listAgentMemories: () => {
              return Promise.resolve({ agent: [], shared: [] })
            },
            patchAgent: () => {
              return Promise.resolve({
                agent: {
                  id: 'ryen',
                  name: 'Ryen',
                  systemPrompt: '',
                  provider: 'siliconflow',
                  model: 'm',
                  tools: [],
                  isBuiltin: true,
                },
              })
            },
            setApiKey: () => {
              return Promise.resolve({ providerId: 'x', configured: true })
            },
            workspace: () => {
              return Promise.resolve({ path: 'C:/data/workspace' })
            },
          }}
          ryen={undefined}
          providers={[builtinProvider]}
          theme="light"
          onThemeChange={() => {}}
        />,
      )
      await Promise.resolve()
    })
    expect(container.querySelector('.provider-section-head')?.textContent).toContain('模型供应商')
    expect(container.querySelector('.provider-add-btn')?.textContent).toContain('添加供应商')
    expect(container.querySelector('.provider-head')?.textContent).toContain('SiliconFlow')
  })
})

/** 凭据全生命周期：测连接 / 更换 Key / 移除凭据，以及三态在其中的流转。 */
describe('凭据生命周期', () => {
  it('测试连接：进行中态 → 通过后显示延迟与已验证', async () => {
    const calls: string[] = []
    let resolveVerify: ((value: { ok: boolean; message: string; latencyMs: number }) => void) | undefined
    const api = fakeApi({
      verifyProvider: (id: string) => {
        calls.push(id)
        return new Promise((resolve) => {
          resolveVerify = resolve
        })
      },
    })
    await renderSettings(api, [builtinProvider])
    act(() => {
      buttonByText('SiliconFlow').click()
    })
    act(() => {
      buttonByText('测试连接').click()
    })
    expect(calls).toEqual(['siliconflow'])
    expect(buttonByText('测试中…', container.querySelector('.provider-body')!).textContent).toContain('测试中')
    await act(async () => {
      resolveVerify?.({ ok: true, message: 'ok', latencyMs: 128 })
      await Promise.resolve()
    })
    expect(container.querySelector('.provider-head')?.textContent).toContain('已验证 · 128ms')
    expect(container.querySelector('.provider-head')?.querySelector('.status-dot.ok')).not.toBeNull()
    expect(toastTexts()).toContain('「SiliconFlow」连接正常（128ms）')
  })

  it('测试连接失败：给出中文原因，并说清下一步（不弹 401 原文）', async () => {
    const api = fakeApi({
      verifyProvider: () => {
        return Promise.resolve({ ok: false, message: '401 Unauthorized', latencyMs: 90 })
      },
    })
    await renderSettings(api, [builtinProvider])
    act(() => {
      buttonByText('SiliconFlow').click()
    })
    await act(async () => {
      buttonByText('测试连接').click()
      await Promise.resolve()
    })
    const error = container.querySelector('.provider-body .apikey-error')!
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toContain('凭据被供应商拒绝')
    expect(error.textContent).toContain('更换 Key')
    expect(error.textContent).not.toContain('401')
    // 没验过就不给绿点。
    expect(container.querySelector('.provider-head')?.textContent).toContain('凭据已备（未验证）')
  })

  it('服务端没有 verify 时说明这版还测不了（不假装测过）', async () => {
    await renderSettings(fakeApi(), [builtinProvider])
    act(() => {
      buttonByText('SiliconFlow').click()
    })
    await act(async () => {
      buttonByText('测试连接', container.querySelector('.provider-body')!).click()
      await Promise.resolve()
    })
    expect(container.querySelector('.provider-body')?.textContent).toContain('还没有「测试连接」')
  })

  it('更换 Key：行内重新填 → setApiKey → 状态退回未验证', async () => {
    const saved: string[] = []
    const api = fakeApi({
      setApiKey: (providerId: string, apiKey: string) => {
        saved.push(apiKey)
        return Promise.resolve({ providerId, configured: true })
      },
      verifyProvider: () => {
        return Promise.resolve({ ok: true, message: 'ok', latencyMs: 50 })
      },
    })
    await renderSettings(api, [builtinProvider])
    act(() => {
      buttonByText('SiliconFlow').click()
    })
    await act(async () => {
      buttonByText('测试连接').click()
      await Promise.resolve()
    })
    expect(container.querySelector('.provider-head')?.textContent).toContain('已验证')

    act(() => {
      buttonByText('更换 Key').click()
    })
    const body = container.querySelector('.provider-body')!
    typeInto(body.querySelector<HTMLInputElement>('input[type="password"]')!, 'sk-new')
    await act(async () => {
      buttonByText('保存', body).click()
      await Promise.resolve()
    })
    expect(saved).toEqual(['sk-new'])
    // 换了 key 等于没验过：不能让上一次的绿点继续骗人。
    expect(container.querySelector('.provider-head')?.textContent).toContain('凭据已备（未验证）')
    expect(container.querySelector('.provider-head')?.textContent).not.toContain('已验证')
  })

  it('移除凭据：确认弹窗里才发 DELETE，成功后提示并刷新', async () => {
    const deleted: string[] = []
    let changed = 0
    const api = fakeApi({
      deleteApiKey: (id: string) => {
        deleted.push(id)
        return Promise.resolve({ deleted: id })
      },
    })
    await renderSettings(api, [builtinProvider], () => {
      changed += 1
    })
    act(() => {
      buttonByText('SiliconFlow').click()
    })
    act(() => {
      buttonByText('移除凭据').click()
    })
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('移除「SiliconFlow」的凭据')
    expect(deleted).toEqual([])
    await act(async () => {
      buttonByText('确认移除', dialog).click()
      await Promise.resolve()
    })
    expect(deleted).toEqual(['siliconflow'])
    expect(changed).toBe(1)
    expect(toastTexts()).toContain('「SiliconFlow」的凭据已移除')
  })

  it('服务端没有移除凭据接口时按钮禁用并给出原因', async () => {
    await renderSettings(fakeApi(), [builtinProvider])
    act(() => {
      buttonByText('SiliconFlow').click()
    })
    const button = buttonByText('移除凭据', container.querySelector('.provider-body')!) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toContain('还不能移除凭据')
  })

  it('没人用的供应商照样能删（usedBy 只是提示，不是永久禁用）', async () => {
    const deleted: string[] = []
    const api = fakeApi({
      deleteProvider: (id: string) => {
        deleted.push(id)
        return Promise.resolve({ deleted: id })
      },
    })
    await renderSettings(api, [{ ...customProvider, usedBy: [] }])
    act(() => {
      buttonByText('我的私有服务').click()
    })
    act(() => {
      buttonByText('删除供应商', container.querySelector('.provider-body')!).click()
    })
    await act(async () => {
      buttonByText('确认删除', container.querySelector('[role="dialog"]')!).click()
      await Promise.resolve()
    })
    expect(deleted).toEqual(['custom-abc'])
  })
})

/** 免 key 的本地服务：探活取代「有没有 key」这套说法。 */
describe('本地服务探活', () => {
  it('探得通：进页面就探，显示在线与延迟（不挂绿点）', async () => {
    const api = fakeApi({
      verifyProvider: () => {
        return Promise.resolve({ ok: true, message: 'ollama is running', latencyMs: 12 })
      },
    })
    await renderSettings(api, [ollamaProvider])
    await act(async () => {
      await Promise.resolve()
    })
    const head = container.querySelector('.provider-head')!
    expect(head.textContent).toContain('本地服务 · 在线 · 12ms')
    expect(head.querySelector('.status-dot')).toBeNull()
  })

  it('探不通：说「未检测到本地服务」，并可手动重探', async () => {
    let attempt = 0
    const api = fakeApi({
      verifyProvider: () => {
        attempt += 1
        return attempt === 1
          ? Promise.reject(new Error('fetch failed'))
          : Promise.resolve({ ok: true, message: 'ok', latencyMs: 9 })
      },
    })
    await renderSettings(api, [ollamaProvider])
    await act(async () => {
      await Promise.resolve()
    })
    const head = container.querySelector('.provider-head')!
    expect(head.textContent).toContain('未检测到本地服务')
    expect(head.querySelector('.status-dot')).toBeNull()

    act(() => {
      buttonByText('Ollama').click()
    })
    await act(async () => {
      buttonByText('重新检测', container.querySelector('.provider-body')!).click()
      await Promise.resolve()
    })
    expect(container.querySelector('.provider-head')?.textContent).toContain('本地服务 · 在线 · 9ms')
    // 免 key 的本地服务不提供更换/移除凭据：它压根没有凭据。
    expect(container.querySelector('.provider-body')?.textContent).not.toContain('更换 Key')
    expect(container.querySelector('.provider-body')?.querySelector('input[type="password"]')).toBeNull()
  })
})

/** 删除前先把使用者说清楚：被引用时禁用删除，而不是等服务端 409。 */
describe('删除供应商前先看谁在用', () => {
  it('有使用者：删除按钮禁用并列出 agent，提示先改绑', async () => {
    await renderSettings(fakeApi(), [{ ...customProvider, usedBy: [{ agentId: 'mine', agentName: '小译' }] }])
    act(() => {
      buttonByText('我的私有服务').click()
    })
    const body = container.querySelector('.provider-body')!
    const button = buttonByText('删除供应商', body) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(body.textContent).toContain('小译')
    expect(body.textContent).toContain('改绑')
    // 禁用时根本不进确认弹窗。
    act(() => {
      button.click()
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('服务端回 409（界面的 usedBy 还没刷新到）：提示先改绑而不是英文原文', async () => {
    const api = fakeApi({
      deleteProvider: () => {
        return Promise.reject(new Error('provider is in use by 2 agents'))
      },
    })
    await renderSettings(api, [{ ...customProvider, usedBy: [] }])
    act(() => {
      buttonByText('我的私有服务').click()
    })
    act(() => {
      buttonByText('删除供应商').click()
    })
    await act(async () => {
      buttonByText('确认删除', container.querySelector('[role="dialog"]')!).click()
      await Promise.resolve()
    })
    expect(
      toastTexts().some((text) => {
        return text.includes('改绑') && !text.includes('in use')
      }),
    ).toBe(true)
  })
})
