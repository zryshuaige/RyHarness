// @vitest-environment jsdom
/**
 * 群聊可演进：会话行尾的「群设置」入口 + 群设置弹窗（改群名 / 加人退人 / 换调度员），
 * 以及行尾浮层的两个老毛病——末行被滚动容器裁掉、键盘够不着。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, Conversation } from '../renderer/src/api.ts'
import type { ConversationApi } from '../renderer/src/components/ConversationList.tsx'
import { ConversationList } from '../renderer/src/components/ConversationList.tsx'
import type { GroupFormInput } from '../renderer/src/components/GroupSettingsModal.tsx'
import { GroupSettingsModal } from '../renderer/src/components/GroupSettingsModal.tsx'
import { getToasts, toast } from '../renderer/src/lib/toast.ts'
import { currentValue, listedValues, pickOption, selectTrigger, triggerLabel } from './select-dom.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agents: AgentDef[] = [
  { id: 'ryen', name: 'Ryen', avatar: 'cat', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: true },
  {
    id: 'coder',
    name: '小码',
    systemPrompt: 'p',
    provider: 'siliconflow',
    model: 'deepseek-ai/DeepSeek-V3',
    tools: [],
    isBuiltin: false,
  },
  { id: 'writer', name: '小笔', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: false },
]

const groupConversation: Conversation = {
  id: 'g1',
  kind: 'group',
  title: '小队',
  memberAgentIds: ['ryen', 'coder'],
  dispatcherAgentId: 'ryen',
  lastReadSeq: 0,
  createdAt: 1,
  updatedAt: 2,
  lastMessagePreview: '那就周三',
}

const directConversation: Conversation = {
  id: 'c1',
  kind: 'direct',
  title: '小码',
  memberAgentIds: ['coder'],
  lastReadSeq: 0,
  createdAt: 1,
  updatedAt: 3,
  lastMessagePreview: '脚本写好了',
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
  for (const item of getToasts()) toast.dismiss(item.id)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function buttonByText(text: string, scope: ParentNode = container): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((node) => {
    return node.textContent?.trim() === text
  })
  if (found === undefined) throw new Error(`找不到按钮：${text}`)
  return found
}

function rect(box: Partial<DOMRect>): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
    ...box,
  } as DOMRect
}

describe('会话行尾：群设置入口', () => {
  async function renderList(extras: Record<string, unknown> = {}): Promise<void> {
    const api: ConversationApi = {}
    await act(async () => {
      root = createRoot(container)
      root.render(
        <ConversationList
          conversations={[groupConversation, directConversation]}
          agents={agents}
          activeId={undefined}
          api={api}
          onSelect={() => {}}
          {...extras}
        />,
      )
      await Promise.resolve()
    })
  }

  function openMenu(index: number): void {
    const row = container.querySelectorAll<HTMLElement>('.conversation-item')[index]!
    act(() => {
      row.querySelector<HTMLButtonElement>('.conversation-more')!.click()
    })
  }

  it('群聊那一行才有「群设置」，点它把这条群交给宿主', async () => {
    const edited: Conversation[] = []
    await renderList({
      onEditGroup: (conversation: Conversation) => {
        edited.push(conversation)
      },
    })
    // 会话按服务端顺序排（未置顶），第一行是群聊。
    openMenu(0)
    expect(buttonByText('群设置', container).textContent).toBe('群设置')
    act(() => {
      buttonByText('群设置', container).click()
    })
    expect(
      edited.map((c) => {
        return c.id
      }),
    ).toEqual(['g1'])
    // 打开设置后菜单收起：两层浮层叠在一起只会互相遮挡。
    expect(container.querySelector('.conversation-item-menu')).toBeNull()
  })

  it('单聊那一行没有「群设置」（没有成员可改，也就没有假入口）', async () => {
    await renderList({
      onEditGroup: () => {},
    })
    openMenu(1)
    expect(container.querySelector('.conversation-item-menu')?.textContent).not.toContain('群设置')
  })

  it('宿主没接 onEditGroup 时整项不渲染', async () => {
    await renderList()
    openMenu(0)
    expect(container.querySelector('.conversation-item-menu')?.textContent).not.toContain('群设置')
  })

  it('末行的浮层翻到行上方，不被滚动容器裁掉', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('conversation-item-menu')) return rect({ height: 40 })
      // 最后一行：下沿已经越过滚动容器的可视下沿。
      if (this.classList.contains('conversation-item')) return rect({ bottom: 640, top: 576, height: 64 })
      if (this.classList.contains('conversation-list')) return rect({ bottom: 600, top: 80 })
      return rect({})
    })
    await renderList()
    openMenu(0)
    const menu = container.querySelector<HTMLElement>('.conversation-item-menu')!
    // 翻上去只改位置：外观仍然交给样式表（内联优先级高，写死底色就再也点不亮了）。
    expect(menu.style.top).toBe('auto')
    expect(menu.style.bottom).toBe('calc(100% + 8px)')
    expect(menu.style.background).toBe('')
    expect(menu.style.zIndex).toBe('')
  })

  it('空间够时仍挂在行下方（不无脑翻转）', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('conversation-item-menu')) return rect({ height: 40 })
      if (this.classList.contains('conversation-item')) return rect({ bottom: 400, top: 336, height: 64 })
      if (this.classList.contains('conversation-list')) return rect({ bottom: 600, top: 80 })
      return rect({})
    })
    await renderList()
    openMenu(0)
    expect(container.querySelector<HTMLElement>('.conversation-item-menu')?.getAttribute('style')).toBeNull()
  })

  it('键盘可达：↓ 打开并落在第一项，↑↓ 走位，Esc 收起并把焦点还给「⋯」', async () => {
    await renderList()
    const row = container.querySelectorAll<HTMLElement>('.conversation-item')[0]!
    const trigger = row.querySelector<HTMLButtonElement>('.conversation-more')!
    act(() => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    const items = () => [...container.querySelectorAll<HTMLButtonElement>('.conversation-item-menu button')]
    expect(items().length).toBe(3)
    expect(document.activeElement).toBe(items()[0])
    // ↓ 走到第二项
    act(() => {
      items()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.activeElement).toBe(items()[1])
    // ↑ 走回第一项
    act(() => {
      items()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    })
    expect(document.activeElement).toBe(items()[0])
    // Esc：收起，焦点回到触发它的「⋯」
    act(() => {
      items()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('.conversation-item-menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('点浮层之外收起', async () => {
    await renderList()
    openMenu(0)
    expect(container.querySelector('.conversation-item-menu')).not.toBeNull()
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(container.querySelector('.conversation-item-menu')).toBeNull()
  })
})

describe('群设置弹窗：改群名 / 加人退人 / 换调度员', () => {
  let submitted: GroupFormInput | undefined

  async function renderModal(conversation: Conversation = groupConversation): Promise<void> {
    submitted = undefined
    await act(async () => {
      root = createRoot(container)
      root.render(
        <GroupSettingsModal
          mode="settings"
          agents={agents}
          conversation={conversation}
          onSubmit={(input) => {
            submitted = input
            return Promise.resolve()
          }}
          onClose={() => {}}
        />,
      )
      await Promise.resolve()
    })
  }

  /**
   * 建群模式：调度员那一格是可改的（改既有群时服务端还不落这个字段，那一格是锁着的，
   * 见下面「编辑既有群时调度员下拉锁住」）。要测"换调度员"必须走这一条路。
   */
  async function renderCreate(): Promise<void> {
    submitted = undefined
    await act(async () => {
      root = createRoot(container)
      root.render(
        <GroupSettingsModal
          mode="create"
          agents={agents}
          onSubmit={(input) => {
            submitted = input
            return Promise.resolve()
          }}
          onClose={() => {}}
        />,
      )
      await Promise.resolve()
    })
  }

  function checkbox(id: string): HTMLInputElement {
    const labels = [...container.querySelectorAll<HTMLElement>('.member-checks label')]
    const row = labels.find((label) => {
      return label.textContent?.includes(
        agents.find((a) => {
          return a.id === id
        })?.name ?? id,
      )
    })
    return row!.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  }
  /** 调度员那一格的下拉触发器（自绘下拉，不再是原生 `<select>`）。 */
  function dispatcherSelect(): HTMLButtonElement {
    return selectTrigger(container, '调度员')
  }
  function nameInput(): HTMLInputElement {
    return container.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')!
  }

  it('打开就是群的真值：群名、成员、调度员', async () => {
    await renderModal()
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('群设置')
    expect(nameInput().value).toBe('小队')
    expect(checkbox('ryen').checked).toBe(true)
    expect(checkbox('coder').checked).toBe(true)
    expect(checkbox('writer').checked).toBe(false)
    expect(triggerLabel(container, '调度员')).toBe('Ryen')
  })

  it('改名 + 加人一次提交出去', async () => {
    await renderModal()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(nameInput(), '三个人小分队')
      nameInput().dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      checkbox('writer').click()
    })
    await act(async () => {
      buttonByText('保存修改').click()
      await Promise.resolve()
    })
    expect(submitted).toEqual({
      title: '三个人小分队',
      memberAgentIds: ['ryen', 'coder', 'writer'],
      dispatcherAgentId: 'ryen',
    })
  })

  it('换调度员：下拉里只有已勾选的成员，换完提交新调度员', async () => {
    await renderCreate()
    act(() => {
      checkbox('coder').click()
    })
    expect(listedValues(container, '调度员')).toEqual(['ryen', 'coder'])
    pickOption(container, '调度员', 'coder')
    expect(triggerLabel(container, '调度员')).toBe('小码')
    await act(async () => {
      buttonByText('创建').click()
      await Promise.resolve()
    })
    expect(submitted?.dispatcherAgentId).toBe('coder')
  })

  it('退掉当前调度员后，候选里不再有这一位，调度员同步落到剩下的第一位', async () => {
    await renderCreate()
    act(() => {
      checkbox('coder').click()
    })
    expect(currentValue(container, '调度员')).toBe('ryen')
    act(() => {
      checkbox('ryen').click()
    })
    // 少了这一步，下拉里就没有当前值了：触发器只能显示兜底文案（值还在时是那个原始
    // id），state 还指着被摘掉的那个，提交上去的 dispatcherAgentId 不在成员名单里。
    expect(listedValues(container, '调度员')).toEqual(['coder'])
    expect(triggerLabel(container, '调度员')).toBe('小码')
    expect(currentValue(container, '调度员')).toBe('coder')
  })

  it('一个成员都不勾时那一格锁住，并写明为什么（不是留一个点不动的空框）', async () => {
    await renderCreate()
    act(() => {
      checkbox('ryen').click()
    })
    expect(dispatcherSelect().disabled).toBe(true)
    expect(triggerLabel(container, '调度员')).toBe('先勾选成员')
  })

  it('退人：不是调度员的可以直接勾掉', async () => {
    await renderModal()
    act(() => {
      checkbox('coder').click()
    })
    expect(checkbox('coder').checked).toBe(false)
    await act(async () => {
      buttonByText('保存修改').click()
      await Promise.resolve()
    })
    expect(submitted?.memberAgentIds).toEqual(['ryen'])
  })

  it('当前调度员不能直接退群：说清真实原因，而不是让人白等一次 400', async () => {
    await renderModal()
    act(() => {
      checkbox('ryen').click()
    })
    // 服务端会以 `dispatcher "ryen" must be one of memberAgentIds` 拒掉这次 PATCH，
    // 而且它认的是**记录里**那位调度员，与这里下拉选谁无关。
    expect(checkbox('ryen').checked).toBe(true)
    // 这是信息性说明（不是红色错误）：红条只留给真的挡住保存的问题。
    // 文案只说结论，不解释「服务端字段还没上线」——那是实现，不是用户的事。
    const note = container.querySelector('.provider-note')?.textContent ?? ''
    expect(note).toContain('现在是调度员')
    expect(note).toContain('不能退出这个群')
    expect(note).not.toContain('服务端')
  })

  it('成员行的副行走人话口径：模型与供应商，不摆 systemPrompt 原文', async () => {
    await renderModal()
    // providerLabel + modelPair：厂商路径前缀（deepseek-ai/）摘掉，供应商说品牌名。
    expect(container.textContent).toContain('DeepSeek-V3 · SiliconFlow')
    expect(container.textContent).not.toContain('deepseek-ai')
    // 系统提示词是英文提示词，截断上屏只剩半句没头没尾的话。
    expect(container.textContent).not.toContain('siliconflow · p')
  })

  it('编辑既有群时调度员下拉锁住，并写明「暂不支持修改」', async () => {
    await renderModal()
    // 服务端还不落这个字段：直接禁用，别让用户先选一遍再在保存时发现没生效。
    expect(dispatcherSelect().disabled).toBe(true)
    expect(container.textContent).toContain('已有群的调度员暂不支持修改')
    await act(async () => {
      buttonByText('保存修改').click()
      await Promise.resolve()
    })
    expect(submitted).toEqual({ title: '小队', memberAgentIds: ['ryen', 'coder'], dispatcherAgentId: 'ryen' })
  })

  it('保存失败留在原地并说清原因（不假装改好了）', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <GroupSettingsModal
          mode="settings"
          agents={agents}
          conversation={groupConversation}
          onSubmit={() => {
            return Promise.reject(new Error('HTTP 400'))
          }}
          onClose={() => {}}
        />,
      )
      await Promise.resolve()
    })
    await act(async () => {
      buttonByText('保存修改').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    // 兜底句说的是用户当时在做什么；`HTTP 400` 这种原话不上屏。
    expect(
      getToasts().some((item) => {
        return item.text.includes('保存群设置失败：') && item.text.includes('再试一次')
      }),
    ).toBe(true)
    expect(
      getToasts().some((item) => {
        return item.text.includes('HTTP 400')
      }),
    ).toBe(false)
  })
})
