// @vitest-environment jsdom
/**
 * 独立插件页：分组、搜索、四态、core 只读、关闭确认 / 撤销、右栏出口与「我的」入口。
 *
 * 渲染层不 import 内核包，所以这里只给 PluginView 形状的假回包；核心断言是
 * 页面读到的分组与能力、开关调用的参数，以及关闭后 toast 上的撤销真的会重新
 * 启用——而不是本地状态自转。
 *
 * 旧 `plugin-settings.test.tsx` 针对的是「我的」页内嵌区块，组件已随独立页签删除；
 * 它原有的三条硬断言（清单来自 API、core 不可切换、PATCH 参数与回包替换）全部
 * 迁到本文件（见「分组与兜底」「core 插件」「关闭确认」）。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../renderer/src/App.tsx'
import type { AgentDef, ApiClient, Conversation, PluginView } from '../renderer/src/api.ts'
import { ApiClient as ApiClientClass, ApiRequestError } from '../renderer/src/api.ts'
import { MePage } from '../renderer/src/components/MePage.tsx'
import { PluginsPage } from '../renderer/src/components/PluginsPage.tsx'
import { RightPanel } from '../renderer/src/components/RightPanel.tsx'
import { ToastHost } from '../renderer/src/components/ToastHost.tsx'
import { getToasts, toast } from '../renderer/src/lib/toast.ts'
import { ChatStore } from '../renderer/src/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const coreTools: PluginView = {
  id: 'core-tools',
  name: '内置工具',
  description: '读写工作区文件、执行命令、把结果落成文件卡片。',
  group: 'core',
  capabilities: { tools: ['fs_read', 'fs_write', 'shell_exec'] },
  impact: '关闭后助理无法读写工作区文件或执行命令，依赖工具的任务会全部失败。',
  enabled: true,
  core: true,
  status: 'running',
}

const todo: PluginView = {
  id: 'todo',
  name: '待办清单',
  description: '把要做的事记成清单，右栏里勾掉。',
  group: 'feature',
  capabilities: { tools: ['todo'], routes: ['GET /api/todos', 'PATCH /api/todos/:id'] },
  impact: '关闭后助理将无法记录待办，已有的待办记录保留；重新打开后恢复。',
  enabled: true,
  core: false,
  status: 'running',
}

const voice: PluginView = {
  id: 'voice',
  name: '语音朗读',
  description: '把回复念出来，云端音色不可用时退回系统语音。',
  group: 'voice',
  capabilities: { routes: ['GET /api/voice/catalog', 'POST /api/voice/speak'] },
  impact: '关闭后朗读只剩本机系统语音，云端音色目录与合成接口下线。',
  enabled: true,
  core: false,
  status: 'running',
}

const voicePiper: PluginView = {
  id: 'voice-piper',
  name: 'Voice Piper',
  description: '离线、开源的中文语音：下载一次后不需要任何 Key，断网也能朗读。',
  group: 'voice',
  capabilities: {
    routes: ['POST /api/voice/engines/piper/install', 'GET /api/voice/engines/piper/status'],
  },
  impact: '关闭后离线音色不可用，云端与系统语音不受影响。',
  enabled: true,
  core: false,
  status: 'running',
}

const web: PluginView = {
  id: 'web-read',
  name: '网页读取',
  description: '让助理直接读你贴过来的网页链接。',
  group: 'tool',
  capabilities: { tools: ['read_url'] },
  impact: '关闭后助理无法读取网页链接，只能依赖你粘贴的内容。',
  enabled: true,
  core: false,
  status: 'running',
}

/** 老服务端 / 精简替身：没有 group、capabilities、impact，只能按 core 兜底。 */
const legacy: PluginView = {
  id: 'legacy',
  name: '旧版插件',
  description: '只回了核心字段的插件。',
  enabled: true,
  core: false,
  status: 'running',
}

const broken: PluginView = {
  id: 'broken',
  name: '坏插件',
  description: '上次挂载失败了。',
  group: 'tool',
  enabled: true,
  core: false,
  status: 'error',
  error: '端口被占用',
}

const ryen: AgentDef = {
  id: 'ryen',
  name: 'Ryen',
  avatar: 'cat',
  systemPrompt: '你是 Ryen。',
  provider: 'siliconflow',
  model: 'deepseek-ai/DeepSeek-V3',
  tools: [],
  isBuiltin: true,
}

