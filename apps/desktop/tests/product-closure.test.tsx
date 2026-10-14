// @vitest-environment jsdom
/**
 * 产品闭环的回归网（D 路）：
 * 停止后不复位、删 agent 文案撒谎、工作区无处可寻、欢迎页没有输入框、
 * 群聊看不到进化、调度轨迹直出机器枚举、弹窗提交失败静默——逐条钉住。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentDef,
  AgentTemplate,
  ApiClient,
  Conversation,
  MessageRow,
  ProviderInfo,
  WsEvent,
} from '../renderer/src/api.ts'
import { ChatView } from '../renderer/src/components/ChatView.tsx'
import { ConfirmDialog } from '../renderer/src/components/ConfirmDialog.tsx'
import { CreateAgentModal } from '../renderer/src/components/ContactsPage.tsx'
import { GroupEvolution, RelayTimeline } from '../renderer/src/components/GroupEvolution.tsx'
import { AboutContent, MePage } from '../renderer/src/components/MePage.tsx'
import { RightPanel } from '../renderer/src/components/RightPanel.tsx'
import { WelcomeHome } from '../renderer/src/components/WelcomeHome.tsx'
import { WorkspaceSection } from '../renderer/src/components/WorkspaceSection.tsx'
import { isGuardRelay, relayChainLabel, relayLabel } from '../renderer/src/lib/relay-labels.ts'
import { getToasts } from '../renderer/src/lib/toast.ts'
import { ALL_TOOLS, toolLabel } from '../renderer/src/lib/tool-labels.ts'
import { LEAVE_MS } from '../renderer/src/lib/useLeaving.ts'
import { ChatStore } from '../renderer/src/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agent: AgentDef = {
  id: 'ryen',
  name: 'Ryen',
  avatar: 'cat',
  systemPrompt: '你是 Ryen。',
  provider: 'siliconflow',
  model: 'deepseek-ai/DeepSeek-V3',
  tools: ['fs_read'],
  isBuiltin: true,
}

const coder: AgentDef = {
  id: 'coder',
  name: 'CodeBot',
  avatar: 'db:dylan:seed1',
  systemPrompt: '你是 CodeBot。',
  provider: 'siliconflow',
  model: 'deepseek-ai/DeepSeek-V3',
  tools: [],
  isBuiltin: false,
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

const templates: AgentTemplate[] = [
  {
    key: 'general',
    name: '通用助理',
    description: '什么都能聊',
    suggestedSystemPrompt: '你是通用助理。',
    defaultTools: ['fs_read'],
    defaultModel: 'deepseek-ai/DeepSeek-V3',
  },
]

const providers: ProviderInfo[] = [
  { id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: true, models: [{ id: 'm' }] },
]

function historyRow(): MessageRow {
  return {
    id: 'm1',
    seq: 1,
    conversationId: 'c1',
    senderType: 'agent',
    senderId: 'ryen',
    contentBlocks: [{ type: 'text', text: '历史消息' }],
    mentions: [],
    turnIndex: 0,
    createdAt: 1000,
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  vi.useFakeTimers()
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
  vi.useRealTimers()
})

/** 受控 textarea 输入：走原生 setter + input 事件（React 受控组件的标准打法）。 */
function typeInto(node: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('调度原因的中文口径', () => {
  it('面板口径把机器枚举翻成人话', () => {
    expect(relayLabel('user-mention')).toBe('你点名了它')
    expect(relayLabel('default-dispatcher')).toBe('总管默认接手')
    expect(relayLabel('loop-guard')).toBe('互相推诿已拦下')
    expect(relayLabel('max-turns')).toBe('达到轮次上限')
    expect(relayLabel('relay @CodeBot')).toBe('点名转交给了CodeBot')
    // 未知 reason 原样透出，不吞信息也不编故事。
    expect(relayLabel('brand-new-reason')).toBe('brand-new-reason')
  })

  it('接力链用同源的紧凑标签', () => {
    expect(relayChainLabel('user-mention')).toBe('点名')
    expect(relayChainLabel('relay @CodeBot')).toBe('转交')
    expect(isGuardRelay('loop-guard')).toBe(true)
    expect(isGuardRelay('max-turns')).toBe(true)
    expect(isGuardRelay('user-mention')).toBe(false)
  })
})

describe('群聊右栏：看得见的进化', () => {
  it('成员逐个给出记忆/经验手册入口（群聊此前完全没有）', () => {
    const onShowMemories = vi.fn()
    const onShowPlaybook = vi.fn()
    const html = renderToStaticMarkup(
      <GroupEvolution members={[agent, coder]} onShowMemories={onShowMemories} onShowPlaybook={onShowPlaybook} />,
    )
    expect(html).toContain('谁在进化')
    expect(html).toContain('CodeBot')
    // 每个成员两个入口（title 里也带名字，所以按按钮数断言而不是按出现次数）。
    expect(html.match(/class="btn btn-mini"/g)).toHaveLength(4)
    expect(html).toContain('查看 CodeBot 的经验手册')
    expect(html).toContain('查看 Ryen 的记忆')
  })

  it('调度轨迹渲染中文标签而不是 loop-guard', () => {
    const html = renderToStaticMarkup(
      <RelayTimeline
        nameOf={(id) => {
          return id === 'ryen' ? 'Ryen' : 'CodeBot'
        }}
        relays={[
          { toAgent: 'ryen', reason: 'default-dispatcher', turnIndex: 0 },
          { fromAgent: 'ryen', toAgent: 'coder', reason: 'loop-guard', turnIndex: 1 },
        ]}
      />,
    )
    expect(html).toContain('总管默认接手')
    expect(html).toContain('互相推诿已拦下')
    expect(html).toContain('is-guard')
    expect(html).not.toContain('loop-guard')
    expect(html).not.toContain('default-dispatcher')
  })

  it('空轨迹给出说明而不是空白', () => {
    const html = renderToStaticMarkup(
      <RelayTimeline
        nameOf={() => {
          return 'x'
        }}
        relays={[]}
      />,
    )
    expect(html).toContain('本轮还没有调度事件')
  })

  it('右栏群聊分支真的把两个组件接上了（组件建好但没人接线等于没做）', async () => {
    const store = new ChatStore()
    store.setDispatchHistory([{ fromAgent: 'ryen', toAgent: 'coder', reason: 'loop-guard', turnIndex: 1 }])
    // RightPanel 自己订阅 store（useSyncExternalStore），必须在客户端渲染。
    await act(async () => {
      root = createRoot(container)
      root.render(
        <RightPanel
          api={
            {
              // 右栏末尾会拉一次会话 token 用量（GET /api/conversations/:id）。
              conversationDetail: () => {
                return Promise.resolve({
                  conversation,
                  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, messages: 1 },
                })
              },
            } as unknown as ApiClient
          }
          store={store}
          conversation={{ ...conversation, kind: 'group', memberAgentIds: ['ryen', 'coder'] }}
          agents={[agent, coder]}
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
    const panel = container.textContent ?? ''
    expect(panel).toContain('谁在进化')
    expect(panel).toContain('互相推诿已拦下')
    expect(panel).not.toContain('loop-guard')
  })
})

describe('ChatView：点「停止」后不复死在生成中', () => {
  let store: ChatStore
  let push: (event: WsEvent) => void
  let cancelled: number

  function fakeApi(): ApiClient {
    return {
      messages: () => {
        return Promise.resolve({ messages: [historyRow()] })
      },
      markRead: () => {
        return Promise.resolve({ conversationId: 'c1', lastReadSeq: 1 })
      },
      listDispatchEvents: () => {
        return Promise.resolve({ events: [] })
      },
      postMessage: () => {
        return Promise.resolve({ accepted: true })
      },
      cancelTurn: () => {
        cancelled += 1
        return Promise.resolve({ cancelled: true })
      },
      fileUrl: (name: string) => {
        return `/api/files/${name}`
      },
      subscribe: (_id: string, onEvent: (event: WsEvent) => void) => {
        push = onEvent
        return () => {}
      },
    } as unknown as ApiClient
  }

  async function render(): Promise<void> {
    await act(async () => {
      root = createRoot(container)
      root.render(<ChatView api={fakeApi()} conversation={conversation} agents={[agent]} store={store} />)
      await Promise.resolve()
    })
  }

  function emit(event: WsEvent): void {
    act(() => {
      push(event)
      vi.advanceTimersByTime(50)
    })
  }

  beforeEach(() => {
    store = new ChatStore()
    cancelled = 0
  })

  it('点停止立即复位输入区并显示「已停止」，ABORTED 不进错误横幅', async () => {
    await render()
    emit({ type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 1 })
    expect(container.querySelector('.typing-indicator')).not.toBeNull()
    expect(container.querySelector('.stop-btn')).not.toBeNull()

    // 用户的主动选择：立刻复位，不等服务端确认（那正是"像卡死"的观感来源）。
    act(() => {
      container.querySelector<HTMLButtonElement>('.stop-btn')!.click()
      vi.advanceTimersByTime(50)
    })
    expect(cancelled).toBe(1)
    // 停止按钮与打字指示器同属统一退场体系：点完即刻失效（.is-leaving 带走
    // pointer-events），150ms 淡出后卸载——不再是一帧消失的硬切换。
    expect(container.querySelector('.stop-btn.is-leaving')).not.toBeNull()
    expect(container.querySelector('.stopped-hint')?.textContent).toContain('已停止')
    // 流式气泡冻结成完结态，光标不会一直闪。
    expect(container.querySelector('.bubble-cursor')).toBeNull()
    // 打字指示器按统一退场体系淡出（150ms）后卸载，不会一直挂在那儿。
    act(() => {
      vi.advanceTimersByTime(LEAVE_MS)
    })
    expect(container.querySelector('.typing-indicator')).toBeNull()
    expect(container.querySelector('.stop-btn')).toBeNull()

    // 服务端随后补的 ABORTED：不是故障，不该出现红条。
    emit({ type: 'error', conversationId: 'c1', message: '已停止生成', code: 'ABORTED' })
    expect(container.querySelector('.error-banner')).toBeNull()
    expect(container.querySelector('.stopped-hint')).not.toBeNull()
  })

  it('真正的失败仍然显示错误横幅', async () => {
    await render()
    emit({ type: 'error', conversationId: 'c1', message: '上游超时', code: 'UPSTREAM' })
    expect(container.querySelector('.error-banner')?.textContent).toContain('上游超时')
    expect(container.querySelector('.stopped-hint')).toBeNull()
  })

  it('新一轮开始即清掉「已停止」', async () => {
    await render()
    emit({ type: 'error', conversationId: 'c1', message: '已停止生成', code: 'ABORTED' })
    expect(container.querySelector('.stopped-hint')).not.toBeNull()
    emit({ type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 1 })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(container.querySelector('.stopped-hint')).toBeNull()
  })
})

describe('欢迎页：能开口，也能改口', () => {
  function renderWelcome(onSend: (text: string) => void = () => {}): void {
    act(() => {
      root = createRoot(container)
      root.render(
        <WelcomeHome
          ryen={agent}
          agents={[agent]}
          conversations={[]}
          providers={providers}
          onSaveApiKey={() => {
            return Promise.resolve()
          }}
          onSend={onSend}
          onOpenConversation={() => {}}
        />,
      )
    })
  }

  it('点 chip 只把文案填进输入框并聚焦，不替用户发出去', () => {
    const sent: string[] = []
    renderWelcome((text) => {
      sent.push(text)
    })
    const chip = [...container.querySelectorAll('.welcome-chip')].find((node) => {
      return node.textContent?.includes('本周周报')
    })!
    act(() => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const textarea = container.querySelector('textarea')!
    expect(textarea.value).toBe('帮我整理一份本周周报')
    expect(document.activeElement).toBe(textarea)
    expect(sent).toEqual([])
  })

  it('Enter 才真的发出去', () => {
    const sent: string[] = []
    renderWelcome((text) => {
      sent.push(text)
    })
    const chip = container.querySelector('.welcome-chip')!
    act(() => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const textarea = container.querySelector('textarea')!
    typeInto(textarea, '帮我整理本周周报，顺便标出风险')
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(sent).toEqual(['帮我整理本周周报，顺便标出风险'])
  })
})

describe('工作区：路径要看得见、点得开', () => {
  it('展示服务端给的路径并给出两个出口', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <WorkspaceSection
          api={{
            workspace: () => {
              return Promise.resolve({ path: 'C:/Users/zry/AppData/ryagent/workspace' })
            },
          }}
        />,
      )
      await Promise.resolve()
    })
    expect(container.querySelector('.workspace-path')?.textContent).toBe('C:/Users/zry/AppData/ryagent/workspace')
    const labels = [...container.querySelectorAll('.workspace-actions button')].map((node) => {
      return node.textContent
    })
    expect(labels).toEqual(['打开所在目录', '复制路径'])
  })

  it('端点不可用时说清楚原因，而不是留一个空白区块', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <WorkspaceSection
          api={{
            workspace: () => {
              return Promise.reject(new Error('404'))
            },
          }}
        />,
      )
      await Promise.resolve()
    })
    expect(container.querySelector('.apikey-error')?.textContent).toContain('读不到工作区路径')
  })
})

