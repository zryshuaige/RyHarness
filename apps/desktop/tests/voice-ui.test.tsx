// @vitest-environment jsdom
/**
 * 朗读的界面接线：气泡朗读键的出现/切换、自动朗读的单聊开关与群聊静默、
 * 「我的」页开关持久化。
 */
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, Conversation, WsEvent } from '../renderer/src/api.ts'
import { ApiClient } from '../renderer/src/api.ts'
import { ChatView } from '../renderer/src/components/ChatView.tsx'
import { MePage } from '../renderer/src/components/MePage.tsx'
import { MessageBubble } from '../renderer/src/components/MessageBubble.tsx'
import { AUTO_SPEAK_STORAGE_KEY, type SystemVoice, VoicePlayer } from '../renderer/src/lib/voice.ts'
import { bucketOf, ChatStore, type MessagePart, type UiMessage } from '../renderer/src/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fileUrl = (name: string): string => {
  return `/api/files/${name}`
}

const agent: AgentDef = {
  id: 'ryen',
  name: 'Ryen',
  avatar: 'cat',
  systemPrompt: '你是 Ryen。',
  provider: 'siliconflow',
  model: 'deepseek-ai/DeepSeek-V3',
  tools: [],
  persona: {
    extroversion: 50,
    rigor: 50,
    humor: 50,
    initiative: 50,
    catchphrase: '',
    affinity: 0,
    voiceId: 'system-huihui',
    appearance: '',
  },
  isBuiltin: true,
}

const directConversation: Conversation = {
  id: 'c1',
  kind: 'direct',
  title: 'Ryen',
  memberAgentIds: ['ryen'],
  lastReadSeq: 1,
  createdAt: 1,
  updatedAt: 2,
}

const groupConversation: Conversation = {
  ...directConversation,
  id: 'g1',
  kind: 'group',
  title: '真实验证群',
}

function agentMessage(parts: MessagePart[], overrides: Partial<UiMessage> = {}): UiMessage {
  return {
    key: 'a1',
    senderType: 'agent',
    senderId: 'ryen',
    senderName: 'Ryen',
    turnIndex: 0,
    done: true,
    parts,
    ...overrides,
  }
}

function mount(node: ReactNode): { container: HTMLDivElement; root: ReturnType<typeof createRoot> } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(node)
  })
  return { container, root }
}

/** 假系统语音：记录念了什么；可选把每句挂起，供「切会话要停」这类用例控制。 */
function fakeSystem(): { system: SystemVoice; spoken: string[]; cancel: ReturnType<typeof vi.fn> } {
  const spoken: string[] = []
  const cancel = vi.fn()
  return {
    system: {
      speak: (input) => {
        spoken.push(input.text)
        return Promise.resolve()
      },
      cancel,
    },
    spoken,
    cancel,
  }
}

function fakePlayer(system: SystemVoice): VoicePlayer {
  return new VoicePlayer({
    catalog: () =>
      Promise.resolve({
        engines: [{ id: 'system', name: '系统语音', available: true }],
        profiles: [
          {
            id: 'system-huihui',
            name: '慧慧（系统女声）',
            engine: 'system',
            voice: 'Microsoft Huihui Desktop',
            sampleText: '你好。',
            description: '系统女声',
          },
        ],
      }),
    synthesize: () => Promise.reject(new Error('系统音色不该走云端')),
    system,
    createAudio: () => {
      throw new Error('系统音色不该创建音频')
    },
    createObjectURL: () => '',
    revokeObjectURL: () => {},
    notifyFallback: () => {},
  })
}

