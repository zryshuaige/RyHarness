// @vitest-environment jsdom
/**
 * 气泡的可见性契约：工具过程看得见、送达状态看得见、谁在说话看得见。
 *
 * 这三件事此前各自缺一块——工具行只剩一句「已读文件」、没送达的气泡与已送达一模一样、
 * 群聊里三个 agent 的白底气泡长得完全一样。断言都落在结构不变量上（正文在不在、
 * 展开态由 aria-expanded 说话、色相按 id 稳定派生），不钉死坐标与像素。
 */
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { relayAnchorsOf } from '../renderer/src/components/ChatView.tsx'
import { MessageBubble, RelayChain } from '../renderer/src/components/MessageBubble.tsx'
import { ChatStore, DELIVERY_TIMEOUT_MS, type MessagePart, type UiMessage } from '../renderer/src/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fileUrl = (name: string): string => {
  return `/api/files/${name}`
}

/** 挂一个真 DOM 容器：折叠/展开是交互，静态标记渲不出来。 */
function mount(node: ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(node)
  })
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

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

describe('工具过程可展开', () => {
  const call: MessagePart = {
    kind: 'tool',
    callId: 'c1',
    name: 'shell_exec',
    arguments: '{"cmd":"cat missing.txt"}',
    status: 'done',
    content: 'cat: missing.txt: No such file or directory',
    isError: true,
  }

  it('成功态默认折叠，点开才给参数与结果正文', () => {
    const message = agentMessage([{ ...call, isError: false, content: 'hello world' }])
    const { container, unmount } = mount(<MessageBubble message={message} fileUrl={fileUrl} />)
    const row = container.querySelector<HTMLButtonElement>('.tool-row')
    expect(row?.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toContain('hello world')

    act(() => {
      row?.click()
    })
    const detail = container.querySelector('.tool-detail')?.textContent ?? ''
    expect(container.querySelector('.tool-row')?.getAttribute('aria-expanded')).toBe('true')
    // 正文与参数都得到位：光看一句「已执行命令」，用户无从判断 agent 做了什么。
    expect(detail).toContain('hello world')
    expect(detail).toContain('cat missing.txt')
    unmount()
  })

  it('失败态默认展开并明写「错误」：错在哪正是要点开这行的理由', () => {
    const { container, unmount } = mount(<MessageBubble message={agentMessage([call])} fileUrl={fileUrl} />)
    expect(container.querySelector('.tool-row')?.getAttribute('aria-expanded')).toBe('true')
    const detail = container.querySelector('.tool-detail')?.textContent ?? ''
    expect(detail).toContain('错误')
    expect(detail).toContain('No such file or directory')
    unmount()
  })

  it('超长结果截断写在脸上，不让用户误以为那就是全部', () => {
    const message = agentMessage([{ ...call, isError: false, content: '长'.repeat(5000) }])
    const { container, unmount } = mount(<MessageBubble message={message} fileUrl={fileUrl} />)
    act(() => {
      container.querySelector<HTMLButtonElement>('.tool-row')?.click()
    })
    const detail = container.querySelector('.tool-detail')?.textContent ?? ''
    expect(detail.length).toBeLessThan(1400)
    expect(detail).toContain('此处还有')
    unmount()
  })

  it('没有正文与参数时不假装可展开（不点得动，也不谎报展开态）', () => {
    const message = agentMessage([{ kind: 'tool', callId: 'c9', name: 'fs_read', arguments: '', status: 'done' }])
    const { container, unmount } = mount(<MessageBubble message={message} fileUrl={fileUrl} />)
    const row = container.querySelector<HTMLButtonElement>('.tool-row')
    expect(row?.disabled).toBe(true)
    expect(row?.getAttribute('aria-expanded')).toBeNull()
    expect(container.querySelector('.tool-detail')).toBeNull()
    unmount()
  })
})

describe('送达三态', () => {
  const user = (delivery: UiMessage['delivery']): UiMessage => {
    return {
      key: 'u1',
      senderType: 'user',
      senderId: 'user',
      senderName: '我',
      turnIndex: 0,
      done: true,
      parts: [{ kind: 'text', text: '在吗' }],
      ...(delivery === undefined ? {} : { delivery }),
    }
  }

  it('pending 在动、sent 是一枚轻对勾、failed 报警', () => {
    const pending = renderToStaticMarkup(<MessageBubble message={user('pending')} fileUrl={fileUrl} />)
    expect(pending).toContain('is-pending')
    expect(pending).toContain('queue-pulse')

    const sent = renderToStaticMarkup(<MessageBubble message={user('sent')} fileUrl={fileUrl} />)
    expect(sent).toContain('is-sent')
    expect(sent).toContain('已送达')

    const failed = renderToStaticMarkup(<MessageBubble message={user('failed')} fileUrl={fileUrl} />)
    expect(failed).toContain('is-error')
    expect(failed).toContain('发送失败')
  })

  it('历史用户消息不画角标：从库里读出来的天然已送达', () => {
    expect(renderToStaticMarkup(<MessageBubble message={user(undefined)} fileUrl={fileUrl} />)).not.toContain(
      'bubble-delivery',
    )
  })

  it('agent 消息不画送达角标', () => {
    expect(
      renderToStaticMarkup(<MessageBubble message={agentMessage([{ kind: 'text', text: '在' }])} fileUrl={fileUrl} />),
    ).not.toContain('bubble-delivery')
  })
})

describe('agent 色相', () => {
  /** 从渲染结果里取气泡左边框的色相（内联样式，稳定派生即可，不钉坐标）。 */
  const hueOf = (html: string): string | undefined => {
    return /border-left:\s*3px solid\s*(#[0-9a-f]{6})/i.exec(html)?.[1]
  }

  /** 发言人名字的内联色（浅色主题那一套）。 */
  const nameColorOf = (html: string): string | undefined => {
    return /class="bubble-name" style="color:\s*(#[0-9a-f]{6})"/i.exec(html)?.[1]
  }

  it('每个 agent 一个稳定色相：边框取图形色、名字取正文色，两套值不相等', () => {
    const ryen = renderToStaticMarkup(
      <MessageBubble message={agentMessage([{ kind: 'text', text: '甲' }])} fileUrl={fileUrl} />,
    )
    const codebot = renderToStaticMarkup(
      <MessageBubble
        message={agentMessage([{ kind: 'text', text: '乙' }], {
          key: 'a2',
          senderId: 'codebot',
          senderName: 'CodeBot',
        })}
        fileUrl={fileUrl}
      />,
    )
    expect(hueOf(ryen)).toBeDefined()
    expect(hueOf(ryen)).not.toBe(hueOf(codebot))
    // 同一个 id 每次渲染都是同一个色（按 id 哈希派生，不是随机）
    expect(
      hueOf(
        renderToStaticMarkup(
          <MessageBubble message={agentMessage([{ kind: 'text', text: '甲' }])} fileUrl={fileUrl} />,
        ),
      ),
    ).toBe(hueOf(ryen))

    // 不变量是「同色相、两套值」：边框是 3:1 的图形色（1.4.11），名字是 12px 正文色
    // （1.4.3，要 4.5:1）。曾经两者同值，断言写成「边框与名字同色」；现在同名同值就是
    // 回归——把正文色降回 3:1 会让白底气泡上的名字读不清，而这行旧断言照样通过。
    const nameColor = nameColorOf(ryen)
    expect(nameColor).toBeDefined()
    expect(nameColor).not.toBe(hueOf(ryen))
    // 暗色主题那一套挂在行上的自定义属性里（主题层 !important 接管），也得是另一值。
    expect(ryen).toMatch(/--agent-hue-text-dark:\s*(#[0-9a-f]{6})/i)
    expect(ryen).not.toMatch(new RegExp(`--agent-hue-text-dark:\\s*${nameColor}`, 'i'))
  })

  it('用户气泡不上色相', () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        message={{
          key: 'u1',
          senderType: 'user',
          senderId: 'user',
          senderName: '我',
          turnIndex: 0,
          done: true,
          parts: [{ kind: 'text', text: '你好' }],
        }}
        fileUrl={fileUrl}
      />,
    )
    expect(html).not.toContain('border-left')
  })
})

describe('接力链按交接点分锚', () => {
  it('谁说完之后，接力就贴在哪一句后面', () => {
    const anchors = relayAnchorsOf([
      { toAgent: 'ryen', reason: 'default-dispatcher', turnIndex: 3 },
      { fromAgent: 'ryen', toAgent: 'codebot', reason: 'relay @CodeBot', turnIndex: 3 },
      { fromAgent: 'codebot', toAgent: 'ryen', reason: 'relay @Ryen', turnIndex: 3 },
    ])
    // 轮首那次没有来源 agent：留在轮首
    expect(anchors.get('3:')).toHaveLength(1)
    expect(anchors.get('3:ryen')?.[0]?.toAgent).toBe('codebot')
    expect(anchors.get('3:codebot')?.[0]?.toAgent).toBe('ryen')
  })

  it('chip 贴左缘跟气泡流对齐，不再整轮压在轮首居中', () => {
    const html = renderToStaticMarkup(
      <RelayChain
        turnIndex={3}
        nameOf={(id: string) => {
          return id
        }}
        avatarOf={(id: string) => {
          return { name: id }
        }}
        relays={[{ fromAgent: 'ryen', toAgent: 'codebot', reason: 'relay @CodeBot', turnIndex: 3 }]}
      />,
    )
    expect(html).toContain('justify-content:flex-start')
  })
})

describe('store 侧的过程与送达折叠', () => {
  it('tool-result 的正文留在消息里（过程可见性的地基）', () => {
    const store = new ChatStore()
    store.apply({ type: 'message-start', conversationId: 'c', senderId: 'ryen', senderName: 'Ryen', turnIndex: 0 })
    store.apply({
      type: 'tool-call-start',
      conversationId: 'c',
      senderId: 'ryen',
      callId: 'c1',
      name: 'shell_exec',
      arguments: '{"cmd":"cat missing.txt"}',
    })
    store.apply({
      type: 'tool-result',
      conversationId: 'c',
      senderId: 'ryen',
      callId: 'c1',
      name: 'shell_exec',
      isError: true,
      content: 'cat: missing.txt: No such file or directory',
    })
    const message = store.getSnapshot().messages[0]
    expect(message?.parts[0]).toMatchObject({
      kind: 'tool',
      status: 'done',
      isError: true,
      content: 'cat: missing.txt: No such file or directory',
    })
    // 留住了就得渲染得出来（折叠时由 store 供料，展开时由气泡给出去）
    const html = renderToStaticMarkup(<MessageBubble message={message as UiMessage} fileUrl={fileUrl} />)
    expect(html).toContain('No such file or directory')
  })

  it('pending 一直收不到回执就降级成失败，不会永远转圈', () => {
    vi.useFakeTimers()
    try {
      const store = new ChatStore()
      store.addUserMessage('在吗', 0)
      expect(store.getSnapshot().messages[0]?.delivery).toBe('pending')
      vi.advanceTimersByTime(DELIVERY_TIMEOUT_MS - 1)
      expect(store.getSnapshot().messages[0]?.delivery).toBe('pending')
      vi.advanceTimersByTime(2)
      expect(store.getSnapshot().messages[0]?.delivery).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('回执到了就不再降级（慢但没断的用户消息不会被误判成失败）', () => {
    vi.useFakeTimers()
    try {
      const store = new ChatStore()
      const key = store.addUserMessage('在吗', 0)
      vi.advanceTimersByTime(DELIVERY_TIMEOUT_MS - 100)
      store.setUserMessageDelivery(key, 'sent')
      vi.advanceTimersByTime(10_000)
      expect(store.getSnapshot().messages[0]?.delivery).toBe('sent')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('MessageBubble', () => {
  it('用户气泡右侧琥珀色、agent 气泡左侧白底', () => {
    const user: UiMessage = {
      key: 'u1',
      senderType: 'user',
      senderId: 'user',
      senderName: '我',
      turnIndex: 0,
      done: true,
      parts: [{ kind: 'text', text: '你好' }],
    }
    const agent: UiMessage = {
      key: 'a1',
      senderType: 'agent',
      senderId: 'ryen',
      senderName: 'Ryen',
      turnIndex: 0,
      done: true,
      parts: [{ kind: 'text', text: '欢迎回家' }],
    }
    const userHtml = renderToStaticMarkup(<MessageBubble message={user} fileUrl={fileUrl} />)
    const agentHtml = renderToStaticMarkup(<MessageBubble message={agent} fileUrl={fileUrl} />)
    expect(userHtml).toContain('from-user')
    expect(userHtml).not.toContain('bubble-name')
    expect(agentHtml).toContain('from-agent')
    expect(agentHtml).toContain('Ryen')
  })

  it('工具过程渲染为进度行（运行中/完成/失败）', () => {
    const running: UiMessage = {
      key: 't1',
      senderType: 'agent',
      senderId: 'ryen',
      senderName: 'Ryen',
      turnIndex: 0,
      done: false,
      parts: [{ kind: 'tool', callId: 'c1', name: 'fs_write', arguments: '{}', status: 'running' }],
    }
    const html = renderToStaticMarkup(<MessageBubble message={running} fileUrl={fileUrl} />)
    expect(html).toContain('正在写文件…')
    expect(html).toContain('is-running')

    const failed: UiMessage = {
      ...running,
      parts: [{ kind: 'tool', callId: 'c1', name: 'fs_write', arguments: '{}', status: 'done', isError: true }],
    }
    expect(renderToStaticMarkup(<MessageBubble message={failed} fileUrl={fileUrl} />)).toContain('失败')
  })

  it('产物卡片渲染文件名/大小/打开链接', () => {
    const message: UiMessage = {
      key: 'f1',
      senderType: 'agent',
      senderId: 'ryen',
      senderName: 'Ryen',
      turnIndex: 0,
      done: true,
      parts: [{ kind: 'file', callId: 'c1', name: 'report.md', size: 2048, mime: 'text/markdown' }],
    }
    const html = renderToStaticMarkup(<MessageBubble message={message} fileUrl={fileUrl} />)
    expect(html).toContain('report.md')
    expect(html).toContain('2.0 KB')
    expect(html).toContain('href="/api/files/report.md"')
  })

  it('流式中显示光标', () => {
    const message: UiMessage = {
      key: 's1',
      senderType: 'agent',
      senderId: 'ryen',
      senderName: 'Ryen',
      turnIndex: 0,
      done: false,
      parts: [{ kind: 'text', text: '正在' }],
    }
    expect(renderToStaticMarkup(<MessageBubble message={message} fileUrl={fileUrl} />)).toContain('bubble-cursor')
  })

  it('每条消息带 data-message-id，历史消息摘掉 hist: 前缀', () => {
    // 搜索命中回的是裸 id；行上的属性得是同一个 id，否则定位选择器永远选不中。
    const history: UiMessage = {
      key: 'hist:m-42',
      senderType: 'agent',
      senderId: 'ryen',
      senderName: 'Ryen',
      turnIndex: 0,
      done: true,
      parts: [{ kind: 'text', text: '周报第三点' }],
    }
    expect(renderToStaticMarkup(<MessageBubble message={history} fileUrl={fileUrl} />)).toContain(
      'data-message-id="m-42"',
    )
    // 流式消息没有服务端 id（也不会被搜索命中），原样保留 key
    const streaming: UiMessage = { ...history, key: 'stream:ryen:0', done: false }
    expect(renderToStaticMarkup(<MessageBubble message={streaming} fileUrl={fileUrl} />)).toContain(
      'data-message-id="stream:ryen:0"',
    )
  })
})

describe('自己的消息也有头像', () => {
  const userMessage = (overrides: Partial<UiMessage> = {}): UiMessage => {
    return {
      key: 'u1',
      senderType: 'user',
      senderId: 'user',
      senderName: '我',
      turnIndex: 0,
      done: true,
      parts: [{ kind: 'text', text: '在吗' }],
      ...overrides,
    }
  }

  /** 行的直接子元素里，头像列的位置（-1 = 这一列压根不存在）。 */
  const gutterIndexOf = (row: Element | undefined): number => {
    if (row === undefined) return -1
    return Array.from(row.children).findIndex((child) => {
      return child.classList.contains('bubble-avatar-gutter')
    })
  }

  it('传了 viewer 就在气泡右侧画上自己的头像', () => {
    const { container, unmount } = mount(
      <MessageBubble message={userMessage()} fileUrl={fileUrl} viewer={{ avatarKey: 'cat', name: '小明' }} />,
    )
    const row = container.querySelector('.bubble-row') as HTMLElement
    // 两侧的头像列是同一个 DOM 位置（行的第一个子元素），用户行 row-reverse 把它翻到右边。
    // 钉位置而不是钉坐标：镜像靠布局翻面实现，另写一份右侧的列就会漏掉这条不变式。
    expect(gutterIndexOf(row)).toBe(0)
    expect(row.querySelector('.bubble-avatar-gutter .avatar-cat')).not.toBeNull()
    expect(row.querySelector('.bubble-avatar-gutter .avatar')?.getAttribute('aria-label')).toBe('小明')
    // 自己的名字每条都挂一行只是噪音：用户侧不画名字行（且不碰 agent 专属的暗色色相变量）。
    expect(container.querySelector('.bubble-name')).toBeNull()
    unmount()
  })

  it('没有 viewer 就不画这一列：老服务端降级成今天的样子，不多出一个空占位', () => {
    const { container, unmount } = mount(<MessageBubble message={userMessage()} fileUrl={fileUrl} />)
    const row = container.querySelector('.bubble-row') as HTMLElement
    expect(gutterIndexOf(row)).toBe(-1)
    // 降级后排版仍要读得出是自己发的
    expect(row.className).toContain('from-user')
    unmount()
  })

  it('组内第二条只留白不画脸：与 agent 侧同一条规矩，否则气泡边缘会横着跳', () => {
    const viewer = { avatarKey: 'cat', name: '小明' }
    const { container, unmount } = mount(
      <>
        <MessageBubble message={userMessage()} fileUrl={fileUrl} viewer={viewer} />
        <MessageBubble
          message={userMessage({ key: 'u2', parts: [{ kind: 'text', text: '在' }] })}
          fileUrl={fileUrl}
          viewer={viewer}
          tight
          firstOfGroup={false}
        />
      </>,
    )
    const rows = container.querySelectorAll('.bubble-row')
    const first = rows[0] as HTMLElement
    const second = rows[1] as HTMLElement
    // 列留着（两侧同一块 40px 定宽），只是第二条里面没有头像
    expect(gutterIndexOf(first)).toBe(0)
    expect(gutterIndexOf(second)).toBe(0)
    expect(first.querySelector('.bubble-avatar-gutter .avatar')).not.toBeNull()
    expect(second.querySelector('.bubble-avatar-gutter .avatar')).toBeNull()
    unmount()
  })
})

describe('RelayChain 接力链', () => {
  const nameOf = (id: string): string => ({ ryen: 'Ryen', codebot: 'CodeBot' })[id] ?? id
  const avatarOf = (id: string) => {
    return { avatarKey: { ryen: 'cat', codebot: 'bot' }[id], name: nameOf(id) } as { avatarKey?: string; name: string }
  }

  it('渲染头像流转与护栏样式', () => {
    const html = renderToStaticMarkup(
      <RelayChain
        turnIndex={0}
        nameOf={nameOf}
        avatarOf={avatarOf}
        relays={[
          { toAgent: 'ryen', reason: 'default-dispatcher', turnIndex: 0 },
          { fromAgent: 'ryen', toAgent: 'codebot', reason: 'relay @CodeBot', turnIndex: 0 },
          { fromAgent: 'codebot', toAgent: 'codebot', reason: 'loop-guard', turnIndex: 0 },
        ]}
      />,
    )
    expect(html).toContain('relay-flow')
    expect(html).toContain('relay-arrow')
    expect(html).toContain('转交')
    expect(html).toContain('调度')
    expect(html).toContain('is-guard')
  })

  it('只渲染当前 turn 的事件；无事件返回 null', () => {
    const html = renderToStaticMarkup(
      <RelayChain
        turnIndex={1}
        nameOf={nameOf}
        avatarOf={avatarOf}
        relays={[{ toAgent: 'ryen', reason: 'default-dispatcher', turnIndex: 0 }]}
      />,
    )
    expect(html).toBe('')
    const empty = renderToStaticMarkup(<RelayChain turnIndex={0} nameOf={nameOf} avatarOf={avatarOf} relays={[]} />)
    expect(empty).toBe('')
  })
})