describe('「我的」页：用户与 agent 分开说', () => {
  async function renderMePage(): Promise<void> {
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
            setApiKey: () => {
              return Promise.resolve({ providerId: 'siliconflow', configured: true })
            },
            workspace: () => {
              return Promise.resolve({ path: 'C:/data/workspace' })
            },
          }}
          ryen={agent}
          providers={providers}
          theme="light"
          onThemeChange={() => {}}
        />,
      )
      await Promise.resolve()
    })
  }

  it('用户卡是「你」，猫管家另起一张卡', async () => {
    await renderMePage()
    const card = container.querySelector('.me-usercard')!
    expect(card.textContent).toContain('你')
    expect(card.textContent).not.toContain('Ryen')
    const butler = container.querySelector('.me-butler')!
    expect(butler.textContent).toContain('Ryen')
    expect(butler.textContent).toContain('内置 Agent')
  })

  it('工作区区块在页面上', async () => {
    await renderMePage()
    expect(container.querySelector('.workspace-path')?.textContent).toBe('C:/data/workspace')
  })

  it('About 的第三方署名只写实际在用的资产', () => {
    const html = renderToStaticMarkup(<AboutContent />)
    // 实际在用的 DiceBear 只有 dylan（Dylan! by Natalia Spivak）与 mascot（Fun Emoji
    // by Davis Uche）两族；Fluent Emoji 已随 emoji 退场整体移除。三条都要钉住。
    expect(html).toContain('Natalia Spivak')
    expect(html).toContain('Dylan!')
    expect(html).toContain('Fun Emoji')
    expect(html).toContain('Davis Uche')
    expect(html).not.toContain('Fluent Emoji')
    expect(html).not.toContain('Adventurer')
    expect(html).not.toContain('Big Ears')
    expect(html).not.toContain('lorelei')
    expect(html).not.toContain('notionists')
  })

  it('Lucide 只报名字不报数量：图标注册表随时会增删，写死数字必然过期', () => {
    const html = renderToStaticMarkup(<AboutContent />)
    expect(html).toContain('Lucide')
    expect(html).not.toMatch(/Lucide[^<]*\d+\s*个/)
  })
})

