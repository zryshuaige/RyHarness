// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, Conversation, ProviderInfo, ProviderPreset } from '../renderer/src/api.ts'
import { setApiToken } from '../renderer/src/api.ts'
import { RelayChain } from '../renderer/src/components/MessageBubble.tsx'
import { greetingForHour, WelcomeHome } from '../renderer/src/components/WelcomeHome.tsx'
import { getToasts, toast } from '../renderer/src/lib/toast.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 当前屏幕上的 toast 文案。删除失败改走 toast 之后，断言得从 DOM 挪到这里。 */
function toastTexts(): string[] {
  return getToasts().map((item) => {
    return item.text
  })
}

/** 主进程 seedFirstLaunchDemo 种出来的首启演示会话（标题前缀与它一致）。 */
function demoConversation(): Conversation {
  return {
    id: 'demo-1',
    kind: 'group',
    title: '示例 · Ryen（总管）、工程师、管家一起做季度报告',
    memberAgentIds: ['ryen', 'ryen-team-coding', 'ryen-team-organizer'],
    dispatcherAgentId: 'ryen',
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 2,
    lastMessagePreview: '报告已经放进工作区（智能家居季度报告-v1.docx），结论先行、图表齐全。',
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

  it('渲染猫管家、问候、起步建议与待办行', () => {
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
        unreadCount: 2,
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
    // 有未读 = 有待办，这一行才在；带标题与最后一句。
    expect(html).toContain('等你回一句')
    expect(html).toContain('welcome-pending-row')
    expect(html).toContain('周报写好了')
    expect(html).toContain('<svg') // 猫管家 SVG
    // 首屏必须真的有输入框：文案让用户"直接跟我说"，页面上就得有地方说。
    expect(html).toContain('welcome-compose')
    expect(html).toContain('<textarea')
    // 凭据齐全时不出现配置卡。
    expect(html).not.toContain('先填一个 API Key')
  })

  it('没有待办时不留占位卡（空状态也不占一张卡）', () => {
    // 左栏已经列了全部会话；「什么都没有」不是首屏需要再说一遍的事。
    const html = renderToStaticMarkup(<WelcomeHome {...welcomeProps()} />)
    expect(html).not.toContain('welcome-pending-row')
    expect(html).not.toContain('等你回一句')
    // 被删掉的空态引导卡：它唯一的作用是把焦点交给输入框，而输入框就在下面。
    expect(html).not.toContain('从一句需求开始')
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

  it('首屏的起步建议直接说出那句话，且标着发给谁', () => {
    const html = renderToStaticMarkup(<WelcomeHome {...welcomeProps()} />)
    // 场景 chip 天然会触发接力、翻旧账、复盘，而不是清一色的公文。
    // prompt 是载荷（允许是一整句），标题只说这是一件什么事。
    expect(html).toContain('行业分析 PPT')
    expect(html).toContain('上次的偏好')
    expect(html).toContain('本周周报')
    expect(html).toContain('帮我做一份行业分析 PPT，小队一起上')
    expect(html).toContain('把我上次说的偏好讲给团队听')
    expect(html).not.toContain('写一封简短的请假邮件')
    expect(html).not.toContain('给我列一个下周工作计划')
    // 去向由头像说出来，读屏器由那句隐藏文案说出来；胶囊上不再印第四个盒子。
    expect(html).toContain('welcome-task-avatars')
    expect(html).toContain('发往小队')
    expect(html).toContain('发往Ryen')
    expect(html).not.toContain('welcome-task-target')
  })

  it('「存储在本机、推理会上传上下文」在首屏看得见，且不再承诺「不上传」', () => {
    const html = renderToStaticMarkup(<WelcomeHome {...welcomeProps()} />)
    expect(html).toContain('对话与记忆存储在本机')
    expect(html).toContain('推理时会把当前上下文发送给你选择的模型供应商')
    expect(html).toContain('Key 只保存在本机')
    // 旧文案把「本地存储」偷换成「本地推理」，是一句不准确的承诺，不许回来。
    expect(html).not.toContain('不上传到任何服务器')
  })

  it('首启演示退到页脚一行：带一枚安静的「示例」标签与一个删除键', () => {
    const html = renderToStaticMarkup(<WelcomeHome {...welcomeProps({ conversations: [demoConversation()] })} />)
    // 首屏的会话行只留给待办；示例既没未读也不是主动开口，它在这里没有位置——
    // 但它仍然必须删得掉，所以标签与叉退到页脚，紧挨着隐私披露。
    expect(html).toContain('welcome-demo-tag')
    expect(html).toContain('welcome-demo-clear')
    // 删除是一个图标键，它必须自己带可读名，光靠一个叉说不清自己在干嘛。
    expect(html).toContain('aria-label="删除示例会话"')
    // 它不再占据一条会话行：没有待办就没有那一行，示例也不顶替它。
    expect(html).not.toContain('welcome-pending-row')
    // 旧版那段「不是你自己的历史 / 删掉示例」是在替界面复述界面，整段去掉。
    expect(html).not.toContain('不是你自己的历史')
  })

  it('用户自己的会话不会被误当成示例（不出现示例标签与删除键）', () => {
    const html = renderToStaticMarkup(
      <WelcomeHome {...welcomeProps({ conversations: [{ ...demoConversation(), id: 'c2', title: 'Ryen' }] })} />,
    )
    expect(html).not.toContain('welcome-demo-tag')
    expect(html).not.toContain('welcome-demo-clear')
  })
})

describe('首屏挑供应商', () => {
  const presets: ProviderPreset[] = [
    {
      id: 'siliconflow',
      displayName: 'SiliconFlow',
      protocol: 'openai',
      baseUrl: 'https://api.siliconflow.cn/v1',
      models: ['deepseek-ai/DeepSeek-V4-Flash'],
    },
    {
      id: 'deepseek',
      displayName: 'DeepSeek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      models: ['deepseek-chat'],
    },
  ]

  let container: HTMLDivElement
  /** 只在交互那两条里建过；静态渲染那条没有 root。 */
  let root: Root | undefined

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (root !== undefined) {
      act(() => {
        root?.unmount()
      })
      root = undefined
    }
    container.remove()
  })

  it('首屏是「先挑一家」的网格，而不是默认点名某一家', () => {
    const html = renderToStaticMarkup(
      <WelcomeHome
        ryen={undefined}
        agents={[]}
        conversations={[]}
        providers={[{ id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: false, models: [] }]}
        presets={presets}
        onSaveApiKey={() => {
          return Promise.resolve()
        }}
        onSaveProviderKey={() => {
          return Promise.resolve()
        }}
        onSend={() => {}}
        onOpenConversation={() => {}}
      />,
    )
    expect(html).toContain('先选一家模型供应商')
    expect(html).toContain('DeepSeek')
    // 还没挑的时候，不该已经把某一家写进输入框的占位符里。
    expect(html).not.toContain('SiliconFlow API Key')
  })

  it('挑了哪家就填哪家的 key，保存也走用户挑的那家', async () => {
    const onSaveProviderKey = vi.fn(async () => {
      return undefined
    })
    act(() => {
      root = createRoot(container)
      root.render(
        <WelcomeHome
          ryen={undefined}
          agents={[]}
          conversations={[]}
          providers={[{ id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: false, models: [] }]}
          presets={presets}
          onSaveApiKey={() => {
            return Promise.resolve()
          }}
          onSaveProviderKey={onSaveProviderKey}
          onSend={() => {}}
          onOpenConversation={() => {}}
        />,
      )
    })
    const tiles = container.querySelectorAll<HTMLButtonElement>('.provider-pick-tile')
    expect(tiles).toHaveLength(2)
    await act(async () => {
      tiles[1]?.click()
    })
    expect(container.textContent).toContain('填 DeepSeek 的 key')
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')
    expect(input).not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(input, 'sk-test-key')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = container.querySelector<HTMLButtonElement>('.apikey-row .btn-primary')
    await act(async () => {
      save?.click()
    })
    expect(onSaveProviderKey).toHaveBeenCalledWith(expect.objectContaining({ id: 'deepseek' }), 'sk-test-key')
  })
})

