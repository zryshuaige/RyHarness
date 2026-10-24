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
import type {
  AgentDef,
  ProviderInfo,
  TodoItem,
  VibeOutputView,
  VibeProjectView,
  VibeQuestionView,
  VibeSessionView,
  VibeSquadMemberView,
} from '../api.ts'
import { openInFileManager } from '../lib/desktop.ts'
import { humanError } from '../lib/error-text.ts'
import { hasUsableProvider, missingProviderHint } from '../lib/provider-health.ts'
import { toast } from '../lib/toast.ts'
import { explainTurnError, type TurnErrorTarget } from '../lib/turn-errors.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { Icon } from './Icon.tsx'
import { MessageBubble } from './MessageBubble.tsx'
import { VibeArtifactPreview } from './VibeArtifactPreview.tsx'

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
  /**
   * 通讯录里的助理清单：首屏要告诉用户"谁会来帮你"。
   *
   * 可选：拿不到就不画那一行——这一行是锦上添花，不该因为接口缺了就让首屏空着。
   */
  agents?(): Promise<{ agents: AgentDef[] }>
  /**
   * 中止这一轮。
   *
   * 复用聊天页那条端点：RyVibe 背后就是一个群会话（session.conversationId），
   * 所以中止那一轮不必另开一条路。可选：没有它就少一枚按钮，不影响别的。
   */
  cancelTurn?(conversationId: string): Promise<{ cancelled: boolean }>
}

export interface RyVibePageProps {
  api: RyVibeApi
  /**
   * 模型供应商清单：开工前的可用性闸门（与欢迎页同一份判定，lib/provider-health.ts）。
   * 不传（旧宿主/测试）就不拦——这页不该比宿主还急着下结论。
   */
  providers?: ProviderInfo[]
  /** 清单还在加载时 `usable=false` 只代表「还不知道」，不能据此拦人。 */
  providersLoading?: boolean
  /** 点「在聊天里继续」时把用户带进那个会话。 */
  onOpenConversation?: (conversationId: string) => void
  /**
   * 点小队里某位成员时，直接开一段跟他的单聊。
   *
   * 此前小队名单只是一行文字：用户看到「Ryen、CodeBot」，想知道「刚才是谁写的这段」
   * 就只能去通讯录里翻。Cursor 那套最便宜的抄法就是**任一个 agent 都能点开**——
   * 多 agent 的可见性靠这个撑起来：知道谁在、点一下就能单独问他。
   */
  onOpenAgent?: (agentId: string) => void
  /**
   * 失败横幅上「去配 Key / 改 agent」等动作的跳转（与 ChatView 的同名 prop 同一套
   * 接线；重试这类就地动作不经过它）。
   */
  onNavigate?: (target: TurnErrorTarget) => void
}

/** 消息流里没有文件部件，但 MessageBubble 的 fileUrl 是必填的：给一个空串即可。 */
const vibeFileUrl = (): string => {
  return ''
}

/**
 * 小队工作台：这一轮谁在、谁在忙。
 *
 * 此前小队只是一行文字链接（「小队：Ryen、CodeBot」），于是这一页看上去是**一个
 * 表单**，而不是一支队伍在干活：等的那 30 秒到 2 分钟里，屏幕上没有任何东西在动，
 * 用户不知道发生了什么。
 *
 * 现在每位成员一行：头像 + 名字 + 此刻在做什么。**正在说的那一位头像会动**（说话
 * 律动），正在想的那一位视线左右游走（思考动效）——动效的幅度与节奏按性格四维走，
 * 所以同一个助理在不同人设下动起来不一样。
 *
 * 同屏只许有一个在动（周边运动会抢注意力），所以这里的状态是互斥的。
 */
