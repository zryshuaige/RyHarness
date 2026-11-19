// @vitest-environment jsdom
/**
 * Agent 编辑页的供应商/模型绑定：默认供应商、切换供应商连 model 一起换、
 * 提交前的 model ∈ models 断言，以及「执行命令」不再是默认勾选项。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERMISSION_PRESETS } from '../../../packages/agent/src/permission.ts'
import type { AgentDef, AgentTemplate, ProviderInfo } from '../renderer/src/api.ts'
import { ApiClient } from '../renderer/src/api.ts'
import { CreateAgentModal } from '../renderer/src/components/ContactsPage.tsx'
import { TEST_PERSONA } from './fixtures.ts'
import { currentValue, listedValues, openSelect, optionRows, pickOption, triggerLabel } from './select-dom.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const noKey: ProviderInfo = {
  id: 'deepseek',
  displayName: 'DeepSeek',
  apiKeyConfigured: false,
  protocol: 'openai',
  models: [{ id: 'deepseek-chat' }],
}

const ready: ProviderInfo = {
  id: 'siliconflow',
  displayName: 'SiliconFlow',
  apiKeyConfigured: true,
  protocol: 'openai',
  models: [
    { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek-V3' },
    { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen2.5-7B' },
  ],
}

const local: ProviderInfo = {
  id: 'ollama',
  displayName: 'Ollama',
  apiKeyConfigured: false,
  protocol: 'ollama',
  models: [{ id: 'qwen2.5:7b' }],
}

/** 模板默认带 shell_exec：这是「默认勾选」的源头。 */
const templateWithShell: AgentTemplate = {
  key: 'coding',
  name: '编程搭档',
  description: '写代码',
  suggestedSystemPrompt: '你是编程搭档。',
  defaultModel: 'deepseek-chat',
  persona: TEST_PERSONA,
  defaultTools: ['fs_read', 'fs_write', 'shell_exec'],
}

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

async function renderModal(
  props: Partial<React.ComponentProps<typeof CreateAgentModal>> & {
    onSubmit?: (input: Record<string, unknown>) => Promise<void>
  } = {},
): Promise<void> {
  const { onSubmit = () => Promise.resolve(), ...rest } = props
  await act(async () => {
    root = createRoot(container)
    root.render(
      <CreateAgentModal
        templates={[templateWithShell]}
        providers={[noKey, ready, local]}
        onSubmit={onSubmit}
        onClose={() => {}}
        {...rest}
      />,
    )
    await Promise.resolve()
  })
}

/**
 * 露出「供应商 / 模型 / 权限」那一块。
 *
 * 它们是实现层选择（不是「她是谁」），默认不摆在第一屏：
 * - 编辑模式：折叠成一入口行（advanced-toggle），点开即展开。
 * - 新建向导（P3）：整整第三步「模型与权限」，没有折叠开关——点两次「下一步」走到那步。
 * 两种形态走完后 #advanced-settings 都在 DOM 里可见，保存键也出现（向导末步才有保存）。
 */
function openAdvanced(): void {
  const toggle = container.querySelector<HTMLButtonElement>('button.advanced-toggle')
  if (toggle !== null) {
    if (toggle.getAttribute('aria-expanded') === 'true') return
    act(() => {
      toggle.click()
    })
    return
  }
  for (let round = 0; round < 2; round += 1) {
    const next = [...container.querySelectorAll<HTMLButtonElement>('.modal-actions button')].find((node) => {
      return node.textContent === '下一步'
    })
    if (next === undefined) return
    act(() => {
      next.click()
    })
  }
}

/**
 * 建 agent 表单里按字段名取下拉。
 *
 * 供应商 / 模型这两格此前是原生 `<select>`（按下标或标签取），换自绘下拉之后
 * 「当前值」不再是一个能直接读的 value 属性：得打开弹层看哪一项是选中态。
 */
function currentOf(label: string): string | undefined {
  return currentValue(container, label)
}

function providerOptions(): { value: string; text: string }[] {
  const popover = openSelect(container, '供应商')
  const rows = optionRows(popover).map((node) => {
    return { value: node.dataset.value ?? '', text: node.querySelector('.select-option-label')?.textContent ?? '' }
  })
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  return rows
}

function saveButton(): HTMLButtonElement {
  return [...container.querySelectorAll('.modal-actions button')].find((node) => {
    return node.textContent === '保存' || node.textContent === '保存修改'
  }) as HTMLButtonElement
}

/** 名字输入框。 */
function nameInput(): HTMLInputElement {
  const label = [...container.querySelectorAll('.field')].find((node) => {
    return node.querySelector('span')?.textContent === '名字'
  })
  const input = label?.querySelector('input')
  if (input === null || input === undefined) throw new Error('找不到名字输入框')
  return input
}

