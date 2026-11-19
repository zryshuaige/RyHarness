import { type CSSProperties, memo, type ReactNode, useEffect, useRef, useState } from 'react'
import type { AgentDef } from '../api.ts'
import type { AvatarTemperament } from '../lib/avatar-motion.ts'
import { humanError } from '../lib/error-text.ts'
import { formatSize } from '../lib/format.ts'
import { humanMime } from '../lib/humanize.ts'
import { isGuardRelay, relayChainLabel } from '../lib/relay-labels.ts'
import type { StyleVars } from '../lib/stagger.ts'
import { toast } from '../lib/toast.ts'
import { toolDoneLabel, toolFailedLabel, toolRunningLabel } from '../lib/tool-labels.ts'
import type { MessageDelivery, MessagePart, UiMessage } from '../store.ts'
// 代码块容器与段落换行（styles.css 不长 pre/code 规则，这里是内容渲染的扩展层）。
import '../styles-content.css'
import { Avatar } from './avatars/Avatar.tsx'
// 身份色：同一个按 id 哈希的稳定色相，分成图形色与两套正文色（见 agentHue）。
import { agentHues } from './avatars/avatars.tsx'
import { Icon } from './Icon.tsx'
import { Markdown } from './Markdown.tsx'
import { type MentionOptions, MentionText } from './MentionText.tsx'

/**
 * 历史消息 key 的前缀（ChatView 拼的），与 {@link serverMessageId} 同约定。 */
const HIST_KEY_PREFIX = 'hist:'

/**
 * 会话级「已确认反馈」记忆：`${消息id}:${信号}`。
 *
 * 组件本地 state 撑不住切换会话/重挂（气泡卸载后重渲，已点态就丢了，用户能再点
 * 一次）。服务端有 messageId+signal 幂等兜底，但客户端先记住、不再发请求，
 * 才算真正的防刷：连网络包都不该重复出现。
 */
const acknowledgedFeedback = new Set<string>()

function feedbackKey(messageKey: string, signal: 'thumb_up' | 'thumb_down'): string {
  return `${serverMessageId(messageKey)}:${signal}`
}

/**
 * 每个 agent 一个稳定色相。
 *
 * 群聊里三个 agent 的气泡共用同一块 --bubble-peer 白底，光看气泡分不出谁在说话；
 * 头像兜底色板本来就是按 id 哈希取的 12 支高饱和中间调，拿同一个色相去上色，气泡与
 * 头像就说的是同一套颜色语言。
 *
 * 但「同一色相」不等于「同一个值」：边框是图形（1.4.11，3:1 就够），发言人名字是
 * 12px 正文（1.4.3，要 4.5:1）。一套 3:1 的值当正文色用，白底 5/12 不达标。
 * 正文色还随主题换一套——亮底要 L ≤ 0.183、暗底要 L ≥ 0.203，没有交集，只能分两套。
 */
function agentHue(senderId: string): { graphic: string; text: { light: string; dark: string } } {
  const hues = agentHues(senderId)
  return { graphic: hues.graphic, text: { light: hues.textLight, dark: hues.textDark } }
}

/** 工具参数的可读化：agent 写的是机器生成的 JSON，缩进后人才读得下去。 */
function prettyArguments(raw: string): string {
  if (raw.trim().length === 0) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2) ?? raw
  } catch {
    // 不是 JSON（shell_exec 的裸命令行等）就按原文给，不改写内容。
    return raw
  }
}

/**
 * 展开后的单块正文上限。
 *
 * 全量正文在 store 里（见 clipToolContent），这里再收一道：一条上千行的命令输出不该
 * 把气泡撑成一面墙。截断必须写在脸上，否则用户会以为那就是全部。
 */
const TOOL_DETAIL_LIMIT = 1200

function clipForDisplay(text: string): string {
  if (text.length <= TOOL_DETAIL_LIMIT) return text
  return `${text.slice(0, TOOL_DETAIL_LIMIT)}\n…（此处还有 ${text.length - TOOL_DETAIL_LIMIT} 字）`
}

/**
 * .tool-row 的规则是按 <p> 写的；换成 <button>（可折叠就得能被键盘和读屏器操作）之后，
 * 浏览器默认的边框、字体与居中会盖掉它。字号仍由样式表的 .tool-row 给，内联不碰。
 */
const TOOL_ROW_STYLE: CSSProperties = {
  border: 'none',
  fontFamily: 'inherit',
  width: '100%',
  textAlign: 'left',
  cursor: 'pointer',
}

/**
 * 展开区的配色全走 token：暗色主题换的是 :root 上的变量值，内联样式跟着一起变，
 * 不必为暗色另写一份覆盖（styles.css 由另一条 lane 独占，这里不落新选择器）。
 */
