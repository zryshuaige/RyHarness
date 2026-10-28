// @vitest-environment jsdom
/**
 * 右栏待办区：清单渲染、勾选走 API、清空，以及插件关闭时的降级文案。
 *
 * 用真的 ApiClient（只替换三条待办方法与 conversationDetail）：状态码从 request
 * 层带上来，404 的「插件已关闭」分支才有真实依据，而不是靠抛一句特定中文。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AgentDef, ApiClient, ApiRequestError, type Conversation } from '../renderer/src/api.ts'
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
  tools: ['todo'],
  isBuiltin: true,
}

const items = [
  { id: 't1', text: '买牛奶', done: false, createdAt: 1 },
  { id: 't2', text: '交房租', done: true, createdAt: 2 },
  { id: 't3', text: '给妈妈打电话', done: false, createdAt: 3 },
]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = undefined
  container.remove()
  vi.restoreAllMocks()
})

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

/** 一份可用的 api：待办三条方法可被单独替换，其余右栏依赖给最小回包。 */
function panelApi(): ApiClient {
  const api = new ApiClient('http://api.test')
  vi.spyOn(api, 'conversationDetail').mockResolvedValue({
    conversation,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, messages: 0 },
  })
  api.listTodos = vi.fn(async () => {
    return { conversationId: 'c1', items: items.map((item) => ({ ...item })) }
  })
  api.setTodoDone = vi.fn(async (_conversationId: string, id: string, done: boolean) => {
    return {
      conversationId: 'c1',
      items: items.map((item) => {
        return item.id === id ? { ...item, done } : { ...item }
      }),
    }
  })
  api.clearTodos = vi.fn(async () => {
    return { conversationId: 'c1', items: [] }
  })
  return api
}

async function renderPanel(api: ApiClient): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(
      <RightPanel
        api={api}
        store={new ChatStore()}
        conversation={conversation}
        agents={[agent]}
        conversations={[conversation]}
        fileUrl={(name) => {
          return `/api/files/${name}`
        }}
        collapsed={false}
        onToggle={() => {}}
      />,
    )
    await Promise.resolve()
  })
  await flush()
}

function checkboxFor(text: string): HTMLInputElement {
  const found = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => {
    return input.closest('label')?.textContent?.includes(text) === true
  })
  if (found === undefined) throw new Error(`找不到待办勾选框：${text}`)
  return found
}

describe('右栏待办区', () => {
  it('显示当前会话清单；勾选调用 PATCH 并把完成态画出来', async () => {
    const api = panelApi()
    await renderPanel(api)
    expect(container.textContent).toContain('待办（3）')
    expect(container.textContent).toContain('买牛奶')
    expect(checkboxFor('交房租').checked).toBe(true)
    expect(checkboxFor('买牛奶').checked).toBe(false)

    await act(async () => {
      checkboxFor('买牛奶').click()
      await Promise.resolve()
    })
    await flush()
    expect(api.setTodoDone).toHaveBeenCalledWith('c1', 't1', true)
    expect(checkboxFor('买牛奶').checked).toBe(true)
    expect(checkboxFor('买牛奶').closest('label')?.className).toContain('is-done')
  })

  it('清空先问一句，确认后走 DELETE；空态文案自然，不再留按钮', async () => {
    const api = panelApi()
    await renderPanel(api)
    const clear = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => {
      return button.textContent === '清空'
    })
    expect(clear).toBeDefined()
    await act(async () => {
      clear?.click()
      await Promise.resolve()
    })
    // 一键清空整个清单是右栏里最狠的一个动作：先弹确认，确认之前不碰服务端。
    expect(api.clearTodos).not.toHaveBeenCalled()
    const confirm = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => {
      return button.textContent === '清空' && button !== clear
    })
    expect(confirm).toBeDefined()
    await act(async () => {
      confirm?.click()
      await Promise.resolve()
    })
    await flush()
    expect(api.clearTodos).toHaveBeenCalledWith('c1')
    expect(container.textContent).toContain('还没有待办')
    expect(
      [...container.querySelectorAll('button')].some((button) => {
        return button.textContent === '清空'
      }),
    ).toBe(false)
  })

  it('插件关闭（路由 404）显示「待办插件已关闭」，不弹错误', async () => {
    const api = panelApi()
    api.listTodos = vi.fn(async () => {
      throw new ApiRequestError('not found: GET /api/todos', 404, 'NOT_FOUND')
    })
    await renderPanel(api)
    expect(container.textContent).toContain('待办插件已关闭')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).not.toContain('没读出来')
  })

  it('服务端没有待办接口时整块不渲染（旧版/精简替身不报错）', async () => {
    const api = panelApi()
    // 模拟「压根没有这三个方法」（不是调用失败）。类型上它们是必填方法——生产
    // 环境的客户端一定带着它们——所以这里用 Object.assign 把它们抹掉，而不是
    // 直接赋值 undefined（那会与类型冲突，也说清了这不是「方法返回 undefined」）。
    Object.assign(api, { listTodos: undefined, setTodoDone: undefined, clearTodos: undefined })
    await renderPanel(api)
    expect(container.textContent).not.toContain('还没有待办')
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(container.textContent).toContain('Ryen')
  })
})
