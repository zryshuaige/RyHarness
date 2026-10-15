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

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agents: AgentDef[] = [
  { id: 'ryen', name: 'Ryen', avatar: 'cat', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: true },
  { id: 'coder', name: '小码', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: false },
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
  function dispatcherSelect(): HTMLSelectElement {
    return container.querySelector<HTMLSelectElement>('select')!
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
    expect(dispatcherSelect().value).toBe('ryen')
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
    await renderModal()
    expect(
      [...dispatcherSelect().options].map((option) => {
        return option.value
      }),
    ).toEqual(['ryen', 'coder'])
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(dispatcherSelect(), 'coder')
      dispatcherSelect().dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      buttonByText('保存修改').click()
      await Promise.resolve()
    })
    expect(submitted?.dispatcherAgentId).toBe('coder')
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
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('当前的调度员')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('服务端要求调度员始终在成员名单里')
  })

  it('换调度员：这格能选，但当场说清服务端还不落这个字段（不假装保存就生效）', async () => {
    await renderModal()
    expect(container.textContent).not.toContain('服务端目前还不支持改已有群的调度员')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(dispatcherSelect(), 'coder')
      dispatcherSelect().dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('服务端目前还不支持改已有群的调度员')
    // 换了调度员之后，记录里那位（Ryen）依然退不出去——服务端认的是记录里那位。
    act(() => {
      checkbox('ryen').click()
    })
    expect(checkbox('ryen').checked).toBe(true)
    // 但请求照发：新调度员随保存一起过去，服务端字段一落地就生效。
    await act(async () => {
      buttonByText('保存修改').click()
      await Promise.resolve()
    })
    expect(submitted).toEqual({ title: '小队', memberAgentIds: ['ryen', 'coder'], dispatcherAgentId: 'coder' })
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
    expect(
      getToasts().some((item) => {
        return item.text.includes('保存群设置失败') && item.text.includes('HTTP 400')
      }),
    ).toBe(true)
  })
})
