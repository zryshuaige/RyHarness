// @vitest-environment jsdom
/**
 * 渲染层这一波的接线清账——能力早就在，缺的是「谁把它接上」：
 *
 * 1) 经验手册的每一条都要能问「它从哪来」：GroupEvolution 导出的 EntryExplain
 *    此前没人用，GET /api/evolve/entries/:id/explain 也因此一次都没被渲染层打过。
 * 2) 会话列表要接窗口化：lib/windowed.ts 早已提供哨兵切片，几千条会话却还在
 *    整表进 DOM。
 * 3) formatTime 只留 lib/format.ts 一份实现（带 Intl 缓存）：ChatView 顶部那份拷贝
 *    是热路径，还形成了 ConversationList → ChatView 的反向依赖。
 * 4) 删除凭据的声明要跟真实响应对齐：api.ts 里的 `deleted: never` 只是当时那层
 *    声明没改的临时妥协，留着就成了「这个字段服务端不返回」的假契约。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../renderer/src/App.tsx'
import type { AgentDef, ApiClient, Conversation, PlaybookEntryRow } from '../renderer/src/api.ts'
import { ApiClient as ApiClientImpl } from '../renderer/src/api.ts'
import { ConversationList } from '../renderer/src/components/ConversationList.tsx'
import { PlaybookPanel } from '../renderer/src/components/PlaybookPanel.tsx'
import type { ProviderApi } from '../renderer/src/components/ProviderSettings.tsx'
import { readBootPhases } from '../renderer/src/lib/boot-trace.ts'
import { DEFAULT_OVERSCAN, FALLBACK_VIEWPORT_ROWS, MAX_RENDERED_ROWS } from '../renderer/src/lib/windowed.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// 路径走 fs 而不是 URL：jsdom 会把全局 URL 换成 whatwg 实现，import.meta.url 在
// 它那儿解析不出 file: 协议。
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../renderer/src')
const sourceOf = (name: string): string => {
  return readFileSync(resolve(SRC, name), 'utf8')
}

let container: HTMLDivElement
let root: Root | undefined

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
  window.history.replaceState({}, '', '/')
})

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const entry = (patch: Partial<PlaybookEntryRow> = {}): PlaybookEntryRow => {
  return {
    id: 'e1',
    agentId: 'ryen',
    section: 'strategy',
    content: '改完配置先读一遍再动手',
    helpful: 2,
    harmful: 0,
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
    source: 'curator',
    ...patch,
  }
}

/** 五种溯源种类各来一条：面板不自己归类，种类口径由 EntryExplain 给中文。 */
const explanation = {
  entry: entry(),
  summary: '来自 3 次对话、1 条教训',
  origins: [
    { kind: 'trajectory' as const, refId: 'c1', detail: '上周那次改崩了目录', createdAt: 1 },
    { kind: 'reflection' as const, refId: 'r1', detail: '写文件前先确认目录存在', createdAt: 2 },
    { kind: 'feedback' as const, refId: 'f1', detail: '👎 这次改坏了', createdAt: 3 },
    { kind: 'memory' as const, refId: 'm1', detail: '这个项目用 pnpm', createdAt: 4 },
    { kind: 'seed' as const, refId: 'coding', detail: '', createdAt: 5 },
  ],
}

async function renderPanel(api: Record<string, unknown>): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<PlaybookPanel api={api as unknown as ApiClient} agentId="ryen" agentName="Ryen" onClose={() => {}} />)
    await Promise.resolve()
    await Promise.resolve()
  })
  await settle()
}

