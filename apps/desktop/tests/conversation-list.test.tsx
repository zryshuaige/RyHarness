// @vitest-environment jsdom
/**
 * 会话列表：全文搜索（按会话分组 + 跳转定位）与行尾的置顶 / 静音 / 删除。
 * api 全 mock，钉住请求形状与降级路径。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, Conversation, ConversationPatch, SearchResultRow } from '../renderer/src/api.ts'
import type { ConversationApi } from '../renderer/src/components/ConversationList.tsx'
import { ConversationList } from '../renderer/src/components/ConversationList.tsx'
import { getToasts, toast } from '../renderer/src/lib/toast.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agents: AgentDef[] = [
  { id: 'ryen', name: 'Ryen', avatar: 'cat', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: true },
  { id: 'coder', name: '小码', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: false },
]

const conversations: Conversation[] = [
  {
    id: 'c1',
    kind: 'direct',
    title: '周报',
    memberAgentIds: ['ryen'],
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 2,
    lastMessagePreview: '把周报整理好了',
  },
  {
    id: 'c2',
    kind: 'direct',
    title: '小码',
    memberAgentIds: ['coder'],
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 3,
    lastMessagePreview: '脚本写好了',
    unreadCount: 2,
  },
]

const hits: SearchResultRow[] = [
  {
    conversationId: 'c1',
    conversationTitle: '周报',
    messageId: 'm1',
    snippet: '周报里的第三点…',
    agentId: 'ryen',
    createdAt: 100,
  },
  {
    conversationId: 'c1',
    conversationTitle: '周报',
    messageId: 'm2',
    snippet: '再补一条周报结论',
    agentId: 'ryen',
    createdAt: 200,
  },
  {
    conversationId: 'c2',
    conversationTitle: '小码',
    messageId: 'm3',
    snippet: '这个脚本在周报里提到过',
    agentId: 'coder',
    createdAt: 300,
  },
]

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
  vi.unstubAllGlobals()
})

interface Recorded {
  queries: string[]
  patches: Array<[string, ConversationPatch]>
  deleted: string[]
  changed: number
}

function fakeApi(search: (q: string) => Promise<{ results: SearchResultRow[] }>): {
  api: ConversationApi
  recorded: Recorded
} {
  const recorded: Recorded = { queries: [], patches: [], deleted: [], changed: 0 }
  return {
    recorded,
    api: {
      searchMessages: (params: { q: string }) => {
        recorded.queries.push(params.q)
        return search(params.q)
      },
      patchConversation: (id: string, patch: ConversationPatch) => {
        recorded.patches.push([id, patch])
        return Promise.resolve({ conversation: undefined })
      },
      deleteConversation: (id: string) => {
        recorded.deleted.push(id)
        return Promise.resolve({ deleted: id })
      },
    },
  }
}

async function renderList(api: ConversationApi | undefined, extras: Record<string, unknown> = {}): Promise<Recorded> {
  let changed = 0
  await act(async () => {
    root = createRoot(container)
    root.render(
      <ConversationList
        conversations={conversations}
        agents={agents}
        activeId="c1"
        api={api}
        onSelect={() => {}}
        onChanged={() => {
          changed += 1
        }}
        {...extras}
      />,
    )
    await Promise.resolve()
  })
  return { queries: [], patches: [], deleted: [], changed } as Recorded & { changed: number }
}

function typeQuery(value: string): void {
  const input = container.querySelector<HTMLInputElement>('.search-box')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 搜索是防抖的：推进定时器让请求真的发出去，再等它落地。 */
async function settleSearch(ms = 300): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
    await Promise.resolve()
  })
}

function buttonByText(text: string, scope: ParentNode = container): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((node) => {
    return node.textContent?.trim() === text
  })
  if (found === undefined) throw new Error(`找不到按钮：${text}`)
  return found
}