/** 往输入框里打字（React 受控组件要走原生 setter）。 */
function typeName(value: string): void {
  const input = nameInput()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('拿不到 input.value 的 setter')
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('重名', () => {
  it('名字跟已有 Agent 撞了就当场说清，并禁用保存键', async () => {
    await renderModal({
      agents: [
        { id: 'a1', name: 'Coder', isBuiltin: false } as AgentDef,
        { id: 'a2', name: '小译', isBuiltin: true } as AgentDef,
      ],
    })
    // 先让模型组合成立：保存键本来就因为「模型不属于当前供应商」而禁用，
    // 那样就分不清是重名拦的，还是模型拦的。
    openAdvanced()
    pickOption(container, '供应商', 'ollama')
    expect(saveButton().disabled).toBe(false)

    typeName('Coder')
    expect(container.textContent).toContain('已经有叫「Coder」')
    expect(saveButton().disabled).toBe(true)

    // 撞内置的也要说（内置助理的名字同样占着名）
    typeName('小译')
    expect(container.textContent).toContain('已经有叫「小译」')
    expect(saveButton().disabled).toBe(true)

    // 换个不撞的名字就能存
    typeName('小码农')
    expect(container.textContent).not.toContain('已经有叫')
    expect(saveButton().disabled).toBe(false)
  })

  it('编辑自己时不算撞名（改回原名照样能存）', async () => {
    await renderModal({
      editing: {
        id: 'a1',
        name: 'Coder',
        isBuiltin: false,
        provider: 'ollama',
        model: 'qwen2.5:7b',
        tools: [],
        systemPrompt: '',
      } as AgentDef,
      agents: [{ id: 'a1', name: 'Coder', isBuiltin: false } as AgentDef],
    })
    expect(container.textContent).not.toContain('已经有叫')
    expect(saveButton().disabled).toBe(false)
  })
})

describe('供应商与模型的绑定', () => {
  it('默认供应商是第一个配好凭据的，没配 key 的降权排后但仍可选', async () => {
    await renderModal()
    openAdvanced()
    expect(currentOf('供应商')).toBe('siliconflow')
    const rows = providerOptions()
    expect(
      rows.map((row) => {
        return row.value
      }),
    ).toEqual(['siliconflow', 'ollama', 'deepseek'])
    // 降权 ≠ 禁用：用户可以先建好 agent 再去补 key。
    const deepseek = rows.find((row) => {
      return row.value === 'deepseek'
    })!
    expect(deepseek.text).toContain('未配置 key')
    // 免 key 的本地服务另有说法，别让人去找一个不存在的 key。
    const ollama = rows.find((row) => {
      return row.value === 'ollama'
    })!
    expect(ollama.text).toContain('本地服务')
  })

  it('切换供应商时 model 跟着换成那家的第一个模型', async () => {
    const submitted: Record<string, unknown>[] = []
    await renderModal({
      onSubmit: (input: Record<string, unknown>) => {
        submitted.push(input)
        return Promise.resolve()
      },
    })
    openAdvanced()
    pickOption(container, '供应商', 'ollama')
    expect(currentOf('模型')).toBe('qwen2.5:7b')
    pickOption(container, '供应商', 'deepseek')
    expect(currentOf('模型')).toBe('deepseek-chat')

    await act(async () => {
      saveButton().click()
      await Promise.resolve()
    })
    expect(submitted).toHaveLength(1)
    expect(submitted[0]?.provider).toBe('deepseek')
    // 提交出去的 model 必须属于所选供应商，否则建出来的 agent 第一句就 404。
    expect(submitted[0]?.model).toBe('deepseek-chat')
  })

  it('model 不属于所选供应商：禁用保存并说清怎么改', async () => {
    const stale: AgentDef = {
      id: 'mine',
      name: '小译',
      systemPrompt: '你是翻译官。',
      provider: 'siliconflow',
      // 这家模型早已从供应商列表里下线（此前表单照收不误）。
      model: 'gpt-4o-mini',
      tools: [],
      isBuiltin: false,
    }
    const submitted: Record<string, unknown>[] = []
    await renderModal({
      editing: stale,
      templates: [],
      providers: [ready],
      onSubmit: (input: Record<string, unknown>) => {
        submitted.push(input)
        return Promise.resolve()
      },
    })
    // 报错不跟着修法一起缩进折叠区：折叠状态下也必须看得见「这个组合存不下来」。
    const hint = container.querySelector('.apikey-error')!
    expect(hint.getAttribute('role')).toBe('alert')
    expect(hint.textContent).toContain('当前模型不属于')
    expect(saveButton().disabled).toBe(true)
    expect(saveButton().title).toContain('当前模型不属于')
    await act(async () => {
      saveButton().click()
      await Promise.resolve()
    })
    expect(submitted).toEqual([])
    // 展开后换成一个合法模型即可保存（修法就在高级设置里）。
    openAdvanced()
    // 手上这个模型仍如实列在下拉里（而不是静默落到第一项），并标注它不属于当前供应商。
    expect(listedValues(container, '模型')).toContain('gpt-4o-mini')
    expect(triggerLabel(container, '模型')).toContain('不属于当前供应商')
    pickOption(container, '模型', 'deepseek-ai/DeepSeek-V3')
    expect(saveButton().disabled).toBe(false)
    await act(async () => {
      saveButton().click()
      await Promise.resolve()
    })
    expect(submitted[0]?.model).toBe('deepseek-ai/DeepSeek-V3')
  })

  it('供应商一个模型都没有时也禁用保存，并指向补模型的地方', async () => {
    await renderModal({ templates: [], providers: [{ ...ready, models: [] }] })
    // 模型校验与保存键都在向导末步（模型与权限），走到那一步再看。
    openAdvanced()
    expect(container.querySelector('.apikey-error')?.textContent).toContain('模型供应商')
    expect(saveButton().disabled).toBe(true)
  })
})

describe('执行命令默认不给', () => {
  /** 档位清单走服务端接口：stub fetch 只答这一条，其余请求一律算测试写错了。 */
  function stubPresets(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        expect(String(input)).toContain('/api/permission-presets')
        return new Response(JSON.stringify({ presets: PERMISSION_PRESETS }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
  }

  function presetRadio(name: string): HTMLInputElement {
    const label = [...container.querySelectorAll('input[name="permission-preset"]')]
      .map((input) => {
        return input.closest('label')
      })
      .find((node) => {
        return node?.textContent?.includes(name)
      })
    if (label === null || label === undefined) throw new Error(`找不到档位「${name}」`)
    return label.querySelector<HTMLInputElement>('input')!
  }

  function pickPreset(name: string): void {
    act(() => {
      presetRadio(name).click()
    })
  }

  it('权限只有几档分类，不再摆工具复选框；模板带的 shell_exec 新建时不给', async () => {
    stubPresets()
    await renderModal({ api: new ApiClient('http://binding.test') })
    openAdvanced()
    await act(async () => {
      await Promise.resolve()
    })
    // 模板默认 [fs_read, fs_write, shell_exec]，新建滤掉 shell_exec 后不属于任何
    // 一档：如实显示「自定义」，而不是硬报成某一档骗用户。
    expect(container.querySelectorAll('.tool-checks input[type="checkbox"]').length).toBe(0)
    expect(presetRadio('自定义').checked).toBe(true)
    expect(container.textContent).not.toContain('直接跑 shell')
  })

  it('选「全权」给一次风险说明，换回「工作区可写」就收回（告知，不做审批流）', async () => {
    stubPresets()
    await renderModal({ api: new ApiClient('http://binding.test') })
    openAdvanced()
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.textContent).not.toContain('直接跑 shell')
    pickPreset('全权')
    expect(container.textContent).toContain('直接跑 shell')
    expect(container.textContent).toContain('只在任务来源可信时给这一档')
    pickPreset('工作区可写')
    expect(container.textContent).not.toContain('直接跑 shell')
  })

  it('编辑既有 agent 时保留它原本的工具（不替用户偷偷取消），提交原样带回', async () => {
    stubPresets()
    const withShell: AgentDef = {
      id: 'coder',
      name: '小码',
      systemPrompt: '写代码',
      provider: 'siliconflow',
      model: 'deepseek-ai/DeepSeek-V3',
      tools: ['fs_read', 'shell_exec'],
      isBuiltin: false,
    }
    const submitted: Record<string, unknown>[] = []
    await renderModal({
      editing: withShell,
      templates: [],
      api: new ApiClient('http://binding.test'),
      onSubmit: (input) => {
        submitted.push(input)
        return Promise.resolve()
      },
    })
    openAdvanced()
    await act(async () => {
      await Promise.resolve()
    })
    // [fs_read, shell_exec] 不属于任何一档：显示「自定义」，风险说明照常给。
    expect(presetRadio('自定义').checked).toBe(true)
    expect(container.textContent).toContain('直接跑 shell')
    await act(async () => {
      saveButton().click()
      await Promise.resolve()
    })
    expect(submitted[0]?.tools).toEqual(['fs_read', 'shell_exec'])
  })
})
