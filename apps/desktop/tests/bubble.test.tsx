// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageBubble, RelayChain } from '../renderer/src/components/MessageBubble.tsx'
import type { UiMessage } from '../renderer/src/store.ts'

const fileUrl = (name: string): string => { return `/api/files/${name}` }

describe('MessageBubble', () => {
  it('用户气泡右侧琥珀色、agent 气泡左侧白底', () => {
    const user: UiMessage = {
      key: 'u1', senderType: 'user', senderId: 'user', senderName: '我',
      turnIndex: 0, done: true, parts: [{ kind: 'text', text: '你好' }],
    }
    const agent: UiMessage = {
      key: 'a1', senderType: 'agent', senderId: 'ryen', senderName: 'Ryen',
      turnIndex: 0, done: true, parts: [{ kind: 'text', text: '欢迎回家' }],
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
      key: 't1', senderType: 'agent', senderId: 'ryen', senderName: 'Ryen',
      turnIndex: 0, done: false,
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
      key: 'f1', senderType: 'agent', senderId: 'ryen', senderName: 'Ryen',
      turnIndex: 0, done: true,
      parts: [{ kind: 'file', callId: 'c1', name: 'report.md', size: 2048, mime: 'text/markdown' }],
    }
    const html = renderToStaticMarkup(<MessageBubble message={message} fileUrl={fileUrl} />)
    expect(html).toContain('report.md')
    expect(html).toContain('2.0 KB')
    expect(html).toContain('href="/api/files/report.md"')
  })

  it('流式中显示光标', () => {
    const message: UiMessage = {
      key: 's1', senderType: 'agent', senderId: 'ryen', senderName: 'Ryen',
      turnIndex: 0, done: false, parts: [{ kind: 'text', text: '正在' }],
    }
    expect(renderToStaticMarkup(<MessageBubble message={message} fileUrl={fileUrl} />)).toContain('bubble-cursor')
  })
})

describe('RelayChain 接力链', () => {
  const nameOf = (id: string): string => ({ ryen: 'Ryen', codebot: 'CodeBot' })[id] ?? id

  it('渲染流转提示与护栏样式', () => {
    const html = renderToStaticMarkup(
      <RelayChain
        turnIndex={0}
        nameOf={nameOf}
        relays={[
          { toAgent: 'ryen', reason: 'default-dispatcher', turnIndex: 0 },
          { fromAgent: 'ryen', toAgent: 'codebot', reason: 'relay @CodeBot', turnIndex: 0 },
          { fromAgent: 'codebot', toAgent: 'codebot', reason: 'loop-guard', turnIndex: 0 },
        ]}
      />,
    )
    expect(html).toContain('Ryen → @CodeBot · 转交')
    expect(html).toContain('@Ryen · 调度')
    expect(html).toContain('is-guard')
  })

  it('只渲染当前 turn 的事件；无事件返回 null', () => {
    const html = renderToStaticMarkup(
      <RelayChain
        turnIndex={1}
        nameOf={nameOf}
        relays={[{ toAgent: 'ryen', reason: 'default-dispatcher', turnIndex: 0 }]}
      />,
    )
    expect(html).toBe('')
    const empty = renderToStaticMarkup(<RelayChain turnIndex={0} nameOf={nameOf} relays={[]} />)
    expect(empty).toBe('')
  })
})
