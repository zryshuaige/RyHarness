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
import { bucketOf, ChatStore, type UiMessage } from '../renderer/src/store.ts'

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
        return Promise.reject(new Error('not found: GET /api/evolve/playbook'))
      },
    })
    await settle()
    const alert = container.querySelector('[role="alert"]')
    // 服务端英文原话不上屏：这句说的是「这版服务端没有这条路由」。
    expect(alert?.textContent).toContain('本机服务没有这个接口')
    expect(alert?.textContent).not.toContain('not found')
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
    // 限定在猫管家那一行：用户卡现在也有一个可点的名字（`.me-inline-edit`），
    // 全局取第一个会点到「你」身上去，于是输入框根本不出现。
    const butler = container.querySelector('.me-butler')
    if (butler === null) throw new Error('猫管家那一行没有渲染出来')
    click(butler.querySelector('.me-inline-edit'))
    const input = butler.querySelector<HTMLInputElement>('.me-name-inline')
    if (input === null) throw new Error('改名输入框没有渲染出来')
    await act(async () => {
      // React 受控输入要绕过 setter 直接派发 input 才会认这次改动，所以必须拿到
      // 原型上的原生 setter。取不到说明 jsdom 环境不对，直接失败好过静默改名失败。
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (setter === undefined) throw new Error('HTMLInputElement.prototype.value 缺少 setter')
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
    title: '示例 · Ryen、阿码一起做季度报告',
    memberAgentIds: ['ryen'],
    dispatcherAgentId: 'ryen',
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 2,
    lastMessagePreview: '报告已经放进工作区。',
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
    // 删除键是行尾那个图标按钮：它默认只是低透明度，不是 display:none，
    // 所以读屏与键盘仍然走得到（本文件盯的正是这一点）。
    const button = container.querySelector('.welcome-demo-clear')
    expect(button, '首屏没有删除示例的按键').not.toBeNull()
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
    // 服务端删的是**软删**（消息还在库里，restore 端点一直在）：提示必须说清还能撤销，
    // 不能写"删不回来"那种绝对化断言——那是在骗人。
    expect(toastTexts().join('|')).toContain('示例会话已删除')
    expect(toastTexts().join('|')).toContain('撤销')
    expect(toastTexts().join('|')).not.toContain('删不回来')
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

/**
 * 起壳用的最小后端：四个列表接口给最小真值，其余一律空包。
 * 栏 1 的两条用例共用它——同一套 fetch 抄两遍，只会各自漂移。
 */
function stubBootApi(): void {
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
}

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
      root.render(
        <ChatView api={chatApi()} conversation={conversation} agents={[agent]} bucket={bucketOf(new ChatStore())} />,
      )
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
    stubBootApi()
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

  it('栏 1 四个页签同一套线性图标、同一档尺寸，品牌猫只留在 logo 槽', async () => {
    stubBootApi()
    await act(async () => {
      root = createRoot(container)
      root.render(<App />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    const nav = container.querySelector('nav[aria-label="主导航"]')!
    // 按槽位定位，不按品牌组件的类名：换成别的品牌组件时这条断言仍然成立。
    const slotWidth = (label: string): number => {
      const tab = [...nav.querySelectorAll('.rail-tab')].find((node) => {
        return node.textContent?.includes(label)
      })
      return Number(tab?.querySelector('.rail-icon svg')?.getAttribute('width') ?? Number.NaN)
    }
    const widths = ['聊天', '通讯录', '插件', '我的'].map((label) => {
      return [label, slotWidth(label)] as const
    })
    for (const [label, width] of widths) {
      expect(width, `「${label}」槽位没渲染出线���图标`).toBeGreaterThan(0)
      expect([16, 20, 24], `栏 1 图标尺寸 ${width} 不在 16/20/24 三档上`).toContain(width)
    }
    // 四个页签是同一套图形语言：尺寸必须一致，不能一个 20 一个 16。
    expect(new Set(widths.map(([, w]) => w)).size, '页签图标尺寸不一致').toBe(1)
    // 品牌猫是产品标识，只出现在 logo 槽；混进导航既不是同一套语言，在 20px 槽位里
    // 也压不住旁边的描边图标（「我的」曾挂过 16px 的猫）。
    expect(nav.querySelector('.rail-tab img'), '页签里不该出现品牌猫').toBeNull()
    expect(container.querySelector('.rail-logo img'), '栏顶 logo 应当是品牌猫').not.toBeNull()
  })
})
