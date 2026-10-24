// @vitest-environment jsdom
/**
 * 欢迎页工作台：继续上次、团队、任务卡、页脚与窄屏 DOM 顺序。
 *
 * 这些用例盯的是「信息架构」而不是像素：首屏只留一条继续入口、团队点了真的
 * 换去向并聚焦输入框、任务卡只填词不替用户发送、隐私/示例退到页脚。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentDef, Conversation, ProviderInfo } from '../renderer/src/api.ts'
import { type ConversationRow, WelcomeHome, type WelcomeTarget } from '../renderer/src/components/WelcomeHome.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ryen: AgentDef = {
  id: 'ryen',
  name: 'Ryen',
  systemPrompt: 'p',
  provider: 'x',
  model: 'm',
  tools: [],
  isBuiltin: true,
}

const coder: AgentDef = {
  id: 'coder',
  name: '工程师',
  systemPrompt: 'p',
  provider: 'x',
  model: 'm',
  tools: [],
  isBuiltin: false,
}

const writer: AgentDef = {
  id: 'writer',
  name: '文案',
  systemPrompt: 'p',
  provider: 'x',
  model: 'm',
  tools: [],
  isBuiltin: false,
}

const providers: ProviderInfo[] = [
  { id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: true, models: [] },
]

const latest: Conversation = {
  id: 'c2',
  kind: 'group',
  title: '季度复盘',
  memberAgentIds: ['ryen', 'coder'],
  dispatcherAgentId: 'ryen',
  lastReadSeq: 0,
  updatedAt: 20,
  createdAt: 1,
  lastMessagePreview: '报告已经放好，等你过目。',
  unreadCount: 3,
}

const older: Conversation = {
  id: 'c1',
  kind: 'direct',
  title: '更早的会话标题',
  memberAgentIds: ['ryen'],
  lastReadSeq: 0,
  updatedAt: 10,
  createdAt: 1,
  lastMessagePreview: '这句不该出现在首屏',
}

const demo: Conversation = {
  id: 'demo-1',
  kind: 'group',
  title: '示例 · 一起做季度报告',
  memberAgentIds: ['ryen', 'coder'],
  dispatcherAgentId: 'ryen',
  lastReadSeq: 0,
  updatedAt: 30,
  createdAt: 1,
  lastMessagePreview: '报告已经放进工作区。',
}

let container: HTMLDivElement
let root: Root | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = undefined
  container.remove()
})

function renderWelcome(overrides: {
  agents?: AgentDef[]
  conversations?: Conversation[]
  providers?: ProviderInfo[]
  onSend?: (text: string, target: WelcomeTarget) => void
  onOpenConversation?: (id: string) => void
}): void {
  act(() => {
    root = createRoot(container)
    root.render(
      <WelcomeHome
        ryen={ryen}
        agents={overrides.agents ?? [ryen, coder, writer]}
        conversations={overrides.conversations ?? []}
        providers={overrides.providers ?? providers}
        onSaveApiKey={() => {
          return Promise.resolve()
        }}
        onSend={overrides.onSend ?? (() => {})}
        onOpenConversation={overrides.onOpenConversation ?? (() => {})}
      />,
    )
  })
}

function buttonByText(text: string, scope: ParentNode = container): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => {
    return node.textContent?.includes(text)
  })
  if (found === undefined) throw new Error(`找不到按钮：${text}`)
  return found
}

function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('HTMLTextAreaElement.prototype.value 缺少 setter')
  setter.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('欢迎页：待办行（不重复左栏）', () => {
  it('只把有未读的那一条抬起来，左栏已经有的其余会话不在首屏出现', () => {
    const opened: string[] = []
    renderWelcome({
      conversations: [latest, older],
      onOpenConversation: (id) => {
        opened.push(id)
      },
    })

    const rows = container.querySelectorAll('.welcome-recent-item')
    expect(rows).toHaveLength(1)
    const row = rows[0] as HTMLButtonElement
    expect(row.textContent).toContain('季度复盘')
    expect(row.textContent).toContain('报告已经放好，等你过目。')
    expect(row.querySelector('.unread-badge')?.textContent).toBe('3')
    expect(row.querySelectorAll('.welcome-continue-avatar')).toHaveLength(2)
    // 更早的那条没有未读，左栏已经按时间列着它：首屏不必再抄一遍，预览文字都不该出现。
    expect(container.textContent).not.toContain('更早的会话标题')
    expect(container.textContent).not.toContain('这句不该出现在首屏')

    act(() => {
      row.click()
    })
    expect(opened).toEqual(['c2'])
  })

  it('Ryen 主动开口过的那一条同样算待办（没有未读也要抬起来）', () => {
    const spoke: ConversationRow = { ...latest, unreadCount: 0, proactive: true }
    renderWelcome({ conversations: [spoke] })
    const row = container.querySelector<HTMLButtonElement>('.welcome-recent-item')
    expect(row).not.toBeNull()
    expect(row?.querySelector('[data-proactive="true"]')?.textContent).toBe('主动')
  })

  it('没有待办时整块不渲染，也不留一张占位卡', () => {
    // 「从一句需求开始」那张卡被删了：它唯一的作用是把焦点交给输入框，而输入框就在
    // 同一屏的下面。为一个用户马上就要做的动作占掉一张卡，是把版面花在废话上。
    renderWelcome({ conversations: [older] })
    expect(container.querySelector('.welcome-recent')).toBeNull()
    expect(container.textContent).not.toContain('从一句需求开始')
    expect(container.textContent).not.toContain('写一句')
    // 「仍然有路可走」这条保证没丢：入口就是 composer 自己，它在、没被禁用、还能聚焦。
    const textarea = container.querySelector<HTMLTextAreaElement>('.welcome-compose textarea')
    expect(textarea).not.toBeNull()
    expect(textarea?.disabled).toBe(false)
    act(() => {
      textarea?.focus()
    })
    expect(document.activeElement).toBe(textarea)
  })
})

describe('欢迎页：收件人行（去向只有一个控件）', () => {
  it('点一个助理头像就换去向、聚焦输入框，发送时带上 agentId', () => {
    const sent: Array<[string, WelcomeTarget]> = []
    renderWelcome({
      onSend: (text, target) => {
        sent.push([text, target])
      },
    })

    const member = buttonByText('工程师', container.querySelector('.welcome-team-row') ?? container)
    act(() => {
      member.click()
    })
    expect(member.getAttribute('aria-pressed')).toBe('true')
    // 头像移进 composer 之后，它自己就是"跟这一位聊"的全部表达——没有第二个按钮
    // 在 200px 外写同一个决定。
    expect(container.textContent).not.toContain('跟 工程师 聊')
    const textarea = container.querySelector<HTMLTextAreaElement>('.welcome-compose textarea')
    if (textarea === null) throw new Error('首屏没有输入框')
    expect(document.activeElement).toBe(textarea)
    expect(container.querySelector('.welcome-live')?.textContent).toContain('下一句发给 工程师')

    act(() => {
      typeInto(textarea, '帮我看一下这个报错')
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('.send-btn')?.click()
    })
    expect(sent).toEqual([['帮我看一下这个报错', { kind: 'direct', agentId: 'coder' }]])
  })

  it('Ryen 的头像就是「跟 Ryen 聊」，而且它默认就是选中态', () => {
    renderWelcome({})
    const ryen = buttonByText('Ryen', container.querySelector('.welcome-team-row') ?? container)
    // 默认去向必须是个人助理而不是群发：不选任何东西时，发出去的话只给 Ryen。
    expect(ryen.getAttribute('aria-pressed')).toBe('true')
    const squad = container.querySelector<HTMLButtonElement>('.welcome-squad')
    expect(squad?.getAttribute('aria-pressed')).toBe('false')
    expect(squad?.textContent).toContain('小队')
    // 职能（总管 / 工程师）撤了：32px 头像底下挂两行字，整排就变成一堆小卡片。
    expect(container.querySelector('.welcome-team-role')).toBeNull()
  })

  it('头像排与小队胶囊是同一组 aria-pressed：广播要用户自己点进去', () => {
    renderWelcome({})
    const toggles = [...container.querySelectorAll<HTMLButtonElement>('.welcome-addressee [aria-pressed]')]
    expect(toggles.length).toBeGreaterThan(1)
    expect(toggles.filter((node) => node.getAttribute('aria-pressed') === 'true')).toHaveLength(1)
    act(() => {
      container.querySelector<HTMLButtonElement>('.welcome-squad')?.click()
    })
    expect(container.querySelector('.welcome-squad')?.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelectorAll('.welcome-addressee [aria-pressed="true"]')).toHaveLength(1)
  })
})

describe('欢迎页：起步建议', () => {
  it('填入文案、联动去向，并通过 aria-live 播报', () => {
    renderWelcome({})
    const task = container.querySelector<HTMLButtonElement>(
      '.welcome-task[data-prompt="帮我做一份行业分析 PPT，小队一起上"]',
    )
    if (task === null) throw new Error('找不到行业分析建议')

    act(() => {
      task.click()
    })
    const textarea = container.querySelector<HTMLTextAreaElement>('.welcome-compose textarea')
    expect(textarea?.value).toBe('帮我做一份行业分析 PPT，小队一起上')
    expect(document.activeElement).toBe(textarea)
    // 去向由收件人行的小队胶囊说，不靠卡片上的一句标签。
    expect(container.querySelector('.welcome-squad')?.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('.welcome-live')?.textContent).toContain('发往小队群')
    // 建议只填词，绝不替用户把话发出去。
    expect(textarea?.value).toBe('帮我做一份行业分析 PPT，小队一起上')
  })

  it('单聊任务把去向拨回 Ryen（收件人行上那位头像亮起来）', () => {
    renderWelcome({})
    const task = container.querySelector<HTMLButtonElement>('.welcome-task[data-prompt="帮我整理一份本周周报"]')
    if (task === null) throw new Error('找不到周报建议')
    expect(task.textContent).toContain('本周周报')

    act(() => {
      task.click()
    })
    expect(container.querySelector<HTMLTextAreaElement>('.welcome-compose textarea')?.value).toBe(
      '帮我整理一份本周周报',
    )
    expect(
      buttonByText('Ryen', container.querySelector('.welcome-team-row') ?? container).getAttribute('aria-pressed'),
    ).toBe('true')
    expect(container.querySelector('.welcome-squad')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('三张建议不多不少，且左端摆的是真实去向的头像而不是装饰图标', () => {
    renderWelcome({ agents: [ryen, coder, writer] })
    const cards = [...container.querySelectorAll('.welcome-task')]
    expect(cards).toHaveLength(3)
    // 小队任务两个头像、单聊任务一个：点之前就知道这句话会发给谁，而这正是 fillTask
    // 真正会做的事。装饰性图标说的是"我是功能"，头像说的是"发给谁"。
    expect(cards.map((card) => card.querySelectorAll('.welcome-task-avatars .avatar').length)).toEqual([2, 2, 1])
    // 胶囊上不再印第四个盒子。
    expect(container.querySelector('.welcome-task-target')).toBeNull()
    // 读屏器读不出头像，所以有一句隐藏文案兜住去向。
    expect(cards.map((card) => card.querySelector('.welcome-sr')?.textContent)).toEqual([
      '发往小队 3 人',
      '发往小队 3 人',
      '发往Ryen',
    ])
  })

  it('没有可用供应商时：点建议不往禁用的输入框里填字，焦点与播报都引向配 Key 卡', () => {
    renderWelcome({
      providers: [{ id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: false, models: [] }],
    })
    const textarea = container.querySelector<HTMLTextAreaElement>('.welcome-compose textarea')
    if (textarea === null) throw new Error('首屏没有输入框')
    // 未就绪时输入框是禁用的（此时 usable=false 且清单已读完）。
    expect(textarea.disabled).toBe(true)
    const task = container.querySelector<HTMLButtonElement>(
      '.welcome-task[data-prompt="帮我做一份行业分析 PPT，小队一起上"]',
    )
    if (task === null) throw new Error('找不到行业分析建议')
    act(() => {
      task.click()
    })
    // 字没有进灰掉的输入框（进去了也改不了、发不出），去向也没被拨动。
    expect(textarea.value).toBe('')
    expect(container.querySelector('.welcome-squad')?.getAttribute('aria-pressed')).toBe('false')
    // 焦点落在配置卡上，播报换成引导配 Key 的文案，而不是「你可以改完再发」。
    const prereq = container.querySelector('.welcome-prereq')
    expect(prereq).not.toBeNull()
    expect(document.activeElement).toBe(prereq)
    expect(container.querySelector('.welcome-live')?.textContent).toContain('先在上面配一家')
    expect(container.querySelector('.welcome-live')?.textContent).not.toContain('你可以改完再发')
  })
})

describe('欢迎页：页脚与单列结构', () => {
  it('隐私披露收在页脚：一行人话，展开才是完整口径', () => {
    renderWelcome({ conversations: [latest] })
    const foot = container.querySelector('.welcome-foot')
    expect(foot).not.toBeNull()
    // 收起来时也必须说清「上下文会离开这台机器」——披露不能只存在于展开态里。
    const privacy = foot?.querySelector('details.welcome-privacy')
    expect(privacy).not.toBeNull()
    expect(privacy?.querySelector('summary')?.textContent).toContain('上下文会发给你选的模型供应商')
    expect(foot?.textContent).toContain('对话与记忆存储在本机')
    expect(foot?.textContent).toContain('推理时会把当前上下文发送给你选择的模型供应商')
    expect(foot?.textContent).toContain('Key 只保存在本机')
  })

  it('示例退到页脚一行 housekeeping：仍然标着示例，也仍然删得掉', () => {
    renderWelcome({ conversations: [demo] })
    // 首启示例既没有未读也不是主动开口——它不是待办，所以不占那条会话行。
    // 但 ConversationList 那边没有删除入口，这个叉必须留在这儿。
    expect(container.querySelector('.welcome-recent-item')).toBeNull()
    const row = container.querySelector('.welcome-demo-row') as HTMLElement
    expect(row.querySelector('.welcome-demo-tag')?.textContent).toBe('示例')
    expect(row.textContent).toContain('首次启动时自带的一条')
    expect(row.querySelector('.welcome-demo-clear')?.getAttribute('aria-label')).toBe('删除示例会话')
  })

  it('用户自己的会话不会被误当成示例', () => {
    renderWelcome({ conversations: [latest] })
    expect(container.querySelector('.welcome-demo-row')).toBeNull()
  })

  it('DOM 顺序就是屏幕顺序：问候 → 待办 → 建议 → 输入', () => {
    renderWelcome({ conversations: [latest] })
    const order = [
      ...container.querySelectorAll('.welcome-head, .welcome-pending, .welcome-suggestions, .welcome-compose'),
    ]
    expect(
      order.map((node) => {
        return ['welcome-head', 'welcome-pending', 'welcome-suggestions', 'welcome-compose'].find((name) => {
          return node.classList.contains(name)
        })
      }),
    ).toEqual(['welcome-head', 'welcome-pending', 'welcome-suggestions', 'welcome-compose'])
    // 宽屏没有右栏、没有独立团队块：DOM 顺序就是屏幕顺序，且输入框永远是最后一块。
    expect(container.querySelector('.welcome-grid')).not.toBeNull()
    expect(container.querySelector('.welcome-side')).toBeNull()
    // 收件人行在 composer 里面，不在它外面。
    expect(container.querySelector('.welcome-compose .welcome-addressee')).not.toBeNull()
    expect(container.querySelectorAll('.welcome-task-grid .welcome-task')).toHaveLength(3)
  })

  it('全页只有一句大标题，其余区块都是一行小标签', () => {
    renderWelcome({ conversations: [latest] })
    // 顺着页面摞三组「小标签 + 大标题 + 计数」读起来像落地页：这里只留一句 h1。
    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(container.querySelectorAll('h2')).toHaveLength(0)
    expect(container.querySelectorAll('.welcome-kicker')).toHaveLength(0)
    expect(container.querySelectorAll('.welcome-team-count')).toHaveLength(0)
  })
})
