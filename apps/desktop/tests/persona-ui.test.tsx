// @vitest-environment jsdom
/**
 * 人格 UI 接线：建 agent 表单的人格编辑区（滑杆 + 生日/口头禅/形象/音色 + 只读预览）、
 * 提交载荷里的人格字段、通讯录卡片的人格摘要，以及资料卡的性格与亲密度。
 *
 * 末尾那条 parity 用例是本文件存在的一半理由：`renderer/src/lib/persona.ts` 与内核
 * `packages/session/src/persona.ts` 是两份手抄的实现，编辑器里显示的预览必须逐字等于
 * 模型真正收到的那段系统提示，否则"看得见因果"就是假的因果。
 */
import {
  composePersonaPrompt as kernelCompose,
  normalizePersona as kernelNormalize,
} from '@ryharness/session/src/persona.ts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, AgentPersona, AgentTemplate, Conversation, ProviderInfo } from '../renderer/src/api.ts'
import { ApiClient } from '../renderer/src/api.ts'
import { ChatView } from '../renderer/src/components/ChatView.tsx'
import { ContactsPage, CreateAgentModal } from '../renderer/src/components/ContactsPage.tsx'
import { RightPanel } from '../renderer/src/components/RightPanel.tsx'
import { composePersonaPrompt, normalizePersona } from '../renderer/src/lib/persona.ts'
import { resetVoiceCatalogCache, type VoiceCatalog, VoicePlayer } from '../renderer/src/lib/voice.ts'
import { bucketOf, ChatStore } from '../renderer/src/store.ts'
import {
  groupLabels,
  openSelect,
  optionLabels,
  optionRows,
  optionValues,
  pickOption,
  triggerLabel,
} from './select-dom.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 满人格：每一档都取顶，摘要与分档描述的期望值最直观。 */
const vividPersona: AgentPersona = {
  extroversion: 100,
  rigor: 100,
  humor: 100,
  initiative: 100,
  birthday: '03-14',
  catchphrase: '交给我吧',
  affinity: 92,
  voiceId: 'sf-cosyvoice2-claire',
  appearance: '一只穿橘色围巾的狸花猫',
}

const templates: AgentTemplate[] = [
  {
    key: 'general',
    name: '通用助理',
    description: '什么都能聊',
    suggestedSystemPrompt: '你是通用助理。',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    defaultTools: ['fs_read'],
    persona: vividPersona,
  },
]

