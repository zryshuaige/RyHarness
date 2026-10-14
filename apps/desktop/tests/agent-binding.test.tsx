// @vitest-environment jsdom
/**
 * Agent 编辑页的供应商/模型绑定：默认供应商、切换供应商连 model 一起换、
 * 提交前的 model ∈ models 断言，以及「执行命令」不再是默认勾选项。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, AgentTemplate, ProviderInfo } from '../renderer/src/api.ts'
import { CreateAgentModal } from '../renderer/src/components/ContactsPage.tsx'

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

/** 选一个 <select> 的值：原生 setter + change 事件（React 受控组件标准打法）。 */
function selectOption(node: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  act(() => {
    setter.call(node, value)
    node.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function clickCheckbox(toolLabel: string): void {
  const label = [...container.querySelectorAll('.tool-checks label')].find((node) => {
    return node.textContent?.includes(toolLabel)
  })!
  act(() => {
    label.querySelector<HTMLInputElement>('input')!.click()
  })
}

function selectByLabel(label: string): HTMLSelectElement {
  const field = [...container.querySelectorAll('label.field')].find((node) => {
    return node.querySelector('span')?.textContent === label
  })!
  return field.querySelector('select')!
}

function saveButton(): HTMLButtonElement {
  return [...container.querySelectorAll('.modal-actions button')].find((node) => {
    return node.textContent === '保存' || node.textContent === '保存修改'
  }) as HTMLButtonElement
}

describe('供应商与模型的绑定', () => {
  it('默认供应商是第一个配好凭据的，没配 key 的降权排后但仍可选', async () => {
    await renderModal()
    const provider = selectByLabel('供应商')
    expect(provider.value).toBe('siliconflow')
    expect(
      [...provider.options].map((option) => {
        return option.value
      }),
    ).toEqual(['siliconflow', 'ollama', 'deepseek'])
    // 降权 ≠ 禁用：用户可以先建好 agent 再去补 key。
    const deepseek = [...provider.options].find((option) => {
      return option.value === 'deepseek'
    })!
    expect(deepseek.disabled).toBe(false)
    expect(deepseek.textContent).toContain('未配置 key')
    // 免 key 的本地服务另有说法，别让人去找一个不存在的 key。
    const ollama = [...provider.options].find((option) => {
      return option.value === 'ollama'
    })!
    expect(ollama.textContent).toContain('本地服务')
  })

  it('切换供应商时 model 跟着换成那家的第一个模型', async () => {
    const submitted: Record<string, unknown>[] = []
    await renderModal({
      onSubmit: (input: Record<string, unknown>) => {
        submitted.push(input)
        return Promise.resolve()
      },
    })
    selectOption(selectByLabel('供应商'), 'ollama')
    expect(selectByLabel('模型').value).toBe('qwen2.5:7b')
    selectOption(selectByLabel('供应商'), 'deepseek')
    expect(selectByLabel('模型').value).toBe('deepseek-chat')

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
    // 换成一个合法模型即可保存。
    selectOption(selectByLabel('模型'), 'deepseek-ai/DeepSeek-V3')
    expect(saveButton().disabled).toBe(false)
    await act(async () => {
      saveButton().click()
      await Promise.resolve()
    })
    expect(submitted[0]?.model).toBe('deepseek-ai/DeepSeek-V3')
  })

  it('供应商一个模型都没有时也禁用保存，并指向补模型的地方', async () => {
    await renderModal({ templates: [], providers: [{ ...ready, models: [] }] })
    expect(container.querySelector('.apikey-error')?.textContent).toContain('模型供应商')
    expect(saveButton().disabled).toBe(true)
  })
})

describe('执行命令默认不勾选', () => {
  it('模板默认带的 shell_exec 在新建时是未勾选', async () => {
    await renderModal()
    const label = [...container.querySelectorAll('.tool-checks label')].find((node) => {
      return node.textContent?.includes('执行命令')
    })!
    expect(label.querySelector<HTMLInputElement>('input')!.checked).toBe(false)
    // 其余工具照旧默认勾上。
    const readLabel = [...container.querySelectorAll('.tool-checks label')].find((node) => {
      return node.textContent?.includes('读文件')
    })!
    expect(readLabel.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
  })

  it('勾上后给一次风险说明（告知，不做审批流）', async () => {
    await renderModal()
    expect(container.textContent).not.toContain('直接跑 shell')
    clickCheckbox('执行命令')
    expect(container.textContent).toContain('直接跑 shell')
    expect(container.textContent).toContain('只在任务来源可信时勾选')
    clickCheckbox('执行命令')
    expect(container.textContent).not.toContain('直接跑 shell')
  })

  it('编辑既有 agent 时保留它原本勾着的工具（不替用户偷偷取消）', async () => {
    const withShell: AgentDef = {
      id: 'coder',
      name: '小码',
      systemPrompt: '写代码',
      provider: 'siliconflow',
      model: 'deepseek-ai/DeepSeek-V3',
      tools: ['fs_read', 'shell_exec'],
      isBuiltin: false,
    }
    await renderModal({ editing: withShell, templates: [] })
    const label = [...container.querySelectorAll('.tool-checks label')].find((node) => {
      return node.textContent?.includes('执行命令')
    })!
    expect(label.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
    // 仍然要给正在勾着的人看风险说明。
    expect(container.textContent).toContain('直接跑 shell')
  })
})