/** 一个只回空数据的真 ApiClient：订阅回调被抓出来，由测试手动推事件。 */
function chatApi(): { api: ApiClient; event: () => (payload: WsEvent) => void } {
  const api = new ApiClient('http://api.test')
  let handler: ((payload: WsEvent) => void) | undefined
  vi.spyOn(api, 'messages').mockResolvedValue({ messages: [] })
  vi.spyOn(api, 'markRead').mockResolvedValue({ conversationId: 'c1', lastReadSeq: 1 })
  vi.spyOn(api, 'listDispatchEvents').mockResolvedValue({ events: [] })
  vi.spyOn(api, 'subscribe').mockImplementation((_id, onEvent) => {
    handler = (payload) => {
      onEvent({ ...payload, seq: 1 })
    }
    return () => {}
  })
  return {
    api,
    event: () => {
      if (handler === undefined) throw new Error('ChatView 还没订阅')
      return handler
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
})

beforeEach(() => {
  localStorage.clear()
})

describe('气泡朗读键', () => {
  it('agent 的文本消息出现朗读键，用户消息与纯工具消息不出现', () => {
    const agentHtml = renderToStaticMarkup(
      <MessageBubble
        message={agentMessage([{ kind: 'text', text: '晚上好。' }])}
        fileUrl={fileUrl}
        onVoiceToggle={() => {}}
      />,
    )
    expect(agentHtml).toContain('aria-label="朗读这条消息"')
    expect(agentHtml).toContain('speaker')

    const userHtml = renderToStaticMarkup(
      <MessageBubble
        message={{
          key: 'u1',
          senderType: 'user',
          senderId: 'user',
          senderName: '我',
          turnIndex: 0,
          done: true,
          parts: [{ kind: 'text', text: '在吗' }],
        }}
        fileUrl={fileUrl}
        onVoiceToggle={() => {}}
      />,
    )
    expect(userHtml).not.toContain('朗读这条消息')

    const toolOnly = renderToStaticMarkup(
      <MessageBubble
        message={agentMessage([{ kind: 'tool', callId: 'c1', name: 'fs_read', arguments: '{}', status: 'done' }])}
        fileUrl={fileUrl}
        onVoiceToggle={() => {}}
      />,
    )
    expect(toolOnly).not.toContain('朗读这条消息')
  })

  it('播放中变成停止键并显示波形；点击回调能拿到这条消息', () => {
    const onVoiceToggle = vi.fn()
    const message = agentMessage([{ kind: 'text', text: '晚上好。' }])
    const { container, root } = mount(
      <MessageBubble message={message} fileUrl={fileUrl} onVoiceToggle={onVoiceToggle} voiceSpeaking />,
    )
    const stop = container.querySelector<HTMLButtonElement>('button[aria-label="停止朗读"]')
    expect(stop).not.toBeNull()
    expect(container.querySelector('.typing-dots.voice-wave')).not.toBeNull()
    act(() => {
      stop?.click()
    })
    expect(onVoiceToggle).toHaveBeenCalledWith(message)
    act(() => {
      root.unmount()
    })
  })
})

describe('流式即读', () => {
  async function renderChat(options: { conversation: Conversation; autoSpeak: boolean; system: SystemVoice }): Promise<{
    container: HTMLDivElement
    root: ReturnType<typeof createRoot>
    event: () => (payload: WsEvent) => void
  }> {
    if (options.autoSpeak) localStorage.setItem(AUTO_SPEAK_STORAGE_KEY, 'true')
    const { api, event } = chatApi()
    const player = fakePlayer(options.system)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <ChatView
          api={api}
          conversation={options.conversation}
          agents={[agent]}
          bucket={bucketOf(new ChatStore())}
          voice={player}
        />,
      )
      await Promise.resolve()
    })
    return { container, root, event }
  }

  const push = async (send: (payload: WsEvent) => void, events: WsEvent[]): Promise<void> => {
    await act(async () => {
      for (const event of events) send(event)
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })
  }

  it('音色目录读不到时点气泡朗读键仍用系统语音念，只轻提示一次且不报错', async () => {
    const { system, spoken } = fakeSystem()
    const notifyCatalogFallback = vi.fn()
    const player = new VoicePlayer({
      catalog: () => Promise.reject(new Error('音色目录没读出来（HTTP 404）')),
      synthesize: () => Promise.reject(new Error('目录失败不该走云端')),
      system,
      createAudio: () => {
        throw new Error('目录失败不该创建音频')
      },
      createObjectURL: () => '',
      revokeObjectURL: () => {},
      notifyFallback: () => {},
      notifyCatalogFallback,
    })
    const message = agentMessage([{ kind: 'text', text: '晚上好。' }])
    const { container, root } = mount(
      <MessageBubble
        message={message}
        fileUrl={fileUrl}
        onVoiceToggle={() => {
          void player.speak({ text: '晚上好。', profileId: 'system-huihui', key: message.key })
        }}
      />,
    )
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="朗读这条消息"]')
    expect(button).not.toBeNull()
    await act(async () => {
      button?.click()
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })
    expect(spoken).toEqual(['晚上好。'])
    expect(notifyCatalogFallback).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    act(() => {
      root.unmount()
    })
  })

  it('单聊自动朗读：一句完成就入队，message-done 补播剩余半句', async () => {
    const { system, spoken } = fakeSystem()
    const { root, event } = await renderChat({ conversation: directConversation, autoSpeak: true, system })
    const send = event()
    await push(send, [
      { type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 0 },
      { type: 'text-delta', conversationId: 'c1', senderId: 'ryen', text: '第一句。第二' },
    ])
    expect(spoken).toEqual(['第一句。'])
    await push(send, [{ type: 'text-delta', conversationId: 'c1', senderId: 'ryen', text: '句！' }])
    expect(spoken).toEqual(['第一句。', '第二句！'])
    await push(send, [{ type: 'message-done', conversationId: 'c1', senderId: 'ryen', turnIndex: 0 }])
    act(() => {
      root.unmount()
    })
  })

  it('开关关闭不自动朗读', async () => {
    const { system, spoken } = fakeSystem()
    const { root, event } = await renderChat({ conversation: directConversation, autoSpeak: false, system })
    await push(event(), [
      { type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 0 },
      { type: 'text-delta', conversationId: 'c1', senderId: 'ryen', text: '不该念。' },
      { type: 'message-done', conversationId: 'c1', senderId: 'ryen', turnIndex: 0 },
    ])
    expect(spoken).toEqual([])
    act(() => {
      root.unmount()
    })
  })

  it('群聊即使开了全局开关也不自动朗读', async () => {
    const { system, spoken } = fakeSystem()
    const { root, event } = await renderChat({ conversation: groupConversation, autoSpeak: true, system })
    await push(event(), [
      { type: 'message-start', conversationId: 'g1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 0 },
      { type: 'text-delta', conversationId: 'g1', senderId: 'ryen', text: '群里不念。' },
      { type: 'message-done', conversationId: 'g1', senderId: 'ryen', turnIndex: 0 },
    ])
    expect(spoken).toEqual([])
    act(() => {
      root.unmount()
    })
  })

  it('卸载聊天区会停止还在念的句子', async () => {
    const pending = new Promise<void>(() => {})
    const cancel = vi.fn()
    const spoken: string[] = []
    const system: SystemVoice = {
      speak: (input) => {
        spoken.push(input.text)
        return pending
      },
      cancel,
    }
    const { root, event } = await renderChat({ conversation: directConversation, autoSpeak: true, system })
    await push(event(), [
      { type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 0 },
      { type: 'text-delta', conversationId: 'c1', senderId: 'ryen', text: '很长的一句。' },
    ])
    expect(spoken).toEqual(['很长的一句。'])
    act(() => {
      root.unmount()
    })
    expect(cancel).toHaveBeenCalled()
  })
})

