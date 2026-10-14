// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentDef, Conversation } from '../renderer/src/api.ts'
import { ChatInput } from '../renderer/src/components/ChatInput.tsx'
import { ContactsPage } from '../renderer/src/components/ContactsPage.tsx'
import { ConversationList } from '../renderer/src/components/ConversationList.tsx'
import { MessageBubble } from '../renderer/src/components/MessageBubble.tsx'
import { ConversationSkeleton } from '../renderer/src/components/Skeleton.tsx'
import type { UiMessage } from '../renderer/src/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agents: AgentDef[] = [
  {
    id: 'ryen',
    name: 'Ryen',
    avatar: 'cat',
    systemPrompt: '你是 Ryen。',
    provider: 'siliconflow',
    model: 'deepseek-ai/DeepSeek-V3',
    tools: [],
    isBuiltin: true,
  },
  {
    id: 'mine',
    name: '小译',
    avatar: 'db:dylan:seed1',
    systemPrompt: '你是翻译官。',
    provider: 'siliconflow',
    model: 'deepseek-ai/DeepSeek-V3',
    tools: ['fs_read'],
    isBuiltin: false,
  },
]

const conversations: Conversation[] = [
  {
    id: 'c1',
    kind: 'direct',
    title: 'Ryen',
    memberAgentIds: ['ryen'],
    lastReadSeq: 3,
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: 'c2',
    kind: 'direct',
    title: '小译',
    memberAgentIds: ['mine'],
    lastReadSeq: 1,
    createdAt: 1,
    updatedAt: 2,
  },
]

const fileUrl = (name: string): string => {
  return `/api/files/${name}`
}

function message(key: string): UiMessage {
  return {
    key,
    senderType: 'agent',
    senderId: 'ryen',
    senderName: 'Ryen',
    turnIndex: 0,
    done: true,
    parts: [{ kind: 'text', text: '在' }],
  }
}

describe('消息进场动画', () => {
  it('只有本次会话新到的消息挂 is-new，历史消息（hist: 前缀）不播进场', () => {
    const live = renderToStaticMarkup(<MessageBubble message={message('stream:ryen:0')} fileUrl={fileUrl} animated />)
    expect(live).toContain('is-new')
    const history = renderToStaticMarkup(
      <MessageBubble message={message('hist:m1')} fileUrl={fileUrl} animated={false} />,
    )
    expect(history).not.toContain('is-new')
  })
})

describe('列表 stagger 接线', () => {
  it('会话列表每一项带递增的 --i', () => {
    const html = renderToStaticMarkup(
      <ConversationList conversations={conversations} agents={agents} activeId="c1" onSelect={() => {}} />,
    )
    expect(html).toContain('--i:0')
    expect(html).toContain('--i:1')
  })

  it('骨架屏每行带 --i（样式表的 40ms 递进延迟不再是死代码）', () => {
    const html = renderToStaticMarkup(<ConversationSkeleton rows={3} />)
    expect(html).toContain('--i:0')
    expect(html).toContain('--i:2')
  })

  it('通讯录卡片与模板卡都带 --i', () => {
    const html = renderToStaticMarkup(
      <ContactsPage
        agents={agents}
        templates={[
          {
            key: 'general',
            name: '通用助理',
            description: '什么都能聊',
            suggestedSystemPrompt: '你是通用助理。',
            defaultModel: 'deepseek-ai/DeepSeek-V3',
            defaultTools: [],
          },
        ]}
        providers={[]}
        onChat={() => {}}
        onCreateAgent={() => {}}
        onEditAgent={() => {}}
        onDeleteAgent={() => {}}
        onCreateGroup={() => {}}
      />,
    )
    expect(html).toContain('template-card" style="--i:0')
    expect(html).toMatch(/contact-card" style="--i:\d+/)
  })
})

describe('ChatInput 停止生成（Esc）', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let stops = 0

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    stops = 0
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  function renderChatInput(props: { streaming?: boolean; members?: { id: string; name: string }[] }): void {
    act(() => {
      root = createRoot(container)
      root.render(
        <ChatInput
          members={props.members ?? []}
          onSend={() => {}}
          streaming={props.streaming}
          onStop={() => {
            stops += 1
          }}
        />,
      )
    })
  }

  function pressEscape(): void {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
  }

  it('流式期间渲染停止按钮，标题里的 Esc 是真的', () => {
    renderChatInput({ streaming: true })
    const stop = container.querySelector<HTMLButtonElement>('.stop-btn')
    expect(stop?.getAttribute('title')).toBe('停止生成（Esc）')
    expect(stop?.getAttribute('aria-label')).toBe('停止生成')
  })

  it('流式期间按 Esc 触发停止生成', () => {
    renderChatInput({ streaming: true })
    pressEscape()
    expect(stops).toBe(1)
  })

  it('不在流式时 Esc 不触发停止', () => {
    renderChatInput({ streaming: false })
    pressEscape()
    expect(stops).toBe(0)
    expect(container.querySelector('.stop-btn')).toBeNull()
  })

  it('补全菜单开着时 Esc 只关菜单，不顺手停掉生成', () => {
    renderChatInput({ streaming: true, members: [{ id: 'ryen', name: 'Ryen' }] })
    const textarea = container.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(textarea, '@R')
      textarea.setSelectionRange(2, 2)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('.mention-menu')).not.toBeNull()

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(stops).toBe(0)
    expect(container.querySelector('.mention-menu.is-leaving')).not.toBeNull()
  })
})
