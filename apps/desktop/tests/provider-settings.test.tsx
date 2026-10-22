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
import type {
  CreateProviderForm,
  ProviderApi,
  ProviderModelEntry,
  UpdateProviderInput,
} from '../renderer/src/components/ProviderSettings.tsx'
import { ProviderSettings } from '../renderer/src/components/ProviderSettings.tsx'
import { getToasts, toast } from '../renderer/src/lib/toast.ts'
import { currentValue, listedValues, openSelect, optionLabels, pickOption, triggerLabel } from './select-dom.tsx'

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

/**
 * 按字段标签取控件。
 *
 * 此前这些断言按 `querySelectorAll('input')[1]` 的下标定位，协议从文本框换成下拉之后
 * 下标整体错位——测试报的却是「Base URL 的值不对」，把人引向错误的方向。按标签取，
 * 字段控件换实现（input ↔ 下拉 ↔ textarea）时断言不用动。
 */
function fieldOf<T extends HTMLElement>(form: ParentNode, label: string): T {
  const found = [...form.querySelectorAll('.field')].find((field) => {
    return field.querySelector(':scope > span')?.textContent?.trim() === label
  })
  if (found === undefined) throw new Error(`找不到字段：${label}`)
  // 协议那一格是自绘下拉：触发器是 .select-trigger，不是原生 <select>。
  const control = found.querySelector('input, select, textarea, .select-trigger')
  if (control === null) throw new Error(`字段没有控件：${label}`)
  return control as T
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
    // 协议徽标说人话：openai 是接口方言，不是用户要读的英文标识。
    expect(silicon.textContent).toContain('OpenAI 兼容')
    // 有 key 不等于这家认：没测过之前只能是「凭据已备（未验证）」，更不能给绿点。
    expect(silicon.textContent).toContain('凭据已备（未验证）')
    expect(silicon.textContent).not.toContain('已验证')
    expect(silicon.textContent).toContain('2 个模型')
    expect(silicon.querySelector('.status-dot.ok')).toBeNull()
    expect(silicon.querySelector('.status-dot.warn')).not.toBeNull()
    // 真实品牌标识：走打包进产物的本地图片，不引外部资源。
    const brandLogo = silicon.querySelector<HTMLImageElement>('.provider-logo img')
    expect(brandLogo).not.toBeNull()
    expect(brandLogo?.getAttribute('src')).toBeTruthy()
    // 打包进来的资源在产物里是本地路径；远程 URL 会让离线/内网环境直接空图。
    expect(brandLogo?.getAttribute('src')).not.toMatch(/^https?:/i)

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
    // 没有品牌标识的供应商退回首字母标，且是内联 SVG —— 自定义服务永远不悬空。
    expect(custom.querySelector('.provider-logo img')).toBeNull()
    expect(custom.querySelector('.provider-logo svg')).not.toBeNull()
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

  it('保存失败时错误就地显示（role=alert），文案说人话而不是服务端原话', async () => {
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
    expect(error.textContent).toContain('这家模型服务已经不在供应商列表里')
    expect(error.textContent).not.toContain('unknown provider')
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
    expect(subs).toEqual(['OpenAI 兼容 · 2 个模型', '本地 Ollama · 免 key', '手动填写'])

    await act(async () => {
      buttonByText('DeepSeek', container.querySelector('.provider-preset-grid')!).click()
      await Promise.resolve()
    })
    const form = container.querySelector('.provider-form')!
    // 名称 / 协议 / Base URL / API Key：预设已预填前三项。
    expect(fieldOf<HTMLInputElement>(form, '名称').value).toBe('DeepSeek')
    expect(currentValue(form, '协议')).toBe('openai')
    expect(fieldOf<HTMLInputElement>(form, 'Base URL').value).toBe('https://api.deepseek.com/v1')
    expect(fieldOf<HTMLTextAreaElement>(form, '模型列表').value).toBe('deepseek-chat\ndeepseek-reasoner')
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
        // 模型条目一律对象形状（服务端两种都收）：带上用户补录的上下文长度时有地方放。
        models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
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
      models: [{ id: 'qwen2.5:7b' }],
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
    expect(fieldOf<HTMLInputElement>(form, '名称').value).toBe('')
    const save = buttonByText('保存', form)
    // 必填项为空时不可保存。
    expect(save.disabled).toBe(true)
    typeInto(fieldOf<HTMLInputElement>(form, '名称'), '内部网关')
    typeInto(fieldOf<HTMLInputElement>(form, 'Base URL'), 'https://llm.internal/v1')
    typeInto(fieldOf<HTMLTextAreaElement>(form, '模型列表'), 'model-a, model-b')
    await act(async () => {
      buttonByText('保存', form).click()
      await Promise.resolve()
    })
    expect(container.querySelector('.apikey-error')?.textContent).toContain('baseUrl 无法连接')
    expect(container.querySelector('.modal')).not.toBeNull()
  })

  it('配过的预设置灰并标「已添加 · N 个模型」，点不进去（不会再生成重复项）', async () => {
    let created = 0
    const api = fakeApi({
      providerPresets: () => Promise.resolve({ presets }),
      createProvider: () => {
        created += 1
        return Promise.resolve({ provider: customProvider })
      },
    })
    // DeepSeek 这个地址已经配过；Ollama 没配过。
    const installed = {
      ...builtinProvider,
      id: 'deepseek',
      displayName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      models: [{ id: 'deepseek-chat' }],
    }
    await renderSettings(api, [installed])
    await act(async () => {
      buttonByText('添加供应商').click()
      await Promise.resolve()
    })
    const tiles = [...container.querySelectorAll<HTMLButtonElement>('.provider-preset-tile')]
    const deepseek = tiles.find((tile) => {
      return tile.querySelector('.provider-preset-name')?.textContent === 'DeepSeek'
    })!
    expect(deepseek.disabled).toBe(true)
    expect(deepseek.className).toContain('is-installed')
    expect(deepseek.querySelector('.provider-preset-sub')?.textContent).toBe('已添加 · 1 个模型')
    expect(deepseek.title).toContain('编辑')
    // 没配过的照常可选，副标题仍是协议 + 推荐模型数。
    const ollama = tiles.find((tile) => {
      return tile.querySelector('.provider-preset-name')?.textContent === 'Ollama'
    })!
    expect(ollama.disabled).toBe(false)
    expect(ollama.querySelector('.provider-preset-sub')?.textContent).toBe('本地 Ollama · 免 key')

    await act(async () => {
      deepseek.click()
      await Promise.resolve()
    })
    // 点不进去：没有表单，也没有发出新增请求。
    expect(container.querySelector('form.provider-form')).toBeNull()
    expect(created).toBe(0)
  })

  it('服务端对重复地址回 409 时：把中文原因就地显示，表单留着让用户改', async () => {
    const api = fakeApi({
      providerPresets: () => Promise.resolve({ presets }),
      createProvider: () => {
        return Promise.reject(
          new Error(
            '已经添加过指向同一个地址的供应商「DeepSeek」，不用重复添加；要改名字、地址或模型，去列表里点「编辑」。',
          ),
        )
      },
    })
    await renderSettings(api, [])
    await act(async () => {
      buttonByText('添加供应商').click()
      await Promise.resolve()
    })
    await act(async () => {
      buttonByText('DeepSeek', container.querySelector('.provider-preset-grid')!).click()
      await Promise.resolve()
    })
    const form = container.querySelector('form.provider-form')!
    typeInto(form.querySelector('input[type="password"]')!, 'sk-x')
    await act(async () => {
      buttonByText('保存', form).click()
      await Promise.resolve()
    })
    const error = form.querySelector('.apikey-error')!
    expect(error.textContent).toContain('已经添加过')
    expect(error.textContent).toContain('DeepSeek')
    expect(container.querySelector('form.provider-form')).not.toBeNull()
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
    typeInto(fieldOf<HTMLInputElement>(form, '名称'), '内部网关')
    typeInto(fieldOf<HTMLInputElement>(form, 'Base URL'), 'https://llm.internal/v1')
    typeInto(fieldOf<HTMLTextAreaElement>(form, '模型列表'), 'model-a')
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
    typeInto(fieldOf<HTMLInputElement>(form, '名称'), '内部网关')
    typeInto(fieldOf<HTMLInputElement>(form, 'Base URL'), 'https://llm.internal/v1')
    typeInto(fieldOf<HTMLTextAreaElement>(form, '模型列表'), 'model-a')
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

describe('编辑供应商', () => {
  it('行内「编辑」→ 弹窗预填现值 → PATCH 载荷只含四个白名单字段', async () => {
    const patched: Array<[string, UpdateProviderInput]> = []
    let changed = 0
    const api = fakeApi({
      updateProvider: (id: string, patch: UpdateProviderInput) => {
        patched.push([id, patch])
        return Promise.resolve({ provider: { ...builtinProvider, displayName: patch.displayName } })
      },
    })
    await renderSettings(api, [builtinProvider], () => {
      changed += 1
    })
    act(() => {
      buttonByText('SiliconFlow').click()
    })
    act(() => {
      buttonByText('编辑', container.querySelector('.provider-body')!).click()
    })
    const form = container.querySelector('form.provider-form')!
    // 预填的是这条路由现在的值（不是预设，也不是空表单）。
    expect(fieldOf<HTMLInputElement>(form, '名称').value).toBe('SiliconFlow')
    expect(currentValue(form, '协议')).toBe('openai')
    expect(fieldOf<HTMLInputElement>(form, 'Base URL').value).toBe('https://api.siliconflow.cn/v1')
    expect(fieldOf<HTMLTextAreaElement>(form, '模型列表').value).toBe(
      'deepseek-ai/DeepSeek-V3\nQwen/Qwen2.5-7B-Instruct',
    )
    // 编辑时不提供改 key 的入口：那是行内「更换 Key」的事，两处混在一起会说不清谁生效。
    expect(form.querySelector('input[type="password"]')).toBeNull()

    typeInto(fieldOf<HTMLInputElement>(form, '名称'), 'SiliconFlow 公司版')
    typeInto(fieldOf<HTMLInputElement>(form, 'Base URL'), 'https://gw.internal/v1')
    typeInto(fieldOf<HTMLTextAreaElement>(form, '模型列表'), 'internal-chat\ninternal-reason')
    await act(async () => {
      buttonByText('保存修改', form).click()
      await Promise.resolve()
    })
    expect(patched).toEqual([
      [
        'siliconflow',
        {
          displayName: 'SiliconFlow 公司版',
          protocol: 'openai',
          baseUrl: 'https://gw.internal/v1',
          models: [{ id: 'internal-chat' }, { id: 'internal-reason' }],
        },
      ],
    ])
    expect(changed).toBe(1)
    expect(container.querySelector('.modal')).toBeNull()
    expect(toastTexts()).toContain('「SiliconFlow」已更新')
  })

  /**
   * 编辑已有供应商时上下文长度的保存往返必须无损：服务端现存的值进输入框，保存时
   * 原样回传。此前这里读的是一份与服务端脱节的覆盖层，重新拉一次目录重建表单就把
   * 用户刚填的数字静默清空——值还在本机躺着，但这条路由从此按「未知」算预算。
   */
  it('编辑时上下文长度随服务端值预填，保存无损回传（不碰不丢，改了才变）', async () => {
    const stored: ProviderInfo = {
      ...builtinProvider,
      models: [{ id: 'deepseek-ai/DeepSeek-V3', contextWindow: 64_000 }, { id: 'Qwen/Qwen2.5-7B-Instruct' }],
    }
    const patched: Array<[string, UpdateProviderInput]> = []
    const api = fakeApi({
      updateProvider: (id: string, patch: UpdateProviderInput) => {
        patched.push([id, patch])
        return Promise.resolve({ provider: stored })
      },
    })
    await renderSettings(api, [stored], () => {})
    act(() => {
      buttonByText('SiliconFlow').click()
    })
    act(() => {
      buttonByText('编辑', container.querySelector('.provider-body')!).click()
    })
    const form = container.querySelector('form.provider-form')!
    // 现存的 64000 如实进框，没存过的明说未知（空串），不猜。
    expect(
      form.querySelector<HTMLInputElement>('input[aria-label="deepseek-ai/DeepSeek-V3 的上下文长度（token）"]')?.value,
    ).toBe('64000')
    expect(
      form.querySelector<HTMLInputElement>('input[aria-label="Qwen/Qwen2.5-7B-Instruct 的上下文长度（token）"]')?.value,
    ).toBe('')

    // 不动长度、只改名字：两条模型（含那条 64000）原样回传，往返无损。
    typeInto([...form.querySelectorAll('input')][0]!, 'SiliconFlow（改名）')
    await act(async () => {
      buttonByText('保存修改', form).click()
      await Promise.resolve()
    })
    expect(patched).toEqual([
      [
        'siliconflow',
        {
          displayName: 'SiliconFlow（改名）',
          protocol: 'openai',
          baseUrl: 'https://api.siliconflow.cn/v1',
          models: [{ id: 'deepseek-ai/DeepSeek-V3', contextWindow: 64_000 }, { id: 'Qwen/Qwen2.5-7B-Instruct' }],
        },
      ],
    ])

    // 第二条补上 32k 再存：PATCH 带上新值，旧那条不动。
    patched.length = 0
    act(() => {
      buttonByText('编辑', container.querySelector('.provider-body')!).click()
    })
    const again = container.querySelector('form.provider-form')!
    typeInto(
      again.querySelector<HTMLInputElement>('input[aria-label="Qwen/Qwen2.5-7B-Instruct 的上下文长度（token）"]')!,
      '32k',
    )
    await act(async () => {
      buttonByText('保存修改', again).click()
      await Promise.resolve()
    })
    expect(patched[0]?.[1].models).toEqual([
      { id: 'deepseek-ai/DeepSeek-V3', contextWindow: 64_000 },
      { id: 'Qwen/Qwen2.5-7B-Instruct', contextWindow: 32_000 },
    ])
  })

  it('保存失败：原因就地显示且拿到焦点，用户刚填的内容原样留着', async () => {
    const api = fakeApi({
      updateProvider: () => {
        return Promise.reject(
          new Error('模型「m1」正被 小译 使用：先到通讯录把这些 agent 改绑到别的模型，再删这些模型。'),
        )
      },
    })
    await renderSettings(api, [{ ...customProvider, usedBy: [{ agentId: 'a', agentName: '小译' }] }])
    act(() => {
      buttonByText('我的私有服务').click()
    })
    act(() => {
      buttonByText('编辑', container.querySelector('.provider-body')!).click()
    })
    const form = container.querySelector('form.provider-form')!
    typeInto(fieldOf<HTMLInputElement>(form, '名称'), '我的私有服务（改了名）')
    typeInto(form.querySelector('textarea')!, 'm-new')
    await act(async () => {
      buttonByText('保存修改', form).click()
      await Promise.resolve()
    })
    const error = form.querySelector('.apikey-error')!
    expect(error.getAttribute('role')).toBe('alert')
    // 点名到 agent：用户知道该去改绑谁，而不是"保存失败"三个字。
    expect(error.textContent).toContain('小译')
    // 键盘可达：保存失败后焦点直接落在原因上。
    expect(error.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(error)
    // 输入没有被清空：改完原因直接重试就行。
    expect(container.querySelector('form.provider-form')).not.toBeNull()
    expect(form.querySelectorAll('input')[0]!.value).toBe('我的私有服务（改了名）')
    expect(form.querySelector('textarea')!.value).toBe('m-new')
  })

  it('删模型时先提醒：还在列表里的模型不动，删掉的点名使用者', async () => {
    const api = fakeApi({ updateProvider: () => Promise.resolve({ provider: customProvider }) })
    await renderSettings(api, [
      {
        ...customProvider,
        models: [{ id: 'm-in-use' }, { id: 'm-free' }],
        usedBy: [{ agentId: 'a', agentName: '小译' }],
      },
    ])
    act(() => {
      buttonByText('我的私有服务').click()
    })
    act(() => {
      buttonByText('编辑', container.querySelector('.provider-body')!).click()
    })
    const form = container.querySelector('form.provider-form')!
    typeInto(form.querySelector('textarea')!, 'm-in-use')
    const warn = form.querySelector('.provider-warn')
    expect(warn?.textContent).toContain('m-free')
    expect(warn?.textContent).toContain('小译')
    // 只增不减（往回加一个）就不该有提醒。
    typeInto(form.querySelector('textarea')!, 'm-in-use\nm-free\nm-new')
    expect(form.querySelector('.provider-warn')).toBeNull()
  })

  it('服务端没实现编辑接口时：按钮禁用并说明，不让点了没反应', async () => {
    await renderSettings(fakeApi(), [builtinProvider])
    act(() => {
      buttonByText('SiliconFlow').click()
    })
    const button = buttonByText('编辑', container.querySelector('.provider-body')!) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toContain('还不能编辑供应商')
  })

  it('服务端没实现编辑接口（打开弹窗后）：保存禁用并说明替代做法', async () => {
    const api = fakeApi({
      updateProvider: () => Promise.reject(new Error('not found: PATCH /api/providers/custom-abc')),
    })
    await renderSettings(api, [builtinProvider])
    act(() => {
      buttonByText('SiliconFlow').click()
    })
    act(() => {
      buttonByText('编辑', container.querySelector('.provider-body')!).click()
    })
    const form = container.querySelector('form.provider-form')!
    typeInto(form.querySelectorAll('input')[0]!, 'SiliconFlow 改名')
    await act(async () => {
      buttonByText('保存修改', form).click()
      await Promise.resolve()
    })
    const message = form.querySelector('.apikey-error')?.textContent ?? ''
    expect(message).toContain('还不能编辑供应商')
    expect(message).toContain('providers.json')
    expect(message).not.toContain('PATCH /api/providers')
  })

  it('改过 Base URL 之后，上一次「已验证」的绿点撤掉', async () => {
    const api = fakeApi({
      verifyProvider: () => Promise.resolve({ ok: true, message: 'ok', latencyMs: 42 }),
      updateProvider: () => Promise.resolve({ provider: { ...builtinProvider } }),
    })
    await renderSettings(api, [{ ...builtinProvider, baseUrl: 'https://api.siliconflow.cn/v1' }])
    act(() => {
      buttonByText('SiliconFlow').click()
    })
    await act(async () => {
      buttonByText('测试连接').click()
      await Promise.resolve()
    })
    expect(container.querySelector('.provider-head')?.textContent).toContain('已验证')
    // 编辑后父组件重新喂一份端点已改的进来：那枚绿点说的已经不是这个地址。
    await act(async () => {
      root?.render(
        <ProviderSettings
          api={api}
          providers={[{ ...builtinProvider, baseUrl: 'https://gw.internal/v1' }]}
          onChanged={() => {}}
        />,
      )
      await Promise.resolve()
    })
    expect(container.querySelector('.provider-head')?.textContent).toContain('凭据已备（未验证）')
    expect(container.querySelector('.provider-head')?.querySelector('.status-dot.ok')).toBeNull()
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
    expect(container.querySelector('.provider-body')?.textContent).toContain('这一版还不支持「测试连接」')
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
        return Promise.resolve({ providerId: id, configured: false })
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
    expect(button.title).toContain('这一版还不支持「移除凭据」')
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

/**
 * 模型列表的录入方式与协议的选取方式。
 *
 * 这两条此前都是「用户得先知道规矩才能填对」：协议是个自由文本框，拼错要到真的
 * 发请求失败才暴露；模型列表要求「一行一个」，从各家控制台复制来的空格分隔清单
 * 粘进去就等于建出了一堆不存在的模型。
 */
/** 模型条目有两种写法（纯 id，或带上下文长度的对象）；断言只看 id。 */
function modelId(entry: ProviderModelEntry): string {
  return typeof entry === 'string' ? entry : entry.id
}

describe('协议与模型列表的录入', () => {
  /** 走到自定义表单并填好必填项，回包由调用方给。 */
  async function openCustomForm(
    create: (input: CreateProviderForm) => Promise<{ provider: ProviderInfo }>,
  ): Promise<HTMLFormElement> {
    const api = fakeApi({
      providerPresets: () => {
        return Promise.resolve({ presets: [] })
      },
      createProvider: create,
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
    return container.querySelector('form.provider-form')!
  }

  it('协议是下拉，且只有服务端真支持的那两个', async () => {
    const form = await openCustomForm(() => {
      return Promise.resolve({ provider: customProvider })
    })
    const select = fieldOf<HTMLButtonElement>(form, '协议')
    expect(select.classList.contains('select-trigger')).toBe(true)
    expect(select.getAttribute('aria-label')).toBe('协议')
    expect(listedValues(form, '协议')).toEqual(['openai', 'ollama'])
    // 给的是人话，不是标识符。
    expect(optionLabels(openSelect(form, '协议'))[0]).not.toBe('openai')
  })

  it('选了 ollama 就发 ollama（不是让用户敲标识）', async () => {
    let sent: unknown
    const form = await openCustomForm((input) => {
      sent = input
      return Promise.resolve({ provider: customProvider })
    })
    typeInto(fieldOf<HTMLInputElement>(form, '名称'), '本地模型')
    typeInto(fieldOf<HTMLInputElement>(form, 'Base URL'), 'http://localhost:11434/v1')
    pickOption(form, '协议', 'ollama')
    expect(triggerLabel(form, '协议')).toContain('Ollama')
    typeInto(fieldOf<HTMLTextAreaElement>(form, '模型列表'), 'qwen3:8b')
    await act(async () => {
      buttonByText('保存', form).click()
      await Promise.resolve()
    })
    expect(sent).toMatchObject({ protocol: 'ollama' })
  })

  it('模型列表用空格分隔也认（控制台复制来的清单直接粘）', async () => {
    let sent: CreateProviderForm | undefined
    const form = await openCustomForm((input) => {
      sent = input
      return Promise.resolve({ provider: customProvider })
    })
    typeInto(fieldOf<HTMLInputElement>(form, '名称'), '网关')
    typeInto(fieldOf<HTMLInputElement>(form, 'Base URL'), 'https://gw.internal/v1')
    typeInto(fieldOf<HTMLTextAreaElement>(form, '模型列表'), 'model-a model-b  model-c')
    await act(async () => {
      buttonByText('保存', form).click()
      await Promise.resolve()
    })
    expect((sent?.models ?? []).map(modelId)).toEqual(['model-a', 'model-b', 'model-c'])
  })

  it('混合分隔符与重复项都会被归一（重复只留第一次）', async () => {
    let sent: CreateProviderForm | undefined
    const form = await openCustomForm((input) => {
      sent = input
      return Promise.resolve({ provider: customProvider })
    })
    typeInto(fieldOf<HTMLInputElement>(form, '名称'), '网关')
    typeInto(fieldOf<HTMLInputElement>(form, 'Base URL'), 'https://gw.internal/v1')
    typeInto(fieldOf<HTMLTextAreaElement>(form, '模型列表'), 'model-a, model-b；model-a\nmodel-c、model-b')
    await act(async () => {
      buttonByText('保存', form).click()
      await Promise.resolve()
    })
    expect((sent?.models ?? []).map(modelId)).toEqual(['model-a', 'model-b', 'model-c'])
  })

  it('失焦时整理成一行一个，但不打断正在输入的人', async () => {
    const form = await openCustomForm(() => {
      return Promise.resolve({ provider: customProvider })
    })
    const area = fieldOf<HTMLTextAreaElement>(form, '模型列表')
    typeInto(area, 'model-a model-b')
    expect(area.value).toBe('model-a model-b')
    await act(async () => {
      // React 17+ 的 onBlur 走 focusout 委托，直接派发 blur 事件它收不到。
      area.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await Promise.resolve()
    })
    expect(area.value).toBe('model-a\nmodel-b')
  })
})

/**
 * 「我的」页的用户卡：名字与头像都能改，且改完真的落库。
 *
 * 这块此前是写死的「你」+ 一枚随机色块。写死的后果不只是不好看——服务端把资料
 * 拼进 agent 的系统提示，用户没有入口去改，就等于这个能力整条链路是死的。
 */
describe('用户卡可改', () => {
  async function renderMe(api: Partial<Parameters<typeof MePage>[0]['api']>): Promise<void> {
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
            ...api,
          }}
          ryen={undefined}
          providers={[builtinProvider]}
          theme="light"
          onThemeChange={() => {}}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('显示服务端给的名字，不显示写死的「你」', async () => {
    await renderMe({
      profile: () => {
        return Promise.resolve({ profile: { name: '小明', avatar: '' } })
      },
    })
    expect(container.querySelector('.me-name')?.textContent).toContain('小明')
  })

  it('改名字走 PATCH，落库后卡片显示新名字', async () => {
    const saved: unknown[] = []
    await renderMe({
      profile: () => {
        return Promise.resolve({ profile: { name: '你', avatar: '' } })
      },
      saveProfile: (patch) => {
        saved.push(patch)
        return Promise.resolve({ profile: { name: '小明', avatar: '' } })
      },
    })
    await act(async () => {
      // 直接取 .me-name：头像兜底色块里的首字母也是「你」，按文本找会点到头像上去。
      container.querySelector<HTMLButtonElement>('.me-usercard .me-name')!.click()
      await Promise.resolve()
    })
    const input = container.querySelector<HTMLInputElement>('.me-usercard .me-name-inline')
    expect(input).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '小明')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(saved).toEqual([{ name: '小明' }])
    expect(container.querySelector('.me-name')?.textContent).toContain('小明')
  })

  it('空名字不提交（服务端也会拒）', async () => {
    const saved: unknown[] = []
    await renderMe({
      profile: () => {
        return Promise.resolve({ profile: { name: '小明', avatar: '' } })
      },
      saveProfile: (patch) => {
        saved.push(patch)
        return Promise.resolve({ profile: { name: '小明', avatar: '' } })
      },
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.me-usercard .me-name')!.click()
      await Promise.resolve()
    })
    const input = container.querySelector<HTMLInputElement>('.me-usercard .me-name-inline')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '   ')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    expect(saved).toEqual([])
  })

  it('保存失败时卡片退回服务端那份，不显示一个没存上的名字', async () => {
    await renderMe({
      profile: () => {
        return Promise.resolve({ profile: { name: '小明', avatar: '' } })
      },
      saveProfile: () => {
        return Promise.reject(new Error('disk full'))
      },
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.me-usercard .me-name')!.click()
      await Promise.resolve()
    })
    const input = container.querySelector<HTMLInputElement>('.me-usercard .me-name-inline')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '小红')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('.me-name')?.textContent).toContain('小明')
  })

  it('服务端没有这条能力时名字仍读得出，但点不动并说明原因', async () => {
    await renderMe({
      profile: () => {
        return Promise.resolve({ profile: { name: '小明', avatar: '' } })
      },
    })
    const nameButton = container.querySelector<HTMLButtonElement>('.me-usercard .me-name')
    expect(nameButton?.disabled).toBe(true)
    expect(nameButton?.title).toContain('还不支持')
  })
})
