// @vitest-environment jsdom
/**
 * RyVibe 页面：一句话进、点几下选项、出一份方案。
 *
 * 断言的是**用户真的只需要这两下动作**：说一句话 → 选一次提交。中间任何一步需要
 * 用户填表、点「下一步」、或者等第二轮，这个页面的承诺就破了。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import type {
  TodoItem,
  VibeOutputView,
  VibeProjectView,
  VibeQuestionView,
  VibeSessionView,
} from '../renderer/src/api.ts'
import { RyVibePage } from '../renderer/src/components/RyVibePage.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session: VibeSessionView = {
  id: 'v1',
  conversationId: 'c1',
  requirement: '给独立开发者做个记账工具',
  skillId: 'grill-me',
  squad: [
    { id: 'ryen', name: 'Ryen' },
    { id: 'eng', name: '工程师' },
  ],
  createdAt: 0,
  status: 'asking',
  stage: 'clarify',
  busy: false,
  pendingAnswers: 1,
  round: 0,
  maxRounds: 4,
  versions: [],
}

/**
 * 小队正在问的那一道题。
 *
 * 一次只问一题：上一题的答案回来了，小队才问下一题。用户全程只需要点几下，
 * 中间那一段等待里也确实有"我根据你的答案改了问题"的实质变化。
 */
const oneQuestion: VibeQuestionView[] = [{ id: 'q1', question: '这东西跑在哪？', options: ['网页', '桌面', '手机'] }]

/** 一次来了两道（老数据 / 兼容）：卡片照旧摆得下。 */
const questions: VibeQuestionView[] = [
  { id: 'q1', question: '这东西跑在哪？', options: ['网页', '桌面', '手机'] },
  { id: 'q2', question: '第一版要几屏？', options: ['1 屏', '2-3 屏'] },
]

/** 已经答过的那一道：答案留在流里，旁边有「改一下」。 */
const answeredQuestions: VibeQuestionView[] = [
  { id: 'q1', question: '这东西跑在哪？', options: ['网页', '桌面', '手机'], answered: true, selected: ['桌面'] },
]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

interface StubOptions {
  session?: VibeSessionView
  questions?: VibeQuestionView[]
  output?: VibeOutputView[]
  sessions?: VibeSessionView[]
  todos?: TodoItem[]
  /** 项目骨架里的文件内容（点文件名时读回来）。 */
  files?: Record<string, string>
  /** 中止这一轮（复用聊天页同一条端点）。 */
  cancelTurn?: (conversationId: string) => Promise<{ cancelled: boolean }>
}

/** 取不到就当场报错：断言之前静默拿到 undefined 只会把错报歪。 */
function must<T>(node: T | null | undefined, what: string): T {
  if (node === null || node === undefined) throw new Error(`找不到：${what}`)
  return node
}

/** 落盘后的项目骨架（页面上那块「项目已落盘」）。 */
const project: VibeProjectView = {
  name: '记账工具',
  slug: '记账工具',
  kind: 'app',
  dir: 'C:\\data\\workspace\\projects\\记账工具',
  files: [
    { name: 'README.md', size: 120 },
    { name: 'PLAN.md', size: 240 },
    { name: 'TODO.md', size: 80 },
    { name: 'index.html', size: 900 },
  ],
  validation: {
    ok: true,
    kind: 'app',
    checks: [],
    summary: '通过 4 项交付验收',
    validatedAt: 0,
  },
  createdAt: 0,
}