describe('「我的」页自动朗读开关', () => {
  it('默认关；点一下写入 localStorage，重挂后读回开启态', async () => {
    const api = new ApiClient('http://api.test')
    vi.spyOn(api, 'workspace').mockResolvedValue({ path: 'C:\\workspace' })
    vi.spyOn(api, 'memoryHealth').mockResolvedValue({ enabled: false })
    vi.spyOn(api, 'usage').mockResolvedValue({
      totals: { input: 0, output: 0, total: 0 },
      byConversation: [],
      byProvider: [],
    })
    const render = (root: ReturnType<typeof createRoot>): void => {
      root.render(<MePage api={api} ryen={undefined} providers={[]} theme="light" onThemeChange={() => {}} />)
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root = createRoot(container)
    await act(async () => {
      render(root)
      await Promise.resolve()
    })
    const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"]')
    expect(toggle?.getAttribute('aria-checked')).toBe('false')
    expect(container.textContent).toContain('助理回复时自动朗读')
    await act(async () => {
      toggle?.click()
      await Promise.resolve()
    })
    expect(toggle?.getAttribute('aria-checked')).toBe('true')
    expect(localStorage.getItem(AUTO_SPEAK_STORAGE_KEY)).toBe('true')

    act(() => {
      root.unmount()
    })
    root = createRoot(container)
    await act(async () => {
      render(root)
      await Promise.resolve()
    })
    expect(container.querySelector('button[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
    act(() => {
      root.unmount()
    })
    container.remove()
  })
})