describe('示例会话：一键删除真的删得掉', () => {
  let container: HTMLDivElement
  let root: Root
  const fetchMock = vi.fn()

  /** 删除键是行尾那个图标按钮（`aria-label` 说明自己在干嘛），不再是一行说明文字。 */
  const deleteButton = (): HTMLButtonElement => {
    const button = container.querySelector<HTMLButtonElement>('.welcome-demo-clear')
    expect(button, '首屏没有删除示例的按键').not.toBeNull()
    return button as HTMLButtonElement
  }

  beforeEach(() => {
    window.history.replaceState({}, '', '/?api=http://127.0.0.1:32100&token=token-demo')
    setApiToken('token-demo')
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
    setApiToken('')
    for (const item of getToasts()) toast.dismiss(item.id)
  })

  it('点删除键打 DELETE（带 token）并把它从首屏摘掉', async () => {
    await clickDeleteDemo()
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; headers?: Record<string, string> }]
    expect(url).toBe('http://127.0.0.1:32100/api/conversations/demo-1')
    expect(init.method).toBe('DELETE')
    // 生产模式主进程每次启动发 256 位 token，服务端对每个请求都比对：裸 fetch 必然 401。
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer token-demo')
    expect(container.querySelector('.welcome-demo-clear')).toBeNull()
    expect(container.querySelector('.welcome-demo-row')).toBeNull()
  })

  it('后端没删成功时说清楚，不假装已经删掉', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409 })
    await clickDeleteDemo()
    // 失败走 toast：它得看得见（一个只有图标的小键旁边放不下错误文案）。
    expect(toastTexts().join('|')).toContain('删除失败（HTTP 409）')
    // 没删掉就必须还留着这个入口，不能把行悄悄摘掉装成已经删了。
    expect(container.querySelector('.welcome-demo-clear')).not.toBeNull()
  })

  async function clickDeleteDemo(): Promise<void> {
    const button = deleteButton()
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
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