function stub(overrides: StubOptions = {}): {
  startVibe: Mock<(requirement: string) => Promise<{ session: VibeSessionView }>>
  vibe: Mock<
    (
      id: string,
      after?: number,
    ) => Promise<{
      session: VibeSessionView
      questions: VibeQuestionView[]
      output: VibeOutputView[]
      todos: TodoItem[]
    }>
  >
  answerVibe: Mock<
    (
      id: string,
      input: { answers: { questionId: string; selected: string[] }[]; skipped?: boolean },
    ) => Promise<{ session: VibeSessionView }>
  >
  vibeSessions: Mock<() => Promise<{ sessions: VibeSessionView[] }>>
  retryVibe: Mock<(id: string) => Promise<{ session: VibeSessionView }>>
  restoreVibeVersion: Mock<(id: string, versionId: string) => Promise<{ session: VibeSessionView }>>
  setTodoDone: Mock<(conversationId: string, id: string, done: boolean) => Promise<unknown>>
  vibeProjectFile: Mock<(id: string, name: string) => Promise<{ name: string; size: number; content: string }>>
} {
  const current = overrides.session ?? session
  const files = overrides.files ?? {}
  return {
    startVibe: vi.fn(async (_requirement: string) => {
      return { session: current }
    }),
    vibe: vi.fn(async (_id: string, _after?: number) => {
      return {
        session: current,
        questions: overrides.questions ?? [],
        output: overrides.output ?? [],
        todos: overrides.todos ?? [],
      }
    }),
    answerVibe: vi.fn(
      async (_id: string, _input: { answers: { questionId: string; selected: string[] }[]; skipped?: boolean }) => {
        return { session: current }
      },
    ),
    vibeSessions: vi.fn(async () => {
      return { sessions: overrides.sessions ?? [] }
    }),
    retryVibe: vi.fn(async (_id: string) => {
      return { session: current }
    }),
    restoreVibeVersion: vi.fn(async (_id: string, _versionId: string) => {
      return { session: current }
    }),
    setTodoDone: vi.fn(async (_conversationId: string, _id: string, _done: boolean) => {
      return undefined
    }),
    vibeProjectFile: vi.fn(async (_id: string, name: string) => {
      return { name, size: 10, content: files[name] ?? '' }
    }),
    ...(overrides.cancelTurn === undefined
      ? {}
      : {
          cancelTurn: vi.fn(
            async (conversationId: string) => overrides.cancelTurn?.(conversationId) ?? { cancelled: true },
          ),
        }),
  }
}

function render(
  api: ReturnType<typeof stub>,
  props: { sessionId?: string; onSessionChange?: (sessionId: string | undefined) => void } = {},
): void {
  act(() => {
    root = createRoot(container)
    root.render(<RyVibePage api={api} {...props} />)
  })
}