describe('危险操作确认弹窗', () => {
  it('Modal 皮肤 + 取消/删除两个出口', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        title="删除「小译」？"
        body="删除后不可恢复"
        onConfirm={() => {
          return Promise.resolve()
        }}
        onCancel={() => {}}
      />,
    )
    expect(html).toContain('modal-mask')
    expect(html).toContain('删除后不可恢复')
    expect(html).toContain('取消')
    expect(html).toContain('删除')
  })
})

describe('弹窗提交失败不再静默', () => {
  it('保存 agent 失败：留在原地 + toast 说明原因', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <CreateAgentModal
          templates={templates}
          providers={providers}
          onSubmit={() => {
            return Promise.reject(new Error('provider 未配置 key'))
          }}
          onClose={() => {
            throw new Error('失败时不应关窗')
          }}
        />,
      )
      await Promise.resolve()
    })
    const save = [...container.querySelectorAll('.modal-actions button')].find((node) => {
      return node.textContent === '保存'
    }) as HTMLButtonElement
    await act(async () => {
      save.click()
      await Promise.resolve()
    })
    expect(getToasts().map((item) => item.text)).toContain('创建失败：provider 未配置 key')
    // 弹窗仍在：用户看得到发生了什么，也能改完再试。
    expect(container.querySelector('.modal')).not.toBeNull()
  })
})

describe('工具中文名只有一份', () => {
  it('新建表单与右栏徽章读同一张表', () => {
    expect(ALL_TOOLS).toEqual(['fs_read', 'fs_write', 'shell_exec', 'file_produce'])
    expect(toolLabel('fs_read')).toBe('读文件')
    // 未知工具原样透出，不显示空白。
    expect(toolLabel('mystery_tool')).toBe('mystery_tool')
  })
})