const conversation: Conversation = {
  id: 'c1',
  kind: 'direct',
  title: 'Ryen',
  memberAgentIds: ['ryen'],
  lastReadSeq: 1,
  createdAt: 1,
  updatedAt: 2,
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

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
    root?.unmount()
  })
  root = undefined
  container.remove()
  for (const item of getToasts()) toast.dismiss(item.id)
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

async function flush(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function click(node: Element | null): Promise<void> {
  if (!(node instanceof HTMLElement)) throw new Error('要点的元素不在页面上')
  await act(async () => {
    node.click()
    await Promise.resolve()
  })
}

function cardFor(id: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-plugin-id="${id}"]`)
  if (found === null) throw new Error(`找不到插件卡片：${id}`)
  return found
}

function switchFor(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')].find((node) => {
    return node.getAttribute('aria-label')?.includes(name) === true
  })
  if (found === undefined) throw new Error(`找不到开关：${name}`)
  return found
}

function buttonByText(selector: string, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>(selector)].find((node) => {
    return node.textContent?.trim() === text
  })
  if (found === undefined) throw new Error(`找不到按钮：${text}`)
  return found
}

function buttonContaining(selector: string, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>(selector)].find((node) => {
    return node.textContent?.includes(text) === true
  })
  if (found === undefined) throw new Error(`找不到按钮：${text}`)
  return found
}

async function renderPage(api: {
  plugins?: () => Promise<{ plugins: PluginView[] }>
  setPluginEnabled?: (id: string, enabled: boolean) => Promise<{ plugin: PluginView }>
}): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<PluginsPage api={api} />)
    await Promise.resolve()
  })
  await flush()
}

async function search(value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索插件"]')
  if (input === null) throw new Error('找不到搜索框')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

describe('插件页：分组与降级', () => {
  it('按 group 分区并给出数量；缺 group 时按 core 兜底', async () => {
    await renderPage({
      plugins: async () => ({ plugins: [coreTools, todo, voice, web, legacy] }),
    })

    const titles = [...container.querySelectorAll('.plugin-group-title')].map((node) => {
      return node.textContent
    })
    expect(titles).toEqual(['内置', '功能', '语音', '工具'])

    const feature = container.querySelector('[data-group="feature"]')
    expect(feature?.querySelector('.plugin-group-count')?.textContent).toBe('2')
    // 缺 group 的旧插件落在「功能」，不是消失，也不是单独一个「其它」。
    expect(feature?.querySelector('[data-plugin-id="legacy"]')).not.toBeNull()
    expect(container.querySelector('[data-plugin-id="legacy"]')?.textContent).toContain('旧版插件')

    // 缺 capabilities / impact 时展开仍然可读：能力区不出现，影响说明用兜底句。
    await click(cardFor('legacy').querySelector('.plugin-card-main'))
    expect(cardFor('legacy').textContent).toContain('关闭后它的工具与界面会一起消失，已有数据会保留。')
    // 内部 id 没有展示位：它只留在 data-plugin-id 上（供自动化与排障定位）。
    expect(cardFor('legacy').querySelector('.plugin-detail')?.textContent).not.toContain('插件 ID')
    expect(cardFor('legacy').querySelector('.plugin-chips')).toBeNull()
  })

  it('语音分组里出现 Voice Piper 卡片，描述与 impact 按服务端元数据渲染', async () => {
    await renderPage({
      plugins: async () => ({ plugins: [voice, voicePiper] }),
    })
    const group = container.querySelector('[data-group="voice"]')
    expect(group?.querySelector('.plugin-group-count')?.textContent).toBe('2')
    expect(cardFor('voice-piper').textContent).toContain('Voice Piper')
    expect(cardFor('voice-piper').textContent).toContain('离线、开源')
    await click(cardFor('voice-piper').querySelector('.plugin-card-main'))
    expect(cardFor('voice-piper').textContent).toContain('关闭后离线音色不可用，云端与系统语音不受影响。')
    // 接口胶囊是人话（`/api/voice/engines/piper/install` 说成「发起语音引擎 Piper 安装」），
    // 原始路由留在 title 上给排障的人。
    const piperChips = [...cardFor('voice-piper').querySelectorAll('.plugin-chip')]
    expect(piperChips.map((node) => node.textContent)).toEqual(['发起语音引擎Piper安装', '读取语音引擎Piper状态'])
    expect(piperChips.map((node) => node.getAttribute('title'))).toEqual([
      'POST /api/voice/engines/piper/install',
      'GET /api/voice/engines/piper/status',
    ])
  })

  it('展开后把 tools / routes 渲染成人话胶囊，并显示 impact（内部 id 不上屏）', async () => {
    await renderPage({
      plugins: async () => ({ plugins: [todo] }),
    })
    await click(cardFor('todo').querySelector('.plugin-card-main'))

    const chips = [...cardFor('todo').querySelectorAll('.plugin-chip')]
    expect(chips.map((node) => node.textContent)).toEqual(['待办清单', '读取待办清单', '修改待办清单'])
    expect(chips.map((node) => node.getAttribute('title'))).toEqual(['todo', 'GET /api/todos', 'PATCH /api/todos/:id'])
    expect(cardFor('todo').textContent).toContain('关闭后助理将无法记录待办')
    expect(cardFor('todo').querySelector('.plugin-detail')?.textContent).not.toContain('插件 ID')
    expect(cardFor('todo').querySelector('.plugin-card-main')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('启动失败的插件展开后给出服务端留下的原因', async () => {
    await renderPage({
      plugins: async () => ({ plugins: [broken] }),
    })
    expect(cardFor('broken').textContent).toContain('启动失败')
    await click(cardFor('broken').querySelector('.plugin-card-main'))
    expect(cardFor('broken').textContent).toContain('失败原因')
    expect(cardFor('broken').textContent).toContain('端口被占用')
  })
})

describe('插件页：搜索', () => {
  it('按名字或描述过滤，并只保留还有命中的分组', async () => {
    await renderPage({
      plugins: async () => ({ plugins: [coreTools, todo, voice, web] }),
    })

    await search('待办')
    expect(container.querySelectorAll('.plugin-card')).toHaveLength(1)
    expect(cardFor('todo')).not.toBeNull()
    expect([...container.querySelectorAll('.plugin-group-title')].map((node) => node.textContent)).toEqual(['功能'])

    await search('音色')
    expect(container.querySelectorAll('.plugin-card')).toHaveLength(1)
    expect(cardFor('voice')).not.toBeNull()

    await search('不存在的插件')
    expect(container.querySelectorAll('.plugin-card')).toHaveLength(0)
    expect(container.textContent).toContain('没有找到匹配的插件')
    await click(buttonByText('.plugins-empty button', '清空搜索'))
    expect(container.querySelectorAll('.plugin-card')).toHaveLength(4)
  })
})

describe('插件页：core 与开关', () => {
  it('core 显示「内置」徽章、没有开关，并说明为什么不可关', async () => {
    const setPluginEnabled = vi.fn(async (id: string, enabled: boolean) => {
      return { plugin: { ...coreTools, id, enabled } }
    })
    await renderPage({
      plugins: async () => ({ plugins: [coreTools, todo] }),
      setPluginEnabled,
    })

    const core = cardFor('core-tools')
    expect(core.textContent).toContain('内置')
    expect(core.querySelector('.plugins-core-badge')?.textContent).toBe('内置')
    expect(core.querySelector('button[role="switch"]')).toBeNull()
    expect(core.textContent).toContain('关闭后助理无法读写工作区文件或执行命令')

    // 点卡片只展开，不会触发切换。
    await click(core.querySelector('.plugin-card-main'))
    expect(setPluginEnabled).not.toHaveBeenCalled()
    expect(core.textContent).toContain('为什么不可关闭')
  })

  it('普通插件关闭前先确认；确认后 PATCH 参数正确，回包替换进列表', async () => {
    const setPluginEnabled = vi.fn(async (id: string, enabled: boolean) => {
      expect(id).toBe('todo')
      expect(enabled).toBe(false)
      return { plugin: { ...todo, enabled, status: 'stopped' as const } }
    })
    await renderPage({
      plugins: async () => ({ plugins: [coreTools, todo] }),
      setPluginEnabled,
    })

    const demoSwitch = switchFor('待办清单')
    expect(demoSwitch.textContent).toBe('已开启')
    expect(demoSwitch.getAttribute('aria-checked')).toBe('true')

    await click(demoSwitch)
    // 确认文案取插件自己声明的 impact，而不是页面写死的通用句。
    expect(container.textContent).toContain('关闭「待办清单」？')
    expect(container.textContent).toContain('关闭后助理将无法记录待办，已有的待办记录保留；重新打开后恢复。')
    expect(setPluginEnabled).not.toHaveBeenCalled()

    await click(buttonByText('.modal-actions button', '关闭'))
    await flush()
    expect(setPluginEnabled).toHaveBeenCalledTimes(1)
    expect(setPluginEnabled).toHaveBeenCalledWith('todo', false)
    // 界面读的是服务端返回的那一行，不是本地取反。
    expect(switchFor('待办清单').textContent).toBe('已关闭')
    expect(switchFor('待办清单').getAttribute('aria-checked')).toBe('false')
    expect(cardFor('todo').textContent).toContain('已停止')

    const last = getToasts().at(-1)
    expect(last?.kind).toBe('success')
    expect(last?.text).toBe('已关闭「待办清单」')
    expect(last?.action?.label).toBe('撤销')
  })

  it('开启不弹确认，直接 PATCH 并 toast', async () => {
    const setPluginEnabled = vi.fn(async (id: string, enabled: boolean) => {
      return { plugin: { ...todo, id, enabled, status: enabled ? ('running' as const) : ('stopped' as const) } }
    })
    await renderPage({
      plugins: async () => ({ plugins: [{ ...todo, enabled: false, status: 'stopped' }] }),
      setPluginEnabled,
    })

    await click(switchFor('待办清单'))
    expect(container.querySelector('.modal-actions')).toBeNull()
    expect(setPluginEnabled).toHaveBeenCalledWith('todo', true)
    await flush()
    expect(switchFor('待办清单').textContent).toBe('已开启')
    expect(getToasts().at(-1)?.text).toBe('已开启「待办清单」')
  })

  it('关闭后的 toast 点「撤销」会重新启用插件', async () => {
    const setPluginEnabled = vi.fn(async (id: string, enabled: boolean) => {
      return { plugin: { ...todo, id, enabled, status: enabled ? ('running' as const) : ('stopped' as const) } }
    })
    await act(async () => {
      root = createRoot(container)
      root.render(
        <>
          <PluginsPage
            api={{
              plugins: async () => ({ plugins: [todo] }),
              setPluginEnabled,
            }}
          />
          <ToastHost />
        </>,
      )
      await Promise.resolve()
    })
    await flush()

    await click(switchFor('待办清单'))
    await click(buttonByText('.modal-actions button', '关闭'))
    await flush()
    expect(setPluginEnabled).toHaveBeenCalledWith('todo', false)

    const action = container.querySelector<HTMLButtonElement>('.toast-action')
    expect(action?.textContent).toBe('撤销')
    await click(action)
    await flush()

    expect(setPluginEnabled).toHaveBeenCalledTimes(2)
    expect(setPluginEnabled).toHaveBeenLastCalledWith('todo', true)
    expect(switchFor('待办清单').getAttribute('aria-checked')).toBe('true')
    expect(getToasts().at(-1)?.text).toBe('已开启「待办清单」')
  })
})

describe('插件页：四态', () => {
  it('加载中显示骨架屏', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(<PluginsPage api={{ plugins: () => new Promise(() => {}) }} />)
      await Promise.resolve()
    })
    expect(container.querySelector('[role="status"][aria-label="加载中"]')).not.toBeNull()
    expect(container.querySelector('.panel-skeleton')).not.toBeNull()
  })

  it('读取失败显示原因与重试；重试成功后落到列表', async () => {
    let attempts = 0
    const plugins = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('HTTP 503')
      return { plugins: [coreTools] }
    })
    await renderPage({ plugins })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('插件清单没读出来')
    expect(container.textContent).toContain('HTTP 503')
    await click(buttonByText('[role="alert"] button', '重试'))
    await flush()
    expect(plugins).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('内置工具')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('服务端回空清单时说「还没有可显示的插件」', async () => {
    await renderPage({ plugins: async () => ({ plugins: [] }) })
    expect(container.textContent).toContain('还没有可显示的插件')
    expect(container.querySelector('.plugin-card')).toBeNull()
  })

  it('这版服务端没有插件接口时给出说明，不冒充加载失败', async () => {
    await renderPage({})
    expect(container.textContent).toContain('这版服务端还没有插件接口')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('.panel-skeleton')).toBeNull()
  })
})

describe('待办插件关闭后的出口', () => {
  function panelApi(): ApiClient {
    const api = new ApiClientClass('http://api.test')
    vi.spyOn(api, 'conversationDetail').mockResolvedValue({
      conversation,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, messages: 0 },
    })
    api.listTodos = vi.fn(async () => {
      throw new ApiRequestError('not found: GET /api/todos', 404, 'NOT_FOUND')
    })
    api.setTodoDone = vi.fn(async () => {
      return { conversationId: 'c1', items: [] }
    })
    api.clearTodos = vi.fn(async () => {
      return { conversationId: 'c1', items: [] }
    })
    return api
  }

  it('「打开插件页」按钮触发 App 传入的回调', async () => {
    const onOpenPlugins = vi.fn()
    await act(async () => {
      root = createRoot(container)
      root.render(
        <RightPanel
          api={panelApi()}
          store={new ChatStore()}
          conversation={conversation}
          agents={[ryen]}
          conversations={[conversation]}
          fileUrl={(name) => {
            return `/api/files/${name}`
          }}
          collapsed={false}
          onToggle={() => {}}
          onOpenPlugins={onOpenPlugins}
        />,
      )
      await Promise.resolve()
    })
    await flush()

    expect(container.textContent).toContain('待办插件已关闭')
    await click(buttonByText('button', '打开插件页'))
    expect(onOpenPlugins).toHaveBeenCalledTimes(1)
  })
})

describe('「我的」页只留入口', () => {
  const meApi = {
    plugins: async () => ({ plugins: [coreTools] }),
    listAgentMemories: async () => ({ agent: [], shared: [] }),
    patchAgent: async () => ({ agent: ryen }),
    workspace: async () => ({ path: 'C:/work' }),
    setApiKey: async () => ({ providerId: 'x', configured: true }),
  }

  it('入口跳到插件页；插件清单不再嵌在「我的」页里', async () => {
    const onOpenPlugins = vi.fn()
    await act(async () => {
      root = createRoot(container)
      root.render(
        <MePage
          api={meApi}
          ryen={undefined}
          providers={[]}
          theme="light"
          onThemeChange={() => {}}
          onOpenPlugins={onOpenPlugins}
        />,
      )
      await Promise.resolve()
    })
    await flush()

    expect(container.textContent).toContain('开关与说明')
    // 内嵌区块已撤走：服务端插件清单不会出现在「我的」页。
    expect(container.textContent).not.toContain('内置工具')
    await click(buttonContaining('.me-row-btn', '开关与说明'))
    expect(onOpenPlugins).toHaveBeenCalledTimes(1)
  })
})

describe('App 导航', () => {
  function reply(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  beforeEach(() => {
    window.history.replaceState({}, '', '/?api=http://127.0.0.1:32100')
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const path = url.pathname
      if (path === '/api/agents') return reply({ agents: [ryen] })
      if (path === '/api/agent-templates') return reply({ templates: [] })
      if (path === '/api/providers') return reply({ providers: [] })
      if (path === '/api/conversations') return reply({ conversations: [] })
      if (path === '/api/plugins') return reply({ plugins: [coreTools, todo] })
      if (path === '/api/workspace') return reply({ path: 'C:/work' })
      if (path === '/api/agents/ryen/memories') return reply({ agent: [], shared: [] })
      if (path === '/api/memory/health') return reply({ enabled: false })
      if (path === '/api/usage')
        return reply({ byConversation: [], byProvider: [], totals: { input: 0, output: 0, total: 0 } })
      return reply({})
    })
  })

  it('rail 有「插件」页签、也有「RyVibe（Beta）」页签；「我的」入口也能跳过去', async () => {    await act(async () => {
      root = createRoot(container)
      root.render(<App />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    await flush()

    const nav = container.querySelector('nav[aria-label="主导航"]')
    const tabs = [...(nav?.querySelectorAll<HTMLButtonElement>('.rail-tab') ?? [])]
    expect(
      tabs.map((tab) => {
        return tab.textContent?.trim()
      }),
    ).toEqual(['聊天', 'RyVibe', '通讯录', '插件', '我的'])

    await click(
      tabs.find((tab) => {
        return tab.textContent?.trim() === '插件'
      }) ?? null,
    )
    await flush()
    expect(container.querySelector('.page-header h2')?.textContent).toBe('插件')
    expect(container.textContent).toContain('关掉后，对应的工具与界面会一起消失')
    expect(cardFor('todo')).not.toBeNull()
    expect(nav?.querySelector('[aria-current="page"]')?.textContent).toContain('插件')

    await click(
      tabs.find((tab) => {
        return tab.textContent?.trim() === '我的'
      }) ?? null,
    )
    await flush()
    expect(container.textContent).toContain('开关与说明')
    await click(buttonContaining('.me-row-btn', '开关与说明'))
    await flush()
    expect(container.querySelector('.page-header h2')?.textContent).toBe('插件')
  })
})