/** 展开第 index 行的行尾菜单。 */
function openMenu(index = 0): void {
  const row = container.querySelectorAll<HTMLElement>('.conversation-item')[index]!
  act(() => {
    row.querySelector<HTMLButtonElement>('.conversation-more')!.click()
  })
}

describe('全文搜索', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('搜的是消息正文：结果按会话分组并展示片段', async () => {
    const { api, recorded } = fakeApi(() => {
      return Promise.resolve({ results: hits })
    })
    await renderList(api)
    typeQuery('周报')
    // 防抖窗口内先不打扰服务端。
    expect(recorded.queries).toEqual([])
    await settleSearch()
    expect(recorded.queries).toEqual(['周报'])

    const groups = [...container.querySelectorAll('.search-group')]
    expect(groups).toHaveLength(2)
    expect(groups[0]?.querySelector('.search-group-title')?.textContent).toBe('周报')
    expect(groups[0]?.querySelectorAll('.search-hit')).toHaveLength(2)
    expect(groups[1]?.querySelectorAll('.search-hit')).toHaveLength(1)
    expect(container.textContent).toContain('这个脚本在周报里提到过')
    expect(container.textContent).toContain('3 条消息命中')
  })

  it('点命中：切到该会话 + 定位那条消息', async () => {
    const { api } = fakeApi(() => {
      return Promise.resolve({ results: hits })
    })
    const selected: string[] = []
    const jumped: Array<[string, string]> = []
    const target = document.createElement('div')
    target.setAttribute('data-message-id', 'm3')
    const scrollIntoView = vi.fn()
    target.scrollIntoView = scrollIntoView
    document.body.appendChild(target)
    const events: string[] = []
    const listener = (): void => {
      events.push('jump')
    }
    window.addEventListener('ryagent:scroll-to-message', listener)

    await renderList(api, {
      onSelect: (id: string) => {
        selected.push(id)
      },
      onJumpToMessage: (conversationId: string, messageId: string) => {
        jumped.push([conversationId, messageId])
      },
    })
    typeQuery('周报')
    await settleSearch()
    act(() => {
      container.querySelectorAll<HTMLButtonElement>('.search-hit')[2]!.click()
    })
    expect(selected).toEqual(['c2'])
    expect(jumped).toEqual([['c2', 'm3']])
    // 聊天区可能正在加载历史，所以定位要重试几次；命中就滚过去并高亮。
    await act(async () => {
      vi.advanceTimersByTime(1000)
      await Promise.resolve()
    })
    expect(scrollIntoView).toHaveBeenCalled()
    expect(target.classList.contains('is-search-hit')).toBe(true)
    expect(events).toEqual(['jump'])
    window.removeEventListener('ryagent:scroll-to-message', listener)
    target.remove()
  })

  it('搜不到时给的是「没有命中的消息」，不是空列表', async () => {
    const { api } = fakeApi(() => {
      return Promise.resolve({ results: [] })
    })
    await renderList(api)
    typeQuery('不存在的东西')
    await settleSearch()
    expect(container.querySelector('.empty-state')?.textContent).toContain('没有命中的消息')
  })

  it('没有搜索接口时降级回按会话名过滤，并说清降级原因', async () => {
    const { api } = fakeApi(() => {
      return Promise.resolve({ results: [] })
    })
    await renderList({
      // 只有 patchConversation、没有 searchMessages：搜索降级、会话行照常可用。
      patchConversation: () => {
        return Promise.resolve({ conversation: undefined })
      },
    })
    typeQuery('周报')
    await settleSearch()
    expect(container.textContent).toContain('全文搜索暂不可用')
    // 会话名命中照样能点。
    const row = container.querySelector<HTMLButtonElement>('.conversation-item-main')!
    expect(row.textContent).toContain('把周报整理好了')
    expect(container.querySelectorAll('.conversation-item')).toHaveLength(1)
  })

  it('接口报错时也降级，不把错误抛给用户', async () => {
    const { api } = fakeApi(() => {
      return Promise.reject(new Error('HTTP 404'))
    })
    await renderList(api)
    typeQuery('周报')
    await settleSearch()
    expect(container.textContent).toContain('全文搜索暂不可用')
  })
})