const providers: ProviderInfo[] = [
  {
    id: 'siliconflow',
    displayName: 'SiliconFlow',
    apiKeyConfigured: true,
    models: [{ id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek-V3' }],
  },
]

const vividAgent: AgentDef = {
  id: 'cat',
  name: '橘仔',
  avatar: 'cat',
  systemPrompt: '你是住在通讯录里的助理。',
  provider: 'siliconflow',
  model: 'deepseek-ai/DeepSeek-V3',
  tools: ['fs_read'],
  persona: vividPersona,
  isBuiltin: false,
}

/** 滑杆的中文 aria-label 对应哪一维（UI 说「外向」，字段名是 extroversion）。 */
const TRAIT_BY_LABEL: Record<string, keyof AgentPersona> = {
  外向: 'extroversion',
  严谨: 'rigor',
  幽默: 'humor',
  主动: 'initiative',
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  resetVoiceCatalogCache()
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
  resetVoiceCatalogCache()
  vi.unstubAllGlobals()
})

async function renderModal(
  props: Partial<React.ComponentProps<typeof CreateAgentModal>> & {
    onSubmit?: (input: Record<string, unknown>) => Promise<void>
  } = {},
): Promise<void> {
  const { onSubmit = () => Promise.resolve(), ...rest } = props
  await act(async () => {
    root = createRoot(container)
    root.render(
      <CreateAgentModal templates={templates} providers={providers} onSubmit={onSubmit} onClose={() => {}} {...rest} />,
    )
    await Promise.resolve()
  })
}

/** 拖滑杆：走原型上的原生 setter，绕开 React 的 value tracker。 */
function dragTrait(label: string, value: number): void {
  const slider = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(slider, String(value))
    slider.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 按 label 的首个文本字段取控件（生日 / 口头禅 / 形象）。 */
function textField(label: string): HTMLInputElement {
  const field = [...container.querySelectorAll('label.field')].find((node) => {
    return node.querySelector('span')?.textContent === label
  })!
  return field.querySelector('input')!
}

/**
 * 音色那一格的下拉（那一格不是 <label>，里面还放着试听按钮，button 不能嵌在 label 里）。
 * 它现在是自绘下拉：取值要打开弹层去看，不是读原生 select 的 value。
 */
function voiceSelect(): HTMLButtonElement {
  const field = [...container.querySelectorAll<HTMLElement>('label.field, div.field')].find((node) => {
    return node.querySelector('span')?.textContent === '音色'
  })!
  return field.querySelector<HTMLButtonElement>('.select-trigger')!
}

function preview(): string {
  return container.querySelector('pre')!.textContent ?? ''
}

function saveButton(): HTMLButtonElement {
  return [...container.querySelectorAll('.modal-actions button')].find((node) => {
    return node.textContent === '保存' || node.textContent === '保存修改'
  }) as HTMLButtonElement
}

/** 高级设置的折叠入口（供应商/模型/工具白名单都收在里面）。 */
function advancedToggle(): HTMLButtonElement {
  const toggle = container.querySelector<HTMLButtonElement>('button.advanced-toggle')
  if (toggle === null) throw new Error('找不到「高级设置」入口')
  return toggle
}

describe('建 agent 表单的人格编辑区', () => {
  it('四个性格滑杆都渲染，且每条都带着该档的中文描述', async () => {
    await renderModal()
    for (const [label, key] of Object.entries(TRAIT_BY_LABEL)) {
      const slider = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
      expect(slider, `缺少「${label}」滑杆`).not.toBeNull()
      expect(slider?.getAttribute('type')).toBe('range')
      expect(slider?.value).toBe(String(vividPersona[key]))
    }
    // 滑杆旁的分档描述（traitBand 的 describe）必须真的上屏，否则用户只会看到一个数字。
    expect(container.textContent).toContain('自来熟，陌生人也能聊起来')
    expect(container.textContent).toContain('宁可标「不确定」也不猜')
  })

  it('生日 / 口头禅 / 形象 / 音色都在，音色可试听且不再写「尚未接入」', async () => {
    await renderModal()
    // 生日是**原生日期选择器**（点开就是日历，不用手敲"03-14"）：控件要完整日期，
    // 所以显示成 2000-03-14（2000 是占位年，生日不需要年份）；存进人格的仍是
    // MM-DD，见下面 normalizePersona 的断言。
    const birthday = textField('生日')
    expect(birthday.getAttribute('type')).toBe('date')
    expect(birthday.value).toBe('2000-03-14')
    expect(textField('口头禅').value).toBe('交给我吧')
    expect(textField('形象').value).toBe('一只穿橘色围巾的狸花猫')
    const voice = voiceSelect()
    // 没有 api 时目录为空：当前值仍要如实占一格，不能被下拉静默吞掉。
    expect(triggerLabel(container, '音色')).toBe('已下架的旧音色')
    // 旧 id 不在目录里：显示「已下架的旧音色」，原始 id 收进 title，不再把它当音色名念出来。
    const popover = openSelect(container, '音色')
    const stale = optionRows(popover).find((node) => {
      return node.dataset.value === vividPersona.voiceId
    })
    expect(stale?.getAttribute('aria-selected')).toBe('true')
    expect(stale?.getAttribute('title')).toBe(vividPersona.voiceId)
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.textContent).toContain('已下架的旧音色')
    expect(container.textContent).not.toContain('未知音色（')
    // 占位提示已经随真接入退场；试听按钮在（无可念音色时禁用）。
    expect(container.textContent).not.toContain('声音尚未接入')
    expect(
      [...container.querySelectorAll('button')].map((button) => {
        return button.textContent?.trim()
      }),
    ).toContain('试听')
    expect(voice.getAttribute('aria-label')).toBe('音色')
  })

  it('音色下拉来自 /api/voice/catalog，按引擎分组，试听念 sampleText', async () => {
    const catalog: VoiceCatalog = {
      engines: [
        { id: 'system', name: '系统语音', available: true },
        { id: 'siliconflow', name: 'SiliconFlow 云端语音', available: true },
      ],
      profiles: [
        {
          id: 'system-huihui',
          name: '慧慧（系统女声）',
          engine: 'system',
          voice: 'Microsoft Huihui Desktop',
          sampleText: '系统试听句。',
          description: 'Windows 自带的普通话女声',
        },
        {
          id: 'sf-cosyvoice2-claire',
          name: '温柔女声（CosyVoice2 claire）',
          engine: 'siliconflow',
          voice: 'FunAudioLLM/CosyVoice2-0.5B:claire',
          sampleText: '云端试听句。',
          description: 'CosyVoice2 预置音色',
        },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        expect(String(input)).toContain('/api/voice/catalog')
        return new Response(JSON.stringify(catalog), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    const spoken: string[] = []
    const player = new VoicePlayer({
      catalog: () => Promise.resolve(catalog),
      synthesize: () => Promise.reject(new Error('系统音色不该走云端')),
      system: {
        speak: (input) => {
          spoken.push(input.text)
          return Promise.resolve()
        },
        cancel: () => {},
      },
      createAudio: () => {
        throw new Error('不该创建音频元素')
      },
      createObjectURL: () => '',
      revokeObjectURL: () => {},
      notifyFallback: () => {},
    })
    await renderModal({ api: new ApiClient('http://voice.test'), voice: player })
    // 等目录请求落地（act 已把微任务跑完，这里再等一拍 fetch 链）。
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const popover = openSelect(container, '音色')
    const values = optionValues(popover)
    expect(values).toContain('system-huihui')
    expect(values).toContain('sf-cosyvoice2-claire')
    expect(groupLabels(popover)).toContain('系统语音')
    expect(groupLabels(popover)).toContain('SiliconFlow 云端语音')
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => {
      const preview = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === '试听')
      if (preview === undefined) throw new Error('找不到试听按钮')
      preview.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(spoken).toEqual(['云端试听句。'])
  })

  it('云端音色不可用：音色行下面给出原因与「配置云端音色」按钮，而不是只弹一次 toast', async () => {
    const catalog: VoiceCatalog = {
      engines: [
        { id: 'system', name: '系统语音', available: true },
        {
          id: 'siliconflow',
          name: 'SiliconFlow 云端语音',
          available: false,
          reason: '还没配置 SiliconFlow 的 API Key',
        },
      ],
      profiles: [
        {
          id: 'sf-cosyvoice2-claire',
          name: '温柔女声（CosyVoice2 claire）',
          engine: 'siliconflow',
          voice: 'FunAudioLLM/CosyVoice2-0.5B:claire',
          sampleText: '云端试听句。',
          description: 'CosyVoice2 预置音色',
        },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(JSON.stringify(catalog), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    const onOpenProviderSettings = vi.fn()
    await renderModal({
      api: new ApiClient('http://voice.test'),
      onOpenProviderSettings,
      editing: { ...vividAgent, persona: { ...vividPersona, voiceId: 'sf-cosyvoice2-claire' } },
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('需要 SiliconFlow API Key')
    const configure = [...container.querySelectorAll('button')].find((button) => {
      return button.textContent?.trim() === '配置云端音色'
    })
    expect(configure).toBeDefined()
    act(() => {
      configure?.click()
    })
    expect(onOpenProviderSettings).toHaveBeenCalledTimes(1)
  })

  it('离线音色不可用：仍列在下拉里并标注「需要先下载」，选中后出现安装卡与进度', async () => {
    let phase: 'absent' | 'downloading' | 'ready' = 'absent'
    const catalogFor = (): VoiceCatalog => {
      return {
        engines: [
          { id: 'system', name: '系统语音', available: true },
          {
            id: 'piper',
            name: '离线（Piper）',
            available: phase === 'ready',
            ...(phase === 'ready' ? {} : { reason: '离线语音包还没下载' }),
          },
        ],
        profiles: [
          {
            id: 'piper-huayan',
            name: '华言 · 离线女声',
            engine: 'piper',
            voice: 'zh_CN-huayan-medium',
            sampleText: '离线试听句。',
            description: 'Piper 离线模型',
          },
        ],
      }
    }
    const json = (value: unknown): Response => {
      return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/voice/catalog')) return json(catalogFor())
      if (url.includes('/api/voice/engines/piper/install')) {
        phase = 'downloading'
        return json({ state: 'downloading', receivedBytes: 0, totalBytes: 100 })
      }
      if (url.includes('/api/voice/engines/piper/status')) {
        if (phase === 'downloading') phase = 'ready'
        return json({ state: phase, ...(phase === 'ready' ? { receivedBytes: 100, totalBytes: 100 } : {}) })
      }
      throw new Error(`未预期的请求 ${url} ${init?.method ?? 'GET'}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    await renderModal({ api: new ApiClient('http://voice.test') })
    // 目录与安装状态各是一条 fetch 链（含 response.json()）；多等一拍宏任务再断言。
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })
    pickOption(container, '音色', 'piper-huayan')
    // 选中后安装卡才挂载，它自己的状态查询要再等一拍。
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })
    // 不可用不等于隐藏：选项与分组都还在，只是标注要下载。
    const popover = openSelect(container, '音色')
    expect(optionLabels(popover)).toContain('华言 · 离线女声（需要先下载）')
    expect(groupLabels(popover)).toContain('离线（Piper）（需要先下载）')
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.textContent).toContain('需要先下载离线语音包')
    expect(container.textContent).toContain('离线语音包还没下载（约 85 MB')
    const download = [...container.querySelectorAll('button')].find((button) => {
      return button.textContent?.trim() === '下载离线语音包'
    })
    expect(download).toBeDefined()
    await act(async () => {
      download?.click()
      await Promise.resolve()
    })
    expect(
      fetchMock.mock.calls.some((call) => {
        return String(call[0]).includes('/api/voice/engines/piper/install') && call[1]?.method === 'POST'
      }),
    ).toBe(true)
    // 轮询间隔 1 秒；在 act 里推进真实时钟，避免 React 状态更新落在测试作用域外。
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 1_100)
      })
    })
    expect(container.querySelector('.voice-install-card')).toBeNull()
    // 目录刷新后同一条音色立刻变成可用，不再需要重启编辑器。
    expect(container.textContent).not.toContain('需要先下载离线语音包')
  })

  it('离线语音包安装失败：安装卡显示原因与「重试」，点击会再次 POST', async () => {
    const catalog: VoiceCatalog = {
      engines: [
        { id: 'system', name: '系统语音', available: true },
        { id: 'piper', name: '离线（Piper）', available: false, reason: '离线语音包还没下载' },
      ],
      profiles: [
        {
          id: 'piper-huayan',
          name: '华言 · 离线女声',
          engine: 'piper',
          voice: 'zh_CN-huayan-medium',
          sampleText: '离线试听句。',
          description: 'Piper 离线模型',
        },
      ],
    }
    const json = (value: unknown): Response => {
      return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/voice/catalog')) return json(catalog)
      if (url.includes('/api/voice/engines/piper/install')) return json({ state: 'downloading', totalBytes: 100 })
      if (url.includes('/api/voice/engines/piper/status')) {
        return json({ state: init?.method === 'POST' ? 'absent' : 'error', error: '镜像都失败了' })
      }
      throw new Error(`未预期的请求 ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    await renderModal({ api: new ApiClient('http://voice.test') })
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })
    const voice = voiceSelect()
    pickOption(container, '音色', 'piper-huayan')
    expect(voice.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })
    expect(container.textContent).toContain('上次安装失败：镜像都失败了')
    const retry = [...container.querySelectorAll('button')].find((button) => {
      return button.textContent?.trim() === '重试'
    })
    expect(retry).toBeDefined()
    await act(async () => {
      retry?.click()
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })
    expect(
      fetchMock.mock.calls.some((call) => {
        return String(call[0]).includes('/api/voice/engines/piper/install') && call[1]?.method === 'POST'
      }),
    ).toBe(true)
  })

  it('预览就是 composePersonaPrompt 的输出（只读、逐字相同）', async () => {
    await renderModal()
    expect(preview()).toBe(composePersonaPrompt('你是通用助理。', vividPersona))
    expect(preview()).toContain('〔人格〕')
    expect(preview()).toContain('生日：03-14')
  })

  it('拖滑杆即时改写预览：用户看得见因果', async () => {
    await renderModal({ initialTemplateKey: 'general' })
    dragTrait('外向', 0)
    expect(preview()).toContain('· 外向 0/100（安静）')
    dragTrait('幽默', 90)
    expect(preview()).toContain('· 幽默 90/100（贫嘴）')
    // 预览整体重算，而不是只改一行。
    expect(preview()).toBe(composePersonaPrompt('你是通用助理。', { ...vividPersona, extroversion: 0, humor: 90 }))
  })

  it('提交带上完整 persona 字段（服务端已支持）', async () => {
    const onSubmit = vi.fn((_input: Record<string, unknown>) => {
      return Promise.resolve()
    })
    await renderModal({ onSubmit })
    dragTrait('严谨', 10)
    await act(async () => {
      saveButton().click()
      await Promise.resolve()
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const input = onSubmit.mock.calls[0]![0] as Record<string, unknown>
    expect(input.persona).toEqual({ ...vividPersona, rigor: 10 })
  })

  it('生日清空后不再拼出「生日：」这一行', async () => {
    const onSubmit = vi.fn((_input: Record<string, unknown>) => {
      return Promise.resolve()
    })
    await renderModal({ onSubmit })
    const birthday = textField('生日')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(birthday, '')
      birthday.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    expect(preview()).not.toContain('生日：')
    await act(async () => {
      saveButton().click()
      await Promise.resolve()
    })
    const input = onSubmit.mock.calls[0]![0] as { persona: AgentPersona }
    // 空串会被 composePersonaPrompt 当成"填了生日"（它判的是 !== undefined）。
    expect(input.persona.birthday).toBeUndefined()
  })

  it('选一个日期后存进人格的是月日（不是带占位年的完整日期）', async () => {
    const onSubmit = vi.fn((_input: Record<string, unknown>) => {
      return Promise.resolve()
    })
    await renderModal({ onSubmit })
    const birthday = textField('生日')
    // React 受控组件：改 value 必须走原生 setter，赋值不会触发 onChange
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter === undefined) throw new Error('拿不到 input.value 的 setter')
    await act(async () => {
      setter.call(birthday, '2001-07-04')
      birthday.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => {
      saveButton().click()
      await Promise.resolve()
    })
    const submitted = onSubmit.mock.calls
    expect(submitted.length).toBe(1)
    const input = submitted[0]?.[0] as { persona: AgentPersona }
    // 生日不需要年份：控件用 2000 占位，存下来只留月日。
    expect(input.persona.birthday).toBe('07-04')
  })

  it('性格区常驻展开，折叠的是高级设置（第一卖点不能藏进折叠区）', async () => {
    await renderModal()
    // 性格是这个产品的第一卖点：四维滑杆必须一进来就在，不需要点任何按钮。
    expect(container.querySelector('input[aria-label="外向"]')).not.toBeNull()
    expect(container.querySelector('.persona-card')).not.toBeNull()
    // 进而在折叠的是实现层选择（供应商/模型/工具），且折叠态仍给一行当前值摘要。
    const advanced = advancedToggle()
    expect(advanced.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('#advanced-settings')).toBeNull()
    expect(container.querySelector('.advanced-text small')?.textContent).toBe('SiliconFlow · DeepSeek-V3 · 1 个工具')
    await act(async () => {
      advanced.click()
      await Promise.resolve()
    })
    expect(advanced.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('#advanced-settings')).not.toBeNull()
  })

  it('切模板连带换人格、头像与工具：身份卡上立刻变成另一位助理', async () => {
    const coding: AgentTemplate = {
      key: 'coding',
      name: '阿码',
      description: '阿码：住在终端里的猫头鹰。',
      suggestedSystemPrompt: '你是阿码。',
      defaultModel: 'deepseek-ai/DeepSeek-V3',
      defaultTools: ['fs_read', 'fs_write'],
      avatar: 'db:dylan:nightowl',
      persona: {
        extroversion: 18,
        rigor: 88,
        humor: 22,
        initiative: 62,
        catchphrase: '改完了，跑一遍。',
        affinity: 10,
        voiceId: 'sf-cosyvoice2-alex',
        appearance: '灰色猫头鹰。',
      },
    }
    const onSubmit = vi.fn((_input: Record<string, unknown>) => {
      return Promise.resolve()
    })
    await renderModal({ templates: [...templates, coding], onSubmit })
    const before = container.querySelector('.agent-card-traits')?.textContent
    await act(async () => {
      const pick = container.querySelector<HTMLButtonElement>('.template-pick[aria-checked="false"]')
      if (pick === null) throw new Error('模板卡片只渲染了一张')
      pick.click()
      await Promise.resolve()
    })
    // 人格段与口头禅都换成模板带来的那份（此前换模板只换提示词与工具）。
    expect(preview()).toBe(composePersonaPrompt('你是阿码。', coding.persona as AgentPersona))
    expect(container.querySelector('.agent-card-catch')?.textContent).toBe('「改完了，跑一遍。」')
    expect(container.querySelector('.agent-card-traits')?.textContent).not.toBe(before)
    await act(async () => {
      saveButton().click()
      await Promise.resolve()
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const input = (onSubmit.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>
    expect(input.templateKey).toBe('coding')
    expect(input.avatar).toBe('db:dylan:nightowl')
    expect(input.persona).toEqual(coding.persona)
    expect(input.tools).toEqual(['fs_read', 'fs_write'])
  })

  it('身份卡跟着名字与口头禅实时变（它是新建流程的结果预览）', async () => {
    await renderModal()
    expect(container.querySelector('.agent-card-name')?.textContent).toBe('通用助理')
    expect(container.querySelector('.agent-card-name')?.className).toContain('is-placeholder')
    const nameField = textField('名字')
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    if (proto?.set === undefined) throw new Error('拿不到 input.value 的原生 setter')
    const setter = proto.set
    await act(async () => {
      setter.call(nameField, '小橘')
      nameField.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    expect(container.querySelector('.agent-card-name')?.textContent).toBe('小橘')
    expect(container.querySelector('.agent-card-name')?.className).not.toContain('is-placeholder')
    const catchphrase = textField('口头禅')
    await act(async () => {
      setter.call(catchphrase, '交给我吧')
      catchphrase.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    expect(container.querySelector('.agent-card-catch')?.textContent).toBe('「交给我吧」')
  })

  it('两段文字的关系写在界面上（否则用户不知道哪段生效）', async () => {
    await renderModal()
    const labels = [...container.querySelectorAll('label.field > span')].map((node) => {
      return node.textContent
    })
    expect(labels).toContain('补充说明（人格之外的交代）')
    expect(labels).not.toContain('人设（system prompt）')
    // 只说两段的关系与「下面就是最终样子」；拼接顺序的细节由下方预览本身承担。
    expect(container.textContent).toContain('排在性格前面')
  })
})

describe('通讯录卡片', () => {
  const html = renderToStaticMarkup(
    <ContactsPage
      agents={[vividAgent]}
      templates={templates}
      onChat={() => {}}
      onCreateAgent={() => {}}
      onEditAgent={() => {}}
      onDeleteAgent={() => {}}
      onCreateGroup={() => {}}
    />,
  )

  it('卡片上给性格档位 + 亲密度档位，而不是原始 system prompt 的前 48 字', () => {
    // 性格做成四条小条：每条带自己的档位名——「自来熟」比「外向 92」好懂。
    expect(html).toContain('contact-traits')
    for (const label of ['自来熟', '一丝不苟', '贫嘴', '很主动']) {
      expect(html).toContain(label)
    }
    expect(html).toContain('亲密度 92/100 · 挚友')
    // 旧写法把 systemPrompt.slice(0, 48) 直接摆上卡片。
    expect(html).not.toContain('你是住在通讯录里的助理。')
  })

  it('模型走人话层，不显示开发者字符串', () => {
    expect(html).toContain('DeepSeek-V3 · SiliconFlow')
    expect(html).not.toContain('deepseek-ai/DeepSeek-V3')
    expect(html).not.toContain('siliconflow / ')
  })

  it('存量 agent（没有 persona）也有性格条，不留空白', () => {
    const legacy = renderToStaticMarkup(
      <ContactsPage
        agents={[{ ...vividAgent, persona: undefined }]}
        templates={[]}
        onChat={() => {}}
        onCreateAgent={() => {}}
        onEditAgent={() => {}}
        onDeleteAgent={() => {}}
        onCreateGroup={() => {}}
      />,
    )
    expect(legacy).toContain('contact-traits')
    // 默认人格的档位名（外向 50 → 适中）。
    expect(legacy).toContain('适中')
  })
})

describe('资料卡', () => {
  const conversation: Conversation = {
    id: 'c1',
    kind: 'direct',
    title: '橘仔',
    memberAgentIds: ['cat'],
    lastReadSeq: 1,
    createdAt: 1,
    updatedAt: 2,
  }

  async function renderPanel(agent: AgentDef): Promise<string> {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <RightPanel
          api={
            {
              conversationDetail: () => {
                return Promise.resolve({ conversation, usage: undefined })
              },
            } as unknown as ApiClient
          }
          store={new ChatStore()}
          conversation={conversation}
          agents={[agent]}
          conversations={[conversation]}
          fileUrl={(name) => `/api/files/${name}`}
          collapsed={false}
          onToggle={() => {}}
        />,
      )
      await Promise.resolve()
    })
    return container.innerHTML
  }

  it('性格四维、亲密度档位、首次相遇都在', async () => {
    const html = await renderPanel(vividAgent)
    for (const label of ['外向 · 自来熟', '严谨 · 一丝不苟', '幽默 · 贫嘴', '主动 · 很主动']) {
      expect(html).toContain(label)
    }
    expect(html).toContain('挚友（亲密度 92/100）')
    // createdAt 缺失时如实写未知，不能编一个日期。
    expect(html).toContain('首次相遇')
    expect(html).toContain('未知')
  })

  it('「模型」只出现一次，且不再把 dt 嵌进 dd', async () => {
    const html = await renderPanel(vividAgent)
    expect(html.match(/<dt>模型<\/dt>/g)?.length).toBe(1)
    // 结构不变量而非坐标字面量：<dd> 里不允许再出现 <dt>（旧代码就是这么嵌的）。
    expect(html).not.toMatch(/<dd[^>]*>[^<]*<dt/)
    expect(html).toContain('DeepSeek-V3 · SiliconFlow')
  })
})

/**
 * 两套人格必须逐字同源：渲染层那一份是手抄的，改一处分档文案就会让用户看到的预览
 * 与模型真正收到的那段系统提示悄悄分叉。
 */
describe('渲染层与内核的人格文案 parity', () => {
  const cases: AgentPersona[] = [
    vividPersona,
    normalizePersona(undefined),
    { ...vividPersona, birthday: undefined, catchphrase: '', appearance: '' },
  ]

  for (const [index, persona] of cases.entries()) {
    it(`第 ${index + 1} 组人格：composePersonaPrompt 输出一致`, () => {
      const base = '你是通用助理。'
      expect(composePersonaPrompt(base, persona)).toBe(kernelCompose(base, kernelNormalize(persona)))
    })
  }

  it('只读预览必须等于内核拼接结果（编辑器看到的 = 模型收到的）', () => {
    for (const persona of cases) {
      expect(composePersonaPrompt('你是通用助理。', persona)).toBe(
        kernelCompose('你是通用助理。', kernelNormalize(persona)),
      )
    }
  })
})

/**
 * 👍/👎 → 亲密度 → 界面外显的接线。
 *
 * 亲密度 bump 由服务端在 /api/feedback 里内联做（反馈被接受才涨），渲染层只走
 * sendFeedback 一个入口——这里锁住三件事：点击会带上 messageId 调 sendFeedback
 * （服务端按 messageId+signal 去重，防连刷）、成功后外层拿到 onAffinityChange
 * 去重拉清单（徽标/卡片/右栏当场跟上）、同一消息重复点击不再发第二次请求。
 */
describe('点赞/点踩的亲密度接线', () => {
  const conversation: Conversation = {
    id: 'c-affinity',
    kind: 'direct',
    title: '橘仔',
    memberAgentIds: ['cat'],
    lastReadSeq: 1,
    createdAt: 1,
    updatedAt: 2,
  }

  it('点 👍 调 sendFeedback（带 messageId），成功后通知外层刷新', async () => {
    const store = new ChatStore()
    store.apply({ type: 'message-start', senderId: 'cat', senderName: '橘仔', turnIndex: 0 } as never)
    store.apply({ type: 'text-delta', senderId: 'cat', text: '交给我吧' } as never)
    store.apply({ type: 'message-done', senderId: 'cat', turnIndex: 0 } as never)
    const bumpAgentAffinity = vi.fn((_id: string, _signal: 'thumb_up' | 'thumb_down') => {
      return Promise.resolve({ agent: vividAgent })
    })
    const sendFeedback = vi.fn(() => {
      return Promise.resolve({ recorded: true, agent: vividAgent })
    })
    const onAffinityChange = vi.fn()
    const api = {
      base: 'http://api.test',
      messages: () => {
        return Promise.resolve({ messages: [] })
      },
      markRead: () => {
        return Promise.resolve({ conversationId: conversation.id, lastReadSeq: 1 })
      },
      listDispatchEvents: () => {
        return Promise.resolve({ events: [] })
      },
      postMessage: () => {
        return Promise.resolve({ accepted: true })
      },
      subscribe: () => {
        return () => {}
      },
      fileUrl: (name: string) => {
        return `/api/files/${name}`
      },
      sendFeedback,
      bumpAgentAffinity,
    } as unknown as ApiClient
    await act(async () => {
      root = createRoot(container)
      root.render(
        <ChatView
          api={api}
          conversation={conversation}
          agents={[vividAgent]}
          bucket={bucketOf(store)}
          onAffinityChange={onAffinityChange}
        />,
      )
      await Promise.resolve()
    })
    const thumbsUp = container.querySelector<HTMLButtonElement>('button[aria-label="有帮助"]')!
    expect(thumbsUp).not.toBeNull()
    await act(async () => {
      thumbsUp.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    // 亲密度改由服务端在 /api/feedback 里内联 bump：渲染层不再直接调 /affinity。
    expect(bumpAgentAffinity).not.toHaveBeenCalled()
    expect(sendFeedback).toHaveBeenCalledTimes(1)
    expect(sendFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'c-affinity',
        agentId: 'cat',
        signal: 'thumb_up',
        messageId: expect.any(String),
      }),
    )
    // 成功后外层据此重拉清单：亲密度外显当场跟上，而不是等下一轮结束。
    expect(onAffinityChange).toHaveBeenCalledTimes(1)

    // 防刷：同一消息再点一次 👍 不再发请求（服务端幂等只是兜底，包都不该重发）。
    await act(async () => {
      thumbsUp.click()
      await Promise.resolve()
    })
    expect(sendFeedback).toHaveBeenCalledTimes(1)
  })
})