describe('经验手册：每条经验都能问「它从哪来」', () => {
  it('每条 entry 都挂上溯源入口；展开才请求，拉回来的证据链按中文种类铺开', async () => {
    const explainPlaybookEntry = vi.fn(() => {
      return Promise.resolve(explanation)
    })
    await renderPanel({
      getPlaybook: () => {
        return Promise.resolve({
          entries: [entry(), entry({ id: 'e2', content: '别动别人的 node_modules' })],
          reflections: [],
        })
      },
      setPlaybookStatus: () => {
        return Promise.resolve({ id: 'e1', status: 'deprecated' })
      },
      explainPlaybookEntry,
    })
    const toggles = container.querySelectorAll('.entry-explain-toggle')
    // 每条经验一个入口，默认全收起：不请求就不打扰
    expect(toggles).toHaveLength(2)
    expect(container.querySelector('.entry-explain-body')).toBeNull()
    expect(explainPlaybookEntry).not.toHaveBeenCalled()

    await act(async () => {
      ;(toggles[0] as HTMLElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(explainPlaybookEntry).toHaveBeenCalledWith('e1')
    expect(container.querySelector('.entry-explain-summary')?.textContent).toBe('来自 3 次对话、1 条教训')
    expect(
      [...container.querySelectorAll('.entry-origin-kind')].map((node) => {
        return node.textContent
      }),
    ).toEqual(['对话', '教训', '反馈', '记忆', '种子'])
    // detail 缺失时回落到种类标签，不留空白
    expect(container.querySelectorAll('.entry-origin-detail')[4]?.textContent).toBe('种子')
    // 手册的其余部分没被溯源挤掉：停用按钮还在
    expect(container.querySelectorAll('.memory-delete')).toHaveLength(2)
  })

  it('服务端没这条路由：就地降级一句灰字，手册照常读得出内容', async () => {
    await renderPanel({
      getPlaybook: () => {
        return Promise.resolve({ entries: [entry()], reflections: [] })
      },
      setPlaybookStatus: () => {
        return Promise.resolve({ id: 'e1', status: 'deprecated' })
      },
      explainPlaybookEntry: () => {
        return Promise.reject(new Error('not found: GET /api/evolve/entries/e1/explain'))
      },
    })
    await act(async () => {
      ;(container.querySelector('.entry-explain-toggle') as HTMLElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('来历暂时查不到')
    expect(container.querySelector('.entry-origin-list')).toBeNull()
    expect(container.textContent).toContain('改完配置先读一遍再动手')
  })

  it('数据面整个缺失时也能展开，不静默（否则用户点了没反应）', async () => {
    await renderPanel({
      getPlaybook: () => {
        return Promise.resolve({ entries: [entry()], reflections: [] })
      },
      setPlaybookStatus: () => {
        return Promise.resolve({ id: 'e1', status: 'deprecated' })
      },
    })
    await act(async () => {
      ;(container.querySelector('.entry-explain-toggle') as HTMLElement).click()
      await Promise.resolve()
    })
    expect(container.querySelector('.entry-explain-body')).not.toBeNull()
    expect(container.textContent).toContain('来历暂时查不到')
  })
})

const listAgents: AgentDef[] = [
  { id: 'ryen', name: 'Ryen', avatar: 'cat', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: true },
]

function conversation(index: number): Conversation {
  return {
    id: `c${index}`,
    kind: 'direct',
    title: `会话 ${index}`,
    memberAgentIds: ['ryen'],
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 2 + index,
    lastMessagePreview: `第 ${index} 条的预览`,
  }
}

async function renderList(count: number): Promise<HTMLDivElement> {
  const conversations = Array.from({ length: count }, (_, index) => {
    return conversation(index)
  })
  await act(async () => {
    root = createRoot(container)
    root.render(
      <ConversationList
        conversations={conversations}
        agents={listAgents}
        activeId={undefined}
        api={{}}
        onSelect={() => {}}
      />,
    )
    await Promise.resolve()
  })
  return container.querySelector<HTMLDivElement>('.conversation-list')!
}

const padHeight = (side: 'top' | 'bottom'): number => {
  const node = container.querySelector<HTMLElement>(`[data-window-pad="${side}"]`)
  return node === null || node === undefined ? -1 : Number(node.style.height.replace('px', ''))
}

const rowTitles = (): string[] => {
  return [...container.querySelectorAll('.conversation-item strong')].map((node) => {
    return node.textContent ?? ''
  })
}

describe('会话列表：几千条也只渲染可视区', () => {
  it('3000 条会话不整表进 DOM，上下哨兵撑住滚动几何', async () => {
    const list = await renderList(3000)
    const rows = container.querySelectorAll('.conversation-item')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThanOrEqual(MAX_RENDERED_ROWS)
    expect(rows.length).toBeLessThan(3000)
    // 量不到可视高度时按兜底行数渲染，列表不会空一帧
    expect(rows.length).toBeGreaterThanOrEqual(FALLBACK_VIEWPORT_ROWS)
    // 停在顶部：上哨兵为 0，下哨兵撑住被裁掉的那些行
    expect(padHeight('top')).toBe(0)
    expect(padHeight('bottom')).toBeGreaterThan(0)
    // 滚动容器就是列表本身（CSS 上 .conversation-list 自己 overflow-y: auto）
    expect(list).not.toBeNull()
    expect(rowTitles()[0]).toBe('会话 0')
  })

  it('滚动到中段：窗口换成那一段，stagger 的 --i 仍是这条会话的整表下标', async () => {
    const list = await renderList(3000)
    Object.defineProperty(list, 'clientHeight', { value: 640, configurable: true })
    const rowHeight = 64
    list.scrollTop = rowHeight * 2000
    await act(async () => {
      list.dispatchEvent(new Event('scroll'))
      await new Promise((resolve_) => {
        setTimeout(resolve_, 40)
      })
    })
    const rows = [...container.querySelectorAll<HTMLElement>('.conversation-item')]
    expect(rows.length).toBeLessThanOrEqual(MAX_RENDERED_ROWS)
    // 窗口起点 = 滚动位置所在行 − 上余量
    expect(rows[0]?.textContent).toContain(`会话 ${2000 - DEFAULT_OVERSCAN}`)
    expect(padHeight('top')).toBeGreaterThan(0)
    // --i 走整表下标：第 1994 行不是窗口内的第 0 行
    const title = rows[0]?.querySelector('strong')?.textContent ?? ''
    const index = Number(/会话 (\d+)/.exec(title)?.[1])
    expect(rows[0]?.style.getPropertyValue('--i')).toBe(String(index))
  })

  it('会话很少时一个都不裁：哨兵为 0，列表与接线前一致', async () => {
    await renderList(2)
    expect(container.querySelectorAll('.conversation-item')).toHaveLength(2)
    expect(padHeight('top')).toBe(0)
    expect(padHeight('bottom')).toBe(0)
  })
})

describe('接线清账的静态护栏', () => {
  it('formatTime 只剩 lib/format.ts 一份：ChatView 不再自带拷贝，列表也不再从它借', () => {
    const chatView = sourceOf('components/ChatView.tsx')
    const list = sourceOf('components/ConversationList.tsx')
    expect(chatView).not.toMatch(/function formatTime/)
    expect(chatView).toContain("from '../lib/format.ts'")
    // 反向依赖：列表借道聊天视图格式化时间戳，此前会让 ChatView 变成公共依赖
    expect(list).not.toContain("from './ChatView.tsx'")
    expect(list).toContain("from '../lib/format.ts'")
  })

  it('删除凭据的响应体不再带 deleted: never 这层临时妥协', () => {
    expect(sourceOf('api.ts')).not.toContain('deleted: never')
    // 真实的 ApiClient 直接满足 ProviderApi（编译期护栏：签名再拧回去就报错）
    const client: ProviderApi = new ApiClientImpl('http://127.0.0.1:1')
    expect(typeof client.deleteApiKey).toBe('function')
  })
})

describe('首屏「可交互」打点', () => {
  it('首份会话列表到手后记一次 first-interactive，之后的刷新不重复记', async () => {
    expect(
      readBootPhases().some((phase) => {
        return phase.stage === 'first-interactive'
      }),
    ).toBe(false)
    window.history.replaceState({}, '', '/?api=http://127.0.0.1:32600')
    vi.stubGlobal('fetch', async (input: string) => {
      const path = new URL(String(input)).pathname
      const reply = (body: unknown): Response => {
        return {
          ok: true,
          status: 200,
          json: () => {
            return Promise.resolve(body)
          },
        } as unknown as Response
      }
      if (path === '/api/agents') return reply({ agents: listAgents })
      if (path === '/api/agent-templates') return reply({ templates: [] })
      if (path === '/api/providers') return reply({ providers: [] })
      if (path === '/api/conversations') return reply({ conversations: [conversation(0)] })
      return reply({})
    })
    await act(async () => {
      root = createRoot(container)
      root.render(<App />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    const first = () => {
      return readBootPhases().filter((phase) => {
        return phase.stage === 'first-interactive'
      })
    }
    // 数据到手这一刻才算「可交互」：此前只有 module / dom-ready 这几段
    expect(first()).toHaveLength(1)
    // 再来一次整表刷新也不该冒出第二段（打点本身幂等）
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(first()).toHaveLength(1)
  })
})
