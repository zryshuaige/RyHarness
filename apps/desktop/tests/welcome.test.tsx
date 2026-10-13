// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentDef, Conversation } from '../renderer/src/api.ts'
import { RelayChain } from '../renderer/src/components/MessageBubble.tsx'
import { greetingForHour, WelcomeHome } from '../renderer/src/components/WelcomeHome.tsx'

describe('欢迎主页', () => {
  it('按时辰问候（纯函数）', () => {
    expect(greetingForHour(8)).toBe('早上好')
    expect(greetingForHour(12)).toBe('中午好')
    expect(greetingForHour(15)).toBe('下午好')
    expect(greetingForHour(20)).toBe('晚上好')
    expect(greetingForHour(1)).toBe('夜深了')
    expect(greetingForHour(23)).toBe('晚上好')
  })

  it('渲染猫管家、问候、建议 chips 与最近会话', () => {
    const agents: AgentDef[] = [
      {
        id: 'ryen',
        name: 'Ryen',
        avatar: 'cat',
        systemPrompt: 'p',
        provider: 'x',
        model: 'm',
        tools: [],
        isBuiltin: true,
      },
    ]
    const conversations: Conversation[] = [
      {
        id: 'c1',
        kind: 'direct',
        title: 'Ryen',
        memberAgentIds: ['ryen'],
        lastReadSeq: 0,
        createdAt: 1,
        updatedAt: 2,
        lastMessagePreview: '周报写好了',
      },
    ]
    const html = renderToStaticMarkup(
      <WelcomeHome
        ryen={agents[0]}
        agents={agents}
        conversations={conversations}
        providers={[{ id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: true, models: [] }]}
        onSaveApiKey={() => {
          return Promise.resolve()
        }}
        onSuggest={() => {}}
        onOpenConversation={() => {}}
      />,
    )
    expect(html).toContain('我是 Ryen')
    expect(html).toContain('welcome-chip')
    expect(html).toContain('帮我整理一份本周周报')
    expect(html).toContain('最近会话')
    expect(html).toContain('周报写好了')
    expect(html).toContain('<svg') // 猫管家 SVG
    // 凭据齐全时不出现配置卡。
    expect(html).not.toContain('先填一个 API Key')
  })

  it('没有配置凭据时给出 API Key 配置卡，而不是让用户去改环境变量', () => {
    const html = renderToStaticMarkup(
      <WelcomeHome
        ryen={undefined}
        agents={[]}
        conversations={[]}
        providers={[{ id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: false, models: [] }]}
        onSaveApiKey={() => {
          return Promise.resolve()
        }}
        onSuggest={() => {}}
        onOpenConversation={() => {}}
      />,
    )
    expect(html).toContain('先填一个 API Key')
    expect(html).toContain('SiliconFlow API Key')
  })
})

describe('接力链头像流转', () => {
  const agents: AgentDef[] = [
    { id: 'a', name: '甲', avatar: 'fox', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: false },
    { id: 'b', name: '乙', avatar: 'owl', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: false },
  ]
  const avatarOf = (id: string) => {
    const agent = agents.find((x) => {
      return x.id === id
    })
    return { avatarKey: agent?.avatar, name: agent?.name ?? id }
  }

  it('渲染头像 → 箭头 → 头像与标签，带错峰动画延迟', () => {
    const html = renderToStaticMarkup(
      <RelayChain
        turnIndex={0}
        nameOf={(id) => {
          return avatarOf(id).name
        }}
        avatarOf={avatarOf}
        relays={[
          { toAgent: 'a', reason: 'default-dispatcher', turnIndex: 0 },
          { fromAgent: 'a', toAgent: 'b', reason: 'relay @乙', turnIndex: 0 },
        ]}
      />,
    )
    expect(html).toContain('relay-flow')
    expect(html).toContain('relay-arrow')
    expect(html).toContain('relay-avatar')
    expect(html).toContain('调度')
    expect(html).toContain('转交')
    expect(html).toContain('animation-delay:0ms') !== undefined
    expect(html.match(/relay-avatar/g)!.length).toBe(3) // 甲 + 乙 + 乙
  })

  it('无本 turn 事件返回空', () => {
    const html = renderToStaticMarkup(
      <RelayChain
        turnIndex={1}
        nameOf={() => 'x'}
        avatarOf={avatarOf}
        relays={[{ toAgent: 'a', reason: 'default-dispatcher', turnIndex: 0 }]}
      />,
    )
    expect(html).toBe('')
  })
})
