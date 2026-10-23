/**
 * RyVibe：一句话做出能开工的东西（Beta）。
 *
 * 这一页的承诺只有一句：**你说一句话，出来一个能接着用的东西**。所以界面上不许出现
 * 「配置」「工作流」「选择角色」这类词——用户要做的只有两件事：说一句话、点几下
 * 选项。小队把需求问清楚的过程被收在页面里，而不是甩给用户一叠表单。
 *
 * 也不许默认他要的是一个软件：他可能只要一份文档、一张表，或者一个以后照着做的
 * 流程。盘问的第一问就是「最后要的东西是个什么」，落盘的文件清单跟着那个答案走。
 *
 * 底下其实是一个真的群会话：问题与答案走的是同一套提问/注入机制，方案落在那个
 * 会话里。所以这一页的结果不是一段凭空生成的文本——用户想接着追问，点「在聊天里
 * 继续」就能进同一个会话，那里的上下文一条不少。
 *
 * 页面不订阅 WS：它轮询服务端的状态接口（问到哪、还差几个答案、方案出来没有）。
 * 一次 RyVibe 就是几轮对话，这个频率足够跟手，而且断线重连天然成立。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TodoItem, VibeOutputView, VibeProjectView, VibeQuestionView, VibeSessionView } from '../api.ts'
import { openInFileManager } from '../lib/desktop.ts'
import { humanError } from '../lib/error-text.ts'
import { toast } from '../lib/toast.ts'
import { Icon } from './Icon.tsx'
import { Markdown } from './Markdown.tsx'

/**
 * 起步示例：让用户知道「一句话」长什么样，比任何说明文字都快。
 *
 * 四个例子覆盖四种产物（软件 / 流程 / 文档 / 表）——只给软件的例子，用户会以为
 * RyVibe 只能做软件，于是把「写封邮件」这类需求不好意思提出来。
 */
const EXAMPLES = [
  '给独立开发者做一个记账工具，能分类、能看趋势',
  '把我们的周报流程做成自动的：每周五出报告',
  '给客户写封道歉邮件，正式但不生硬',
  '把这个月的开支列成一张表',
]

/** 轮询间隔（ms）：小队还在写时 1.2 秒一次（页面要跟手）；轮到用户点选时退到 4 秒。 */
const POLL_BUSY_MS = 1200
const POLL_IDLE_MS = 4000

/**
 * 小队干活的三个阶段：空窗期最要有事可说。
 *
 * 措辞不绑形态：「拆功能」「写方案」是软件的话，用户要一份邮件时这三步就没意义了。
 */
const STEPS = ['读需求', '想清楚', '做出来'] as const

/** 页面需要的 api 形状（测试可以只给这几个方法）。 */
export interface RyVibeApi {
  startVibe(requirement: string): Promise<{ session: VibeSessionView }>
  vibe: (
    id: string,
    after?: number,
  ) => Promise<{
    session: VibeSessionView
    questions: VibeQuestionView[]
    output: VibeOutputView[]
    todos: TodoItem[]
  }>
  answerVibe(
    id: string,
    input: { answers: { questionId: string; selected: string[] }[]; skipped?: boolean },
  ): Promise<{ session: VibeSessionView }>
  /** 最近几次 RyVibe：页面重新挂载时靠它把上一次找回来。 */
  vibeSessions(): Promise<{ sessions: VibeSessionView[] }>
  /** 失败后重来一次。 */
  retryVibe(id: string): Promise<{ session: VibeSessionView }>
  /** 勾一条任务；没有它就只显示清单不让勾。 */
  setTodoDone?: (conversationId: string, id: string, done: boolean) => Promise<unknown>
  /** 读项目骨架里的一个文件（预览用）。 */
  vibeProjectFile?: (id: string, name: string) => Promise<{ name: string; size: number; content: string }>
}

export interface RyVibePageProps {
  api: RyVibeApi
  /** 点「在聊天里继续」时把用户带进那个会话。 */
  onOpenConversation?: (conversationId: string) => void
}