/** 冲掉 promise 链：一次 act 只推进一层微任务。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  const setter = must(
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set,
    'textarea.value 的原生 setter',
  )
  act(() => {
    setter.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('RyVibe 页面', () => {
  it('首屏只有一句话和一个开始：别的都不问用户', () => {
    render(stub())
    expect(container.querySelector('.vibe-input')).not.toBeNull()
    expect(container.querySelector('.vibe-start')).not.toBeNull()
    expect(container.textContent).toContain('说一句你想要的东西')
  })

  it('从聊天进入时恢复指定任务，不被最近任务顶替', async () => {
    const requested: VibeSessionView = { ...session, id: 'v2', conversationId: 'c2', requirement: '指定任务' }
    const onSessionChange = vi.fn()
    const api = stub({ session: requested, sessions: [session, requested] })
    render(api, { sessionId: 'v2', onSessionChange })
    await settle()
    // 断言落在主列（当前这一轮的 flow）：历史左栏会如实列出包括最近任务在内的所有条目，
    // 那是常驻历史该有的样子；要验的是「主列恢复的是指定任务，而不是被最近任务顶替」。
    const main = must(container.querySelector('.vibe-main'), '.vibe-main')
    expect(main.textContent).toContain('指定任务')
    expect(main.textContent).not.toContain(session.requirement)
    expect(onSessionChange).toHaveBeenCalledWith('v2')
  })

  it('说了才让开始；点了开始就把这句话交出去', async () => {
    const api = stub()
    render(api)
    const start = must(container.querySelector<HTMLButtonElement>('.vibe-start'), '.vibe-start')
    expect(start.disabled).toBe(true)
    typeInto(
      must(container.querySelector<HTMLTextAreaElement>('.vibe-input'), '.vibe-input'),
      '给独立开发者做个记账工具',
    )
    expect(start.disabled).toBe(false)
    await act(async () => {
      start.click()
    })
    expect(api.startVibe).toHaveBeenCalledWith('给独立开发者做个记账工具')
  })

  it('小队问的那一题就在卡上：预选第一项，答完只交这一道', async () => {
    const api = stub({ questions: oneQuestion })
    render(api)
    typeInto(must(container.querySelector<HTMLTextAreaElement>('.vibe-input'), '.vibe-input'), '做个记账工具')
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-start'), '.vibe-start').click()
    })
    await settle()

    expect(container.querySelectorAll('.vibe-card')).toHaveLength(1)
    expect(container.querySelectorAll('.vibe-question')).toHaveLength(1)
    // 每题都预选了第一个选项：用户不改也能直接提交
    const chosen = container.querySelectorAll('.vibe-option.is-chosen')
    expect(chosen).toHaveLength(1)
    expect(chosen[0]?.textContent).toBe('网页')

    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-card-submit'), '.vibe-card-submit').click()
    })
    // 一次只交一道：下一道是小队看到这一道的答案之后才问出来的。
    expect(api.answerVibe).toHaveBeenCalledTimes(1)
    expect(api.answerVibe).toHaveBeenCalledWith('v1', {
      answers: [{ questionId: 'q1', selected: ['网页'] }],
    })
  })

  it('可以改选项再提交', async () => {
    const api = stub({ questions: oneQuestion })
    render(api)
    typeInto(must(container.querySelector<HTMLTextAreaElement>('.vibe-input'), '.vibe-input'), '做个记账工具')
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-start'), '.vibe-start').click()
    })
    await settle()
    const options = container.querySelectorAll<HTMLButtonElement>('.vibe-option')
    await act(async () => {
      must(options[1], '第二个选项').click()
    })
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-card-submit'), '.vibe-card-submit').click()
    })
    expect(api.answerVibe).toHaveBeenCalledWith('v1', {
      answers: [{ questionId: 'q1', selected: ['桌面'] }],
    })
  })

  it('「按你们的默认方案来」：照旧提交预选项，但告诉小队是默认', async () => {
    const api = stub({ questions: oneQuestion })
    render(api)
    typeInto(must(container.querySelector<HTMLTextAreaElement>('.vibe-input'), '.vibe-input'), '做个记账工具')
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-start'), '.vibe-start').click()
    })
    await settle()
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-card-skip'), '.vibe-card-skip').click()
    })
    expect(api.answerVibe).toHaveBeenCalledWith('v1', {
      answers: [{ questionId: 'q1', selected: ['网页'] }],
      skipped: true,
    })
  })

  it('挂载时把上一次找回来：切走再回来，这一轮还在', async () => {
    const api = stub({ sessions: [session], questions })
    render(api)
    await settle()
    expect(api.vibeSessions).toHaveBeenCalled()
    expect(container.textContent).toContain('给独立开发者做个记账工具')
    expect(container.querySelectorAll('.vibe-question')).toHaveLength(2)
  })

  it('没有未完成的就回到空首屏，不报错', async () => {
    const api = stub({ sessions: [] })
    render(api)
    await settle()
    expect(container.querySelector('.vibe-input')).not.toBeNull()
    expect(container.textContent).not.toContain('小队想先问清楚')
  })

  it('失败要说人话，并且给一条重试的路——不能宣布「方案好了」', async () => {
    const failed: VibeSessionView = {
      ...session,
      status: 'failed',
      error: '供应商炸了',
    }
    const api = stub({ session: failed, sessions: [failed] })
    render(api)
    await settle()
    expect(container.textContent).toContain('小队没能给出方案')
    expect(container.textContent).toContain('供应商炸了')
    expect(container.textContent).not.toContain('方案好了')
    const retry = container.querySelector<HTMLButtonElement>('.vibe-retry')
    expect(retry).not.toBeNull()
    await act(async () => {
      must(retry, '重试按钮').click()
    })
    expect(api.retryVibe).toHaveBeenCalledWith('v1')
  })

  it('失败横幅走聊天页同一张翻译表：英文原话不许顶在正文里', async () => {
    const failed: VibeSessionView = {
      ...session,
      status: 'failed',
      // 服务端那轮失败的原话（apps/server 落库的 event.message），用户读不懂。
      error: 'no adapter registered for provider "siliconflow"',
    }
    const navigated: string[] = []
    act(() => {
      root = createRoot(container)
      root.render(
        <RyVibePage api={stub({ session: failed, sessions: [failed] })} onNavigate={(t) => navigated.push(t)} />,
      )
    })
    await settle()
    const banner = must(container.querySelector('.vibe-failed'), '.vibe-failed')
    // 正文是翻译后的「出了什么事 + 下一步」（lib/turn-errors.ts 的 NO_ADAPTER 条目）。
    const line = must(banner.querySelector('span'), '横幅正文')
    expect(line.textContent).toContain('这个模型服务没接进来')
    expect(line.textContent).toContain('去「我的 → 模型供应商」确认它还在')
    expect(line.textContent).not.toContain('no adapter registered')
    // 「下一步」点得动：去配 Key 与聊天页红条走同一条跳转接线。
    const action = must(banner.querySelector<HTMLButtonElement>('.vibe-failed-action'), '下一步动作')
    expect(action.textContent).toContain('去我的 → 模型供应商')
    await act(async () => {
      action.click()
    })
    expect(navigated).toEqual(['me'])
  })

  it('没有可用供应商时不发请求，先把人引去配 Key——别让人白等 30 秒', async () => {
    const api = stub()
    act(() => {
      root = createRoot(container)
      root.render(
        <RyVibePage
          api={api}
          providers={[{ id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: false, models: [] }]}
        />,
      )
    })
    // 引导是前置摆出来的：不用先点一次「开始」才知道路怎么走。
    expect(container.textContent).toContain('还没有能用的模型来源')
    typeInto(must(container.querySelector<HTMLTextAreaElement>('.vibe-input'), '.vibe-input'), '做个记账工具')
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-start'), '.vibe-start').click()
    })
    expect(api.startVibe).not.toHaveBeenCalled()
  })

  it('供应商清单还在加载时不拦：usable=false 只代表「还不知道」', async () => {
    const api = stub()
    act(() => {
      root = createRoot(container)
      root.render(
        <RyVibePage
          api={api}
          providersLoading
          providers={[{ id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: false, models: [] }]}
        />,
      )
    })
    expect(container.textContent).not.toContain('还没有能用的模型来源')
    typeInto(must(container.querySelector<HTMLTextAreaElement>('.vibe-input'), '.vibe-input'), '做个记账工具')
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-start'), '.vibe-start').click()
    })
    expect(api.startVibe).toHaveBeenCalledWith('做个记账工具')
  })

  it('等答案的时候有进度可看，不是一个空转圈', async () => {
    const api = stub({ questions })
    render(api)
    typeInto(must(container.querySelector<HTMLTextAreaElement>('.vibe-input'), '.vibe-input'), '做个记账工具')
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-start'), '.vibe-start').click()
    })
    await settle()
    expect(container.querySelector('.vibe-progress')).not.toBeNull()
    expect(container.textContent).toContain('读需求')
  })

  it('小队工作台：每人一行、带头像、说清此刻在做什么', async () => {
    const opened: string[] = []
    const withProject: VibeSessionView = { ...session, status: 'done', project }
    const api = stub({ session: withProject, sessions: [withProject] })
    act(() => {
      root = createRoot(container)
      root.render(<RyVibePage api={api} onOpenAgent={(agentId) => opened.push(agentId)} />)
    })
    await settle()
    // 一行一个成员（此前是"小队：Ryen、CodeBot"一行文字，看不出谁在谁不在）。
    const rows = [...container.querySelectorAll('.vibe-squad-row')]
    expect(rows).toHaveLength(2)
    // 每行都有头像：这一页讲的是"一支队伍在接力干活"，谁在说是关键信息。
    expect(rows[0]?.querySelector('.avatar')).not.toBeNull()
    // 每行都写清此刻在做什么。
    expect(rows[0]?.querySelector('.vibe-squad-state')?.textContent).toBe('在听')
    // 每个人都能点开单独聊：多 agent 的可见性靠这个。
    const members = [...container.querySelectorAll<HTMLButtonElement>('.vibe-squad-name')]
    expect(members.map((button) => button.textContent)).toEqual(['Ryen', '工程师'])
    await act(async () => {
      must(members[1], '工程师按钮').click()
    })
    expect(opened).toEqual(['eng'])
  })

  it('正在说话的那一位：动的是输出区那个署名头像，全页只许一个在动', async () => {
    // 等的那一两分钟里，屏幕上要有一个"在动的东西"告诉用户小队还活着。
    const output: VibeOutputView[] = [{ senderId: 'eng', text: '正在写方案…', createdAt: 1, seq: 9 }]
    const talking: VibeSessionView = {
      ...session,
      status: 'building',
      busy: true,
    }
    const api = stub({ session: talking, sessions: [talking], output })
    render(api)
    await settle()
    // 工作台写清此刻谁在做什么（"正在说"）。
    const speaking = container.querySelector('.vibe-squad-row.is-speaking')
    expect(speaking).not.toBeNull()
    expect(speaking?.querySelector('.vibe-squad-state')?.textContent).toBe('正在说')
    // 动的是输出区那个署名头像——动效要落在正在长出来的内容旁边。
    expect(container.querySelector('.bubble-avatar-gutter .avatar[data-motion="speaking"]')).not.toBeNull()
    // 同屏只许有一个在动：工作台里的头像不跟着动（周边运动会抢注意力）。
    expect(container.querySelectorAll('.avatar[data-motion="speaking"]')).toHaveLength(1)
  })

  it('还在等首 token、正文一个字都还没出来时：动的是工作台里「正在想」的那一位', async () => {
    // 这段是屏幕上最空的时候——气泡还没出现，三点之外什么都没有。
    const thinking: VibeSessionView = { ...session, status: 'building', busy: true }
    const api = stub({ session: thinking, sessions: [thinking], output: [] })
    render(api)
    await settle()
    const row = container.querySelector('.vibe-squad-row')
    expect(row?.querySelector('.vibe-squad-state')?.textContent).toBe('正在想')
    expect(row?.querySelector('.avatar[data-motion="pondering"]')).not.toBeNull()
    expect(container.querySelectorAll('.avatar[data-motion="speaking"]')).toHaveLength(0)
  })

  it('等的时候能喊停：不用干等上一两分钟', async () => {
    // 这一页此前从头到尾没有"停"——用户发了一句话就只能盯着屏幕等。
    const cancelled: string[] = []
    const output: VibeOutputView[] = [{ senderId: 'eng', text: '正在写方案…', createdAt: 1, seq: 9 }]
    const talking: VibeSessionView = { ...session, status: 'building', busy: true }
    const api = stub({
      session: talking,
      sessions: [talking],
      output,
      cancelTurn: (conversationId: string) => {
        cancelled.push(conversationId)
        return Promise.resolve({ cancelled: true })
      },
    })
    render(api)
    await settle()
    const stop = container.querySelector<HTMLButtonElement>('.vibe-stop')
    expect(stop).not.toBeNull()
    await act(async () => {
      must(stop, '停一下按钮').click()
    })
    await settle()
    // 中止走的是这一轮背后那个群会话（复用聊天页同一条端点）。
    expect(cancelled).toEqual(['c1'])
    expect(container.textContent).toContain('已停下')
  })

  it('产物通过验收：结果摘要、文件清单和预览都在，完整路径不占主视图', async () => {
    const withProject: VibeSessionView = { ...session, status: 'done', stage: 'deliver', project }
    const api = stub({
      session: withProject,
      sessions: [withProject],
      files: { 'README.md': '# 记账工具' },
    })
    render(api)
    await settle()
    expect(container.querySelector('.vibe-project')).not.toBeNull()
    expect(container.textContent).toContain('记账工具')
    expect(container.textContent).toContain('通过 4 项交付验收')
    expect(container.textContent).not.toContain('projects\\记账工具')
    expect(container.querySelector('.vibe-open-folder')?.getAttribute('title')).toContain('projects\\记账工具')
    expect(container.querySelectorAll('.vibe-file')).toHaveLength(4)
    // 点一个文件 → 内容就地展开
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-file'), 'README.md 按钮').click()
    })
    await settle()
    // Markdown 渲染成文档，而不是把 `# 记账工具` 这行源码倒出来。
    expect(container.querySelector('.vibe-preview-doc h1')?.textContent).toBe('记账工具')
  })

  it('历史版本能从产物卡恢复', async () => {
    const validation = must(project.validation, '项目验收报告')
    const withVersions: VibeSessionView = {
      ...session,
      status: 'done',
      stage: 'deliver',
      project,
      versions: [
        {
          id: 'version-1',
          name: project.name,
          kind: project.kind,
          summary: '第一版',
          createdAt: 1,
          validation,
        },
        {
          id: 'version-2',
          name: project.name,
          kind: project.kind,
          summary: '第二版',
          createdAt: 2,
          validation,
        },
      ],
    }
    const api = stub({ session: withVersions, sessions: [withVersions] })
    render(api)
    await settle()
    const buttons = container.querySelectorAll<HTMLButtonElement>('.vibe-version')
    expect(buttons).toHaveLength(2)
    await act(async () => {
      buttons[1]?.click()
    })
    expect(api.restoreVibeVersion).toHaveBeenCalledWith('v1', 'version-1')
  })

  it('表形态：预览摆成表格，形态也写在项目名旁边', async () => {
    const sheetProject: VibeProjectView = {
      name: '本月开支',
      slug: '本月开支',
      kind: 'sheet',
      dir: 'C:\\data\\workspace\\projects\\本月开支',
      files: [
        { name: 'README.md', size: 120 },
        { name: 'TODO.md', size: 80 },
        { name: '清单.csv', size: 64 },
      ],
      createdAt: 0,
    }
    const withSheet: VibeSessionView = { ...session, status: 'done', project: sheetProject }
    const api = stub({
      session: withSheet,
      sessions: [withSheet],
      files: { '清单.csv': '项目,金额\n房租,1200\n吃饭,380' },
    })
    render(api)
    await settle()
    expect(container.querySelector('.vibe-project-kind')?.textContent).toBe('表格')
    // 文件行现在是 icon + 名字 span + 打开角标：按名字 span 定位（装饰图标的空白不算名字）。
    const csv = [...container.querySelectorAll<HTMLButtonElement>('.vibe-file')].find((button) => {
      return button.querySelector('.vibe-file-name')?.textContent === '清单.csv'
    })
    await act(async () => {
      must(csv, '清单.csv 按钮').click()
    })
    await settle()
    // 表就是表：几行几列摆成格子，而不是一屏逗号。
    const cells = [...container.querySelectorAll('.artifact-table th, .artifact-table td')].map((cell) => {
      return cell.textContent
    })
    expect(cells).toEqual(['项目', '金额', '房租', '1200', '吃饭', '380'])
  })

  it('答完就进对话流：小队问的那句 + 你的回答，旁边有「改一下」', async () => {
    const api = stub({ sessions: [session], questions: answeredQuestions })
    render(api)
    await settle()
    // 答案不是折进一张"你已经选好了"的卡，而是留在流里，像一句说过的话。
    expect(container.textContent).toContain('这东西跑在哪？')
    expect(container.textContent).toContain('桌面')
    expect(container.querySelector('.vibe-asked-edit-link')).not.toBeNull()
  })

  it('「改一下」：展开选项、填回上次的答案，改完只交这一道', async () => {
    const api = stub({ sessions: [session], questions: answeredQuestions })
    render(api)
    await settle()
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-asked-edit-link'), '.vibe-asked-edit-link').click()
    })
    // 上次选的那个被勾上了：改主意不是从零开始。
    const chosen = container.querySelectorAll('.vibe-asked-edit .vibe-option.is-chosen')
    expect(chosen).toHaveLength(1)
    expect(chosen[0]?.textContent).toBe('桌面')

    const options = container.querySelectorAll<HTMLButtonElement>('.vibe-asked-edit .vibe-option')
    await act(async () => {
      must(options[0], '第一个选项').click()
    })
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-asked-edit .vibe-card-submit'), '改好了').click()
    })
    expect(api.answerVibe).toHaveBeenCalledWith('v1', {
      answers: [{ questionId: 'q1', selected: ['网页'] }],
    })
  })

  it('「算了」：不改了就把这一道收回原样', async () => {
    const api = stub({ sessions: [session], questions: answeredQuestions })
    render(api)
    await settle()
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-asked-edit-link'), '.vibe-asked-edit-link').click()
    })
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-asked-edit .vibe-card-skip'), '算了').click()
    })
    expect(container.querySelector('.vibe-asked-edit')).toBeNull()
    expect(api.answerVibe).not.toHaveBeenCalled()
  })

  it('每题能自己写一句：写了字的那题按写的交，不按预选项', async () => {
    const api = stub({ questions })
    render(api)
    typeInto(must(container.querySelector<HTMLTextAreaElement>('.vibe-input'), '.vibe-input'), '做个记账工具')
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-start'), '.vibe-start').click()
    })
    await settle()
    const own = must(container.querySelector<HTMLTextAreaElement>('.vibe-own-answer'), '.vibe-own-answer')
    typeInto(own, '我们公司内部用')
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-card-submit'), '.vibe-card-submit').click()
    })
    await settle()
    const call = api.answerVibe.mock.calls.at(-1)
    expect(call?.[1].answers[0]).toEqual({ questionId: 'q1', selected: [], text: '我们公司内部用' })
    // 没写字的那题照旧交选项。
    expect(call?.[1].answers[1]).toEqual({ questionId: 'q2', selected: ['1 屏'] })
  })

  it('任务清单能勾：勾完就发给待办', async () => {
    const todos: TodoItem[] = [
      { id: 't1', text: '建数据表', done: false, createdAt: 0 },
      { id: 't2', text: '做分类页', done: true, createdAt: 0 },
    ]
    const done: VibeSessionView = { ...session, status: 'done' }
    const api = stub({ session: done, sessions: [done], todos })
    render(api)
    await settle()
    const boxes = container.querySelectorAll<HTMLInputElement>('.vibe-task input')
    expect(boxes).toHaveLength(2)
    expect(boxes[1]?.checked).toBe(true)
    await act(async () => {
      must(boxes[0], '第一个勾选框').click()
    })
    await settle()
    expect(api.setTodoDone).toHaveBeenCalledWith('c1', 't1', true)
  })
})

describe('RyVibe 选项单选语义与进度 stepper（P5）', () => {
  /** 进到有选项的那一屏：说一句话 → 开始 → 小队问第一题。 */
  async function intoQuestion(): Promise<ReturnType<typeof stub>> {
    const api = stub({ questions: oneQuestion })
    render(api)
    typeInto(must(container.querySelector<HTMLTextAreaElement>('.vibe-input'), '.vibe-input'), '做个记账工具')
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-start'), '.vibe-start').click()
    })
    await settle()
    return api
  }

  it('选项是 radiogroup 里的 radio：预选第一项 aria-checked=true，其余 false', async () => {
    await intoQuestion()
    const group = must(container.querySelector('.vibe-options'), '.vibe-options')
    expect(group.getAttribute('role')).toBe('radiogroup')
    expect(group.getAttribute('aria-label')).toBe('这东西跑在哪？')
    const radios = [...container.querySelectorAll<HTMLButtonElement>('.vibe-option')]
    expect(radios).toHaveLength(3)
    expect(
      radios.every((node) => {
        return node.getAttribute('role') === 'radio'
      }),
    ).toBe(true)
    expect(radios[0]?.getAttribute('aria-checked')).toBe('true')
    expect(radios[1]?.getAttribute('aria-checked')).toBe('false')
    expect(radios[2]?.getAttribute('aria-checked')).toBe('false')
    // 圆点是纯装饰（aria-hidden、空 span），选项 textContent 仍只是选项本身。
    expect(radios[0]?.querySelector('.vibe-option-radio')?.getAttribute('aria-hidden')).toBe('true')
    expect(radios[0]?.textContent).toBe('网页')
  })

  it('方向键在选项间走位：ArrowDown 把选中移到下一项并聚焦', async () => {
    await intoQuestion()
    const radios = [...container.querySelectorAll<HTMLButtonElement>('.vibe-option')]
    act(() => {
      must(radios[0], '第一个选项').focus()
      radios[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    await settle()
    const after = [...container.querySelectorAll<HTMLButtonElement>('.vibe-option')]
    expect(after[1]?.classList.contains('is-chosen')).toBe(true)
    expect(after[1]?.getAttribute('aria-checked')).toBe('true')
    expect(after[0]?.getAttribute('aria-checked')).toBe('false')
    expect(document.activeElement).toBe(after[1])
  })

  it('进度是五节点 stepper：节点 + 标签结构，恰好一个当前步带 aria-current', async () => {
    await intoQuestion()
    const steps = [...container.querySelectorAll('.vibe-step')]
    expect(steps).toHaveLength(5)
    // 不再是纯文字 li：每个节点有 node 容器与下方标签。
    expect(steps[0]?.querySelector('.vibe-step-node')).not.toBeNull()
    expect(
      steps.map((node) => {
        return node.querySelector('.vibe-step-label')?.textContent
      }),
    ).toEqual(['读需求', '定方案', '动手做', '验收', '交付'])
    // 首屏 clarify=第 0 步：恰好一个当前步，带 aria-current=step 与 is-active。
    const current = [...container.querySelectorAll('.vibe-step[aria-current="step"]')]
    expect(current).toHaveLength(1)
    expect(current[0]?.classList.contains('is-active')).toBe(true)
  })
})

describe('RyVibe 历史常驻左栏（P5）', () => {
  it('有过任务就常驻左栏：需求 + 状态短签 + 日期，当前任务标 is-active，表头带新任务', async () => {
    const done: VibeSessionView = {
      ...session,
      id: 'v0',
      requirement: '上一轮旧任务',
      status: 'done',
      createdAt: 86_400_000,
    }
    const api = stub({ session, sessions: [session, done] })
    render(api)
    await settle()
    const rail = must(container.querySelector('.vibe-rail'), '.vibe-rail')
    expect(rail.getAttribute('aria-label')).toBe('任务历史')
    const items = [...container.querySelectorAll<HTMLButtonElement>('.vibe-history-item')]
    expect(items).toHaveLength(2)
    // 当前这一轮（v1）高亮且 aria-current；另一条不高亮。
    expect(items[0]?.classList.contains('is-active')).toBe(true)
    expect(items[0]?.getAttribute('aria-current')).toBe('true')
    expect(items[1]?.classList.contains('is-active')).toBe(false)
    expect(items[1]?.hasAttribute('aria-current')).toBe(false)
    // 每条都有需求摘要、状态短签与日期。
    expect(items[0]?.querySelector('.vibe-history-req')?.textContent).toBe('给独立开发者做个记账工具')
    expect(items[0]?.querySelector('.vibe-status-chip')?.textContent).toBe('等你选')
    expect(items[1]?.querySelector('.vibe-status-chip')?.textContent).toBe('已完成')
    expect(items[0]?.querySelector('.vibe-history-date')).not.toBeNull()
    // 正开着一轮：表头有「新任务」入口。
    expect(rail.querySelector('.vibe-rail-head')?.textContent).toContain('新任务')
  })

  it('首跑零历史不画左栏：欢迎屏独占整幅居中', () => {
    render(stub())
    expect(container.querySelector('.vibe-rail')).toBeNull()
    expect(container.querySelector('.vibe-main')).not.toBeNull()
    expect(container.querySelector('.vibe-hero')).not.toBeNull()
  })

  it('点左栏一条就把那一轮接回来（不是重说一遍）', async () => {
    const other: VibeSessionView = { ...session, id: 'v9', conversationId: 'c9', requirement: '另一轮任务' }
    const onSessionChange = vi.fn()
    const api = stub({ session, sessions: [session, other] })
    render(api, { onSessionChange })
    await settle()
    const items = [...container.querySelectorAll<HTMLButtonElement>('.vibe-history-item')]
    await act(async () => {
      must(items[1], '左栏第二条').click()
    })
    await settle()
    expect(onSessionChange).toHaveBeenCalledWith('v9')
  })

  it('状态短签四种语义色：未通过 / 进行中 / 已完成 / 等你选', async () => {
    const failed: VibeSessionView = { ...session, id: 'f', status: 'failed' }
    const building: VibeSessionView = { ...session, id: 'b', status: 'building', stage: 'execute' }
    const done: VibeSessionView = { ...session, id: 'd', status: 'done' }
    const api = stub({ sessions: [failed, building, done, session] })
    render(api)
    await settle()
    const chips = [...container.querySelectorAll('.vibe-status-chip')]
    expect(chips).toHaveLength(4)
    expect(chips[0]?.textContent).toBe('未通过')
    expect(chips[0]?.classList.contains('is-failed')).toBe(true)
    expect(chips[1]?.textContent).toBe('进行中')
    expect(chips[1]?.classList.contains('is-building')).toBe(true)
    expect(chips[2]?.textContent).toBe('已完成')
    expect(chips[2]?.classList.contains('is-done')).toBe(true)
    expect(chips[3]?.textContent).toBe('等你选')
    expect(chips[3]?.classList.contains('is-asking')).toBe(true)
  })
})