const TOOL_DETAIL_STYLE: CSSProperties = {
  margin: 'var(--space-2) 0',
  padding: 'var(--space-2) var(--space-3)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--tool-row-bg)',
  boxShadow: 'inset 0 0 0 1px var(--edge)',
  color: 'var(--text-secondary)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-xs)',
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: '240px',
  overflow: 'auto',
}

/**
 * 工具过程行：折叠时是一句话，展开后是参数 + 结果。
 *
 * 「已读文件」这一行曾经是工具调用的全部可见信息——agent 读了什么、命令回成什么样、
 * 错在哪，用户一个字都看不到，过程可见性（也是信任来源）等于零。失败态默认展开：
 * 报错正文正是用户要点开这一行的唯一理由。
 */
function ToolRow({ part }: { part: Extract<MessagePart, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(part.isError === true)
  const args = prettyArguments(part.arguments)
  const output = part.content ?? ''
  const hasDetail = args.length > 0 || output.length > 0
  const label =
    part.status === 'running'
      ? toolRunningLabel(part.name)
      : part.isError === true
        ? toolFailedLabel(part.name)
        : toolDoneLabel(part.name)
  return (
    <>
      <button
        type="button"
        className={`tool-row ${part.status === 'running' ? 'is-running' : ''} ${part.isError === true ? 'is-error' : ''}`}
        style={TOOL_ROW_STYLE}
        disabled={!hasDetail}
        aria-expanded={hasDetail ? open : undefined}
        onClick={() => {
          setOpen((prev) => {
            return !prev
          })
        }}
      >
        <span className={`tool-dot ${part.status === 'running' ? 'is-running' : ''}`}>
          {part.status === 'running' ? '' : <Icon name={part.isError === true ? 'alert' : 'check'} size={16} />}
        </span>
        <span className="tool-label">{label}</span>
        {hasDetail && (
          <span
            className="tool-caret"
            style={{
              transform: open ? 'rotate(90deg)' : 'none',
              transition: 'transform var(--dur-hover) var(--ease-out)',
            }}
          >
            <Icon name="chevron-right" size={16} />
          </span>
        )}
      </button>
      {open && hasDetail && (
        <div className="tool-detail" style={TOOL_DETAIL_STYLE}>
          {args.length > 0 && (
            <>
              <div className="tool-detail-label">参数</div>
              <div className="tool-detail-body">{clipForDisplay(args)}</div>
            </>
          )}
          {output.length > 0 && (
            <>
              <div className="tool-detail-label" style={part.isError === true ? { color: 'var(--danger)' } : undefined}>
                {part.isError === true ? '错误' : '结果'}
              </div>
              <div
                className="tool-detail-body"
                style={part.isError === true ? { borderLeft: '2px solid var(--danger)', paddingLeft: 8 } : undefined}
              >
                {clipForDisplay(output)}
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}

/**
 * `<button>` 复用 `.file-open` 的样子，但浏览器默认的按钮边框/字体得抹掉——
 * styles.css 由另一条 lane 独占，这里不落新选择器（与 TOOL_DETAIL_STYLE 同理）。
 */
const FILE_ACTION_STYLE: CSSProperties = { border: 'none', cursor: 'pointer', fontFamily: 'inherit' }

/** 单个消息部件的渲染。markdown=true 时文本按 Markdown 渲染（agent 消息全程）。 */
export function MessagePartView({
  part,
  fileUrl,
  onPreview,
  markdown = false,
  streaming = false,
  cacheKey,
  mentions,
}: {
  part: MessagePart
  fileUrl: (name: string) => string
  /** 有它就把「打开」变成「预览」（ArtifactPreview）；没有才退回新窗口打开。 */
  onPreview?: (file: { name: string; mime: string; size: number }) => void
  markdown?: boolean
  /** 还在流式：未闭合的尾块降级为纯文本，避免随 token 长出结构。 */
  streaming?: boolean
  /** 流式前缀缓存的分槽键（消息 key）；群聊并发多条流式时必须带上。 */
  cacheKey?: string
  /** @提及的接线（名单 / 悬停取资料 / 点一下送回输入框）。 */
  mentions?: MentionOptions
}) {
  if (part.kind === 'text') {
    // 流式期也走 Markdown：等 done 才切会让整条气泡在结束瞬间重排（单换行塌成空格）。
    if (markdown)
      return (
        <div className="bubble-text bubble-md">
          <Markdown text={part.text} streaming={streaming} cacheKey={cacheKey} mentions={mentions} />
        </div>
      )
    // 用户消息走纯文本。名单里有人时，@某人 被画成蓝色链接，鼠标一停出名片。
    if (mentions !== undefined && mentions.entries.length > 0)
      return (
        <p className="bubble-text">
          <MentionText text={part.text} {...mentions} />
        </p>
      )
    return <p className="bubble-text">{part.text}</p>
  }
  if (part.kind === 'tool') {
    // 用 Fragment 而不是包一层 div：.tool-row 与 .bubble-text 的相邻间距规则长在
    // 兄弟选择器上，包一层就把那 6px 间距弄没了。
    return <ToolRow part={part} />
  }
  return (
    <div className="file-card">
      <span className="file-icon">
        <Icon name="file" size={24} />
      </span>
      <span className="file-meta">
        <strong>{part.name}</strong>
        <small title={part.mime}>
          {formatSize(part.size)} · {humanMime(part.mime)}
        </small>
      </span>
      {/* 主动作是「预览」：产物是给人看的，先落到一个空白下载页是最差的第一印象。
          没有预览能力时（页面级用例）才退回新窗口打开。 */}
      {onPreview === undefined ? (
        <a className="file-open" href={fileUrl(part.name)} target="_blank" rel="noreferrer">
          打开
        </a>
      ) : (
        <button
          type="button"
          className="file-open"
          style={FILE_ACTION_STYLE}
          onClick={() => {
            onPreview({ name: part.name, mime: part.mime, size: part.size })
          }}
        >
          预览
        </button>
      )}
      {/* 产物要能拿走：另一份是浏览器原生下载（download 属性），不依赖服务端额外端点。 */}
      <a className="file-open is-quiet" href={fileUrl(part.name)} download={part.name}>
        下载
      </a>
    </div>
  )
}

/** 气泡里全部文本部件拼成的纯文本（复制与朗读共用同一份口径）。 */
export function messagePlainText(message: UiMessage): string {
  return message.parts
    .filter((part) => {
      return part.kind === 'text'
    })
    .map((part) => {
      return part.kind === 'text' ? part.text : ''
    })
    .join('\n')
}

/**
 * 搜索命中定位用的服务端消息 id。
 *
 * 历史消息的 React key 由 ChatView 拼成 `hist:<服务端 id>`，而 /api/search 回的是
 * 裸 id——不摘掉这个前缀，「滚到那条消息」的选择器永远选不中气泡。流式与本地
 * 用户消息没有服务端 id（也不会被搜索命中），保留原 key 不动。
 */
export function serverMessageId(key: string): string {
  return key.startsWith(HIST_KEY_PREFIX) ? key.slice(HIST_KEY_PREFIX.length) : key
}

/**
 * 送达角标：三态各有各的样子。
 *
 * 「上屏」与「送达」是两件事，断网时两者在界面上曾经毫无区别——用户气泡与已送达
 * 一模一样，看不出自己那句话还在本地排队。pending 复用 .queue-pulse（跳动的关键帧
 * 样式表里已经有了），sent 只给一枚很轻的对勾（历史消息没有 delivery 字段，压根不画）。
 */
/** 角标是 .bubble-row 的直接 flex 子项：竖向居中、不许被长正文压扁。 */
const DELIVERY_STYLE: CSSProperties = { alignSelf: 'center', flexShrink: 0, display: 'inline-flex' }

function DeliveryMark({ delivery }: { delivery: MessageDelivery }) {
  if (delivery === 'pending') {
    return (
      <span className="bubble-delivery is-pending" title="发送中" role="status" style={DELIVERY_STYLE}>
        <span className="queue-pulse" />
      </span>
    )
  }
  if (delivery === 'failed') {
    return (
      <span
        className="bubble-delivery is-error"
        title="发送失败"
        role="status"
        style={{ ...DELIVERY_STYLE, color: 'var(--danger)' }}
      >
        <Icon name="alert" size={16} />
      </span>
    )
  }
  return (
    <span
      className="bubble-delivery is-sent"
      title="已送达"
      style={{ ...DELIVERY_STYLE, color: 'var(--text-disabled)' }}
    >
      <Icon name="check" size={16} />
    </span>
  )
}

/**
 * 看消息的人自己（由 ChatView 从 /api/profile 取，见 UserProfile）。
 * 缺省是有意义的：老服务端没有 profile，气泡就退回成没有头像的样子，而不是多出一个
 * 空占位把排版顶歪。
 */
export interface MessageViewer {
  avatarKey?: string
  name: string
}

/**
 * 气泡旁那 40px 头像的两侧内容，画法一律交给 {@link Avatar}（不另造一套头像渲染）。
 *
 * 用户侧的 seed 固定成 'you'：兜底色板按 seed 哈希，改昵称不该把「我」的那张脸换成
 * 另一种颜色——同一个人的头像在资料页与气泡里必须是同一枚。
 */
/**
 * 一条消息上最多同时挂几枚**内联**操作按钮（D5）：停止朗读（仅播放时）+ 复制 + 溢出触发。
 * 低频动作（朗读/赞/踩/编辑重发/重新生成/分支）进 `.bubble-menu` 溢出菜单，不计入内联。
 * 导出给 design-system.test 当操作条通道宽度与窄列断点的几何输入——按钮数变了却不同步改
 * 它，通道就短一截、按钮重新压回正文（975px 那条旧断点正是六枚内联按钮算出来的）。
 */
export const BUBBLE_INLINE_ACTIONS = 3

function userAvatar(viewer: MessageViewer | undefined): ReactNode {
  if (viewer === undefined) return null
  return <Avatar avatarKey={viewer.avatarKey} name={viewer.name} seed="you" size={40} />
}

/**
 * 气泡需要的 agent 信息：只有头像与名字。
 *
 * 刻意不接整个 {@link AgentDef}：亲密度每轮都在涨，agent 清单每轮都换一次身份，
 * 把整个定义塞进气泡的 props，memo 就每轮失效一次——几十条气泡为了一次用不上的
 * 亲密度分数全部重渲染。
 */
export interface BubbleAgent {
  id: string
  name: string
  avatar?: string
  /**
   * 性格三维（外向 / 严谨 / 幽默）：决定头像动效的幅度与节奏。
   *
   * 刻意只取这三个数而不接整个 persona：**亲密度每轮都在涨**，把整个 persona 塞进
   * 气泡的 props，memo 就每轮失效一次——几十条气泡为了一次用不上的分数全部重渲染。
   * 这三维是用户在编辑里定的，一轮之内不动。
   */
  temperament?: AvatarTemperament
}

/**
 * agent 侧头像：这条消息对应的 agent 定义还没到时留空（列还在，气泡不跳）。
 *
 * `speaking` = 这条消息还在流式写入，也就是**这位此刻正在回话**——头像跟着动，
 * 用户看到的不再是一张静止的图，而是"这位正在说"。
 */
function agentAvatar(agent: BubbleAgent | undefined, speaking: boolean): ReactNode {
  if (agent === undefined) return null
  return (
    <Avatar
      avatarKey={agent.avatar}
      name={agent.name}
      seed={agent.id}
      size={40}
      action={speaking ? 'speaking' : 'idle'}
      {...(agent.temperament === undefined ? {} : { temperament: agent.temperament })}
    />
  )
}

/** 聊天气泡：用户居右（琥珀渐变、右下直角），agent 居左（白底、左下直角）；
 *  带头像列、hover 浮现复制操作、流式光标。 */
function MessageBubbleInner({
  message,
  fileUrl,
  onPreview,
  agent,
  viewer,
  tight = false,
  firstOfGroup = true,
  animated = false,
  onFeedback,
  voiceSpeaking = false,
  onVoiceToggle,
  onEdit,
  onRegenerate,
  onBranch,
  mentions,
}: {
  message: UiMessage
  fileUrl: (name: string) => string
  /** 打开内嵌预览；缺省时文件卡退回「新窗口打开」。 */
  onPreview?: (file: { name: string; mime: string; size: number }) => void
  /** 对应 agent（拿头像）；用户消息为 undefined。 */
  agent?: BubbleAgent
  /** 看消息的人自己（用户消息的头像）；没拉到 profile 时为 undefined。 */
  viewer?: MessageViewer
  /** 与同 sender 上一条相邻（收紧间距）。 */
  tight?: boolean
  /** 同 sender 组首条（显示头像与名字）。 */
  firstOfGroup?: boolean
  /** 播进场动画：只给本次会话新到的消息，历史消息整屏淡入像掉帧。 */
  animated?: boolean
  /** 👍/👎 反馈（仅 agent 消息）。resolve true = 服务端已接受，false = 失败（恢复可点）。 */
  onFeedback?: (message: UiMessage, signal: 'thumb_up' | 'thumb_down') => Promise<boolean>
  /** 这一条正在被朗读（播放器状态按 message key 对上的那一条）。 */
  voiceSpeaking?: boolean
  /** 点朗读/停止（仅 agent 且确实有文本的消息会显示按钮）。 */
  onVoiceToggle?: (message: UiMessage) => void
  /** 编辑并重发（仅用户消息）：把这条消息就地改成新正文并重跑这一轮。 */
  onEdit?: (message: UiMessage, text: string) => void
  /** 重新生成（仅 agent 消息）：用同一句提示词重答一遍。 */
  onRegenerate?: (message: UiMessage) => void
  /** 从此处分支：把会话在这里的状态复制成一个新会话。 */
  onBranch?: (message: UiMessage) => void
  /** @提及的接线：正文里的 @某人 画成蓝色链接，悬停出名片。 */
  mentions?: MentionOptions
}) {
  const [copied, setCopied] = useState(false)
  const [feedback, setFeedback] = useState<'thumb_up' | 'thumb_down' | undefined>(() => {
    return acknowledgedFeedback.has(feedbackKey(message.key, 'thumb_up'))
      ? 'thumb_up'
      : acknowledgedFeedback.has(feedbackKey(message.key, 'thumb_down'))
        ? 'thumb_down'
        : undefined
  })
  /** 请求在途：期间两个按钮都锁住，连点/换信号不会发出并发请求。 */
  const [pending, setPending] = useState(false)
  /** 溢出菜单（D5）：低频动作收进这里，气泡上只留「停止朗读/复制/更多」三枚。 */
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  /** 菜单里可点的项（跳过禁用项）：方向键走位与 Home/End 共用一份查询。 */
  const focusableMenuItems = (): HTMLButtonElement[] => {
    return [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
  }
  /**
   * 关菜单并（按需）把焦点还给触发键。
   *
   * 键盘用户把菜单关掉之后焦点必须落在「哪里」，否则会掉回 body——下一次 Tab 从
   * 文档开头重新数起，等于丢了这个会话的位置。鼠标移出操作区那条路径不还焦。
   */
  const closeMenu = (refocusTrigger: boolean): void => {
    setMenuOpen(false)
    if (refocusTrigger) triggerRef.current?.focus()
  }
  // 指针移出操作区已能关菜单；键盘与触屏没有 mouseleave，补一条「外部按下即关闭」。
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (menuRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true) return
      setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [menuOpen])
  const isUser = message.senderType === 'user'
  const hue = agentHue(message.senderId)
  /**
   * 这位此刻正在回话：这条消息还在流式写入（done=false）。
   *
   * 判据就是消息本身，不另接一份状态：服务端把这条消息标成 done 的那一刻，头像自然
   * 停下来——不需要谁去同步两个信号源。
   */
  const speaking = !isUser && message.done === false
  /**
   * 只给「真的有话可念」的 agent 消息挂朗读键：工具行、空占位与用户消息都不该出现
   * 一个点下去没声音的按钮（群聊与单聊同一口径）。
   */
  const canRead =
    message.senderType === 'agent' && onVoiceToggle !== undefined && messagePlainText(message).trim().length > 0

  // 防刷：同一信号已确认过就不再发请求（换信号允许——改主意是合法操作，
  // 服务端按 messageId+signal 去重，两种信号各自只计一次）。
  const giveFeedback = (signal: 'thumb_up' | 'thumb_down'): void => {
    if (onFeedback === undefined || pending || feedback === signal) return
    const key = feedbackKey(message.key, signal)
    if (acknowledgedFeedback.has(key)) return
    setFeedback(signal)
    setPending(true)
    void onFeedback(message, signal)
      .then((ok) => {
        if (ok) {
          acknowledgedFeedback.add(key)
        } else {
          // 失败恢复可点：清掉乐观高亮，已确认集合里本来就没它。
          setFeedback((prev) => {
            return prev === signal ? undefined : prev
          })
        }
      })
      .finally(() => {
        setPending(false)
      })
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(messagePlainText(message))
      setCopied(true)
      setTimeout(() => {
        setCopied(false)
      }, 1200)
    } catch (error) {
      // 剪贴板不可用（未授权 / 非安全上下文）时按钮毫无变化，等于没点过。
      toast.error(`复制失败：${humanError(error, '手动选中这段话复制也行')}`)
    }
  }

  /**
   * 就地编辑：把这条消息的正文摊开成输入框，保存后交给上层改写并重跑。
   *
   * 输入法组合中的回车是"选词"不是"保存"——中文用户按回车选词时不能把半截拼音
   * 存进去。nativeEvent.isComposing 是标准信号，部分 Electron 下的 IME 不带它，
   * 再由 compositionstart/end 的 ref 兜底（与 ChatInput 同一套口径）。
   */
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const composingRef = useRef(false)

  const startEdit = (): void => {
    setEditText(messagePlainText(message))
    setEditing(true)
  }

  const submitEdit = (): void => {
    const next = editText.trim()
    // 空正文没有意义：发出去的是一句没有话的话。
    if (next.length === 0) {
      toast.error('不能把这条消息改成空的')
      return
    }
    setEditing(false)
    onEdit?.(message, next)
  }

  /**
   * 溢出菜单里到底有几项（决定是否挂「更多」触发键）。朗读在播放中已经以内联停止键
   * 出现，所以此时不再重复进菜单；其余低频动作按各自的可见条件算。
   */
  const hasMenuItems =
    (canRead && !voiceSpeaking) ||
    (!isUser && onFeedback !== undefined && message.done === true) ||
    (isUser && onEdit !== undefined && !editing && message.seq !== undefined) ||
    (!isUser && onRegenerate !== undefined && message.done === true && message.seq !== undefined) ||
    onBranch !== undefined

  const rowClass = [
    'bubble-row',
    isUser ? 'from-user' : 'from-agent',
    tight ? 'tight' : '',
    firstOfGroup ? 'first-of-group' : '',
    animated ? 'is-new' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    // 身份色相只挂在行上，由样式表喂给头像环（.from-agent .bubble-avatar-gutter）：
    // 以前是名字文字色 + 气泡左 3px 条，蓝名字看着像超链接、左条和琥珀品牌色抢注意力，
    // 一个 agent 在整页里就出现了三次身份色。现在色相只做「是谁」的环，正文/名字全回中性。
    <div
      className={rowClass}
      data-sender={message.senderId}
      data-message-id={serverMessageId(message.key)}
      style={isUser ? undefined : ({ '--agent-hue': hue.graphic } as StyleVars)}
    >
      {/* 头像列：两侧共用同一个 DOM 位置——.bubble-row 在用户行是 row-reverse，所以
          同一处代码落在 agent 行是左侧、落在用户行是右侧，镜像不必另写一套。
          画布（40px 固定列）每条都留，头像只画组首那条：中间那条不占位，气泡就会横向
          跳。没有 viewer 时整列不渲染，老服务端下不多出一个空占位。 */}
      {(!isUser || viewer !== undefined) && (
        <span className="bubble-avatar-gutter">
          {firstOfGroup && (isUser ? userAvatar(viewer) : agentAvatar(agent, speaking))}
        </span>
      )}
      <div className="bubble">
        {!isUser && firstOfGroup && (
          // 名字回中性正文色（styles.css 的 .bubble-name 给 --text-secondary），
          // 身份交给上面头像环的 --agent-hue，不再把色相写进文字。
          <div className="bubble-name">{message.senderName}</div>
        )}
        <div className="bubble-bubble">
          {editing ? (
            <div className="bubble-edit">
              <textarea
                className="bubble-edit-input"
                value={editText}
                rows={3}
                aria-label="编辑这条消息"
                onChange={(event) => {
                  setEditText(event.target.value)
                }}
                onCompositionStart={() => {
                  composingRef.current = true
                }}
                onCompositionEnd={() => {
                  composingRef.current = false
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setEditing(false)
                    return
                  }
                  if (event.key !== 'Enter') return
                  // 输入法组合中的回车是"选词"，不是"保存"。
                  if (event.nativeEvent.isComposing || composingRef.current) return
                  // Shift+Enter 换行，与输入框同一套口径：这一框有 3 行，
                  // 用户却打不出第二行——看着能多行、实际存不进去。
                  if (event.shiftKey) return
                  event.preventDefault()
                  submitEdit()
                }}
              />
              <div className="bubble-edit-actions">
                <button type="button" className="bubble-edit-save" aria-label="保存并重发" onClick={submitEdit}>
                  保存并重发
                </button>
                <button
                  type="button"
                  className="bubble-edit-cancel"
                  aria-label="取消编辑"
                  onClick={() => {
                    setEditing(false)
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              {message.parts.map((part, index) => (
                <MessagePartView
                  key={`${part.kind}-${index}`}
                  part={part}
                  fileUrl={fileUrl}
                  onPreview={onPreview}
                  markdown={message.senderType === 'agent'}
                  streaming={!message.done}
                  cacheKey={message.key}
                  mentions={mentions}
                />
              ))}
              {message.senderType === 'agent' && !message.done && <span className="bubble-cursor">▍</span>}
            </>
          )}
        </div>
        <span
          className="bubble-actions"
          role="toolbar"
          aria-label="消息操作"
          // 播放中必须常显：操作条默认靠 hover 浮现，朗读时用户找不到停止键就只能
          // 等它念完。其余状态仍交给样式表的 hover 规则。
          style={
            voiceSpeaking ? { opacity: 1, pointerEvents: 'auto', transform: 'translateY(-50%) scale(1)' } : undefined
          }
          // 指针离开整条操作区（含已展开的菜单）就收起菜单：菜单是绝对定位的子节点，
          // 指针移进菜单不算离开；移出去再 hover 回来不该还留着一个上次没关的菜单。
          onMouseLeave={() => {
            setMenuOpen(false)
          }}
        >
          {/* 内联只剩三枚（BUBBLE_INLINE_ACTIONS）：停止朗读（仅播放中）+ 复制 + 更多。
              播放中不出现「朗读」——那会与停止键同形同事，反而让用户犹豫点哪个。 */}
          {canRead && voiceSpeaking && (
            <>
              <span className="typing-dots voice-wave" aria-hidden="true" style={{ alignSelf: 'center' }}>
                <i />
                <i />
                <i />
              </span>
              <button
                type="button"
                className="bubble-action is-active"
                title="停止朗读"
                aria-label="停止朗读"
                onClick={() => {
                  onVoiceToggle?.(message)
                }}
              >
                <Icon name="square" size={16} />
              </button>
            </>
          )}
          <button
            type="button"
            className="bubble-action"
            title="复制"
            aria-label={copied ? '已复制' : '复制这条消息'}
            onClick={() => {
              void copy()
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} size={16} />
          </button>
          {hasMenuItems && (
            <button
              ref={triggerRef}
              type="button"
              className={`bubble-action${menuOpen ? ' is-active' : ''}`}
              title="更多操作"
              aria-label="更多操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => {
                setMenuOpen((open) => !open)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  closeMenu(false)
                  return
                }
                // ↓ 从触发键直接进菜单第一项：键盘用户不必再 Tab 一次。
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setMenuOpen(true)
                  requestAnimationFrame(() => {
                    focusableMenuItems()[0]?.focus()
                  })
                }
              }}
            >
              <Icon name="ellipsis" size={16} />
            </button>
          )}
          {/* 低频动作收在溢出菜单里：朗读（非播放时）/ 赞 / 踩 / 编辑重发 / 重新生成 / 分支。
              关闭时用 hidden 属性移出可达树，但仍留在 DOM——测试与读屏按 aria-label 找得到。 */}
          <div
            ref={menuRef}
            className="bubble-menu"
            role="menu"
            hidden={!menuOpen}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                closeMenu(true)
                return
              }
              // 菜单内全键盘走位（WAI-ARIA menu 约定）：↑↓ 循环、Home/End 到两端。
              const items = focusableMenuItems()
              if (items.length === 0) return
              const current = items.indexOf(document.activeElement as HTMLButtonElement)
              const focusAt = (index: number): void => {
                items[(index + items.length) % items.length]?.focus()
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                focusAt(current + 1)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                focusAt(current - 1)
              } else if (event.key === 'Home') {
                event.preventDefault()
                focusAt(0)
              } else if (event.key === 'End') {
                event.preventDefault()
                focusAt(items.length - 1)
              }
            }}
          >
            {canRead && !voiceSpeaking && (
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                title="朗读这条消息"
                aria-label="朗读这条消息"
                onClick={() => {
                  closeMenu(true)
                  onVoiceToggle?.(message)
                }}
              >
                <Icon name="volume-2" size={16} />
                <span>朗读</span>
              </button>
            )}
            {!isUser && onFeedback !== undefined && message.done && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className={`menu-item${feedback === 'thumb_up' ? ' is-active' : ''}`}
                  title="有帮助"
                  aria-label="有帮助"
                  disabled={pending}
                  onClick={() => {
                    closeMenu(true)
                    giveFeedback('thumb_up')
                  }}
                >
                  <Icon name="thumbs-up" size={16} />
                  <span>有帮助</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`menu-item${feedback === 'thumb_down' ? ' is-active-neg' : ''}`}
                  title="有问题（触发反思）"
                  aria-label="哪里不对"
                  disabled={pending}
                  onClick={() => {
                    closeMenu(true)
                    giveFeedback('thumb_down')
                  }}
                >
                  <Icon name="thumbs-down" size={16} />
                  <span>哪里不对</span>
                </button>
              </>
            )}
            {/* 编辑并重发：只给用户自己的话（改 agent 的发言等于让用户替它说话），
                也只给已经落库的消息（还没送达的那条没有服务端 seq，改不了）。 */}
            {isUser && onEdit !== undefined && !editing && message.seq !== undefined && (
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                title="编辑并重发"
                aria-label="编辑并重发"
                onClick={() => {
                  // 编辑会原地摊开输入框：焦点交给编辑器，不还给触发键。
                  closeMenu(false)
                  startEdit()
                }}
              >
                <Icon name="pencil" size={16} />
                <span>编辑并重发</span>
              </button>
            )}
            {/* 重新生成：只给已经说完的 agent 消息（还在生成时没有"重来"可言）。 */}
            {!isUser && onRegenerate !== undefined && message.done && message.seq !== undefined && (
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                title="重新生成"
                aria-label="重新生成这条回复"
                onClick={() => {
                  closeMenu(true)
                  onRegenerate(message)
                }}
              >
                <Icon name="arrow-up" size={16} />
                <span>重新生成</span>
              </button>
            )}
            {/* 从此处分支：把会话在这里的状态复制成一个新会话，之后各走各的。 */}
            {onBranch !== undefined && (
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                title="从这里分支"
                aria-label="从这里分支出新会话"
                onClick={() => {
                  closeMenu(true)
                  onBranch(message)
                }}
              >
                <Icon name="arrow-up-right" size={16} />
                <span>分支新会话</span>
              </button>
            )}
          </div>
        </span>
      </div>
      {/* 送达角标挂在行尾（row-reverse 下落在用户气泡左侧），不进 .bubble：
          复制/反馈操作条是 hover 才浮现的，送达状态必须一直在。 */}
      {isUser && message.delivery !== undefined && <DeliveryMark delivery={message.delivery} />}
    </div>
  )
}

