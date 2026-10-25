// @vitest-environment jsdom
/**
 * 本轮 UI/UX 审计的回归护栏：后端原文不上屏、异步四态不互相冒充、破坏性操作可撤销、
 * 未保存的表单不会被一键关掉。
 *
 * 这些用例刻意从**用户能看到的东西**断言：错误条的第一句、toast 上有没有撤销、
 * 弹窗关不关得掉。内部状态只作为「重试真的又请求了一次」的证据。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../renderer/src/App.tsx'
import type {
  AgentDef,
  AgentTemplate,
  Conversation,
  MemoryRow,
  MessageRow,
  PluginView,
  ProviderInfo,
} from '../renderer/src/api.ts'
import { ApiClient, ApiRequestError } from '../renderer/src/api.ts'
import { ArtifactPreviewContent } from '../renderer/src/components/ArtifactPreview.tsx'
import { ChatView, fromHistory, parseStoredFailure } from '../renderer/src/components/ChatView.tsx'
import { ContactsPage, CreateAgentModal } from '../renderer/src/components/ContactsPage.tsx'
import { ConversationList } from '../renderer/src/components/ConversationList.tsx'
import { GroupSettingsModal } from '../renderer/src/components/GroupSettingsModal.tsx'
import { MemoryPanel } from '../renderer/src/components/MemoryPanel.tsx'
import { MePage } from '../renderer/src/components/MePage.tsx'
import { MessageBubble } from '../renderer/src/components/MessageBubble.tsx'
import { PlaybookPanel } from '../renderer/src/components/PlaybookPanel.tsx'
import { PluginsPage } from '../renderer/src/components/PluginsPage.tsx'
import { ToastHost } from '../renderer/src/components/ToastHost.tsx'
import { WelcomeHome } from '../renderer/src/components/WelcomeHome.tsx'
import {
  humanDuration,
  humanMime,
  humanPreview,
  humanTokens,
  LOCAL_DATA_NOTE,
  protocolLabel,
} from '../renderer/src/lib/humanize.ts'
import { getToasts, toast } from '../renderer/src/lib/toast.ts'
import { bucketOf, ChatStore } from '../renderer/src/store.ts'
import { TEST_PERSONA } from './fixtures.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  for (const item of getToasts()) toast.dismiss(item.id)
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
  window.history.replaceState({}, '', '/')
})

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function text(): string {
  return container.textContent ?? ''
}

function click(node: Element | null | undefined): void {
  expect(node).not.toBeNull()
  act(() => {
    ;(node as HTMLElement).click()
  })
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => {
    return node.textContent?.trim() === label
  })
}

const provider: ProviderInfo = {
  id: 'siliconflow',
  displayName: 'SiliconFlow',
  apiKeyConfigured: true,
  protocol: 'openai',
  models: [],
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

const templates: AgentTemplate[] = [
  {
    key: 'general',
    name: '通用助理',
    description: '什么都能聊',
    suggestedSystemPrompt: '你是通用助理。',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    persona: TEST_PERSONA,
    defaultTools: [],
  },
]

const conversation: Conversation = {
  id: 'c1',
  kind: 'direct',
  title: 'Ryen',
  memberAgentIds: ['ryen'],
  lastReadSeq: 0,
  createdAt: 1,
  updatedAt: 2,
}

function messageRow(partial: Partial<MessageRow> & Pick<MessageRow, 'id' | 'seq'>): MessageRow {
  return {
    conversationId: 'c1',
    senderType: 'agent',
    senderId: 'ryen',
    contentBlocks: [{ type: 'text', text: '你好' }],
    mentions: [],
    turnIndex: 0,
    createdAt: 1000,
    ...partial,
  }
}

function memoryRow(partial: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: 'm1',
    agentId: 'ryen',
    kind: 'fact',
    content: '用户喜欢简洁的回复',
    createdAt: 1,
    updatedAt: 2,
    accessCount: 0,
    ...partial,
  }
}

/** 真客户端 + 逐方法替换：不引入 `as unknown as`，也保证组件拿到的是同一套契约。 */
function stubbedClient(): ApiClient {
  const api = new ApiClient('http://127.0.0.1:32100')
  vi.spyOn(api, 'subscribe').mockReturnValue(() => {})
  vi.spyOn(api, 'markRead').mockResolvedValue({ conversationId: 'c1', lastReadSeq: 0 })
  vi.spyOn(api, 'listDispatchEvents').mockResolvedValue({ events: [] })
  vi.spyOn(api, 'plugins').mockResolvedValue({ plugins: [] })
  vi.spyOn(api, 'workspace').mockResolvedValue({ path: 'C:/data/workspace' })
  return api
}

