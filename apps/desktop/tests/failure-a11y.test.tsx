// @vitest-environment jsdom
/**
 * 失败路径可见化 + 可访问性：
 * 1) 静默 catch 一律出 toast（停用手册、改昵称、复制、删示例），区段的加载失败
 *    就地报出来，不再伪装成"本来就是空的"；
 * 2) 对话流是 log、导航与主题单选有选中态、装饰猫不进无障碍树。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../renderer/src/App.tsx'
import type { AgentDef, ApiClient, Conversation, PlaybookEntryRow, ReflectionRow } from '../renderer/src/api.ts'
import { ChatView } from '../renderer/src/components/ChatView.tsx'
import { MePage } from '../renderer/src/components/MePage.tsx'
import { MessageBubble } from '../renderer/src/components/MessageBubble.tsx'
import { PlaybookPanel } from '../renderer/src/components/PlaybookPanel.tsx'
import { WelcomeHome } from '../renderer/src/components/WelcomeHome.tsx'
import { getToasts, toast } from '../renderer/src/lib/toast.ts'
import { ChatStore, type UiMessage } from '../renderer/src/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | undefined

/** toast 文本；空数组表示屏幕上没有任何提示。 */
function toastTexts(): string[] {
  return getToasts().map((item) => {
    return item.text
  })
}

