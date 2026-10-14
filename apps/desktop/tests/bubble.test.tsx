// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageBubble, RelayChain } from '../renderer/src/components/MessageBubble.tsx'
import type { UiMessage } from '../renderer/src/store.ts'

const fileUrl = (name: string): string => {
  return `/api/files/${name}`
}

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
    expect(html).toContain('正在使用工具：fs_write')
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
