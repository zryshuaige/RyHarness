// @vitest-environment jsdom
/**
 * 通讯录 P3 的两个交互：列表/卡片双视图（选择记住）与建 Agent 三步向导。
 *
 * 静态渲染（contacts.test.tsx）只能看结构；这里的断言都要求「点一下之后」才成立：
 * 默认视图是哪一个、切换是否持久化、下一步是否真的换屏、提交是否只在最后一步发生。
 */
import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, AgentTemplate, ProviderInfo } from '../renderer/src/api.ts'
import { ContactsPage, CreateAgentModal } from '../renderer/src/components/ContactsPage.tsx'
import { TEST_PERSONA } from './fixtures.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const templates: AgentTemplate[] = [
  {
    key: 'general',
    name: '通用助理',
    description: '什么都能聊',
    suggestedSystemPrompt: '你是通用助理。',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    persona: TEST_PERSONA,
    defaultTools: ['fs_read'],
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

const agents: AgentDef[] = [
  {
    id: 'ryen',
    name: 'Ryen',
    avatar: 'cat',
    systemPrompt: '你是 Ryen。',
    provider: 'siliconflow',
    model: 'deepseek-ai/DeepSeek-V3',
    tools: [],
    isBuiltin: true,
  },
  {
    id: 'mine',
    name: '小译',
    avatar: 'db:dylan:seed1',
    systemPrompt: '你是翻译官。',
    provider: 'siliconflow',
    model: 'deepseek-ai/DeepSeek-V3',
    tools: ['fs_read'],
    isBuiltin: false,
  },
]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  localStorage.clear()
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
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function render(node: ReactNode): void {
  act(() => {
    root = createRoot(container)
    root.render(node)
  })
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((node) => {
    return node.textContent?.trim() === text
  })
  if (found === undefined) throw new Error(`找不到按钮：${text}`)
  return found
}

function click(text: string): void {
  const node = buttonByText(text)
  act(() => {
    node.click()
  })
}

function page(): ReactElement {
  return (
    <ContactsPage
      agents={agents}
      templates={templates}
      onChat={() => {}}
      onCreateAgent={() => {}}
      onEditAgent={() => {}}
      onDeleteAgent={() => {}}
      onCreateGroup={() => {}}
    />
  )
}

describe('通讯录双视图', () => {
  it('默认列表；点「卡片」切到卡片网格并把选择记到本机偏好', () => {
    render(page())
    expect(container.querySelector('.contact-list')).not.toBeNull()
    expect(container.querySelector('.contact-grid')).toBeNull()

    click('卡片')
    expect(container.querySelector('.contact-grid')).not.toBeNull()
    expect(container.querySelector('.contact-list')).toBeNull()
    expect(localStorage.getItem('ryharness-contacts-view')).toBe('card')

    click('列表')
    expect(container.querySelector('.contact-list')).not.toBeNull()
    expect(localStorage.getItem('ryharness-contacts-view')).toBe('list')
  })

  it('记住的卡片视图下次打开直接生效', () => {
    localStorage.setItem('ryharness-contacts-view', 'card')
    render(page())
    expect(container.querySelector('.contact-grid')).not.toBeNull()
    expect(container.querySelector('.contact-list')).toBeNull()
  })

  it('两种视图的每一行/每一卡都带身份环与开聊入口（拉平链接按钮）', () => {
    render(page())
    expect(container.querySelectorAll('.contact-row .contact-hit').length).toBe(agents.length)
    click('卡片')
    expect(container.querySelectorAll('.contact-card .contact-hit').length).toBe(agents.length)
  })
})

describe('建 Agent 三步向导', () => {
  function modal(onSubmit: (input: Record<string, unknown>) => Promise<void> = () => Promise.resolve()): ReactElement {
    return <CreateAgentModal templates={templates} providers={providers} onSubmit={onSubmit} onClose={() => {}} />
  }

  function panel(index: number): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-step="${index}"]`)
  }

  it('下一步/上一步切换面板：第一步只露起点，最后一步才是保存', () => {
    render(modal())
    expect(panel(0)?.hasAttribute('hidden')).toBe(false)
    expect(panel(1)?.hasAttribute('hidden')).toBe(true)
    expect(panel(2)?.hasAttribute('hidden')).toBe(true)
    expect(buttonByText('下一步')).toBeDefined()

    click('下一步')
    expect(panel(0)?.hasAttribute('hidden')).toBe(true)
    expect(panel(1)?.hasAttribute('hidden')).toBe(false)
    expect(panel(1)?.textContent).toContain('它是谁')

    click('下一步')
    expect(panel(2)?.hasAttribute('hidden')).toBe(false)
    expect(panel(2)?.textContent).toContain('供应商')

    click('上一步')
    expect(panel(1)?.hasAttribute('hidden')).toBe(false)
  })

  it('步骤条：未到的步骤禁用；已完成的可点回去改', () => {
    render(modal())
    const stepButton = (label: string): HTMLButtonElement => {
      // 步骤按钮的 textContent 还包含序号圆点（2人设），按 label 子元素精确找。
      const found = [...container.querySelectorAll<HTMLButtonElement>('.wizard-step')].find((node) => {
        return node.querySelector('.wizard-step-label')?.textContent === label
      })
      if (found === undefined) throw new Error(`找不到步骤：${label}`)
      return found
    }
    // 第一步时，后两步不可点
    expect(stepButton('人设').disabled).toBe(true)
    expect(stepButton('模型与权限').disabled).toBe(true)

    click('下一步')
    click('下一步')
    // 回到起点：已完成步骤可点
    click('起点')
    expect(panel(0)?.hasAttribute('hidden')).toBe(false)
    expect(panel(2)?.hasAttribute('hidden')).toBe(true)
  })

  it('提交只发生在最后一步：中途「下一步」不触发 onSubmit', async () => {
    const onSubmit = vi.fn((_input: Record<string, unknown>) => Promise.resolve())
    render(modal(onSubmit))
    click('下一步')
    click('下一步')
    expect(onSubmit).not.toHaveBeenCalled()

    click('保存')
    await act(async () => {
      await Promise.resolve()
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      templateKey: 'general',
      provider: 'siliconflow',
      model: 'deepseek-ai/DeepSeek-V3',
    })
  })
})