function click(node: Element | null | undefined): void {
  expect(node).not.toBeNull()
  act(() => {
    ;(node as HTMLElement).click()
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

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
  // toast 是模块级单例：用例之间清干净，别串到下一条。
  for (const item of getToasts()) toast.dismiss(item.id)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = undefined
  container.remove()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

const agent: AgentDef = {
  id: 'ryen',
  name: 'Ryen',
  avatar: 'cat',
  systemPrompt: '你是 Ryen。',
  provider: 'siliconflow',
  model: 'deepseek-ai/DeepSeek-V3',
  tools: [],
  isBuiltin: true,
}

function playbookEntry(partial: Partial<PlaybookEntryRow> = {}): PlaybookEntryRow {
  return {
    id: 'p1',
    agentId: 'ryen',
    section: 'strategy',
    content: '先给结论，再给理由',
    helpful: 3,
    harmful: 0,
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
    source: 'curator',
    ...partial,
  }
}

describe('经验手册：停用/恢复失败要出声', () => {
  /** 覆盖只换实现、不换 spy：调用次数还得能数。 */
  async function renderPanel(
    overrides: {
      getPlaybook?: () => Promise<{ entries: PlaybookEntryRow[]; reflections: ReflectionRow[] }>
      setPlaybookStatus?: () => Promise<{ id: string; status: string }>
    } = {},
  ): Promise<{ setPlaybookStatus: ReturnType<typeof vi.fn>; getPlaybook: ReturnType<typeof vi.fn> }> {
    const setPlaybookStatus = vi.fn(() => {
      return Promise.resolve({ id: 'p1', status: 'deprecated' })
    })
    const getPlaybook = vi.fn<() => Promise<{ entries: PlaybookEntryRow[]; reflections: ReflectionRow[] }>>(() => {
      return Promise.resolve({ entries: [playbookEntry({})], reflections: [] })
    })
    if (overrides.setPlaybookStatus !== undefined) setPlaybookStatus.mockImplementation(overrides.setPlaybookStatus)
    if (overrides.getPlaybook !== undefined) getPlaybook.mockImplementation(overrides.getPlaybook)
    await act(async () => {
      root = createRoot(container)
      root.render(
        <PlaybookPanel
          api={{ getPlaybook, setPlaybookStatus } as unknown as ApiClient}
          agentId="ryen"
          agentName="Ryen"
          onClose={() => {}}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    return { setPlaybookStatus, getPlaybook }
  }

  it('停用失败时报出原因，且不假装已经停用', async () => {
    const { getPlaybook } = await renderPanel({
      setPlaybookStatus: () => {
        return Promise.reject(new Error('服务端 500'))
      },
    })
    await settle()
    click(container.querySelector('.memory-delete'))
    await settle()
    expect(toastTexts().join('|')).toContain('停用这条经验失败：服务端 500')
    // 失败后不刷新：条目还在，且仍是生效态。
    expect(getPlaybook).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('先给结论，再给理由')
    expect(container.textContent).toContain('1 生效')
  })

  it('停用成功时说一声（软删可被误认为丢内容）', async () => {
    await renderPanel({})
    click(container.querySelector('.memory-delete'))
    await settle()
    expect(toastTexts().join('|')).toContain('已停用')
  })

  it('读手册失败就地报错，不装成"手册还是空的"', async () => {
    const { getPlaybook } = await renderPanel({
      getPlaybook: () => {
        return Promise.reject(new Error('后端没起来'))
      },
    })
    await settle()
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('经验手册没读出来：后端没起来')
    expect(container.textContent).not.toContain('手册还是空的')
    // 读不出来也留着重试口。
    click(container.querySelector('.apikey-error button'))
    await settle()
    expect(getPlaybook).toHaveBeenCalledTimes(2)
  })

  it('停用按钮有可读名（图标按钮光靠 x/✓ 说不清自己在干嘛）', async () => {
    await renderPanel({})
    expect(container.querySelector('.memory-delete')?.getAttribute('aria-label')).toContain('停用')
  })
})

describe('「我的」页：改昵称失败要出声', () => {
  async function renderMe(api: {
    patchAgent: () => Promise<unknown>
    listAgentMemories?: () => Promise<{ agent: never[]; shared: never[] }>
    onRyenPatched?: () => void
  }): Promise<void> {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <MePage
          api={{
            listAgentMemories:
              api.listAgentMemories ??
              (() => {
                return Promise.resolve({ agent: [], shared: [] })
              }),
            patchAgent: api.patchAgent as never,
            workspace: () => {
              return Promise.resolve({ path: 'C:/data/workspace' })
            },
            setApiKey: () => {
              return Promise.resolve({ providerId: 'x', configured: true })
            },
          }}
          ryen={agent}
          providers={[{ id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: true, models: [{ id: 'm' }] }]}
          theme="light"
          onThemeChange={() => {}}
          onRyenPatched={api.onRyenPatched}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  async function rename(value: string): Promise<void> {
    click(container.querySelector('.me-inline-edit'))
    const input = container.querySelector<HTMLInputElement>('.me-name-inline')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('保存失败时报出原因，不刷新（名字没改却像改了）', async () => {
    let refreshed = 0
    await renderMe({
      patchAgent: () => {
        return Promise.reject(new Error('name 被占用'))
      },
      onRyenPatched: () => {
        refreshed += 1
      },
    })
    await rename('小橘')
    await settle()
    expect(toastTexts().join('|')).toContain('改昵称失败：name 被占用')
    expect(refreshed).toBe(0)
  })

  it('保存成功时说一声新名字', async () => {
    let refreshed = 0
    await renderMe({
      patchAgent: () => {
        return Promise.resolve({ agent: { ...agent, name: '小橘' } })
      },
      onRyenPatched: () => {
        refreshed += 1
      },
    })
    await rename('小橘')
    await settle()
    expect(toastTexts().join('|')).toContain('小橘')
    expect(refreshed).toBe(1)
  })

  it('共享画像读不出来时说清楚，不说成"还没有画像"', async () => {
    await renderMe({
      patchAgent: () => {
        return Promise.resolve({ agent })
      },
      listAgentMemories: () => {
        return Promise.reject(new Error('向量库打不开'))
      },
    })
    await settle()
    const alerts = [...container.querySelectorAll('[role="alert"]')].map((node) => {
      return node.textContent
    })
    expect(alerts.join('|')).toContain('共享画像没读出来：向量库打不开')
    expect(container.textContent).not.toContain('还没有画像')
  })
})

describe('气泡：复制失败要出声', () => {
  const message: UiMessage = {
    key: 'a1',
    senderType: 'agent',
    senderId: 'ryen',
    senderName: 'Ryen',
    turnIndex: 0,
    done: true,
    parts: [{ kind: 'text', text: '周报写好了' }],
  }

  beforeEach(() => {
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.reject(new Error('剪贴板被拒绝')) } })
  })

  it('剪贴板不可用时报错（此前按钮毫无变化，等于没点）', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(<MessageBubble message={message} fileUrl={(name) => `/api/files/${name}`} />)
    })
    click(container.querySelector('.bubble-action'))
    await settle()
    expect(toastTexts().join('|')).toContain('复制失败')
    expect(container.querySelector('.bubble-action')?.getAttribute('aria-label')).toBe('复制这条消息')
  })

  it('复制成功后按钮自报「已复制」', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.resolve() } })
    await act(async () => {
      root = createRoot(container)
      root.render(<MessageBubble message={message} fileUrl={(name) => `/api/files/${name}`} />)
    })
    click(container.querySelector('.bubble-action'))
    await settle()
    expect(container.querySelector('.bubble-action')?.getAttribute('aria-label')).toBe('已复制')
  })
})