/**
 * memo 包装（O(1)）：store 定点更新 + 结构共享保证「没变的消息对象就是同一引用」，
 * 所以这里只比 key/senderId/done/version 与几个 props——绝不序列化 parts。
 * version 由 store 在 parts/done 变化时自增，历史消息无此字段按 0 处理。
 */
export const MessageBubble = memo(MessageBubbleInner, (prev, next) => {
  if (prev.tight !== next.tight) return false
  if (prev.firstOfGroup !== next.firstOfGroup) return false
  if (prev.animated !== next.animated) return false
  if (prev.onFeedback !== next.onFeedback || prev.fileUrl !== next.fileUrl) return false
  if (prev.onPreview !== next.onPreview) return false
  if (prev.agent !== next.agent) return false
  // @提及的接线：名单变了（新助理、改名）才需要重画，其余时候身份不变，memo 继续有效。
  if (prev.mentions !== next.mentions) return false
  // viewer 由调用方现拼一个对象传进来，比身份等于每个 token 都失效 memo；只有头像/名字
  // 真的换了才需要重画（agent 是稳定引用，比身份就够）。
  if (prev.viewer?.avatarKey !== next.viewer?.avatarKey || prev.viewer?.name !== next.viewer?.name) return false
  if (prev.voiceSpeaking !== next.voiceSpeaking || prev.onVoiceToggle !== next.onVoiceToggle) return false
  const a = prev.message
  const b = next.message
  if (a === b) return true
  return a.key === b.key && a.senderId === b.senderId && a.done === b.done && (a.version ?? 0) === (b.version ?? 0)
})

