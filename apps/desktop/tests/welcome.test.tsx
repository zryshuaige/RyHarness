// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, Conversation, ProviderInfo } from '../renderer/src/api.ts'
import { RelayChain } from '../renderer/src/components/MessageBubble.tsx'
import { greetingForHour, WelcomeHome } from '../renderer/src/components/WelcomeHome.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 主进程 seedFirstLaunchDemo 种出来的首启演示会话（标题前缀与它一致）。 */
function demoConversation(): Conversation {
  return {
    id: 'demo-1',
    kind: 'group',
    title: '示例 · Ryen、阿码、阿屉一起定晚饭',
    memberAgentIds: ['ryen', 'ryen-team-coding', 'ryen-team-organizer'],
    dispatcherAgentId: 'ryen',
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 2,
    lastMessagePreview: '那就定周三晚，巷口那家意面、少辣。',
  }
}

/** 首屏渲染用的默认 props：凭据齐全、无选中会话。 */
function welcomeProps(overrides: { conversations?: Conversation[] } = {}) {
  return {
    ryen: undefined,
    agents: [],
    conversations: overrides.conversations ?? [],
    providers: [
      { id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: true, models: [] },
    ] as ProviderInfo[],
    onSaveApiKey: () => {
      return Promise.resolve()
    },
    onSend: () => {},
    onOpenConversation: () => {},
  }
}

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
        onSend={() => {}}
        onOpenConversation={() => {}}
      />,
    )
    expect(html).toContain('我是 Ryen')
    expect(html).toContain('welcome-chip')
    expect(html).toContain('帮我整理一份本周周报')
    expect(html).toContain('最近会话')
    expect(html).toContain('周报写好了')
    expect(html).toContain('<svg') // 猫管家 SVG
    // 首屏必须真的有输入框：文案让用户"直接跟我说"，页面上就得有地方说。
    expect(html).toContain('welcome-compose')
    expect(html).toContain('<textarea')
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
        onSend={() => {}}
        onOpenConversation={() => {}}
      />,
    )
    expect(html).toContain('先填一个 API Key')
    expect(html).toContain('SiliconFlow API Key')
  })

  it('只有免 key 的本地服务时不催人填 key（本地用户压根没有 key 可填）', () => {
    const html = renderToStaticMarkup(
      <WelcomeHome
        ryen={undefined}
        agents={[]}
        conversations={[]}
        providers={[
          { id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: false, models: [] },
          { id: 'ollama', displayName: 'Ollama', apiKeyConfigured: false, protocol: 'ollama', models: [] },
        ]}
        onSaveApiKey={() => {
          return Promise.resolve()
        }}
        onSend={() => {}}
        onOpenConversation={() => {}}
      />,
    )
    expect(html).not.toContain('先填一个 API Key')
  })

  it('有 key 的供应商在位时不催人填 key', () => {
    const html = renderToStaticMarkup(
      <WelcomeHome
        ryen={undefined}
        agents={[]}
        conversations={[]}
        providers={[
          { id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: true, models: [] },
          { id: 'moonshot', displayName: 'Moonshot', apiKeyConfigured: false, models: [] },
        ]}
        onSaveApiKey={() => {
          return Promise.resolve()
        }}
        onSend={() => {}}
        onOpenConversation={() => {}}
      />,
    )
    expect(html).not.toContain('先填一个 API Key')
  })

  it('首屏把三件事写出来：多 agent 接力、长期记忆、自我进化', () => {
    const html = renderToStaticMarkup(<WelcomeHome {...welcomeProps()} />)
    expect(html).toContain('多 agent 群聊接力')
    expect(html).toContain('长期记忆')
    expect(html).toContain('自我进化')
    // 场景 chip 天然会触发接力、翻旧账、复盘，而不是清一色的公文。
    expect(html).toContain('我们三个定下周去哪吃')
    expect(html).toContain('把我上次说的偏好讲给团队听')
    expect(html).not.toContain('写一封简短的请假邮件')
    expect(html).not.toContain('给我列一个下周工作计划')
  })

  it('「数据都在本机」在首屏看得见，不再只藏在「我的」页第三级', () => {
    const html = renderToStaticMarkup(<WelcomeHome {...welcomeProps()} />)
    expect(html).toContain('数据都在本机')
    expect(html).toContain('不上传到任何服务器')
  })

  it('首启演示会话被标成示例，并给出一键删除的入口', () => {
    const html = renderToStaticMarkup(<WelcomeHome {...welcomeProps({ conversations: [demoConversation()] })} />)
    expect(html).toContain('示例 · Ryen、阿码、阿屉一起定晚饭')
    expect(html).toContain('不是你自己的历史')
    expect(html).toContain('删掉示例')
  })

  it('用户自己的会话不会被误当成示例（不出现删除按钮）', () => {
    const html = renderToStaticMarkup(
      <WelcomeHome {...welcomeProps({ conversations: [{ ...demoConversation(), id: 'c2', title: 'Ryen' }] })} />,
    )
    expect(html).not.toContain('删掉示例')
  })
})

describe('示例会话：一键删除真的删得掉', () => {
  let container: HTMLDivElement
  let root: Root
  const fetchMock = vi.fn()

  beforeEach(() => {
    window.history.replaceState({}, '', '/?api=http://127.0.0.1:32100')
    container = document.createElement('div')
    document.body.appendChild(container)
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    act(() => {
      root = createRoot(container)
      root.render(<WelcomeHome {...welcomeProps({ conversations: [demoConversation()] })} />)
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.unstubAllGlobals()
  })

  it('点「删掉示例」打 DELETE 并把这行摘掉', async () => {
    await clickDeleteDemo()
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:32100/api/conversations/demo-1', { method: 'DELETE' })
    expect(container.textContent).not.toContain('示例 · Ryen、阿码、阿屉一起定晚饭')
  })

  it('后端没删成功时说清楚，不假装已经删掉', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409 })
    await clickDeleteDemo()
    expect(container.textContent).toContain('删除失败（HTTP 409）')
    expect(container.textContent).toContain('示例 · Ryen、阿码、阿屉一起定晚饭')
  })

  async function clickDeleteDemo(): Promise<void> {
    const button = [...container.querySelectorAll('button')].find((node) => {
      return node.textContent === '删掉示例'
    })
    expect(button).toBeDefined()
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }
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