describe('首屏：删示例的每条分支都有回音', () => {
  const demo: Conversation = {
    id: 'demo-1',
    kind: 'group',
    title: '示例 · Ryen、阿码一起定晚饭',
    memberAgentIds: ['ryen'],
    dispatcherAgentId: 'ryen',
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 2,
    lastMessagePreview: '那就定周三晚。',
  }

  function renderWelcome(): void {
    act(() => {
      root = createRoot(container)
      root.render(
        <WelcomeHome
          ryen={agent}
          agents={[agent]}
          conversations={[demo]}
          providers={[{ id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: true, models: [] }]}
          onSaveApiKey={() => {
            return Promise.resolve()
          }}
          onSend={() => {}}
          onOpenConversation={() => {}}
        />,
      )
    })
  }

  function deleteButton(): Element {
    const button = [...container.querySelectorAll('button')].find((node) => {
      return node.textContent === '删掉示例'
    })
    expect(button).toBeDefined()
    return button as Element
  }

  it('删成功说一声', async () => {
    window.history.replaceState({}, '', '/?api=http://127.0.0.1:32100')
    vi.stubGlobal('fetch', () => {
      return Promise.resolve({ ok: true, status: 200 })
    })
    renderWelcome()
    await act(async () => {
      deleteButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(toastTexts().join('|')).toContain('示例会话已删掉')
  })

  it('还没拿到本机服务地址时也要说话，而不是点了没反应', async () => {
    window.history.replaceState({}, '', '/')
    renderWelcome()
    await act(async () => {
      deleteButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(toastTexts().join('|')).toContain('还没拿到本机服务地址')
  })

  it('装饰性品牌猫不进无障碍树（否则多念一句英文枚举 Ryen idle）', () => {
    const html = renderToStaticMarkup(
      <WelcomeHome
        ryen={agent}
        agents={[agent]}
        conversations={[]}
        providers={[{ id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: true, models: [] }]}
        onSaveApiKey={() => {
          return Promise.resolve()
        }}
        onSend={() => {}}
        onOpenConversation={() => {}}
      />,
    )
    expect(html).toContain('<div class="welcome-cat" aria-hidden="true">')
  })
})

describe('可访问性：读屏能定位到新增内容与当前所在', () => {
  function chatApi(): ApiClient {
    return {
      messages: () => {
        return Promise.resolve({ messages: [] })
      },
      markRead: () => {
        return Promise.resolve({ conversationId: 'c1', lastReadSeq: 0 })
      },
      listDispatchEvents: () => {
        return Promise.resolve({ events: [] })
      },
      fileUrl: (name: string) => {
        return `/api/files/${name}`
      },
      subscribe: () => {
        return () => {}
      },
    } as unknown as ApiClient
  }

  const conversation: Conversation = {
    id: 'c1',
    kind: 'direct',
    title: 'Ryen',
    memberAgentIds: ['ryen'],
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 2,
  }

  it('对话流是 role=log + polite + 只播报新增', async () => {
    window.history.replaceState({}, '', '/?api=http://127.0.0.1:32100')
    await act(async () => {
      root = createRoot(container)
      root.render(<ChatView api={chatApi()} conversation={conversation} agents={[agent]} store={new ChatStore()} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const log = container.querySelector('.chat-scroll')!
    expect(log.getAttribute('role')).toBe('log')
    expect(log.getAttribute('aria-live')).toBe('polite')
    expect(log.getAttribute('aria-relevant')).toBe('additions')
  })

  it('主题是真正的 radiogroup：两个 radio 各带 aria-checked', async () => {
    window.history.replaceState({}, '', '/?api=http://127.0.0.1:32100')
    await act(async () => {
      root = createRoot(container)
      root.render(
        <MePage
          api={{
            listAgentMemories: () => {
              return Promise.resolve({ agent: [], shared: [] })
            },
            patchAgent: () => {
              return Promise.resolve({ agent })
            },
            workspace: () => {
              return Promise.resolve({ path: 'C:/data/workspace' })
            },
            setApiKey: () => {
              return Promise.resolve({ providerId: 'x', configured: true })
            },
          }}
          ryen={undefined}
          providers={[]}
          theme="light"
          onThemeChange={() => {}}
        />,
      )
      await Promise.resolve()
    })
    const group = container.querySelector('.theme-toggle')!
    expect(group.getAttribute('role')).toBe('radiogroup')
    const radios = [...group.querySelectorAll('[role="radio"]')]
    expect(
      radios.map((node) => {
        return node.getAttribute('aria-checked')
      }),
    ).toEqual(['true', 'false'])
  })

  it('主导航当前页带 aria-current，且只有一个', async () => {
    window.history.replaceState({}, '', '/?api=http://127.0.0.1:32100')
    vi.stubGlobal('fetch', async (input: string) => {
      const path = new URL(String(input)).pathname
      const reply = (body: unknown): Response =>
        ({
          ok: true,
          status: 200,
          json: () => {
            return Promise.resolve(body)
          },
        }) as unknown as Response
      if (path === '/api/agents') return reply({ agents: [agent] })
      if (path === '/api/agent-templates') return reply({ templates: [] })
      if (path === '/api/providers') return reply({ providers: [] })
      if (path === '/api/conversations') return reply({ conversations: [] })
      return reply({})
    })
    await act(async () => {
      root = createRoot(container)
      root.render(<App />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    const nav = container.querySelector('nav[aria-label="主导航"]')!
    const current = () => {
      return [...nav.querySelectorAll('[aria-current="page"]')]
    }
    expect(current()).toHaveLength(1)
    expect(current()[0]!.textContent).toContain('聊天')
    // 装饰性品牌猫不进无障碍树。
    expect(nav.querySelector('.rail-logo')?.getAttribute('aria-hidden')).toBe('true')

    click(
      [...nav.querySelectorAll('button')].find((node) => {
        return node.textContent?.includes('通讯录')
      }),
    )
    expect(current()).toHaveLength(1)
    expect(current()[0]!.textContent).toContain('通讯录')
  })
})
