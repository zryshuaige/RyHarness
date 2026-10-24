// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { TEST_PERSONA } from './fixtures.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../renderer/src')

/** ChatView 的源码（切会话补间接在它内部）。 */
function findChatViewSource(): string {
  return readFileSync(resolve(SRC, 'components/ChatView.tsx'), 'utf8')
}

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

describe('切会话的进场补间', () => {
  /**
   * 聊天区**不按 conversationId 重挂**（桶缓存让同一个 id 拿同一个桶），所以
   * 「换桶」不会重播任何 CSS 动画——切会话此前就是一次纯粹的瞬换。
   *
   * 补间由 ChatView 在会话 id 变化时打一个一次性的 .is-switching 触发。
   * animation-name 在两个同内容的 keyframes 之间交替：CSS 动画只在
   * animation-name 变化或元素重建时才重新开始，而「摘 class 再加回来」在 React
   * 里不保证产生两次提交（连续切换时 class 名可能压根没变）。
   */
  it('切会话时聊天区挂上 is-switching，动画播完摘掉', () => {
    const chatView = findChatViewSource()
    expect(chatView).toContain('is-switching')
    // 两个同内容的 keyframes：名字交替，浏览器必然重播
    expect(chatView).toMatch(/chat-swap-\$\{switchSeq % 2\}/)
  })

  it('样式表里两个 chat-swap keyframes 内容相同（交替只为触发重播）', () => {
    const css = readFileSync(resolve(SRC, 'styles.css'), 'utf8')
    const frames = [...css.matchAll(/@keyframes (chat-swap-\d)\s*\{([^}]*)\}/g)].map((match) => {
      return { name: match[1] as string, body: (match[2] as string).replace(/\s+/g, ' ').trim() }
    })
    expect(frames.length).toBe(2)
    expect(frames[0]?.body).toBe(frames[1]?.body)
  })

  it('.chat-view 上不再挂着无条件的 fade-rise（它只在首次挂载时播一次，切会话播不到）', () => {
    const css = readFileSync(resolve(SRC, 'styles.css'), 'utf8')
    const rule = /(^|\})\s*\.chat-view\s*\{([^}]*)\}/m.exec(css)
    expect(rule).not.toBeNull()
    expect(rule?.[2]).not.toContain('animation')
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
            persona: TEST_PERSONA,
            defaultTools: [],
          },
        ]}
        onChat={() => {}}
        onCreateAgent={() => {}}
        onEditAgent={() => {}}
        onDeleteAgent={() => {}}
        onCreateGroup={() => {}}
      />,
    )
    expect(html).toContain('template-card" style="--i:0')
    expect(html).toMatch(/contact-card contact-create" style="--i:0/)
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
