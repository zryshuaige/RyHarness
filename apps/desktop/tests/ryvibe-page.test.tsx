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
  busy: false,
  pendingAnswers: 2,
  round: 0,
  maxRounds: 1,
}

const questions: VibeQuestionView[] = [
  { id: 'q1', question: '这东西跑在哪？', options: ['网页', '桌面', '手机'] },
  { id: 'q2', question: '第一版要几屏？', options: ['1 屏', '2-3 屏'] },
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
    setTodoDone: vi.fn(async (_conversationId: string, _id: string, _done: boolean) => {
      return undefined
    }),
    vibeProjectFile: vi.fn(async (_id: string, name: string) => {
      return { name, size: 10, content: files[name] ?? '' }
    }),
  }
}

function render(api: ReturnType<typeof stub>): void {
  act(() => {
    root = createRoot(container)
    root.render(<RyVibePage api={api} />)
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

/** 往 input 里打字（React 受控输入要走原生 setter）。 */
function typeIntoInput(input: HTMLInputElement, value: string): void {
  const setter = must(
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set,
    'input.value 的原生 setter',
  )
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('RyVibe 页面', () => {
  it('首屏只有一句话和一个开始：别的都不问用户', () => {
    render(stub())
    expect(container.querySelector('.vibe-input')).not.toBeNull()
    expect(container.querySelector('.vibe-start')).not.toBeNull()
    expect(container.textContent).toContain('说一句你想要的东西')
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

  it('盘问是一张卡：所有问题在一张卡上、每题预选第一项、一次提交', async () => {
    const api = stub({ questions })
    render(api)
    typeInto(must(container.querySelector<HTMLTextAreaElement>('.vibe-input'), '.vibe-input'), '做个记账工具')
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-start'), '.vibe-start').click()
    })
    await settle()

    expect(container.querySelectorAll('.vibe-card')).toHaveLength(1)
    expect(container.querySelectorAll('.vibe-question')).toHaveLength(2)
    // 每题都预选了第一个选项：用户不改也能直接提交
    const chosen = container.querySelectorAll('.vibe-option.is-chosen')
    expect(chosen).toHaveLength(2)
    expect(chosen[0]?.textContent).toBe('网页')
    expect(chosen[1]?.textContent).toBe('1 屏')

    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-card-submit'), '.vibe-card-submit').click()
    })
    // 一次请求带上全部答案
    expect(api.answerVibe).toHaveBeenCalledTimes(1)
    expect(api.answerVibe).toHaveBeenCalledWith('v1', {
      answers: [
        { questionId: 'q1', selected: ['网页'] },
        { questionId: 'q2', selected: ['1 屏'] },
      ],
    })
  })

  it('可以改选项再提交', async () => {
    const api = stub({ questions })
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
      answers: [
        { questionId: 'q1', selected: ['桌面'] },
        { questionId: 'q2', selected: ['1 屏'] },
      ],
    })
  })

  it('「按你们的默认方案来」：照旧提交预选项，但告诉小队是默认', async () => {
    const api = stub({ questions })
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
      answers: [
        { questionId: 'q1', selected: ['网页'] },
        { questionId: 'q2', selected: ['1 屏'] },
      ],
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

  it('小队里每个人都能点开单独聊：多 agent 的可见性靠这个', async () => {
    const opened: string[] = []
    const withProject: VibeSessionView = { ...session, status: 'done', project }
    const api = stub({ session: withProject, sessions: [withProject] })
    act(() => {
      root = createRoot(container)
      root.render(<RyVibePage api={api} onOpenAgent={(agentId) => opened.push(agentId)} />)
    })
    await settle()
    const members = [...container.querySelectorAll<HTMLButtonElement>('.vibe-squad-member')]
    expect(members.map((button) => button.textContent)).toEqual(['Ryen', '工程师'])
    await act(async () => {
      must(members[1], '工程师按钮').click()
    })
    expect(opened).toEqual(['eng'])
  })

  it('方案落成了项目：目录、文件清单、预览都在', async () => {
    const withProject: VibeSessionView = { ...session, status: 'done', project }
    const api = stub({
      session: withProject,
      sessions: [withProject],
      files: { 'README.md': '# 记账工具' },
    })
    render(api)
    await settle()
    expect(container.querySelector('.vibe-project')).not.toBeNull()
    expect(container.textContent).toContain('记账工具')
    // 目录路径是原样给的：用户要能自己去文件管理器里找
    expect(container.textContent).toContain('projects\\记账工具')
    expect(container.querySelectorAll('.vibe-file')).toHaveLength(4)
    // 点一个文件 → 内容就地展开
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-file'), 'README.md 按钮').click()
    })
    await settle()
    // Markdown 渲染成文档，而不是把 `# 记账工具` 这行源码倒出来。
    expect(container.querySelector('.vibe-preview-doc h1')?.textContent).toBe('记账工具')
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
    const csv = [...container.querySelectorAll<HTMLButtonElement>('.vibe-file')].find((button) => {
      return button.textContent === '清单.csv'
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

  it('答完也能改：提交后卡片还在，「改一下」点得到', async () => {
    const api = stub({ questions })
    render(api)
    typeInto(must(container.querySelector<HTMLTextAreaElement>('.vibe-input'), '.vibe-input'), '做个记账工具')
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-start'), '.vibe-start').click()
    })
    await settle()
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-card-submit'), '.vibe-card-submit').click()
    })
    await settle()
    // 答错了要能回去改：卡片不能从 DOM 上消失，「改一下」也不能是空气。
    expect(container.querySelector('.vibe-card')).not.toBeNull()
    expect(container.querySelector('.vibe-card-edit')).not.toBeNull()
    expect(container.textContent).toContain('你已经选好了')
  })

  it('每题能自己写一句：写了字的那题按写的交，不按预选项', async () => {
    const api = stub({ questions })
    render(api)
    typeInto(must(container.querySelector<HTMLTextAreaElement>('.vibe-input'), '.vibe-input'), '做个记账工具')
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('.vibe-start'), '.vibe-start').click()
    })
    await settle()
    const own = must(container.querySelector<HTMLInputElement>('.vibe-own-answer'), '.vibe-own-answer')
    typeIntoInput(own, '我们公司内部用')
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