describe('人话层：开发单位不上屏', () => {
  it('错误码预览转成一句人话', () => {
    expect(humanPreview('[error:NO_ADAPTER] no adapter registered for provider "mock"')).toBe(
      '无法完成 · 这个模型服务没接进来',
    )
    expect(humanPreview('普通消息')).toBe('普通消息')
  })

  it('耗时换算成秒，MIME 换算成文件类型，协议换算成中文', () => {
    expect(humanDuration(1834)).toBe('约 1.8 秒')
    expect(humanDuration(12)).toBe('0.01 秒')
    expect(humanDuration(1000)).toBe('约 1 秒')
    expect(humanMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('Word 文档')
    expect(humanMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('表格')
    expect(humanMime('application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe('演示文稿')
    expect(humanMime('application/pdf')).toBe('PDF')
    expect(humanMime('image/png')).toBe('图片')
    expect(humanMime('application/octet-stream')).toBe('文件')
    expect(protocolLabel('openai')).toBe('OpenAI 兼容')
    expect(protocolLabel('ollama')).toBe('本地 Ollama')
    expect(protocolLabel('anthropic')).toBe('Anthropic 协议')
    expect(protocolLabel('gemini')).toBe('自定义协议')
  })

  it('用量口径是「字」，不是 token', () => {
    expect(humanTokens(1300)).toBe('约 1.3 千字')
    expect(humanTokens(12840)).toBe('约 1.3 万字')
  })

  it('隐私文案同时说清「存本机」与「推理会发送上下文」', () => {
    expect(LOCAL_DATA_NOTE).toContain('对话与记忆存储在本机')
    expect(LOCAL_DATA_NOTE).toContain('推理时会把当前上下文发送给你选择的模型供应商')
    expect(LOCAL_DATA_NOTE).not.toContain('不上传到任何服务器')
  })
})

describe('会话预览与搜索命中里的错误串', () => {
  it('会话列表预览走 humanPreview', () => {
    const html = renderToStaticMarkup(
      <ConversationList
        conversations={[
          {
            ...conversation,
            lastMessagePreview: '[error:NO_ADAPTER] no adapter registered for provider "mock"',
          },
        ]}
        agents={[ryen]}
        activeId={undefined}
        onSelect={() => {}}
      />,
    )
    expect(html).toContain('无法完成 · 这个模型服务没接进来')
    expect(html).not.toContain('[error:')
    expect(html).not.toContain('no adapter registered')
  })

  it('搜索命中片段也走 humanPreview，不把原文漏出来', async () => {
    vi.useFakeTimers()
    await act(async () => {
      root = createRoot(container)
      root.render(
        <ConversationList
          conversations={[conversation]}
          agents={[ryen]}
          activeId={undefined}
          onSelect={() => {}}
          api={{
            searchMessages: () => {
              return Promise.resolve({
                results: [
                  {
                    conversationId: 'c1',
                    conversationTitle: 'Ryen',
                    messageId: 'm1',
                    agentId: 'ryen',
                    createdAt: 1,
                    snippet: '[error:NO_ADAPTER] no adapter registered for provider "mock"',
                  },
                ],
              })
            },
          }}
        />,
      )
      await Promise.resolve()
    })
    const input = container.querySelector<HTMLInputElement>('.search-box')
    expect(input).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'adapter')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      vi.advanceTimersByTime(300)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('.search-hit-snippet')?.textContent).toBe('无法完成 · 这个模型服务没接进来')
    expect(container.querySelector('.search-hit-snippet')?.textContent).not.toContain('[error:')
    vi.useRealTimers()
  })
})

describe('历史里的失败：提示条而不是 agent 气泡', () => {
  it('fromHistory 把 [error:CODE] 标记成 failure，且不再作为普通文本部件', () => {
    const parsed = parseStoredFailure('[error:NO_ADAPTER] no adapter registered for provider "mock"')
    expect(parsed).toEqual({ code: 'NO_ADAPTER', message: 'no adapter registered for provider "mock"' })
    const messages = fromHistory(
      [
        messageRow({
          id: 'm1',
          seq: 1,
          senderType: 'system',
          contentBlocks: [{ type: 'text', text: '[error:NO_ADAPTER] no adapter registered' }],
        }),
      ],
      (id) => id,
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]?.failure).toEqual({ code: 'NO_ADAPTER', message: 'no adapter registered' })
    expect(messages[0]?.parts).toEqual([])
  })

  it('重开会话时画成失败提示条：首句是人话，原文折进「详情」', async () => {
    const api = stubbedClient()
    vi.spyOn(api, 'messages').mockResolvedValue({
      messages: [
        messageRow({
          id: 'm1',
          seq: 1,
          senderType: 'system',
          contentBlocks: [{ type: 'text', text: '[error:NO_ADAPTER] no adapter registered for provider "mock"' }],
        }),
      ],
    })
    await act(async () => {
      root = createRoot(container)
      root.render(<ChatView api={api} conversation={conversation} agents={[ryen]} bucket={bucketOf(new ChatStore())} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const banner = container.querySelector('.error-banner')
    expect(banner).not.toBeNull()
    expect(banner?.querySelector('strong')?.textContent).toBe('这个模型服务没接进来。')
    // 它不是一个 agent 气泡：没有可点赞/朗读的气泡行。
    expect(container.querySelector('.bubble-row')).toBeNull()
    // 原文仍然拿得到，但只在展开的「详情」里。
    expect(banner?.querySelector('details code')?.textContent).toContain('[error:NO_ADAPTER]')
    expect(banner?.querySelector('details summary')?.textContent).toBe('详情')
  })
})

describe('异步四态：加载、失败、空互不冒充', () => {
  it('ChatView 历史读取失败：错误条 + 重试，不画成「新的对话」', async () => {
    const api = stubbedClient()
    let calls = 0
    vi.spyOn(api, 'messages').mockImplementation(() => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('HTTP 500'))
      return Promise.resolve({ messages: [messageRow({ id: 'm1', seq: 1 })] })
    })
    await act(async () => {
      root = createRoot(container)
      root.render(<ChatView api={api} conversation={conversation} agents={[ryen]} bucket={bucketOf(new ChatStore())} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(text()).toContain('历史消息没读出来')
    expect(text()).not.toContain('新的对话')
    expect(container.querySelector('details')?.textContent).toContain('HTTP 500')
    click(buttonByText('重试'))
    await settle()
    expect(calls).toBe(2)
    expect(text()).toContain('你好')
    expect(text()).not.toContain('历史消息没读出来')
  })

  it('MemoryPanel 读取失败：错误条 + 重试，不画成「还没有记忆」', async () => {
    const api = stubbedClient()
    vi.spyOn(api, 'memoryHealth').mockResolvedValue({ enabled: false })
    vi.spyOn(api, 'listArchivedMemories').mockResolvedValue({ items: [] })
    let calls = 0
    vi.spyOn(api, 'listAgentMemories').mockImplementation(() => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('向量库打不开'))
      return Promise.resolve({ agent: [memoryRow()], shared: [] })
    })
    await act(async () => {
      root = createRoot(container)
      root.render(
        <MemoryPanel api={api} agentId="ryen" agentName="Ryen" conversationTitles={new Map()} onClose={() => {}} />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(text()).toContain('记忆没读出来')
    expect(text()).not.toContain('还没有记忆')
    expect(container.querySelector('details')?.textContent).toContain('向量库打不开')
    click(buttonByText('重试'))
    await settle()
    expect(calls).toBe(2)
    expect(text()).toContain('用户喜欢简洁的回复')
  })

  it('通讯录加载期画联系人卡骨架，不说「通讯录还是空的」', () => {
    const html = renderToStaticMarkup(
      <ContactsPage
        agents={[ryen]}
        templates={templates}
        loading
        onChat={() => {}}
        onCreateAgent={() => {}}
        onEditAgent={() => {}}
        onDeleteAgent={() => {}}
        onCreateGroup={() => {}}
      />,
    )
    expect(html).toContain('contact-grid')
    expect(html).toContain('skeleton')
    expect(html).not.toContain('通讯录还是空的')
  })

  it('欢迎页供应商加载期：轻骨架 + 输入框不锁', () => {
    const html = renderToStaticMarkup(
      <WelcomeHome
        ryen={ryen}
        agents={[ryen]}
        conversations={[]}
        providers={[]}
        providersLoading
        onSaveApiKey={() => Promise.resolve()}
        onSend={() => {}}
        onOpenConversation={() => {}}
      />,
    )
    expect(html).toContain('正在读取模型供应商')
    expect(html).not.toContain('先填一个 API Key')
    expect(html).not.toMatch(/<textarea[^>]*disabled/)
  })

  it('启动失败页：先说现象与下一步，原文进「详情」', async () => {
    window.history.replaceState({}, '', '/?api=http://127.0.0.1:32100')
    vi.stubGlobal('fetch', () => {
      return Promise.reject(new Error('fetch failed'))
    })
    await act(async () => {
      root = createRoot(container)
      root.render(<App />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const page = container.querySelector('.app-error')
    expect(page?.querySelector('h2')?.textContent).toBe('连不上 RyHarness 的本机服务')
    expect(page?.querySelector('p')?.textContent).toContain('本机服务没有响应')
    expect(page?.querySelector('p')?.textContent).not.toContain('fetch failed')
    expect(page?.querySelector('details code')?.textContent).toContain('fetch failed')
  })
})

describe('撤销：真的调恢复接口', () => {
  it('移入归档后点「撤销」会 restore 这条记忆', async () => {
    const api = stubbedClient()
    vi.spyOn(api, 'memoryHealth').mockResolvedValue({ enabled: false })
    vi.spyOn(api, 'listArchivedMemories').mockResolvedValue({ items: [] })
    vi.spyOn(api, 'listAgentMemories').mockResolvedValue({ agent: [memoryRow()], shared: [] })
    const remove = vi.spyOn(api, 'deleteMemory').mockResolvedValue({ deleted: 'm1' })
    const restore = vi.spyOn(api, 'restoreMemory').mockResolvedValue({ restored: 'm1' })
    await act(async () => {
      root = createRoot(container)
      root.render(
        <>
          <MemoryPanel api={api} agentId="ryen" agentName="Ryen" conversationTitles={new Map()} onClose={() => {}} />
          <ToastHost />
        </>,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    click(container.querySelector('.memory-delete'))
    await settle()
    expect(remove).toHaveBeenCalledWith('m1')
    expect(container.querySelector('.memory-delete')?.textContent).toBe('移入归档')
    expect(container.querySelector('.toast')?.textContent).toContain('已移入归档')
    const action = container.querySelector<HTMLButtonElement>('.toast-action')
    expect(action?.textContent).toBe('撤销')
    click(action)
    await settle()
    expect(restore).toHaveBeenCalledWith('m1')
  })

  it('停用经验后点「撤销」会把它恢复成生效', async () => {
    const api = stubbedClient()
    vi.spyOn(api, 'evolveStats').mockResolvedValue({ enabled: false })
    vi.spyOn(api, 'getPlaybook').mockResolvedValue({
      entries: [
        {
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
        },
      ],
      reflections: [],
    })
    const setStatus = vi.spyOn(api, 'setPlaybookStatus').mockResolvedValue({ id: 'e1', status: 'deprecated' })
    await act(async () => {
      root = createRoot(container)
      root.render(
        <>
          <PlaybookPanel api={api} agentId="ryen" agentName="Ryen" onClose={() => {}} />
          <ToastHost />
        </>,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(text()).toContain('有用 2 · 没用 0')
    expect(text()).not.toContain('helpful')
    expect(text()).not.toContain('ms')
    click(buttonByText('停用'))
    await settle()
    expect(setStatus).toHaveBeenCalledWith('e1', 'deprecated')
    const action = container.querySelector<HTMLButtonElement>('.toast-action')
    expect(action?.textContent).toBe('撤销')
    click(action)
    await settle()
    expect(setStatus).toHaveBeenLastCalledWith('e1', 'active')
  })
})

describe('未保存修改的守卫', () => {
  it('新建 Agent：改了名字再 Esc 会先问「放弃未保存的修改？」', async () => {
    const onClose = vi.fn()
    await act(async () => {
      root = createRoot(container)
      root.render(
        <CreateAgentModal
          templates={templates}
          providers={[provider]}
          onSubmit={() => Promise.resolve()}
          onClose={onClose}
        />,
      )
      await Promise.resolve()
    })
    const nameInput = container.querySelector<HTMLInputElement>('.studio-main input')
    expect(nameInput).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(nameInput, '小助手')
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(text()).toContain('放弃未保存的修改？')
    expect(onClose).not.toHaveBeenCalled()
    click(buttonByText('放弃修改'))
    await settle()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('群设置：改了群名再 Esc 同样先确认', async () => {
    const onClose = vi.fn()
    await act(async () => {
      root = createRoot(container)
      root.render(
        <GroupSettingsModal
          mode="settings"
          agents={[ryen]}
          conversation={conversation}
          onSubmit={() => Promise.resolve()}
          onClose={onClose}
        />,
      )
      await Promise.resolve()
    })
    const nameInput = container.querySelector<HTMLInputElement>('input:not([type])')
    expect(nameInput).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(nameInput, '换个名字')
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(text()).toContain('放弃未保存的修改？')
    expect(onClose).not.toHaveBeenCalled()
    click(buttonByText('放弃修改'))
    await settle()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('保存中：按钮自报忙碌，不让人以为没点上', () => {
  const providerWithModel: ProviderInfo = {
    ...provider,
    models: [{ id: 'deepseek-ai/DeepSeek-V3' }],
  }

  it('新建 Agent', async () => {
    let release: () => void = () => {}
    await act(async () => {
      root = createRoot(container)
      root.render(
        <CreateAgentModal
          templates={templates}
          providers={[providerWithModel]}
          onSubmit={() => {
            return new Promise<void>((resolve) => {
              release = resolve
            })
          }}
          onClose={() => {}}
        />,
      )
      await Promise.resolve()
    })
    click(buttonByText('保存'))
    await act(async () => {
      await Promise.resolve()
    })
    const save = buttonByText('保存中…')
    expect(save?.getAttribute('aria-busy')).toBe('true')
    await act(async () => {
      release()
      await Promise.resolve()
    })
  })

  it('群设置', async () => {
    let release: () => void = () => {}
    await act(async () => {
      root = createRoot(container)
      root.render(
        <GroupSettingsModal
          mode="settings"
          agents={[ryen]}
          conversation={conversation}
          onSubmit={() => {
            return new Promise<void>((resolve) => {
              release = resolve
            })
          }}
          onClose={() => {}}
        />,
      )
      await Promise.resolve()
    })
    click(buttonByText('保存修改'))
    await act(async () => {
      await Promise.resolve()
    })
    const save = buttonByText('保存中…')
    expect(save?.getAttribute('aria-busy')).toBe('true')
    await act(async () => {
      release()
      await Promise.resolve()
    })
  })
})

describe('用户可见的单位与类型', () => {
  it('文件卡片显示中文文件类型，原始 MIME 留在 title', () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{
          key: 'a1',
          senderType: 'agent',
          senderId: 'ryen',
          senderName: 'Ryen',
          turnIndex: 0,
          done: true,
          parts: [
            {
              kind: 'file',
              callId: 'c1',
              name: '季度报告.docx',
              size: 2048,
              mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            },
          ],
        }}
        fileUrl={(name) => `/api/files/${name}`}
      />,
    )
    expect(html).toContain('Word 文档')
    // 原始 MIME 只允许出现在 title 上，正文里不能再念一遍。
    expect(html).not.toContain('· application/vnd')
    expect(html).toContain('title="application/vnd.openxmlformats-officedocument.wordprocessingml.document"')
  })

  it('用量账单不出现 tokens 裸字段', async () => {
    const api = stubbedClient()
    vi.spyOn(api, 'usage').mockResolvedValue({
      totals: { input: 3900, output: 1100, total: 5000 },
      byConversation: [],
      byProvider: [],
    })
    vi.spyOn(api, 'listAgentMemories').mockResolvedValue({
      agent: [],
      shared: [memoryRow({ id: 's1', kind: 'preference', content: '喜欢先看结论' })],
    })
    vi.spyOn(api, 'memoryHealth').mockResolvedValue({ enabled: false })
    vi.spyOn(api, 'listArchivedMemories').mockResolvedValue({ items: [] })
    await act(async () => {
      root = createRoot(container)
      root.render(<MePage api={api} ryen={ryen} providers={[provider]} theme="light" onThemeChange={() => {}} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const total = container.querySelector('.usage-total')?.textContent ?? ''
    expect(total).toContain('累计 约 5.0 千字')
    expect(total).not.toContain('tokens')
    // 共享画像的类别徽章说中文；隐私口径与欢迎页一致。
    expect(container.textContent).toContain('偏好')
    expect(container.textContent).not.toContain('preference')
    // 完整口径有自己的位置（.me-note），不再塞进 .me-sub 那个副标题里被扫过去。
    expect(container.querySelector('.me-note')?.textContent).toContain('推理时会把当前上下文发送给你选择的模型供应商')
  })
})

/**
 * REST 失败的人话层（lib/error-text.ts）：界面各处都不再递服务端原话。
 *
 * 这一组从**用户看到的那一句**断言：toast / 错误条 / 展开区里必须是中文，且不含
 * `HTTP 500`、`conversation not found` 这类原话。原文允许出现在折叠的「详情」和
 * title 上——排障要拿得到，只是不该占第一眼。
 */
describe('REST 失败：原文不上屏', () => {
  it('插件页：开关失败说人话，工具与接口是中文，内部 id 不上屏', async () => {
    const plugin: PluginView = {
      id: 'todo',
      name: '待办清单',
      description: '把要做的事记成清单。',
      group: 'feature',
      capabilities: { tools: ['file_produce'], routes: ['POST /api/todos'] },
      impact: '关闭后助理将无法记录待办。',
      // 关着的插件：点开关直接发 PATCH（开着的那条要先过一遍关闭确认弹窗）。
      enabled: false,
      core: false,
      status: 'stopped',
    }
    const api = stubbedClient()
    vi.spyOn(api, 'plugins').mockResolvedValue({ plugins: [plugin] })
    vi.spyOn(api, 'setPluginEnabled').mockRejectedValue(new ApiRequestError('memory system disabled', 409))
    await act(async () => {
      root = createRoot(container)
      root.render(<PluginsPage api={api} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    click(container.querySelector('[role="switch"]'))
    await settle()
    const shown = getToasts()
      .map((item) => item.text)
      .join(' | ')
    expect(shown).toContain('记忆功能被关掉了')
    expect(shown).not.toContain('memory system disabled')
    expect(shown).not.toContain('HTTP')

    // 展开区：工具与接口都是中文，原值只在 title 上。
    click(container.querySelector('.plugin-card-main'))
    const detail = container.querySelector('.plugin-detail')?.textContent ?? ''
    expect(detail).toContain('产出文件')
    expect(detail).not.toContain('file_produce')
    expect(detail).not.toContain('/api/todos')
    const chips = [...container.querySelectorAll('.plugin-chip')]
    expect(chips.map((node) => node.getAttribute('title'))).toEqual(['file_produce', 'POST /api/todos'])
    // 插件 id 是内部标识，不该有它的展示位。
    expect(detail).not.toContain('插件 ID')
  })

  it('记忆面板：归档失败说人话，不弹服务端原话', async () => {
    const api = stubbedClient()
    vi.spyOn(api, 'memoryHealth').mockResolvedValue({ enabled: false })
    vi.spyOn(api, 'listArchivedMemories').mockResolvedValue({ items: [] })
    vi.spyOn(api, 'listAgentMemories').mockResolvedValue({ agent: [memoryRow()], shared: [] })
    vi.spyOn(api, 'deleteMemory').mockRejectedValue(new ApiRequestError('memory not found', 404))
    await act(async () => {
      root = createRoot(container)
      root.render(
        <MemoryPanel api={api} agentId="ryen" agentName="Ryen" conversationTitles={new Map()} onClose={() => {}} />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    click(container.querySelector('.memory-delete'))
    await settle()
    const shown = getToasts()
      .map((item) => item.text)
      .join(' | ')
    expect(shown).toContain('这条记忆已经不在了')
    expect(shown).not.toContain('memory not found')
  })

  it('「我的」页：用量读不出来时正文是中文，不出现 conversation not found', async () => {
    const api = stubbedClient()
    vi.spyOn(api, 'usage').mockRejectedValue(new ApiRequestError('conversation not found', 404))
    vi.spyOn(api, 'listAgentMemories').mockResolvedValue({ agent: [], shared: [] })
    vi.spyOn(api, 'memoryHealth').mockResolvedValue({ enabled: false })
    vi.spyOn(api, 'listArchivedMemories').mockResolvedValue({ items: [] })
    await act(async () => {
      root = createRoot(container)
      root.render(<MePage api={api} ryen={ryen} providers={[provider]} theme="light" onThemeChange={() => {}} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(text()).toContain('用量没读出来')
    expect(text()).toContain('这个会话已经不在了')
    expect(text()).not.toContain('conversation not found')
  })

  it('产物预览：文件类型说中文，MIME 留在 title；读失败时原文只进折叠的详情', async () => {
    const api = stubbedClient()
    api.fileInfo = () => {
      return Promise.reject(new ApiRequestError('file not found: 方案.docx', 404))
    }
    api.fileRawUrl = () => '/api/files/x/raw'
    await act(async () => {
      root = createRoot(container)
      root.render(
        <ArtifactPreviewContent
          variant="panel"
          api={api}
          target={{
            name: '方案.docx',
            mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            size: 2048,
          }}
          onClose={() => {}}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    const box = container.querySelector('.attach-preview-body') as HTMLElement
    expect(box.textContent).toContain('工作区里没有这个文件了')
    // 原文只在折叠的「详情」里（textContent 含 details 内部，所以另查它挂在 details 下）。
    const details = box.querySelector('details')
    expect(details?.querySelector('summary')?.textContent).toBe('详情')
    expect(details?.textContent).toContain('file not found: 方案.docx')
  })

  it('产物预览：读得出时 MIME 说中文，原值留在 title', async () => {
    const api = stubbedClient()
    api.fileInfo = () => {
      return Promise.resolve({
        name: '报告.docx',
        path: 'C:/ws/报告.docx',
        size: 2048,
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
    }
    api.fileRawUrl = () => '/api/files/x/raw'
    await act(async () => {
      root = createRoot(container)
      root.render(
        <ArtifactPreviewContent
          variant="panel"
          api={api}
          target={{
            name: '报告.docx',
            mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            size: 2048,
          }}
          onClose={() => {}}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    const head = container.querySelector('.attach-preview-title small') as HTMLElement
    expect(head.textContent).toContain('Word 文档')
    expect(head.textContent).not.toContain('application/vnd')
    expect(head.getAttribute('title')).toContain('application/vnd')
  })

  it('会话列表：置顶失败说人话，不弹服务端原话', async () => {
    const row: Conversation = {
      id: 'c2',
      kind: 'direct',
      title: 'Ryen',
      memberAgentIds: ['ryen'],
      lastReadSeq: 0,
      createdAt: 1,
      updatedAt: 2,
    }
    const api = stubbedClient()
    vi.spyOn(api, 'patchConversation').mockRejectedValue(new ApiRequestError('conversation not found', 404))
    await act(async () => {
      root = createRoot(container)
      root.render(
        <ConversationList
          api={api}
          conversations={[row]}
          agents={[ryen]}
          activeId={undefined}
          onSelect={() => {}}
          onChanged={() => {}}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    click(container.querySelector('.conversation-more'))
    const pin = [...container.querySelectorAll<HTMLButtonElement>('.conversation-item-menu button')].find((node) => {
      return node.textContent?.trim() === '置顶'
    })
    click(pin)
    await settle()
    const shown = getToasts()
      .map((shown2) => {
        return shown2.text
      })
      .join(' | ')
    expect(shown).toContain('操作失败')
    expect(shown).toContain('这个会话已经不在了')
    expect(shown).not.toContain('conversation not found')
  })
})