/**
 * 一张盘问卡：所有问题放在一张卡上，一次提交。
 *
 * 抄的是 Lovable 的提问卡片，不是 Cursor 的逐题弹窗：
 * - **一次一张卡**：分两轮问，用户会被打断两次，中间那次等待里并没有「我根据你的
 *   答案改了问题」的实质变化。
 * - **每题预选第一项**：小队认为最稳的选项默认选中，用户不改也能直接提交——于是
 *   「完全不想被打扰」也是一种合法选择。
 * - **一次提交**：所有答案一起交，答案进小队共同看到的那条正文里。
 * - **可以跳过**：按默认方案来，不追问。
 * - **提交后还能改**：改主意重交一次，小队按新答案重出方案。
 */
function QuestionCard({
  questions,
  picks,
  submitted,
  busy,
  onPick,
  onSubmit,
  onSkip,
  onEdit,
}: {
  questions: VibeQuestionView[]
  /** 当前选择（questionId → 选项）。 */
  picks: Record<string, string>
  /** 已提交的答案；undefined = 卡片还开着。 */
  submitted: Record<string, string> | undefined
  busy: boolean
  onPick: (questionId: string, option: string) => void
  onSubmit: () => void
  onSkip: () => void
  onEdit: () => void
}) {
  if (submitted !== undefined) {
    return (
      <div className="vibe-card is-answered">
        <div className="vibe-card-head">
          <span>你已经选好了</span>
          <button type="button" className="vibe-card-edit" disabled={busy} onClick={onEdit}>
            改一下
          </button>
        </div>
        <ul className="vibe-answered-list">
          {questions.map((question) => {
            return (
              <li key={question.id}>
                <span className="vibe-answered-q">{question.question}</span>
                <span className="vibe-answered-a">{submitted[question.id]}</span>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }
  return (
    <div className="vibe-card">
      <div className="vibe-card-head">
        <span>小队有几件事想跟你确认</span>
        <span className="vibe-card-hint">不用写，选一个就行</span>
      </div>
      {questions.map((question) => {
        const current = picks[question.id] ?? question.options[0] ?? ''
        return (
          <div key={question.id} className="vibe-question">
            <p className="vibe-question-text">{question.question}</p>
            <div className="vibe-options">
              {question.options.map((option) => {
                const chosen = current === option
                return (
                  <button
                    key={option}
                    type="button"
                    className={chosen ? 'vibe-option is-chosen' : 'vibe-option'}
                    disabled={busy}
                    onClick={() => {
                      onPick(question.id, option)
                    }}
                  >
                    {option}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
      <div className="vibe-card-actions">
        <button type="button" className="btn btn-primary vibe-card-submit" disabled={busy} onClick={onSubmit}>
          就这样，开始出方案
        </button>
        <button type="button" className="btn vibe-card-skip" disabled={busy} onClick={onSkip}>
          按你们的默认方案来
        </button>
      </div>
    </div>
  )
}

/**
 * 等待期的进度条。
 *
 * 小队开工到出方案之间有 30 秒到 2 分钟，这一段屏幕上只有一个转圈是最容易让人
 * 放弃的地方（Linear 的 agent 规范第一条就是「沉默等于不确定」）。三步 + 一条
 * 顶边进度线，让人知道事情在往前走。
 */
function Progress({ step, status }: { step: number; status: VibeSessionView['status'] }) {
  return (
    <section className="vibe-progress" aria-label="小队进度">
      <div className="vibe-progress-bar">
        <span style={{ width: `${Math.round((step / STEPS.length) * 100)}%` }} />
      </div>
      <ol className="vibe-steps">
        {STEPS.map((label, index) => {
          const done = index < step
          const active = index === step && status !== 'done'
          return (
            <li key={label} className={done ? 'is-done' : active ? 'is-active' : ''}>
              {label}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

/** 正在预览的那个文件。 */
interface ProjectPreview {
  name: string
  content: string
}

/**
 * 项目区块：方案落成的那个目录。
 *
 * 这是 RyVibe 从「写了一段介绍」变成「做出一个东西」的那一步。页面上要让用户
 * 看见三件事：落在哪、里面有什么、点一下就能看。**目录路径是原样给的**：用户要
 * 能自己打开文件管理器找过去，而不是只能通过应用去看。
 */
function ProjectCard({
  project,
  preview,
  onOpenFile,
  onClosePreview,
  onOpenFolder,
}: {
  project: VibeProjectView
  preview: ProjectPreview | undefined
  onOpenFile: (name: string) => void
  onClosePreview: () => void
  onOpenFolder: () => void
}) {
  return (
    <section className="vibe-project">
      <div className="vibe-project-head">
        <div className="vibe-project-meta">
          <h2 className="vibe-section-title">{project.name}</h2>
          <p className="vibe-project-path" title={project.dir}>
            {project.dir}
          </p>
        </div>
        <button type="button" className="btn btn-mini vibe-open-folder" onClick={onOpenFolder}>
          打开文件夹
        </button>
      </div>
      <ul className="vibe-files">
        {project.files.map((file) => {
          return (
            <li key={file.name}>
              <button
                type="button"
                className="vibe-file"
                onClick={() => {
                  onOpenFile(file.name)
                }}
              >
                {file.name}
              </button>
            </li>
          )
        })}
      </ul>
      {preview !== undefined && (
        <div className="vibe-preview">
          <div className="vibe-preview-head">
            <span>{preview.name}</span>
            <button type="button" className="btn btn-mini" onClick={onClosePreview}>
              收起
            </button>
          </div>
          {preview.name.endsWith('.html') ? (
            // 预览里的脚本一律不跑：sandbox 空值就是禁脚本、禁表单、禁弹窗。
            // 页面本身在磁盘上双击打开是能跑的，这里只给用户看个样子。
            <iframe className="vibe-preview-frame" title={preview.name} sandbox="" srcDoc={preview.content} />
          ) : (
            <pre className="vibe-preview-text">{preview.content}</pre>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * 任务清单：落盘时写进待办的那几条。
 *
 * 用户在这里就能勾，不用去聊天页右侧找——那才是「接下来做什么」的落点。勾选走
 * 待办插件的接口，所以聊天页那边看到的也是同一份状态。
 */
function TaskList({ todos, onToggle }: { todos: readonly TodoItem[]; onToggle: (id: string, done: boolean) => void }) {
  if (todos.length === 0) return null
  return (
    <section className="vibe-section">
      <h2 className="vibe-section-title">接下来要做的事</h2>
      <ul className="vibe-tasks">
        {todos.map((todo) => {
          return (
            <li key={todo.id}>
              <label className={todo.done ? 'vibe-task is-done' : 'vibe-task'}>
                <input
                  type="checkbox"
                  checked={todo.done}
                  onChange={(event) => {
                    onToggle(todo.id, event.target.checked)
                  }}
                />
                <span>{todo.text}</span>
              </label>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** 状态一句话：用户最想知道的是「还要等多久 / 我要做什么」。 */
function statusLine(session: VibeSessionView): string {
  if (session.status === 'failed') return '没做出来'
  if (session.status === 'asking') {
    return session.pendingAnswers > 0
      ? `小队想先问清楚 ${session.pendingAnswers} 件事，选完就开工`
      : '小队正在整理你的选择…'
  }
  if (session.status === 'building') return '小队正在做…'
  return '做好了'
}

/** 小队走到第几步了。 */
function stepOf(session: VibeSessionView, outputCount: number): number {
  if (session.status === 'done') return STEPS.length
  if (session.status === 'failed') return 0
  if (session.status === 'asking') return 1
  return outputCount > 0 ? 2 : 1
}

export function RyVibePage({ api, onOpenConversation }: RyVibePageProps) {
  const [requirement, setRequirement] = useState('')
  const [session, setSession] = useState<VibeSessionView | undefined>(undefined)
  const [questions, setQuestions] = useState<VibeQuestionView[]>([])
  const [output, setOutput] = useState<VibeOutputView[]>([])
  /** 用户在卡片上点过的选择（questionId → 选项）；没点过的用预选项（第一个）。 */
  const [picks, setPicks] = useState<Record<string, string>>({})
  /** 已提交的答案；undefined = 卡片还开着。 */
  const [submitted, setSubmitted] = useState<Record<string, string> | undefined>(undefined)
  const [starting, setStarting] = useState(false)
  const [answering, setAnswering] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  /** 落盘时写进待办的任务清单。 */
  const [todos, setTodos] = useState<TodoItem[]>([])
  /** 正在预览的项目文件。 */
  const [preview, setPreview] = useState<ProjectPreview | undefined>(undefined)
  /** 已经从服务端找过一轮没有（避免重复找）。 */
  const restoredRef = useRef(false)
  /** 轮询的定时器；用 ref 存，避免每次渲染都重建 effect。 */
  const timerRef = useRef<number | undefined>(undefined)
  /** 已经拿到的最后一条产出的序号：轮询只取新的，不重发整份。 */
  const outputCursorRef = useRef(0)

  /** 拉一次状态。`after` 之后的新产出才回传。 */
  const refresh = useCallback(
    async (id: string): Promise<void> => {
      try {
        const after = outputCursorRef.current
        const state = await api.vibe(id, after)
        setSession(state.session)
        setQuestions(state.questions)
        // 任务清单：服务端下发的那份（落盘时写进待办的）。
        setTodos(state.todos ?? [])
        // 增量：产出只会变多，重发整份的话一段长方案每 1.2 秒就要传一次。
        setOutput((prev) => {
          return [...prev, ...state.output]
        })
        const last = state.output.at(-1)
        if (last !== undefined) outputCursorRef.current = last.seq
        setError(undefined)
      } catch (err) {
        setError(humanError(err, '没拿到小队的进度，再试一次'))
      }
    },
    [api],
  )

  /**
   * 挂载时把上一次找回来。
   *
   * RyVibe 页是条件渲染的：切到别的页签它就卸载，组件里的状态一点都留不住。用户
   * 切去通讯录看一眼再切回来，这一轮就报废了——而服务端那边的待答问题还挂着，
   * 永远等不到答案。挂载时问一句"最近有没有没做完的"就能接上。
   *
   * 做完了的也接上：那一轮落盘的项目与任务清单是用户真正想看的东西，切走一圈
   * 回来就没了，等于逼用户重说一遍。先找没做完的，没有就接最近一次。
   */
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    let cancelled = false
    void (async () => {
      try {
        const { sessions } = await api.vibeSessions()
        if (cancelled) return
        const live = sessions.find((item) => {
          return item.status !== 'done'
        })
        const target = live ?? sessions[0]
        if (target === undefined) return
        setSession(target)
        await refresh(target.id)
      } catch {
        // 找不回来就当没有上次：用户自己再开一次，不该看到一句报错。
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, refresh])

  /**
   * 轮询：只要这一轮还没结束就定期拉一次。
   *
   * 快慢按「小队还在不在说话」分：还在写就 1.2 秒一次（页面要跟手）；
   * 轮到用户点选了，就退到 4 秒一次——那段时间状态基本不会变，一直 1.2 秒地刷
   * 只是白打后端。'done' 之后彻底不轮询；**页面看不见时也停**（用户去开会了，
   * 页面还挂在那儿一秒一次地打后端没有意义）。
   */
  useEffect(() => {
    if (session === undefined) return
    if (session.status === 'done') return
    if (document.hidden) return
    const id = session.id
    timerRef.current = window.setTimeout(
      () => {
        void refresh(id)
      },
      session.busy ? POLL_BUSY_MS : POLL_IDLE_MS,
    )
    return () => {
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current)
        timerRef.current = undefined
      }
    }
  }, [session, refresh])

  const start = async (): Promise<void> => {
    const text = requirement.trim()
    if (text.length === 0) return
    setStarting(true)
    setError(undefined)
    try {
      const created = await api.startVibe(text)
      setSession(created.session)
      setQuestions([])
      setOutput([])
      setPicks({})
      setSubmitted(undefined)
      setTodos([])
      setPreview(undefined)
      outputCursorRef.current = 0
      // 立刻拉一次状态：不然用户点完「开始」要空等一个轮询周期才看见小队动了。
      await refresh(created.session.id)
    } catch (err) {
      setError(humanError(err, '这次没开起来，再试一次'))
    } finally {
      setStarting(false)
    }
  }

  /** 提交这张卡上的全部答案（一次请求，答案一起交）。 */
  const submit = async (skipped: boolean): Promise<void> => {
    if (session === undefined) return
    const answers = questions
      .filter((question) => {
        return question.answered !== true
      })
      .map((question) => {
        return {
          questionId: question.id,
          selected: [picks[question.id] ?? question.options[0] ?? ''],
        }
      })
    if (answers.length === 0) return
    setAnswering(true)
    try {
      await api.answerVibe(session.id, { answers, ...(skipped ? { skipped: true } : {}) })
      setSubmitted(
        Object.fromEntries(
          answers.map((answer) => {
            return [answer.questionId, answer.selected[0] ?? '']
          }),
        ),
      )
      await refresh(session.id)
    } catch (err) {
      toast.error(humanError(err, '这些答案没送出去，再点一次'))
    } finally {
      setAnswering(false)
    }
  }

  /** 重来一次：同样的需求，重新开一轮。 */
  const retry = (): void => {
    if (session === undefined) return
    setSubmitted(undefined)
    setPicks({})
    setOutput([])
    outputCursorRef.current = 0
    void (async () => {
      try {
        await api.retryVibe(session.id)
        await refresh(session.id)
      } catch (err) {
        toast.error(humanError(err, '这次没重起来，再点一次'))
      }
    })()
  }

  const reset = (): void => {
    setSession(undefined)
    setQuestions([])
    setOutput([])
    setPicks({})
    setSubmitted(undefined)
    setError(undefined)
    setRequirement('')
    setTodos([])
    setPreview(undefined)
    outputCursorRef.current = 0
  }

  /** 勾一条任务：先本地改，再发出去；发失败就把服务端那份拉回来。 */
  const toggleTodo = (id: string, done: boolean): void => {
    if (session === undefined) return
    setTodos((prev) => {
      return prev.map((item) => {
        return item.id === id ? { ...item, done } : item
      })
    })
    void (async () => {
      try {
        await api.setTodoDone?.(session.conversationId, id, done)
      } catch (err) {
        toast.error(humanError(err, '这条没勾上，再点一次'))
        await refresh(session.id)
      }
    })()
  }

  /** 预览项目里的一个文件。 */
  const openFile = (name: string): void => {
    if (session === undefined) return
    void (async () => {
      try {
        const file = await api.vibeProjectFile?.(session.id, name)
        if (file === undefined) return
        setPreview({ name: file.name, content: file.content })
      } catch (err) {
        toast.error(humanError(err, '这个文件读不出来'))
      }
    })()
  }

  /** 用文件管理器打开项目目录。 */
  const openFolder = (): void => {
    const dir = session?.project?.dir
    if (dir === undefined) return
    void (async () => {
      const opened = await openInFileManager(dir)
      if (!opened) toast.error('打不开这个目录，把上面的路径复制到文件管理器里就行')
    })()
  }

  if (session === undefined) {
    return (
      <div className="vibe-page">
        <div className="vibe-hero">
          <h1 className="vibe-title">
            RyVibe
            <span className="vibe-badge">Beta</span>
          </h1>
          <p className="vibe-lede">
            说一句你想要的东西，小队会先问清楚你到底要个什么。
            <br />
            一个能打开的小程序、一份文档、一张表，还是一个以后照着做的流程——小队带着选项来问你，你点一下就行。
          </p>
          <textarea
            className="vibe-input"
            value={requirement}
            rows={3}
            placeholder="例如：给独立开发者做一个记账工具，能分类、能看趋势"
            onChange={(event) => {
              setRequirement(event.target.value)
            }}
            onKeyDown={(event) => {
              // 输入法组合中的回车是「选词」，不是「开始」。
              if (event.nativeEvent.isComposing) return
              if (event.key !== 'Enter' || event.shiftKey) return
              event.preventDefault()
              void start()
            }}
          />
          <div className="vibe-actions">
            <button
              type="button"
              className="btn btn-primary vibe-start"
              disabled={starting || requirement.trim().length === 0}
              onClick={() => {
                void start()
              }}
            >
              {starting ? '小队正在接手…' : '开始'}
            </button>
            <span className="vibe-hint">Enter 也可以直接开始</span>
          </div>
          {error !== undefined && <p className="vibe-error">{error}</p>}
          <div className="vibe-examples">
            <span className="vibe-examples-label">或者试试</span>
            {EXAMPLES.map((example) => {
              return (
                <button
                  key={example}
                  type="button"
                  className="vibe-example"
                  onClick={() => {
                    setRequirement(example)
                  }}
                >
                  {example}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  const nameOf = (agentId: string): string => {
    const member = session.squad.find((item) => {
      return item.id === agentId
    })
    return member?.name ?? '小队'
  }

  const pending = questions.filter((question) => {
    return question.answered !== true
  })
  const answered = questions.filter((question) => {
    return question.answered === true
  })

  return (
    <div className="vibe-page">
      <header className="vibe-header">
        <h1 className="vibe-title">
          RyVibe
          <span className="vibe-badge">Beta</span>
        </h1>
        <span className="vibe-status">
          {statusLine(session)}
          {session.status !== 'done' && session.status !== 'failed' && (
            <span className="queue-pulse vibe-spinner" aria-hidden="true" />
          )}
        </span>
        <button type="button" className="btn btn-mini vibe-reset" onClick={reset}>
          换一个
        </button>
      </header>

      {session.status !== 'failed' && session.status !== 'done' && (
        <Progress step={stepOf(session, output.length)} status={session.status} />
      )}

      <blockquote className="vibe-requirement">{session.requirement}</blockquote>
      <p className="vibe-squad">
        小队：
        {session.squad
          .map((member) => {
            return member.name
          })
          .join('、')}
      </p>

      {session.status === 'failed' && (
        <div className="vibe-failed" role="alert">
          <strong>小队没能给出方案</strong>
          <span>{session.error ?? '这一轮出错了'}</span>
          <div className="vibe-failed-actions">
            <button type="button" className="btn vibe-retry" onClick={retry}>
              再试一次
            </button>
            <button type="button" className="btn vibe-continue" onClick={reset}>
              换句话说
            </button>
          </div>
        </div>
      )}

      {answered.length > 0 && (
        <section className="vibe-section">
          <h2 className="vibe-section-title">你们问过这些</h2>
          <ul className="vibe-record">
            {answered.map((question) => {
              return (
                <li key={question.id} className="vibe-record-item">
                  <span className="vibe-record-q">{question.question}</span>
                  <span className="vibe-record-a">
                    {question.selected !== undefined && question.selected.length > 0
                      ? question.selected.join('、')
                      : (question.answer ?? '')}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {pending.length > 0 && (
        <section className="vibe-section">
          <QuestionCard
            questions={pending}
            picks={picks}
            submitted={submitted}
            busy={answering}
            onPick={(questionId, option) => {
              setPicks((prev) => {
                return { ...prev, [questionId]: option }
              })
            }}
            onSubmit={() => {
              void submit(false)
            }}
            onSkip={() => {
              void submit(true)
            }}
            onEdit={() => {
              setSubmitted(undefined)
            }}
          />
        </section>
      )}

      {output.length > 0 && (
        <section className="vibe-section">
          <h2 className="vibe-section-title">{session.status === 'done' ? '做好的东西' : '小队正在做的'}</h2>
          {output.map((item, index) => {
            return (
              <article key={`${item.seq}`} className="vibe-output">
                <div className="vibe-output-name">{nameOf(item.senderId)}</div>
                <div className="vibe-output-body">
                  <Markdown text={item.text} />
                </div>
                {index === output.length - 1 ? null : null}
              </article>
            )
          })}
        </section>
      )}

      {session.project !== undefined && (
        <ProjectCard
          project={session.project}
          preview={preview}
          onOpenFile={openFile}
          onClosePreview={() => {
            setPreview(undefined)
          }}
          onOpenFolder={openFolder}
        />
      )}

      <TaskList todos={todos} onToggle={toggleTodo} />

      {error !== undefined && <p className="vibe-error">{error}</p>}

      {session.status === 'done' && onOpenConversation !== undefined && (
        <button
          type="button"
          className="btn vibe-continue"
          onClick={() => {
            onOpenConversation(session.conversationId)
          }}
        >
          <Icon name="chat-bubble" size={16} />
          在聊天里继续追问
        </button>
      )}
    </div>
  )
}