function SquadPanel({
  squad,
  speakingId,
  ponderingId,
  onOpenAgent,
}: {
  squad: readonly VibeSquadMemberView[]
  /** 此刻正在说话的那位（正在写最后一段输出的人）。 */
  speakingId: string | undefined
  /** 此刻正在想的那位（还在等首 token）。 */
  ponderingId: string | undefined
  onOpenAgent?: (agentId: string) => void
}) {
  if (squad.length === 0) return null
  return (
    <div className="vibe-squad-panel">
      {squad.map((member) => {
        const speaking = member.id === speakingId
        const pondering = !speaking && member.id === ponderingId
        const state = speaking ? '正在说' : pondering ? '正在想' : '在听'
        return (
          <div key={member.id} className={`vibe-squad-row${speaking ? ' is-speaking' : ''}`}>
            {/* 头像只在**还在等首 token**（一段输出都还没有）时动：那时屏幕上没有
                正在长出来的正文，动效没处可挂，就落在"正在想"的那一位身上。
                一旦开始输出，动效就交给正文旁边那个署名头像（见输出区），同一时刻
                全页只有一个在动——周边运动多了会抢注意力。 */}
            <Avatar
              avatarKey={member.avatar}
              name={member.name}
              seed={member.id}
              size={40}
              pondering={pondering}
              {...(member.temperament === undefined ? {} : { temperament: member.temperament })}
            />
            <button
              type="button"
              className="vibe-squad-name"
              title={`跟 ${member.name} 单聊`}
              disabled={onOpenAgent === undefined}
              onClick={() => {
                onOpenAgent?.(member.id)
              }}
            >
              {member.name}
            </button>
            <span className="vibe-squad-state">{state}</span>
            {/* 「正在说」的信号点：输出区的署名头像在动，这里再动就同屏两个了。 */}
            {speaking && <span className="vibe-squad-dot" aria-hidden="true" />}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 一道题的选项 + 「我自己说」那一行。
 *
 * 正在问的那道题（卡片）与「改一下」展开的那一道共用这一份：两处摆的是同一个东西
 * （几个选项 + 一个输入框），抄两遍必然漂。
 */
function AnswerOptions({
  question,
  current,
  draft,
  busy,
  onPick,
  onDraft,
}: {
  question: VibeQuestionView
  /** 当前选中的选项（空串 = 一个都没选）。 */
  current: string
  /** 用户自己写的那句。 */
  draft: string
  busy: boolean
  onPick: (option: string) => void
  onDraft: (text: string) => void
}) {
  return (
    <>
      <div className="vibe-options">
        {question.options.map((option) => {
          const chosen = current === option && draft.trim().length === 0
          return (
            <button
              key={option}
              type="button"
              className={chosen ? 'vibe-option is-chosen' : 'vibe-option'}
              disabled={busy}
              onClick={() => {
                onPick(option)
              }}
            >
              {option}
            </button>
          )
        })}
      </div>
      {/* 自己写一句：没有这一行，选项之外的话就没地方说了——用户只能把
          「我自己说」这个选项当成答案交上去，等于什么都没说。 */}
      <input
        type="text"
        className="vibe-own-answer"
        value={draft}
        placeholder="都不对？我自己说"
        aria-label={`${question.question} —— 自己写一句`}
        disabled={busy}
        onChange={(event) => {
          onDraft(event.target.value)
        }}
      />
    </>
  )
}

/**
 * 一张盘问卡：小队正在问的那一道题，带选项。
 *
 * 抄的是 Lovable 的提问卡片，但**不抄它「一次四题」那一半**：
 * - **一次一题**：小队问一题就停下等，用户点完它才问下一题。此前一轮丢四题过来，
 *   用户看到的是一张问卷——他连第一题都来不及看，整段交互等于没有交互。
 * - **每题预选第一项**：小队认为最稳的选项默认选中，用户不改也能直接提交——于是
 *   「完全不想被打扰」也是一种合法选择。
 * - **可以跳过**：按默认方案来，不追问，直接出方案。
 * - **提交后还能改**：答案那一行旁边有「改一下」，改完小队按新答案重出方案。
 */
function QuestionCard({
  questions,
  picks,
  drafts,
  busy,
  squad,
  onPick,
  onDraft,
  onSubmit,
  onSkip,
}: {
  questions: VibeQuestionView[]
  /** 当前选择（questionId → 选项）。 */
  picks: Record<string, string>
  /** 用户自己写的答案（questionId → 他写的那句话）。 */
  drafts: Record<string, string>
  busy: boolean
  /** 小队成员：谁问的题，头像就挂在题旁边。 */
  squad: readonly VibeSquadMemberView[]
  onPick: (questionId: string, option: string) => void
  onDraft: (questionId: string, text: string) => void
  onSubmit: () => void
  /** 「按你们的默认方案来」：不再追问了。 */
  onSkip?: () => void
}) {
  return (
    <div className="vibe-card">
      {/* 卡片头只留一句操作提示，不再写「小队有几件事想跟你确认」——
          下面每一道题本身就是小队说的一句话（气泡形态），再说一遍是重复。 */}
      <div className="vibe-card-head">
        <span className="vibe-card-hint">选一个就行，也可以自己写</span>
      </div>
      {questions.map((question) => {
        const current = picks[question.id] ?? question.options[0] ?? ''
        const draft = drafts[question.id] ?? ''
        // 谁问的：盘问是"某个人替小队问你"，不是一张匿名的表单。
        const asker = squad.find((member) => {
          return member.id === question.agentId
        })
        return (
          <div key={question.id} className="vibe-question">
            {/* 题干就是小队说的一句话：气泡形态，与上面的产出、下面你的回答同一条流。 */}
            <MessageBubble
              message={{
                key: `vibe-q-${question.id}`,
                senderType: 'agent',
                senderId: question.agentId ?? 'squad',
                senderName: asker?.name ?? '小队',
                turnIndex: 0,
                parts: [{ kind: 'text', text: question.question }],
                done: true,
              }}
              agent={
                asker === undefined
                  ? undefined
                  : {
                      id: asker.id,
                      name: asker.name,
                      ...(asker.avatar === undefined ? {} : { avatar: asker.avatar }),
                      ...(asker.temperament === undefined ? {} : { temperament: asker.temperament }),
                    }
              }
              fileUrl={vibeFileUrl}
            />
            <AnswerOptions
              question={question}
              current={current}
              draft={draft}
              busy={busy}
              onPick={(option) => {
                onPick(question.id, option)
              }}
              onDraft={(text) => {
                onDraft(question.id, text)
              }}
            />
          </div>
        )
      })}
      <div className="vibe-card-actions">
        <button type="button" className="btn btn-primary vibe-card-submit" disabled={busy} onClick={onSubmit}>
          就这个
        </button>
        {onSkip !== undefined && (
          <button type="button" className="btn vibe-card-skip" disabled={busy} onClick={onSkip}>
            按你们的默认方案来
          </button>
        )}
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

/** 产物形态的中文名：页面上要让人一眼看出"这是个软件还是一张表"。 */
const KIND_LABEL: Record<VibeProjectView['kind'], string> = {
  app: '软件',
  doc: '文档',
  sheet: '表格',
  flow: '流程',
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
          <h2 className="vibe-section-title">
            {project.name}
            <span className="vibe-project-kind">{KIND_LABEL[project.kind]}</span>
          </h2>
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
          <VibeArtifactPreview name={preview.name} content={preview.content} />
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
function TaskList({
  todos,
  busyId,
  onToggle,
}: {
  todos: readonly TodoItem[]
  /** 正在提交的那一条：勾选期间禁用，连点会并发提交。 */
  busyId: string | undefined
  onToggle: (id: string, done: boolean) => void
}) {
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
                  // 提交期间禁用这一条：此前不禁用，连点两下会并发提交，
                  // 两个请求都乐观改本地状态，后到的那个失败回滚会把正确的
                  // 状态又改回去——用户看着像"勾上又弹回来"。
                  disabled={busyId === todo.id}
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
    if (session.pendingAnswers <= 0) return '小队正在整理你的选择…'
    // 一次只问一题：「一件事」比「1 件事」像人话。
    return session.pendingAnswers === 1
      ? '小队问你一件事，选完就接着往下走'
      : `小队想先问清楚 ${session.pendingAnswers} 件事，选完就开工`
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

export function RyVibePage({
  api,
  providers,
  providersLoading,
  onOpenConversation,
  onOpenAgent,
  onNavigate,
}: RyVibePageProps) {
  const [requirement, setRequirement] = useState('')
  const [session, setSession] = useState<VibeSessionView | undefined>(undefined)
  const [questions, setQuestions] = useState<VibeQuestionView[]>([])
  const [output, setOutput] = useState<VibeOutputView[]>([])
  /** 通讯录里的助理（首屏给用户看"谁会来帮你"）。拿不到就不画那一行。 */
  const [crew, setCrew] = useState<AgentDef[]>([])
  /** 用户在卡片上点过的选择（questionId → 选项）；没点过的用预选项（第一个）。 */
  const [picks, setPicks] = useState<Record<string, string>>({})
  /** 用户自己写的答案（questionId → 他写的那句话）。 */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  /**
   * 正在改主意的题（questionId）：undefined = 没在改。
   *
   * 答案就摆在那条对话里，所以「改一下」也长在那条对话里——不再单独做一张
   * 「你已经选好了」的卡（此前那张卡一提交就占着位置，把小队新问的那道题挤没了）。
   */
  const [editingId, setEditingId] = useState<string | undefined>(undefined)
  const [starting, setStarting] = useState(false)
  const [answering, setAnswering] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  /** 落盘时写进待办的任务清单。 */
  const [todos, setTodos] = useState<TodoItem[]>([])
  /** 正在提交的那一条待办：勾选期间禁用它，连点会并发提交。 */
  const [todoBusy, setTodoBusy] = useState<string | undefined>(undefined)
  /** 中止请求在途。 */
  const [stopping, setStopping] = useState(false)
  /** 用户按了「停一下」：这一轮到此为止，但已做出来的东西还在。 */
  const [stopped, setStopped] = useState(false)
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
        // **按 seq 去重**：轮询与提交会重叠（用户在建造期答完题，服务端回包与下一次
        // 轮询可能同时在飞），两次请求读到同一个游标，同一段产出会被服务端发两遍，
        // 客户端各追加一次 —— 屏幕上于是出现两份一样的方案。
        setOutput((prev) => {
          const next = [...prev]
          for (const item of state.output) {
            if (next.some((old) => old.seq === item.seq)) continue
            next.push(item)
          }
          return next.length === prev.length ? prev : next
        })
        const last = state.output.at(-1)
        if (last !== undefined && last.seq > outputCursorRef.current) {
          outputCursorRef.current = last.seq
        }
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
   * 首屏的"谁会来帮你"：拉一次通讯录，把这一轮会参与的人摆出来。
   *
   * 拿不到就算了——这一行是锦上添花，不该因为接口缺了就让首屏空着或报错。
   */
  useEffect(() => {
    if (api.agents === undefined) return
    let cancelled = false
    void api
      .agents()
      .then((result) => {
        if (cancelled) return
        setCrew(result.agents.slice(0, 4))
      })
      .catch(() => {
        // 拉不到就不画。
      })
    return () => {
      cancelled = true
    }
  }, [api])

  /**
   * 轮询：只要这一轮还没结束就定期拉一次。
   *
   * 快慢按「小队还在不在说话」分：还在写就 1.2 秒一次（页面要跟手）；
   * 轮到用户点选了，就退到 4 秒一次——那段时间状态基本不会变，一直 1.2 秒地刷
   * 只是白打后端。'done' 之后彻底不轮询；**页面看不见时也停**（用户去开会了，
   * 页面还挂在那儿一秒一次地打后端没有意义）。
   *
   * **窗口重新可见时要自己接上**：此前隐藏时直接 return（连定时器都不挂），而
   * effect 的依赖里没有可见性、也没有 visibilitychange 监听——于是用户最小化一次
   * 窗口，这一轮在界面上就永远停在旧状态（还写着「小队正在做…」），而服务端
   * 还在跑。建造期有一两分钟，这一次最小化就够把这一轮作废。
   */
  useEffect(() => {
    if (session === undefined) return
    if (session.status === 'done') return
    const id = session.id
    const arm = (): void => {
      if (document.hidden) return
      timerRef.current = window.setTimeout(
        () => {
          void refresh(id)
        },
        session.busy ? POLL_BUSY_MS : POLL_IDLE_MS,
      )
    }
    arm()
    const onVisible = (): void => {
      if (document.hidden) return
      void refresh(id)
      arm()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current)
        timerRef.current = undefined
      }
    }
  }, [session, refresh])

  /**
   * 「一个能用的模型来源都没有」的前置闸门：与欢迎页同一份判定（hasUsableProvider）。
   *
   * 没有 key 的用户第一次「动手做东西」若直接放行，要空等 30 秒才等来一条英文
   * 横幅——Beta 页与主应用判若两产品。清单没给/还在加载时（usable=false 只代表
   * 「还不知道」）不拦，等真失败再由翻译层接住。
   */
  const noSourceHint =
    providers !== undefined && providersLoading !== true && !hasUsableProvider(providers)
      ? (missingProviderHint(providers) ?? '还没有能用的模型来源，先去「我的 → 模型供应商」配一个。')
      : undefined

  const start = async (): Promise<void> => {
    const text = requirement.trim()
    if (text.length === 0) return
    // 前置闸门：必败的一轮不发请求，把人先引去配 Key。
    if (noSourceHint !== undefined) {
      setError(noSourceHint)
      return
    }
    setStarting(true)
    setError(undefined)
    try {
      const created = await api.startVibe(text)
      setSession(created.session)
      setQuestions([])
      setOutput([])
      setPicks({})
      setDrafts({})
      setEditingId(undefined)
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

  /**
   * 「改一下」：把他上次怎么答的填回去，再把这道题放回可编辑的状态。
   *
   * 服务端是支持的（重复回答会覆盖上一次）。新答案跟着下一道题的答案一起交给小队，
   * 所以小队只重跑一次，界面上不会冒出一版半成品方案。
   */
  const startEdit = (question: VibeQuestionView): void => {
    const selected = question.selected?.[0]
    setPicks((prev) => {
      return { ...prev, [question.id]: selected ?? '' }
    })
    setDrafts((prev) => {
      // 没勾选项 = 他自己写的那句话，把原话填回去。
      return { ...prev, [question.id]: selected === undefined ? (question.answer ?? '') : '' }
    })
    setEditingId(question.id)
  }

  /**
   * 提交答案。
   *
   * 正常答题交的是「当前待答的那道题」，改主意交的是「被改的那一道」。答案进小队
   * 共同看到的那条正文里——下一道题就是小队看到它之后问出来的，所以这才是「一来一回」。
   */
  const submit = async (skipped: boolean, ids: readonly string[]): Promise<void> => {
    if (session === undefined) return
    const answers: { questionId: string; selected: string[]; text?: string }[] = []
    for (const id of ids) {
      const question = questions.find((item) => {
        return item.id === id
      })
      if (question === undefined) continue
      // 自己写了字就交字，没写才交选项。写了字还把预选项一起交上去，
      // 小队看到的是两句而不是一句，反而更糊。
      const draft = (drafts[id] ?? '').trim()
      const useDraft = draft.length > 0 && !skipped
      answers.push({
        questionId: id,
        selected: useDraft ? [] : [picks[id] ?? question.options[0] ?? ''],
        ...(useDraft ? { text: draft } : {}),
      })
    }
    if (answers.length === 0) return
    setAnswering(true)
    try {
      await api.answerVibe(session.id, { answers, ...(skipped ? { skipped: true } : {}) })
      setEditingId(undefined)
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
    setEditingId(undefined)
    setPicks({})
    setDrafts({})
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

  /** 失败横幅上的「下一步」：重试就地做；跳面板交给宿主（与 ChatView 的 runErrorAction 同一口径）。 */
  const runFailureAction = (target: TurnErrorTarget): void => {
    if (target === 'retry') {
      retry()
      return
    }
    onNavigate?.(target)
  }

  const reset = (): void => {
    setSession(undefined)
    setQuestions([])
    setOutput([])
    setPicks({})
    setDrafts({})
    setEditingId(undefined)
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
    setTodoBusy(id)
    void (async () => {
      try {
        await api.setTodoDone?.(session.conversationId, id, done)
      } catch (err) {
        toast.error(humanError(err, '这条没勾上，再点一次'))
        await refresh(session.id)
      } finally {
        setTodoBusy((current) => {
          return current === id ? undefined : current
        })
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
          {/* 引导前置摆出来：没有可用模型来源时，不必先点一次「开始」才知道路怎么走。 */}
          {(error ?? noSourceHint) !== undefined && <p className="vibe-error">{error ?? noSourceHint}</p>}
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
          {/* 谁会来帮你：首屏原本只有一个输入框，像一张空表单。把这一轮会参与的人
              摆出来，用户点下「开始」之前就知道不是一个人在自言自语。 */}
          {crew.length > 0 && (
            <div className="vibe-crew">
              <span className="vibe-crew-label">这一轮谁来做</span>
              <div className="vibe-crew-row">
                {crew.map((agent) => {
                  return (
                    <span key={agent.id} className="vibe-crew-member" title={`${agent.name} 会参与`}>
                      <Avatar avatarKey={agent.avatar} name={agent.name} seed={agent.id} size={44} />
                      <span className="vibe-crew-name">{agent.name}</span>
                    </span>
                  )
                })}
              </div>
            </div>
          )}
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

  /**
   * 停一下：中止这一轮。
   *
   * 此前这一页从头到尾没有"停"——用户发了一句话，就只能盯着屏幕等上一两分钟，
   * 连"算了不要了"都说不出口。这一轮背后就是那个群会话，中止走的是聊天页同一条
   * 端点（session.conversationId）。
   */
  const stop = (): void => {
    if (api.cancelTurn === undefined || session === undefined) return
    setStopping(true)
    void api
      .cancelTurn(session.conversationId)
      .then(() => {
        setStopped(true)
        void refresh(session.id)
      })
      .catch((error: unknown) => {
        toast.error(humanError(error, '没能停下来，再点一次'))
      })
      .finally(() => {
        setStopping(false)
      })
  }

  /**
   * 失败横幅的人话：session.error 是服务端那轮失败的原话（多为英文），与聊天页
   * 红条走同一张翻译表（lib/turn-errors.ts）——认得出的失败说清「出了什么事、
   * 下一步去哪」，认不出才把原文折进「详情」。
   */
  const failure = session.status === 'failed' ? explainTurnError(undefined, session.error ?? '') : undefined

  const pending = questions.filter((question) => {
    return question.answered !== true
  })
  const answered = questions.filter((question) => {
    return question.answered === true
  })
  /** 卡片该不该画：小队正在等一道题的答案（一次只等一道）。 */
  const showCard = pending.length > 0

  /**
   * 此刻正在说的是谁。
   *
   * 判据：**最后一段输出**的作者。流式写入时最后一条一直在长，那就是正在写的那位；
   * 这一轮停下来（done）之后不再有人说话。
   */
  const speakingId = ((): string | undefined => {
    if (session.status !== 'building') return undefined
    const last = output.at(-1)
    return last?.senderId
  })()
  /**
   * 此刻正在想的是谁：还在等首 token，一段输出都还没有。
   *
   * 这种时刻屏幕上最没东西可看——气泡还没出现，三点指示器之外什么都没有。
   */
  const ponderingId = ((): string | undefined => {
    if (session.status !== 'building') return undefined
    if (output.length > 0) return undefined
    return session.squad[0]?.id
  })()

  return (
    <div className="vibe-page">
      <header className="vibe-header">
        <h1 className="vibe-title">
          RyVibe
          <span className="vibe-badge">Beta</span>
        </h1>
        <span className="vibe-status">
          {stopped ? '已停下' : statusLine(session)}
          {!stopped && session.status !== 'done' && session.status !== 'failed' && (
            <span className="queue-pulse vibe-spinner" aria-hidden="true" />
          )}
        </span>
        <div className="vibe-header-actions">
          {/* 停一下：这一轮还在跑的时候，用户不该只能干等。 */}
          {!stopped && session.status === 'building' && api.cancelTurn !== undefined && (
            <button type="button" className="btn btn-mini vibe-stop" disabled={stopping} onClick={stop}>
              {stopping ? '停下中…' : '停一下'}
            </button>
          )}
          {stopped && (
            <button
              type="button"
              className="btn btn-mini vibe-retry"
              onClick={() => {
                setStopped(false)
                retry()
              }}
            >
              再来一次
            </button>
          )}
          <button type="button" className="btn btn-mini vibe-reset" onClick={reset}>
            换一个
          </button>
        </div>
      </header>

      {session.status !== 'failed' && session.status !== 'done' && (
        <Progress step={stepOf(session, output.length)} status={session.status} />
      )}

      {/* 小队工作台：这一轮谁在、谁在忙。
          此前这里只有一行「小队：Ryen、CodeBot」的文字链接，等的那一两分钟里屏幕上
          没有任何东西在动——用户不知道是谁在写、写到哪了。现在每人一行：头像 + 名字 +
          此刻在做什么，正在说的那一位头像会动。
          它放在消息流**之上**：夹在对话中间会把一段话切成两半。 */}
      <SquadPanel
        squad={session.squad}
        speakingId={speakingId}
        ponderingId={ponderingId}
        {...(onOpenAgent === undefined ? {} : { onOpenAgent })}
      />

      {/* 消息流：你那句话在最上面，小队的回话往下接。
          此前那句话是一块左边带竖线的引用块——那是一句**引文**，不像一句你说的话。
          放进流里当用户气泡，这一页从头到尾就是一段对话。 */}
      <div className="vibe-stream">
        <MessageBubble
          message={{
            key: 'vibe-requirement',
            senderType: 'user',
            senderId: 'user',
            senderName: '你',
            turnIndex: 0,
            parts: [{ kind: 'text', text: session.requirement }],
            done: true,
          }}
          fileUrl={vibeFileUrl}
        />
      </div>

      {session.status === 'failed' && (
        <div className="vibe-failed" role="alert">
          <strong>小队没能给出方案</strong>
          <span>
            {failure?.title}。{failure?.hint}
          </span>
          {/* 与聊天页红条同一套「下一步」：可点的动作（去配 Key / 改 agent），重试走旁边那枚。 */}
          {failure?.action !== undefined && (
            <button
              type="button"
              className="btn vibe-failed-action"
              onClick={() => {
                runFailureAction(failure?.action?.target ?? 'retry')
              }}
            >
              {failure.action.label}
            </button>
          )}
          {failure?.detail !== undefined && (
            <details style={{ flexBasis: '100%' }}>
              <summary style={{ cursor: 'pointer', fontSize: 'var(--fs-xs)' }}>详情</summary>
              <code
                style={{
                  display: 'block',
                  marginTop: 4,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--fs-xs)',
                }}
              >
                {failure.detail}
              </code>
            </details>
          )}
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
        <section className="vibe-section vibe-stream-section">
          {/*
            已经答过的题也留在流里：小队问的那句是一条气泡，你的回答是另一条。
            此前它们被折成一张"你们问过这些"的表——那是记录表，不是对话。
          */}
          <div className="vibe-stream">
            {answered.map((question) => {
              const asker = session.squad.find((member) => {
                return member.id === question.agentId
              })
              const answer =
                question.selected !== undefined && question.selected.length > 0
                  ? question.selected.join('、')
                  : (question.answer ?? '')
              const editing = editingId === question.id
              return (
                <div key={question.id} className="vibe-asked-pair">
                  <MessageBubble
                    message={{
                      key: `vibe-q-${question.id}`,
                      senderType: 'agent',
                      senderId: question.agentId ?? 'squad',
                      senderName: asker?.name ?? '小队',
                      turnIndex: 0,
                      parts: [{ kind: 'text', text: question.question }],
                      done: true,
                    }}
                    agent={
                      asker === undefined
                        ? undefined
                        : {
                            id: asker.id,
                            name: asker.name,
                            ...(asker.avatar === undefined ? {} : { avatar: asker.avatar }),
                            ...(asker.temperament === undefined ? {} : { temperament: asker.temperament }),
                          }
                    }
                    fileUrl={vibeFileUrl}
                  />
                  {editing ? (
                    /* 改主意的展开态就长在答案底下：选项还是那几个，填回他上次说的。 */
                    <div className="vibe-asked-edit">
                      <AnswerOptions
                        question={question}
                        current={picks[question.id] ?? ''}
                        draft={drafts[question.id] ?? ''}
                        busy={answering}
                        onPick={(option) => {
                          setPicks((prev) => {
                            return { ...prev, [question.id]: option }
                          })
                        }}
                        onDraft={(text) => {
                          setDrafts((prev) => {
                            return { ...prev, [question.id]: text }
                          })
                        }}
                      />
                      <div className="vibe-card-actions">
                        <button
                          type="button"
                          className="btn btn-primary vibe-card-submit"
                          disabled={answering}
                          onClick={() => {
                            void submit(false, [question.id])
                          }}
                        >
                          改好了
                        </button>
                        <button
                          type="button"
                          className="btn vibe-card-skip"
                          disabled={answering}
                          onClick={() => {
                            setEditingId(undefined)
                          }}
                        >
                          算了
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {answer.length > 0 && (
                        <MessageBubble
                          message={{
                            key: `vibe-a-${question.id}`,
                            senderType: 'user',
                            senderId: 'user',
                            senderName: '你',
                            turnIndex: 0,
                            parts: [{ kind: 'text', text: answer }],
                            done: true,
                          }}
                          fileUrl={vibeFileUrl}
                        />
                      )}
                      <button
                        type="button"
                        className="vibe-asked-edit-link"
                        disabled={answering}
                        onClick={() => {
                          startEdit(question)
                        }}
                      >
                        改一下
                      </button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {showCard && (
        <section className="vibe-section">
          <QuestionCard
            questions={pending}
            picks={picks}
            drafts={drafts}
            busy={answering}
            squad={session.squad}
            onPick={(questionId, option) => {
              setPicks((prev) => {
                return { ...prev, [questionId]: option }
              })
            }}
            onDraft={(questionId, text) => {
              setDrafts((prev) => {
                return { ...prev, [questionId]: text }
              })
            }}
            onSubmit={() => {
              void submit(
                false,
                pending.map((question) => {
                  return question.id
                }),
              )
            }}
            onSkip={() => {
              void submit(
                true,
                pending.map((question) => {
                  return question.id
                }),
              )
            }}
          />
        </section>
      )}

      {output.length > 0 && (
        <section className="vibe-section vibe-stream-section">
          {/*
            这一页就是一条消息流。
            此前每段产出是一个带边框的独立卡片——那是一份**日志**：看得见"有几条记录"，
            看不见"谁在跟谁说话"。RyVibe 讲的就是一支队伍在接力干活，那它就该长得
            像一段对话：小队每个人的发言是一条气泡，用户那句话也在流里。
            视觉直接复用聊天页那套气泡（同一个组件），于是复制、朗读、流式光标、
            头像列对齐全是白捡的，RyVibe 与聊天页也不会是两副面孔。
          */}
          <div className="vibe-stream">
            {output.map((item, index) => {
              const member = session.squad.find((row) => {
                return row.id === item.senderId
              })
              const previous = output[index - 1]
              // 同一个人连着说几句：收紧间距，头像只在组首画一次（与聊天页同一套口径）。
              const tight = previous !== undefined && previous.senderId === item.senderId
              /**
               * 正在写的那一条标成"还没写完"：气泡组件靠这一位决定头像要不要动
               * （未完成的 agent 消息，头像会跟着说话律动）。
               */
              const last = index === output.length - 1
              const writing = last && session.status === 'building'
              return (
                <MessageBubble
                  key={`vibe-${item.seq}`}
                  message={{
                    key: `vibe-${item.seq}`,
                    senderType: 'agent',
                    senderId: item.senderId,
                    senderName: nameOf(item.senderId),
                    turnIndex: 0,
                    seq: item.seq,
                    createdAt: item.createdAt,
                    parts: [{ kind: 'text', text: item.text }],
                    done: !writing,
                  }}
                  agent={
                    member === undefined
                      ? undefined
                      : {
                          id: member.id,
                          name: member.name,
                          ...(member.avatar === undefined ? {} : { avatar: member.avatar }),
                          ...(member.temperament === undefined ? {} : { temperament: member.temperament }),
                        }
                  }
                  fileUrl={vibeFileUrl}
                  firstOfGroup={!tight}
                  tight={tight}
                />
              )
            })}
          </div>
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

      <TaskList todos={todos} busyId={todoBusy} onToggle={toggleTodo} />

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