/**
 * 群聊接力链：头像 A → 箭头 → 头像 B 的流转提示，错峰滑入。
 *
 * relays 是「调用方已经定好锚点」的那一批（见 ChatView 的 relayAnchors）：交接发生在
 * 轮内的哪两句之间，就贴在哪一句后面；只有轮首那次没有来源的调度留在轮首。
 */
function RelayChainInner({
  relays,
  turnIndex,
  nameOf,
  avatarOf,
}: {
  relays: readonly { fromAgent?: string; toAgent: string; reason: string; turnIndex: number }[]
  turnIndex: number
  nameOf: (id: string) => string
  avatarOf: (id: string) => { avatarKey?: string; name: string }
}) {
  const items = relays.filter((relay) => {
    return relay.turnIndex === turnIndex
  })
  if (items.length === 0) return null
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: 纯展示容器，aria-label 供读屏器命名
    <div
      className="relay-chain"
      aria-label="调度轨迹"
      // 样式表把整条链居中（轮首整链时合适）；现在它贴左缘跟气泡流对齐，内联改掉居中。
      style={{ justifyContent: 'flex-start' }}
    >
      {items.map((relay, index) => (
        <span
          key={`${relay.reason}-${index}`}
          className={`relay-flow ${isGuardRelay(relay.reason) ? 'is-guard' : ''}`}
          style={{ animationDelay: `${index * 90}ms` }}
        >
          {relay.fromAgent !== undefined && (
            <>
              <span className="relay-avatar">
                <Avatar
                  avatarKey={avatarOf(relay.fromAgent).avatarKey}
                  name={nameOf(relay.fromAgent)}
                  seed={relay.fromAgent}
                  size={20}
                />
              </span>
              <span className="relay-arrow" aria-hidden="true">
                <Icon name="chevron-right" size={16} />
              </span>
            </>
          )}
          <span className="relay-avatar">
            <Avatar
              avatarKey={avatarOf(relay.toAgent).avatarKey}
              name={nameOf(relay.toAgent)}
              seed={relay.toAgent}
              size={20}
            />
          </span>
          <span className="relay-label">{relayChainLabel(relay.reason)}</span>
        </span>
      ))}
    </div>
  )
}

/**
 * memo：props 全是稳定引用（relays 数组只在调度事件时换新、nameOf/avatarOf 已 useCallback），
 * 聊天流式期间没有理由每个 token 都重跑一遍 filter。
 */
export const RelayChain = memo(RelayChainInner)
