// @vitest-environment jsdom
/**
 * 窄窗下右栏改走**覆盖式抽屉**。
 *
 * 此前样式表里那条 `@media (max-width: 1199px) { .right-panel { display: none } }`
 * 把整块信息板藏了：记忆、手册、待办、调度轨迹在这个宽度下**一个入口都没有**。
 * 内容还在服务端，界面上既看不到也打不开，用户只能把窗口拉宽才找得到。
 *
 * 现在面板保留在 DOM 里，关着时滑出屏幕右侧，开着时盖在聊天区上面；聊天头部多
 * 一枚常驻按钮作为入口，遮罩与 Esc 负责关掉它。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isNarrowViewport, NARROW_PANEL_MAX_WIDTH } from '../renderer/src/App.tsx'
import { type AgentDef, ApiClient, type Conversation } from '../renderer/src/api.ts'
import { RightPanel } from '../renderer/src/components/RightPanel.tsx'
import { ChatStore } from '../renderer/src/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const conversation: Conversation = {
  id: 'c1',
  kind: 'direct',
  title: 'Ryen',
  memberAgentIds: ['ryen'],
  lastReadSeq: 1,
  createdAt: 1,
  updatedAt: 2,
}

const agent: AgentDef = {
  id: 'ryen',
  name: 'Ryen',
  systemPrompt: '你是 Ryen。',
  provider: 'siliconflow',
  model: 'deepseek-ai/DeepSeek-V3',
  tools: [],
  isBuiltin: true,
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = undefined
  container.remove()
  vi.restoreAllMocks()
})

function panelApi(): ApiClient {
  const api = new ApiClient('http://api.test')
  vi.spyOn(api, 'conversationDetail').mockResolvedValue({
    conversation,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, messages: 0 },
  })
  api.listTodos = vi.fn(async () => {
    return { conversationId: 'c1', items: [] }
  })
  return api
}

function renderPanel(props: { overlay?: boolean; open?: boolean; collapsed?: boolean; onToggle?: () => void }): void {
  act(() => {
    root?.render(
      <RightPanel
        api={panelApi()}
        store={new ChatStore()}
        conversation={conversation}
        agents={[agent]}
        conversations={[conversation]}
        fileUrl={(name) => {
          return `http://api.test/files/${name}`
        }}
        collapsed={props.collapsed ?? false}
        {...(props.overlay === undefined ? {} : { overlay: props.overlay })}
        {...(props.open === undefined ? {} : { open: props.open })}
        onToggle={props.onToggle ?? (() => {})}
      />,
    )
  })
}

describe('窄窗判定', () => {
  it('断点与样式表一致（1199 及以下算窄）', () => {
    expect(NARROW_PANEL_MAX_WIDTH).toBe(1199)
  })

  it('按视口宽度判断', () => {
    const original = window.innerWidth
    try {
      Object.defineProperty(window, 'innerWidth', { value: 1100, configurable: true })
      expect(isNarrowViewport()).toBe(true)
      Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true })
      expect(isNarrowViewport()).toBe(false)
      Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true })
      expect(isNarrowViewport()).toBe(false)
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: original, configurable: true })
    }
  })
})

describe('覆盖式抽屉', () => {
  it('面板在窄窗时仍渲染（此前是 display:none，一个入口都没有）', () => {
    renderPanel({ overlay: true, open: false })
    expect(container.querySelector('.right-panel')).not.toBeNull()
    expect(container.querySelector('.right-panel')?.className).toContain('is-overlay')
  })

  it('关着时没有 is-overlay-open，开了才有', () => {
    renderPanel({ overlay: true, open: false })
    expect(container.querySelector('.right-panel')?.className).not.toContain('is-overlay-open')
    renderPanel({ overlay: true, open: true })
    expect(container.querySelector('.right-panel')?.className).toContain('is-overlay-open')
  })

  it('面板上那枚键是「收起信息板」，点它通知宿主', () => {
    const onToggle = vi.fn()
    renderPanel({ overlay: true, open: true, onToggle })
    const button = container.querySelector('.panel-expand-btn')
    expect(button?.getAttribute('aria-label')).toBe('收起信息板')
    act(() => {
      ;(button as HTMLButtonElement).click()
    })
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('宽窗下仍按手动态走：收起态是窄边，不是抽屉', () => {
    renderPanel({ overlay: false, collapsed: true })
    const panel = container.querySelector('.right-panel')
    expect(panel?.className).toContain('is-collapsed')
    expect(panel?.className).not.toContain('is-overlay')
  })
})