describe('会话行尾操作', () => {
  it('置顶：发 PATCH 并把这条排到最前', async () => {
    const { api, recorded } = fakeApi(() => {
      return Promise.resolve({ results: [] })
    })
    let changed = 0
    await act(async () => {
      root = createRoot(container)
      root.render(
        <ConversationList
          conversations={conversations}
          agents={agents}
          activeId={undefined}
          api={api}
          onSelect={() => {}}
          onChanged={() => {
            changed += 1
          }}
        />,
      )
      await Promise.resolve()
    })
    await openMenu(1)
    await act(async () => {
      buttonByText('置顶', container.querySelectorAll('.conversation-item')[1]!).click()
      await Promise.resolve()
    })
    expect(recorded.patches).toEqual([['c2', { pinned: true }]])
    expect(changed).toBe(1)
    // 界面立刻反映：置顶的那条排到了第一位。
    const titles = [...container.querySelectorAll('.conversation-item strong')].map((node) => {
      return node.textContent
    })
    expect(titles[0]).toContain('小码')
    expect(titles[0]).toContain('置顶')
    // 再点一次是取消（操作面板还开着，不用重新展开）。
    await act(async () => {
      buttonByText('取消置顶', container).click()
      await Promise.resolve()
    })
    expect(recorded.patches[1]).toEqual(['c2', { pinned: false }])
  })

  it('静音：发 PATCH，且未读徽标让位给「已静音」', async () => {
    const { api, recorded } = fakeApi(() => {
      return Promise.resolve({ results: [] })
    })
    await renderList(api)
    expect(container.textContent).toContain('2')
    await openMenu(1)
    await act(async () => {
      buttonByText('静音', container.querySelectorAll('.conversation-item')[1]!).click()
      await Promise.resolve()
    })
    expect(recorded.patches).toEqual([['c2', { muted: true }]])
    expect(container.textContent).toContain('已静音')
    expect(container.querySelector('.unread-badge')).toBeNull()
  })

  it('置顶失败会回滚本地状态并说明原因', async () => {
    const api: ConversationApi = {
      patchConversation: () => {
        return Promise.reject(new Error('HTTP 404'))
      },
    }
    await renderList(api)
    await openMenu(1)
    await act(async () => {
      buttonByText('置顶', container.querySelectorAll('.conversation-item')[1]!).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(
      getToasts()
        .map((item) => {
          return item.text
        })
        .join(),
    ).toContain('操作失败')
    const titles = [...container.querySelectorAll('.conversation-item strong')].map((node) => {
      return node.textContent
    })
    expect(titles[0]).toContain('周报')
    // 回滚只该动「置顶」这一项，不能顺手把这条静音了。
    expect(container.textContent).not.toContain('已静音')
  })

  it('删除：确认弹窗里才发 DELETE，删完这行消失', async () => {
    const { api, recorded } = fakeApi(() => {
      return Promise.resolve({ results: [] })
    })
    let changed = 0
    await act(async () => {
      root = createRoot(container)
      root.render(
        <ConversationList
          conversations={conversations}
          agents={agents}
          activeId="c1"
          api={api}
          onSelect={() => {}}
          onChanged={() => {
            changed += 1
          }}
        />,
      )
      await Promise.resolve()
    })
    await openMenu(0)
    act(() => {
      buttonByText('删除', container.querySelectorAll('.conversation-item')[0]!).click()
    })
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('删除「周报」')
    expect(recorded.deleted).toEqual([])
    await act(async () => {
      buttonByText('确认删除', dialog).click()
      await Promise.resolve()
    })
    expect(recorded.deleted).toEqual(['c1'])
    expect(changed).toBe(1)
    expect(container.querySelectorAll('.conversation-item')).toHaveLength(1)
    expect(container.textContent).not.toContain('把周报整理好了')
  })

  it('删除失败留在原地并说明（不假装删掉了）', async () => {
    const api: ConversationApi = {
      deleteConversation: () => {
        return Promise.reject(new Error('数据库忙'))
      },
    }
    await renderList(api)
    await openMenu(0)
    act(() => {
      buttonByText('删除', container.querySelectorAll('.conversation-item')[0]!).click()
    })
    await act(async () => {
      buttonByText('确认删除', container.querySelector('[role="dialog"]')!).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelectorAll('.conversation-item')).toHaveLength(2)
    expect(
      getToasts().some((item) => {
        return item.text.includes('删除失败') && item.text.includes('数据库忙')
      }),
    ).toBe(true)
  })

  it('服务端不支持置顶时说明原因，而不是静默没反应', async () => {
    await renderList({})
    await openMenu(0)
    await act(async () => {
      buttonByText('置顶', container.querySelectorAll('.conversation-item')[0]!).click()
      await Promise.resolve()
    })
    expect(
      getToasts().some((item) => {
        return item.text.includes('还不支持置顶')
      }),
    ).toBe(true)
  })
})

describe('列表的样式契约：内联不许抢走样式表那一层', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('片段里的查询词包进行内高亮（服务端回的片段是纯文本，自己标）', async () => {
    const { api } = fakeApi(() => {
      return Promise.resolve({ results: hits })
    })
    await renderList(api)
    typeQuery('周报')
    await settleSearch()
    const marks = [...container.querySelectorAll('.search-hit-mark')].map((node) => {
      return node.textContent
    })
    // 三个片段各命中一次；片段本身被切开重组，文字仍原样连着
    expect(marks).toEqual(['周报', '周报', '周报'])
    expect(container.querySelector('.search-hit-snippet')?.textContent).toBe('周报里的第三点…')
  })

  it('置顶与已静音各带一枚行内徽标（不靠「未读徽标」兼职）', async () => {
    const { api } = fakeApi(() => {
      return Promise.resolve({ results: [] })
    })
    await renderList(api)
    await openMenu(1)
    // 置顶后行序会重排，按下标再找菜单就找错了行——菜单本身仍是同一个
    await act(async () => {
      buttonByText('置顶', container.querySelector('.conversation-item-menu')!).click()
      await Promise.resolve()
      buttonByText('静音', container.querySelector('.conversation-item-menu')!).click()
      await Promise.resolve()
    })
    const flags = [...container.querySelectorAll('.conversation-item-flag')].map((node) => {
      return node.textContent
    })
    expect(flags).toContain('置顶')
    expect(flags).toContain('已静音')
    // 静音是中性档，不跟置顶共用一枚琥珀药丸
    expect(container.querySelector('.conversation-item-flag.is-muted')?.textContent).toBe('已静音')
  })

  it('操作条与菜单不带内联外观（亮度/层级/抬升都由样式表给）', async () => {
    const { api } = fakeApi(() => {
      return Promise.resolve({ results: [] })
    })
    await renderList(api)
    const actions = container.querySelector<HTMLElement>('.conversation-item-actions')!
    // 内联 opacity 会盖掉 `.conversation-item:hover .conversation-item-actions`，
    // 那条 hover 点亮的规则就成了死代码（这正是样式表要管的那两档亮度）。
    expect(actions.style.opacity).toBe('')
    await openMenu(0)
    const menu = container.querySelector<HTMLElement>('.conversation-item-menu')!
    expect(menu.getAttribute('style')).toBeNull()
    // 菜单仍是行内的一层（不是固定定位的浮窗），层级交给 z token
    expect(menu.closest('.conversation-item')).not.toBeNull()
    expect(container.querySelector('.conversation-more')?.getAttribute('style')).toBeNull()
  })
})
