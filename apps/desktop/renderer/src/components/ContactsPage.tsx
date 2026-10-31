import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { AgentDef, AgentPersona, AgentTemplate, ApiClient, PermissionPresetView, ProviderInfo } from '../api.ts'
import { isPortraitKey, PORTRAITS, portraitOf } from '../lib/brand-portraits.ts'
import { humanError } from '../lib/error-text.ts'
import { providerLabel } from '../lib/humanize.ts'
import { catalogFromProvider, groupModels, modelMeta, modelTitle } from '../lib/model-catalog.ts'
import { applyPreset, detectPreset } from '../lib/permission.ts'
import {
  birthdayFromInput,
  birthdayInputValue,
  clampTrait,
  composePersonaPrompt,
  NO_VOICE_ID,
  normalizePersona,
  personaSummary,
  suggestTemperature,
  TRAIT_META,
  traitBand,
} from '../lib/persona.ts'
import {
  explainModelMismatch,
  firstUsableProviderId,
  isLocalService,
  providerModelIds,
  providersByReadiness,
} from '../lib/provider-health.ts'
import { type StyleVars, stagger } from '../lib/stagger.ts'
import { toast } from '../lib/toast.ts'
import { ALL_TOOLS, toolLabel } from '../lib/tool-labels.ts'
import {
  fetchPiperInstallStatus,
  fetchVoiceCatalog,
  localSystemVoiceNames,
  refreshVoiceCatalog,
  startPiperInstall,
  useVoicePlayback,
  type VoiceCatalog,
  type VoiceEngineInfo,
  type VoiceInstallStatus,
  type VoicePlayer,
  type VoiceProfile,
  voicePlayerFor,
} from '../lib/voice.ts'
import { AsyncState } from './AsyncState.tsx'
import { Avatar } from './avatars/Avatar.tsx'
import { Avatar3D } from './avatars/Avatar3D.tsx'
import { AVATAR_STYLE_BY_KEY, AVATAR_STYLES, BRAND_AVATAR, dicebearSvg, randomAvatarSpec } from './avatars/avatars.tsx'
import { Cat } from './Cat.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { ContactCard, type ContactCardHandlers } from './ContactCard.tsx'
import { GroupSettingsModal } from './GroupSettingsModal.tsx'
import { Icon, type IconName } from './Icon.tsx'
import { Modal } from './Modal.tsx'
import { Select, type SelectOption } from './Select.tsx'
import { ContactSkeleton } from './Skeleton.tsx'

/**
 * 选择器里每一格的脸：40px，刻意小于模板卡的 44px。
 *
 * 首屏上同一张脸要出现三次（身份卡的结果、模板轨的选项、这里的控件），三次都得在，
 * 但它们不是同一种东西：只有结果那张该被看见。40 < 44 < 88 的严格层级 + 只给结果卡
 * 光晕与投影（格子不带投影）让眼睛第一眼落在身份卡上，控件那一排读起来是工具而不是
 * 又一个主角。
 */
const FACE_SIZE = 40

/** 选择器缩略图统一裁成 44px 圆：DiceBear 母版是方形，品牌橘猫是圆形底板。 */
const cellStyle: CSSProperties = {
  width: FACE_SIZE,
  height: FACE_SIZE,
  display: 'inline-flex',
  borderRadius: '50%',
  overflow: 'hidden',
}

/** 品牌橘猫在选择器里的显示名（随选项走，不能散落在 JSX 里）。 */
const BRAND_AVATAR_NAME = '橘猫'

/** 选择器里的一张候选项：品牌橘猫 / 立绘 / DiceBear 风格同表排列。 */
interface FaceOption {
  /** agent.avatar 的取值（风格项是 `db:{styleKey}:{当前 seed}`）。 */
  key: string
  label: string
  hint: string
  /** 有值 = DiceBear 风格格（走本地生成 SVG），无值 = 走 <Avatar>（品牌与立绘）。 */
  styleKey?: string
}

/** 分区小标题：图标 + 层次名 + 一句「为什么值得动它」，右侧可以挂一个动作。 */
function SectionTitle({
  icon,
  title,
  hint,
  action,
}: {
  icon: IconName
  title: string
  hint: string
  action?: ReactNode
}) {
  return (
    <div className="studio-section-head">
      <span className="studio-section-icon">
        <Icon name={icon} size={16} />
      </span>
      <span className="studio-section-text">
        <strong>{title}</strong>
        <small>{hint}</small>
      </span>
      {action}
    </div>
  )
}

/**
 * 模板的定位行：描述里重复的「名字：」前缀去掉——卡片上标题已经写着那位助理的名字，
 * 两行一模一样等于把最贵的一行位置浪费在复读上。
 */
function templatePitch(template: AgentTemplate): string {
  const prefix = `${template.name}：`
  return template.description.startsWith(prefix) ? template.description.slice(prefix.length) : template.description
}

/**
 * 模板选择：横向卡片而不是下拉。
 *
 * 下拉把「有哪几位助理、每位什么定位」全藏进点开才可见的黑盒，而这恰恰是新建
 * 流程里唯一需要用户做的判断。切模板会连带换掉立绘、性格与工具（pickTemplate），
 * 所以卡片上写的就是切过去之后会得到什么。
 */
function TemplatePicker({
  templates,
  value,
  onPick,
}: {
  templates: AgentTemplate[]
  value: string
  onPick: (key: string) => void
}) {
  return (
    <div className="template-rail studio-templates" role="radiogroup" aria-label="从模板开始">
      {templates.map((template, index) => {
        const selected = template.key === value
        return (
          // biome-ignore lint/a11y/useSemanticElements: 卡片式单选，原生 radio 样式无法满足设计
          <button
            key={template.key}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`template-pick${selected ? ' is-selected' : ''}`}
            style={stagger(index)}
            onClick={() => {
              onPick(template.key)
            }}
          >
            <span className="template-pick-face">
              <Avatar3D avatarKey={template.avatar} name={template.name} size={44} tilt />
            </span>
            <span className="template-pick-text">
              <strong>{template.name}</strong>
              <small>{templatePitch(template)}</small>
            </span>
            {selected && <Icon name="check" size={16} className="template-pick-check" />}
          </button>
        )
      })}
    </div>
  )
}

/**
 * 身份卡：整个新建流程的结果预览，滚动时吸在右栏不动。
 *
 * 改名字、换头像、拖滑杆、点模板，改的都是这一张卡。用户要的不是填完一张表，
 * 而是看着一位助理在自己手里成形——这是这个产品与表单后台的全部差别。
 */
function IdentityCard({
  name,
  fallbackName,
  avatarKey,
  persona,
  voiceName,
}: {
  /** 输入框原值（这里自己 trim：用户刚敲下的空格不该让卡片闪一下）。 */
  name: string
  /** 没起名时先顶着模板名，占位态压暗。 */
  fallbackName: string
  avatarKey: string
  persona: AgentPersona
  /** 音色显示名（目录由服务端给，渲染层不抄 id 清单）；不朗读时为 undefined。 */
  voiceName?: string
}) {
  const named = name.trim().length > 0
  const displayName = named ? name.trim() : fallbackName
  const voice = persona.voiceId === NO_VOICE_ID ? undefined : voiceName
  return (
    <aside className="agent-card" aria-label="助理卡">
      <span className="agent-card-face">
        <Avatar3D avatarKey={avatarKey} name={displayName} size={88} tilt action="breathing" />
      </span>
      <span className="agent-card-body">
        <span className={`agent-card-name${named ? '' : ' is-placeholder'}`}>{displayName}</span>
        {persona.catchphrase.length > 0 ? (
          <span className="agent-card-catch">「{persona.catchphrase}」</span>
        ) : (
          <span className="agent-card-catch is-empty">还没口头禅</span>
        )}
        <span className="agent-card-traits">{personaSummary(persona)}</span>
        <span className="agent-card-tags">
          {persona.birthday !== undefined && (
            <span className="agent-card-tag">
              <Icon name="calendar-days" size={16} />
              {persona.birthday}
            </span>
          )}
          {voice !== undefined && (
            <span className="agent-card-tag">
              <Icon name="chat-bubble" size={16} />
              {voice}
            </span>
          )}
        </span>
      </span>
    </aside>
  )
}

/**
 * 这一屏列出哪一族 DiceBear 风格：吉祥物。
 *
 * 「人物」是扁平插画人像，和品牌橘猫、柴犬灰狐这类动物立绘、彩色表情脸同屏就是三套
 * 画风混排——avatars.tsx 顶部写着「同屏不再黑白线稿与彩色卡通混排」，选择器当时漏了。
 * 移出的是**这一屏的选择**，不是渲染：库里已有的 db:dylan:* 旧值照旧由 {@link Avatar}
 * 正常画出来（见 {@link unlistedFaceNote}），不会退化成首字母色块。
 */
const LISTED_STYLE_KEY = 'mascot'

/** 当前头像是不是这一屏列得出的那几张（品牌橘猫 / 动物立绘 / 列出的 DiceBear 族）。 */
function isListedFace(value: string): boolean {
  if (value === BRAND_AVATAR || isPortraitKey(value)) return true
  return new RegExp(`^db:${LISTED_STYLE_KEY}:`).test(value)
}

/**
 * 这一屏列不出的旧值（人像插画族，以及早于在册风格的 db:lorelei:*）要说清它没坏。
 *
 * 静默空着会读成「这张脸丢了」——用户会以为是自己刚才点坏了什么。
 */
function unlistedFaceNote(value: string): string | undefined {
  if (isListedFace(value)) return undefined
  // 只认在册风格的名字：把 "lorelei" 这种早于在册的值当风格名念给用户听，正是这条
  // 文案最初要治的毛病（橘猫曾被念成「lorelei」）。
  const name = /^db:([a-zA-Z]+):/.exec(value)?.[1]
  const styleName = name === undefined ? undefined : AVATAR_STYLE_BY_KEY[name]?.name
  return styleName === undefined
    ? '这张头像不在下面的候选里（库里早于在册风格的旧值）。点任意一张就换掉它。'
    : `当前是「${styleName}」插画族的旧头像，照常显示着。这一屏只列动物立绘与吉祥物，点一张就换掉它。`
}

/**
 * 头像选择器：品牌橘猫 + 动物立绘 + DiceBear「吉祥物」一族的 radiogroup。
 *
 * 这一排格子小、密度高，反馈必须比通用按钮更重（选中环 + 抬升，见 styles-product.css
 * 的 .face-cell）：否则用户在两排小圆图里根本分不清自己挑的是哪一张。刻意不放大件：
 * 头像是控件，结果那张脸由右栏身份卡担任（见 IdentityCard），同一张脸在一屏里出现三次
 * 就分不出主次了。
 *
 * **键盘可达性**：ARIA 的 radiogroup 规范要求方向键在组内移动选择。此前这排格子
 * 只有 `role="radio"`，没有 roving tabindex，于是键盘用户只能一路 Tab 过去，
 * ←→↑↓ 完全无效——六枚格子按六次 Tab 才能换一张脸。现在：
 * - 组内恰好一枚 `tabIndex=0`（当前选中项），其余 `tabIndex=-1`；
 * - ←→ 在同一行内左右移动，↑↓ 跨行移动（栅格是二维的，行宽由 CSS 决定，
 *   所以「是否同一行」要在运行时量，见 sameRow）；
 * - Home/End 跳到首/末；
 * - 移动焦点即选中（radiogroup 的标准行为）。
 */
export function AvatarPicker({
  value,
  onChange,
}: {
  /** `db:{style}:{seed}` 或 {@link BRAND_AVATAR}。 */
  value: string
  onChange: (spec: string) => void
}) {
  const current = parsePickerValue(value)
  const options: FaceOption[] = [
    // 品牌橘猫排在首位：它是 RyHarness 自己的脸，也是随机「换一批」的常客。
    { key: BRAND_AVATAR, label: BRAND_AVATAR_NAME, hint: `${BRAND_AVATAR_NAME}（RyHarness 品牌）` },
    // 立绘族：与品牌橘猫同一画布，用户在同一个选择器里挑「长相」。
    // cat 不在这个循环里——它由上面那块品牌位图承担（有分档位图与 srcset）。
    ...PORTRAITS.filter((portrait) => {
      return portrait.key !== 'cat'
    }).map((portrait) => {
      return { key: portrait.key, label: portrait.label, hint: portrait.hint }
    }),
    // DiceBear 只留吉祥物：当前头像也是这一族时沿用它的 seed（换画法不换脸），
    // 否则用 parsePickerValue 的兜底种子——那张格子的脸只是个示例。
    ...AVATAR_STYLES.filter((style) => {
      return style.key === LISTED_STYLE_KEY
    }).map((style) => {
      return {
        key: `db:${style.key}:${current.seed}`,
        label: style.name,
        // 提示里写清这一族画的是什么：Fun Emoji 出的是彩色表情脸，不是动物。
        // 用户按「我要一只猫」的心智去点它，点了发现是张笑脸就是选择器在骗人。
        hint: `${style.name}：随机生成的彩色表情脸（${style.license === 'CC0-1.0' ? 'CC0 公有领域' : 'CC BY 4.0'}）`,
        styleKey: style.key,
      }
    }),
  ]
  const note = unlistedFaceNote(value)
  // 当前选中项的下标：roving tabindex 的锚点。没有选中项时落在第一格。
  const selectedIndex = options.findIndex((option) => {
    return option.key === value
  })
  const [focusIndex, setFocusIndex] = useState(selectedIndex >= 0 ? selectedIndex : 0)
  const cellRefs = useRef<(HTMLButtonElement | null)[]>([])
  // 换了一组选项（头像值变了导致 DiceBear 那格的 key 变了）时把焦点锚点收回选中项。
  useEffect(() => {
    setFocusIndex(selectedIndex >= 0 ? selectedIndex : 0)
  }, [selectedIndex])

  /**
   * 方向键移动。栅格的行宽由 CSS 决定（auto-fill + minmax），运行时才知道，
   * 所以「同一行」靠量两格的 clientTop 是否相同来判断。
   */
  const moveFocus = (from: number, delta: number): void => {
    if (options.length === 0) return
    const next = Math.max(0, Math.min(options.length - 1, from + delta))
    const node = cellRefs.current[next]
    const currentNode = cellRefs.current[from]
    // 跨行时要落到「同一列」的那一格，而不是简单的 +N。
    if (currentNode !== undefined && currentNode !== null && node !== undefined && node !== null) {
      const sameLine = node.getBoundingClientRect().top === currentNode.getBoundingClientRect().top
      if (!sameLine) {
        // 先量出这一行有几格，再算出目标行里同列的那一格。
        const tops = cellRefs.current
          .map((cell) => {
            return cell === undefined || cell === null ? undefined : cell.getBoundingClientRect().top
          })
          .filter((top): top is number => {
            return top !== undefined
          })
        const rowStart = tops.findIndex((top) => {
          return Math.abs(top - currentNode.getBoundingClientRect().top) < 1
        })
        let rowLen = 0
        for (let i = rowStart; i < tops.length; i++) {
          if (Math.abs((tops[i] as number) - currentNode.getBoundingClientRect().top) >= 1) break
          rowLen++
        }
        const column = from - rowStart
        const target = rowStart + Math.max(0, rowLen) * (delta > 0 ? 1 : -1) + column
        const clamped = Math.max(0, Math.min(options.length - 1, target))
        setFocusIndex(clamped)
        onChange(options[clamped]?.key ?? value)
        cellRefs.current[clamped]?.focus()
        return
      }
    }
    setFocusIndex(next)
    onChange(options[next]?.key ?? value)
    cellRefs.current[next]?.focus()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault()
        moveFocus(index, 1)
        break
      case 'ArrowLeft':
        event.preventDefault()
        moveFocus(index, -1)
        break
      case 'ArrowDown':
        event.preventDefault()
        moveFocus(index, 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        moveFocus(index, -1)
        break
      case 'Home':
        event.preventDefault()
        setFocusIndex(0)
        onChange(options[0]?.key ?? value)
        cellRefs.current[0]?.focus()
        break
      case 'End':
        event.preventDefault()
        {
          const last = options.length - 1
          setFocusIndex(last)
          onChange(options[last]?.key ?? value)
          cellRefs.current[last]?.focus()
        }
        break
      default:
        break
    }
  }

  return (
    <div className="face-picker">
      <div className="face-grid" role="radiogroup" aria-label="选择头像">
        {options.map((option, index) => {
          // 选中判定就是「当前值等于这一格的值」：风格格的 key 带着 seed（seed 取自当前
          // 值），所以同一族的同一颗骰子会选中，而别族/别 seed 的旧值自然一格都不选中。
          const selected = value === option.key
          const placeholder = isPortraitKey(option.key) && portraitOf(option.key)?.visualSpec.placeholder === true
          const art =
            option.styleKey === undefined ? (
              <Avatar avatarKey={option.key} name={option.label} size={FACE_SIZE} />
            ) : (
              <span
                style={cellStyle}
                // biome-ignore lint/security/noDangerouslySetInnerHtml: 头像预览为本地生成的 SVG，无外部输入
                dangerouslySetInnerHTML={{
                  __html: (dicebearSvg(option.styleKey, current.seed) ?? '').replace(
                    '<svg',
                    `<svg width="${FACE_SIZE}" height="${FACE_SIZE}"`,
                  ),
                }}
              />
            )
          return (
            // biome-ignore lint/a11y/useSemanticElements: 卡片式单选，原生 radio 样式无法满足设计
            <button
              key={option.key}
              ref={(node) => {
                cellRefs.current[index] = node
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              // roving tabindex：组内只有一枚可 Tab 到达，其余用方向键走。
              tabIndex={index === focusIndex ? 0 : -1}
              // 人设说明：此前只挂在 title 上，hover 才可见、读屏不播。
              // 这里给它一个可被读屏器取到的元素，title 留着做 hover 气泡。
              aria-describedby={`face-hint-${option.key}`}
              className={`face-cell${selected ? ' is-selected' : ''}${placeholder ? ' is-placeholder' : ''}`}
              title={option.hint}
              onClick={() => {
                setFocusIndex(index)
                onChange(option.key)
              }}
              onFocus={() => {
                setFocusIndex(index)
              }}
              onKeyDown={(event) => {
                onKeyDown(event, index)
              }}
            >
              <span className="face-cell-art" style={cellStyle}>
                {art}
              </span>
              <small>{option.label}</small>
              {placeholder && <span className="face-cell-tag">占位</span>}
              {/* 视觉隐藏的人设说明：读屏器会念它，屏幕上不占位。 */}
              <span id={`face-hint-${option.key}`} className="sr-only">
                {option.hint}
              </span>
            </button>
          )
        })}
      </div>
      {note !== undefined && <p className="provider-note">{note}</p>}
    </div>
  )
}

/**
 * 「换一批」掷出来的头像。
 *
 * 随机源仍是 randomAvatarSpec（品牌橘猫 1/8，其余按 AVATAR_STYLES 掷族），但它可能掷到
 * 这一屏没列的族——换出来一张用户既选不到、也看不出属于哪一类的脸。这里只把族换算成
 * 列出的那一个，种子与品牌概率都沿用原实现，不在这里另抄一份。
 */
function randomFaceSpec(): string {
  const spec = randomAvatarSpec()
  if (spec === BRAND_AVATAR || isListedFace(spec)) return spec
  return `db:${LISTED_STYLE_KEY}:${parsePickerValue(spec).seed}`
}

/**
 * 把 agent.avatar 拆成选择器的 (风格, seed)。
 *
 * 品牌橘猫与一切不认识的值都落到首个在册风格：兜底早先硬编码 'lorelei'——一个
 * 早已从 AVATAR_STYLES 收敛掉、界面上根本不存在的风格，于是橘猫被选中时预览退化
 * 成首字母色块，标签还把 "lorelei" 当成风格名念给用户听。
 */
function parsePickerValue(value: string): { styleKey: string; seed: string } {
  const match = /^db:([a-zA-Z]+):(.+)$/.exec(value)
  const styleKey = match?.[1]
  const seed = match?.[2]
  if (styleKey !== undefined && seed !== undefined && AVATAR_STYLE_BY_KEY[styleKey] !== undefined) {
    return { styleKey, seed }
  }
  return { styleKey: AVATAR_STYLES[0]!.key, seed: seed ?? randomSeed() }
}

function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** 通讯录：agent 卡片网格（Ryen 置顶）+ 新建/建群入口。 */
export function ContactsPage({
  agents,
  templates,
  loading,
  error,
  errorDetail,
  onRetry,
  onChat,
  onCreateAgent,
  onEditAgent,
  onDeleteAgent,
  onCreateGroup,
}: {
  agents: AgentDef[]
  templates: AgentTemplate[]
  /** 首份数据是否还在路上：加载期画联系人卡骨架，别把「加载中」说成「通讯录还是空的」。 */
  loading?: boolean
  /**
   * 助理清单没读出来（人话）。
   *
   * 此前这一项失败只留一句 toast，页面显示的是「还没有助理」——用户以为是自己没建人，
   * 实际是接口没读到。这两件事必须分开说。
   */
  error?: string | undefined
  /** 原始报错：折在「详情」里，排障用。 */
  errorDetail?: string | undefined
  /** 重试一次（失败态给的那枚按钮）。 */
  onRetry?: (() => void) | undefined
  onChat: (agentId: string) => void
  /** 传入模板 key 时以该模板为初始值新建（此前恒为第一个模板，等于假按钮）。 */
  onCreateAgent: (templateKey?: string) => void
  onEditAgent: (agent: AgentDef) => void
  onDeleteAgent: (agent: AgentDef) => void
  onCreateGroup: () => void
}) {
  const sorted = [...agents].sort((a, b) => {
    if (a.id === 'ryen') return -1
    if (b.id === 'ryen') return 1
    return a.name.localeCompare(b.name)
  })
  /**
   * 试听用的播放器：按 API 地址共享的单例（队列与「正在播哪一个」必须是全局状态，
   * 卡片各自 new 一个会同时开口）。
   *
   * 它创建时要读 window 里的 API 地址，所以无 DOM 的环境（单测的静态渲染）拿不到
   * ——就地跳过，卡片上的试听随之不可用，而不是让整页在渲染期就炸。
   */
  const voicePlayer = useMemo(() => {
    try {
      return voicePlayerFor()
    } catch {
      return undefined
    }
  }, [])
  const voicePlayback = useVoicePlayback(voicePlayer)
  /**
   * 点击回调装进一个稳定的 ref。
   *
   * 卡片是 memo 组件，props 全是稳定引用时才会跳过重画。父级每次渲染都重建
   * `onChat` / `onEditAgent` / `onDeleteAgent`，直接当 props 传下去的话浅比较永远
   * 不成立——点一下「试听」，语音状态一变，三十张卡就一起重画一遍。
   */
  const handlers = useRef<ContactCardHandlers['current']>({ onChat, onEditAgent, onDeleteAgent })
  handlers.current = { onChat, onEditAgent, onDeleteAgent }
  /** 正在出声的那张卡片（key 形如 agent-voice-<id>）。 */
  const speakingAgentId =
    voicePlayback.status === 'speaking' && voicePlayback.key?.startsWith('agent-voice-') === true
      ? voicePlayback.key.slice('agent-voice-'.length)
      : undefined
  return (
    <section className="page contacts-page">
      <header className="page-header">
        <h2>通讯录</h2>
        <div className="page-actions">
          <button type="button" className="btn" onClick={onCreateGroup}>
            <Icon name="group" size={16} /> 建群
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              onCreateAgent()
            }}
          >
            <Icon name="plus" size={16} /> 新建 Agent
          </button>
        </div>
      </header>
      <div className="page-scroll">
        <div className="page-scroll-col">
          <AsyncState
            loading={loading === true}
            skeleton={<ContactSkeleton />}
            error={error}
            detail={errorDetail}
            {...(onRetry === undefined ? {} : { onRetry })}
            empty={sorted.length === 0}
            emptyView={
              <div className="empty-state contacts-empty">
                <span className="empty-cat">
                  {/* 空态插画：徽标是装饰，「正在思考」由 ChatView 的 TypingDots 承担。
                      通讯录为空时并没有谁在思考，此前那个 thinking 三态是矢量猫时代的
                      遗留语义，位图徽标没有可换的眼形。 */}
                  <Cat size={88} />
                </span>
                <h3>还没有助理</h3>
                <p>先建一位吧：挑个头像、定个脾气，建完就能直接开聊。</p>
                {/* 这一屏此前只有一句话，没有能点的地方——用户得自己抬头去找页头那个
                    「新建 Agent」。空态是最该给按钮的地方。 */}
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    onCreateAgent()
                  }}
                >
                  <Icon name="plus" size={16} /> 新建 Agent
                </button>
              </div>
            }
          >
            <>
              <p className="section-title">我的 Agent（{sorted.length}）</p>
              <div className="contact-grid">
                <button
                  type="button"
                  className="contact-card contact-create"
                  style={stagger(0)}
                  onClick={() => {
                    onCreateAgent()
                  }}
                >
                  <span className="contact-create-icon">
                    <Icon name="plus" size={24} />
                  </span>
                  <h3>新建 Agent</h3>
                  <p className="contact-prompt">从模板开始，挑头像、定脾气</p>
                </button>
                {sorted.map((agent, index) => {
                  return (
                    <ContactCard
                      key={agent.id}
                      agent={agent}
                      index={index}
                      speaking={speakingAgentId === agent.id}
                      voicePlayer={voicePlayer}
                      handlers={handlers}
                    />
                  )
                })}
              </div>
              <p className="section-title" style={{ marginTop: 24 }}>
                可用模板（{templates.length}）
              </p>
              <p className="contacts-hint">点一个模板，就按它的样子建一位：名字、头像、性格都会一起带过来。</p>
              <div className="template-rail">
                {templates.map((template, index) => (
                  <button
                    type="button"
                    key={template.key}
                    className="template-card"
                    style={stagger(index)}
                    onClick={() => {
                      onCreateAgent(template.key)
                    }}
                  >
                    <strong>{template.name}</strong>
                    <span>{template.description}</span>
                  </button>
                ))}
              </div>
            </>
          </AsyncState>
        </div>
      </div>
    </section>
  )
}

/** 需要单独告知的工具：勾上它等于把这台机器的一部分交给 agent。 */
const RISKY_TOOL = 'shell_exec'

/** 勾上执行命令时的一次性风险说明（只告知，不做审批流）。 */
const RISKY_TOOL_HINT = '执行命令能在你这台电脑上直接跑 shell：改文件、装东西、删东西都做得到。只在任务来源可信时勾选。'

/**
 * 模型下拉下方那句话：解释「上下文未知」是什么，以及能去哪里补。
 *
 * 端点不报上下文长度是常态（OpenAI 兼容的 `/v1/models` 一般只回 id），照实说清
 * 这一点，比让那一列安静地空着强——空着用户会以为是界面坏了。
 */
const MODEL_HINT = '厂家没标的就显示「未知」。要补，去「我的 → 模型供应商」。'

/**
 * 思考强度的档位名。刻意只给三档：低 / 中 / 高。
 *
 * 各家的完整枚举差得很远且变得很快（MiniMax M3.1 有 xhigh、GLM-5.2 有 minimal、
 * OpenAI 的 GPT-6.1 干脆不给 none），逐一登记要每季度跟一次公告，而多出来的档位对
 * 绝大多数用户没有可感知的差别。取各家都接受的交集，少几个选项换来零 400。
 */
const EFFORT_LABEL: Readonly<Record<string, string>> = { low: '低（快）', medium: '中', high: '高（慢，想得久）' }

const REASONING_HINT = '想得越久越准，但更慢也更贵。不选就用模型自己的默认值。'

/** 字节数 → 一句人话（下载进度用；精度只到 0.1 MB）。 */
function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || bytes <= 0) return undefined
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`
}

/** 下拉里对不可用引擎的短标注：用户要一眼知道差哪一步。 */
function engineAvailabilityLabel(engine: VoiceEngineInfo): string {
  if (engine.id === 'piper') return '需要先下载'
  if (engine.id === 'siliconflow') return '未配置 Key'
  return '不可用'
}

/** 引擎不可用时那一行解释 + 可操作入口。 */
function unavailableReason(engine: VoiceEngineInfo | undefined): string {
  if (engine === undefined) return '这个音色所属的引擎当前不可用'
  return engine.reason ?? `「${engine.name}」当前不可用`
}

/**
 * 离线语音包安装卡。
 *
 * 只在用户选中了 piper 音色、而引擎还没装好时出现。它做三件事：说清差什么、
 * 启动下载、轮询到 ready 后刷新目录（于是下拉里的「需要先下载」当场消失）。
 * 轮询放在组件内而不是父级，是因为下载可能持续几分钟，失败/重试不该把整张
 * 助理编辑器重挂一遍。
 */
function PiperInstallCard({ base, onInstalled }: { base: string; onInstalled: (catalog: VoiceCatalog) => void }) {
  const [status, setStatus] = useState<VoiceInstallStatus | undefined>(undefined)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  /** 回调放进 ref：父级每次渲染都会换一个函数，不该因此重置轮询。 */
  const installedRef = useRef(onInstalled)
  installedRef.current = onInstalled

  useEffect(() => {
    let alive = true
    void fetchPiperInstallStatus(base)
      .then((next) => {
        if (!alive) return
        setStatus(next)
        setProblem(undefined)
      })
      .catch((error: unknown) => {
        if (!alive) return
        setProblem(humanError(error, '离线语音包的状态没读出来，重试看看'))
      })
    return () => {
      alive = false
    }
  }, [base])

  // 只在 downloading 时轮询；ready/error/absent 停下，避免空转。
  useEffect(() => {
    if (status?.state !== 'downloading') return
    let alive = true
    const timer = setInterval(() => {
      void fetchPiperInstallStatus(base)
        .then(async (next) => {
          if (!alive) return
          setStatus(next)
          setProblem(undefined)
          if (next.state !== 'ready') return
          const catalog = await refreshVoiceCatalog(base)
          if (alive) installedRef.current(catalog)
        })
        .catch((error: unknown) => {
          if (alive) setProblem(humanError(error, '离线语音包的状态没读出来，重试看看'))
        })
    }, 1_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [base, status?.state])

  const beginInstall = (): void => {
    setBusy(true)
    setProblem(undefined)
    void startPiperInstall(base)
      .then((next) => {
        setStatus(next)
      })
      .catch((error: unknown) => {
        setProblem(humanError(error, '离线语音包没开始下载，先确认网络'))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const received = formatBytes(status?.receivedBytes)
  const total = formatBytes(status?.totalBytes)
  const percent =
    status?.receivedBytes !== undefined && status.totalBytes !== undefined && status.totalBytes > 0
      ? Math.min(100, Math.round((status.receivedBytes / status.totalBytes) * 100))
      : undefined
  const downloadable = status?.state === 'absent' || status?.state === 'error'
  return (
    <fieldset className="voice-install-card" aria-label="离线语音包安装">
      <div className="voice-install-row">
        <span className="voice-install-title">
          {status === undefined && '正在检查离线语音包…'}
          {status?.state === 'absent' && '离线语音包还没下载（约 85 MB，一次下载永久可用）。'}
          {status?.state === 'downloading' &&
            `正在下载${received === undefined ? '' : ` ${received}`}${total === undefined ? '' : ` / ${total}`}`}
          {status?.state === 'ready' && '离线语音包已就绪。'}
          {/* 离线语音包进程的失败原因由 piper 插件给（可能是 spawn ENOENT 这类系统原话），
              同样经人话层出口；title 上留原文。 */}
          {status?.state === 'error' && (
            <span title={status.error}>上次安装失败：{humanError(status.error, '这次没装上，再点一次重试')}</span>
          )}
          {status?.state === 'unsupported' && (
            <span title={status.error}>{humanError(status.error, '当前平台不支持离线语音包。')}</span>
          )}
        </span>
        {downloadable && (
          <button type="button" className="btn btn-mini" disabled={busy} onClick={beginInstall}>
            <Icon name="arrow-up" size={16} />
            {status?.state === 'error' ? '重试' : '下载离线语音包'}
          </button>
        )}
      </div>
      {status?.state === 'downloading' && (
        <div
          className="voice-install-progress"
          role="progressbar"
          aria-label="离线语音包下载进度"
          {...(percent === undefined ? {} : { 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 })}
        >
          <span style={{ width: `${percent ?? 8}%` }} />
        </div>
      )}
      {problem !== undefined && <small className="provider-note provider-warn">{problem}</small>}
    </fieldset>
  )
}

/**
 * 性格卡：四维各一行 + 生日 / 口头禅 / 形象 / 音色，末尾是只读的最终提示预览。
 *
 * 每行三段：维度名与分值、尺子（两端是最低/最高档的名，拖到哪头看得出倾向）、
 * 当前档位与它的行为描述。描述随滑杆实时改写，用户不必去看预览区才知道改了没有。
 *
 * 预览直接调 composePersonaPrompt、零加工：用户看到的必须逐字等于内核真正拼给模型的那段
 * （见 lib/persona.ts 的 parity 说明），否则"看得见因果"就成了假的因果。
 */
function PersonaEditor({
  persona,
  basePrompt,
  voiceProfiles,
  voiceEngines,
  voiceCatalogError,
  voicePreviewSpeaking,
  apiBase,
  onPreviewVoice,
  onOpenProviderSettings,
  onCatalogChange,
  onChange,
}: {
  persona: AgentPersona
  /** 人格段接在它后面（系统提示的顺序是：补充说明 → 〔人格〕）。 */
  basePrompt: string
  /** 音色目录（/api/voice/catalog）；没拿到时下拉只剩「不朗读」与当前旧值。 */
  voiceProfiles: readonly VoiceProfile[]
  voiceEngines: VoiceCatalog['engines']
  voiceCatalogError?: string
  /** 试听正在播（按钮变成停止）。 */
  voicePreviewSpeaking: boolean
  /** 有它才能启动/轮询离线语音包安装。 */
  apiBase?: string
  onPreviewVoice: () => void
  /** 「配置云端音色」的去处；缺省时只显示说明，不摆一个点了没反应的按钮。 */
  onOpenProviderSettings?: () => void
  /** 安装完成后把新目录交回父级（下拉当场从「需要先下载」变回可选）。 */
  onCatalogChange?: (catalog: VoiceCatalog) => void
  onChange: (next: AgentPersona) => void
}) {
  const selectedVoice = voiceProfiles.find((profile) => {
    return profile.id === persona.voiceId
  })
  const selectedEngine = voiceEngines.find((engine) => {
    return engine.id === selectedVoice?.engine
  })
  const voiceAvailable = selectedVoice === undefined || selectedEngine?.available !== false
  const needsPiperInstall = selectedVoice?.engine === 'piper' && !voiceAvailable
  const needsCloudKey = selectedVoice?.engine === 'siliconflow' && !voiceAvailable
  const knownVoice = persona.voiceId === NO_VOICE_ID || selectedVoice !== undefined

  /**
   * 本机真实有的系统音色名（`undefined` = 还没读到；`[]` = 读到了，本机一条都没有）。
   *
   * 系统音色能不能用，取决于这台机器装了哪些 Windows 语音包——目录里列的四条
   * 在没装对应语言包的机器上**全都念不出来**（四条一起回退到同一条，用户听着
   * 就是"一种声音"）。所以下拉里要把"本机没装"标出来，而不是让人白选一次。
   */
  const [localVoices, setLocalVoices] = useState<string[] | undefined>(undefined)
  useEffect(() => {
    const read = (): void => {
      setLocalVoices(localSystemVoiceNames())
    }
    read()
    if (typeof window === 'undefined' || window.speechSynthesis === undefined) return
    window.speechSynthesis.addEventListener('voiceschanged', read)
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', read)
    }
  }, [])
  /** 这条系统音色在本机有没有。读到列表之前一律当有（别先标错再改）。 */
  const localVoiceAvailable = (profile: VoiceProfile): boolean => {
    if (profile.engine !== 'system') return true
    if (localVoices === undefined) return true
    return localVoices.some((name) => {
      return name === profile.voice || name.startsWith(profile.voice)
    })
  }
  /**
   * 音色下拉的选项（原生 `<optgroup>` 的等价物：按引擎分组的小标题）。
   * 不可用的引擎不隐藏：用户要看得见「有这一条」，还要知道差哪一步。
   */
  const voiceOptions: SelectOption[] = [
    { value: NO_VOICE_ID, label: '不朗读' },
    // 旧库里的 id 可能不在目录里：如实列出来，别让下拉静默落到第一项。
    // 原始 id 收进 title——它是排障线索，不是用户要读的音色名。
    ...(knownVoice ? [] : [{ value: persona.voiceId, label: '已下架的旧音色', title: persona.voiceId }]),
    ...voiceEngines.flatMap((engine) => {
      const profiles = voiceProfiles.filter((profile) => {
        return profile.engine === engine.id
      })
      if (profiles.length === 0) return []
      return profiles.map((profile) => {
        // 三种"不可用"要分开说：引擎没就绪（差一步就能用）、本机没装这条系统音色
        // （装了才有）、引擎可用。
        const engineLabel = engine.available ? undefined : engineAvailabilityLabel(engine)
        const missingHere = localVoiceAvailable(profile) ? undefined : '本机没装'
        const suffix = engineLabel ?? missingHere
        return {
          value: profile.id,
          group: engine.available ? engine.name : `${engine.name}（${engineAvailabilityLabel(engine)}）`,
          label: suffix === undefined ? profile.name : `${profile.name}（${suffix}）`,
          ...(missingHere === undefined ? {} : { title: '这台机器没装对应的 Windows 语音包，点了会用系统默认音色' }),
        }
      })
    }),
  ]
  return (
    <div className="persona-card">
      <div className="persona-traits">
        {TRAIT_META.map((meta) => {
          const score = clampTrait(persona[meta.key])
          const band = traitBand(meta, score)
          return (
            <div className="persona-trait" key={meta.key}>
              <span className="persona-trait-label">
                {meta.label}
                <span className="persona-trait-score">{score}</span>
              </span>
              <span className="persona-trait-slider">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={score}
                  aria-label={meta.label}
                  title={meta.hint}
                  // 轨道左端到当前值那一段纯 CSS 画不出来（Chromium 没有进度段伪元素），
                  // 它要的是取值：按分值覆写 --fill，轨道色自己按它切。
                  style={{ '--fill': `${score}%` } as StyleVars}
                  onChange={(e) => {
                    // input.value 是字符串，直接喂给 clampTrait 会被当成非数字归零。
                    onChange({ ...persona, [meta.key]: clampTrait(Number(e.target.value)) })
                  }}
                />
                {/* 尺子：四档的名字都摆出来，当前那一档点亮。
                    此前只标了两端（「安静」和「自来熟」），中间两档看得见却叫不出名字，
                    拖到 60 分时不知道那算「适中」还是「外向」。档位名直接从分档表里取，
                    不另抄一份，免得改了分档这里还在说旧话。 */}
                <span className="persona-trait-scale">
                  {meta.bands.map((stop) => {
                    return (
                      <span
                        key={stop.max}
                        className={`persona-trait-stop${stop.label === band.label ? ' is-current' : ''}`}
                      >
                        {stop.label}
                      </span>
                    )
                  })}
                </span>
              </span>
              <span className="persona-trait-band">
                <strong>{band.label}</strong>
                <small>{band.describe}</small>
              </span>
            </div>
          )
        })}
      </div>
      <div className="persona-fields">
        <label className="field">
          <span>生日</span>
          {/* 原生日期选择器：点开就是日历，不用手敲"03-14"这种没人记得住的格式。
              存的是 MM-DD（生日不需要年份），控件要用完整日期，所以中间过一道
              2000-01-01 的占位年。 */}
          <input
            type="date"
            value={birthdayInputValue(persona.birthday)}
            onChange={(e) => {
              const birthday = birthdayFromInput(e.target.value)
              onChange({ ...persona, birthday })
            }}
          />
        </label>
        {/* 口头禅/形象输入期不 trim：当场裁会把英文短语中间的空格吞掉（"Trust me"
            敲到空格就成了 "Trustme"）；空白的收口放到保存时做，名字字段同此口径。 */}
        <label className="field">
          <span>口头禅</span>
          <input
            value={persona.catchphrase}
            placeholder="例如：交给我吧"
            onChange={(e) => {
              onChange({ ...persona, catchphrase: e.target.value })
            }}
          />
        </label>
        <label className="field">
          <span>形象</span>
          <input
            value={persona.appearance}
            placeholder="一句话描述：长什么样、什么动物"
            onChange={(e) => {
              onChange({ ...persona, appearance: e.target.value })
            }}
          />
        </label>
        <div className="field">
          <span>音色</span>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
            {/* 长选项不再撑破这一行：触发器有 min-width: 0（长的模型名/音色名在框里省略），
                完整的名字在浮层里看——浮层按视口定位，永远不会把并排的试听键挤出字段。 */}
            <Select
              value={persona.voiceId}
              options={voiceOptions}
              ariaLabel="音色"
              searchable
              placeholder="已下架的旧音色"
              onChange={(next) => {
                onChange({ ...persona, voiceId: next })
              }}
            />
            <button
              type="button"
              className="btn btn-mini"
              style={{ flexShrink: 0 }}
              // 选「不朗读」或旧 id 时没有试听句可念：禁用并说明，而不是点下去没反应。
              disabled={selectedVoice === undefined}
              title={selectedVoice === undefined ? '先选一个可以朗读的音色' : undefined}
              onClick={onPreviewVoice}
            >
              <Icon name={voicePreviewSpeaking ? 'square' : 'volume-2'} size={16} />
              {voicePreviewSpeaking ? '停止' : '试听'}
            </button>
          </span>
          {selectedVoice !== undefined && <small className="provider-note">{selectedVoice.description}</small>}
          {/* 不可用不是一次性 toast：把「为什么」和「去哪修」留在音色行下面，
              用户下次打开编辑器仍然看得见。 */}
          {selectedVoice !== undefined && !voiceAvailable && (
            <div className="voice-unavailable" role="status">
              <span>
                {needsPiperInstall
                  ? `「${selectedVoice.name}」需要先下载离线语音包；下载前点朗读会用系统语音。`
                  : needsCloudKey
                    ? `「${selectedVoice.name}」需要 SiliconFlow API Key；未配置时朗读会用系统语音。`
                    : `${unavailableReason(selectedEngine)}；朗读会用系统语音。`}
              </span>
              {needsCloudKey && onOpenProviderSettings !== undefined && (
                <button type="button" className="btn btn-mini" onClick={onOpenProviderSettings}>
                  配置云端音色
                </button>
              )}
            </div>
          )}
          {needsPiperInstall && apiBase !== undefined && onCatalogChange !== undefined && (
            <PiperInstallCard base={apiBase} onInstalled={onCatalogChange} />
          )}
          {voiceCatalogError !== undefined && <small className="provider-note">{voiceCatalogError}</small>}
        </div>
      </div>
      <div className="field">
        <span>最终系统提示（只读预览）</span>
        <pre className="profile-prompt">{composePersonaPrompt(basePrompt, persona)}</pre>
      </div>
      <p className="provider-note">按当前性格建议的回复温度：{suggestTemperature(persona)}</p>
    </div>
  )
}

/**
 * 新建/编辑 Agent：左侧分层编辑（起点 → 身份 → 性格 → 它会做什么 → 高级设置），
 * 右栏是随任何输入实时更新的身份卡。内容区可滚动，操作条吸底。
 *
 * 供应商与模型必须成对成立：切换供应商时把 model 重置成那家的第一个模型，提交前再
 * 断言 model ∈ 该供应商的 models——此前 model 可以是模板留下的、属于别家供应商的
 * 标识，服务端照单全收，agent 建出来第一句话就 404。
 */
export function CreateAgentModal({
  templates,
  providers,
  api,
  voice,
  initialTemplateKey,
  editing,
  agents,
  onOpenProviderSettings,
  onSubmit,
  onClose,
}: {
  templates: AgentTemplate[]
  providers: ProviderInfo[]
  /** 有它才拉音色目录、才能试听；缺省时下拉只剩「不朗读」（单测的静态渲染）。 */
  api?: ApiClient
  /** 试听用的播放器（单测注入）；缺省按 API 地址取共享单例。 */
  voice?: VoicePlayer
  /** 初始模板（通讯录模板轨点进来时带 key）。 */
  initialTemplateKey?: string
  /** 非空 = 编辑既有 agent（此时模板选择隐藏，保存走 PATCH）。 */
  editing?: AgentDef
  /** 已有 Agent 名单：用来当场发现重名（服务端也会拦一道）。 */
  agents?: AgentDef[]
  /** 「配置云端音色」跳到「我的 → 供应商」；不传时只显示说明。 */
  onOpenProviderSettings?: () => void
  onSubmit: (input: Record<string, unknown>) => Promise<void>
  onClose: () => void
}) {
  const [templateKey, setTemplateKey] = useState(initialTemplateKey ?? templates[0]?.key ?? 'general')
  const template = templates.find((t) => {
    return t.key === templateKey
  })
  const [name, setName] = useState(editing?.name ?? '')
  const [avatarKey, setAvatarKey] = useState(() => {
    // 模板自带立绘时先用它：身份卡一打开就该是这位助理的脸，而不是一枚随机色块。
    return editing?.avatar ?? template?.avatar ?? randomFaceSpec()
  })
  const [systemPrompt, setSystemPrompt] = useState(editing?.systemPrompt ?? template?.suggestedSystemPrompt ?? '')
  // 人格与补充说明分开存：内核把两者拼成一段系统提示，编辑时必须分别可编辑。
  const [persona, setPersona] = useState<AgentPersona>(() => {
    return normalizePersona(editing?.persona ?? template?.persona)
  })
  // 默认供应商 = 第一个配好凭据（或免 key 的本地服务）的；否则第一个（多半是没 key 的）。
  const [provider, setProvider] = useState(
    editing?.provider ?? firstUsableProviderId(providers) ?? providers[0]?.id ?? 'siliconflow',
  )
  const [model, setModel] = useState(editing?.model ?? template?.defaultModel ?? '')
  const [reasoningEffort, setReasoningEffort] = useState(editing?.reasoningEffort ?? '')
  // 新建时默认不勾「执行命令」：模板给的默认工具里带着它，但用户从没为它点过头。
  const [tools, setTools] = useState<string[]>(() => {
    if (editing !== undefined) return editing.tools
    return (template?.defaultTools ?? []).filter((tool) => {
      return tool !== RISKY_TOOL
    })
  })
  /**
   * 权限档位：助理「能碰到什么」的那一档。
   *
   * 缺省按工具清单现状反推；用户手动改过工具后反推不出来，就落到「自定义」——
   * 硬报成某一档会骗用户。
   */
  const [permissionPreset, setPermissionPreset] = useState<string>(() => {
    return editing?.permissionPreset ?? ''
  })
  /** 档位清单（服务端出）。读不到就不给这个控件——空着比给一份抄来的强。 */
  const [presets, setPresets] = useState<PermissionPresetView[]>([])
  /**
   * 最新的工具清单（给异步回调用）。
   *
   * 档位清单是异步回来的，回调里要拿**当时**的工具清单反推档位；把它放进依赖里
   * 会让每次改工具都重拉一次清单。用 ref 读最新值，依赖保持干净。
   */
  const toolsRef = useRef<string[]>(tools)
  toolsRef.current = tools
  // 供应商 / 模型 / 工具默认折叠：它们是「这位助理归谁跑、能碰到什么」的实现层选择，
  // 不是「她是谁」。折叠态仍给一行当前值摘要，不是把选择藏起来。
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 脏表单关闭前的二次确认。 */
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  /**
   * 表单初始快照：只比「用户改了什么」，打开弹窗本身不算修改。
   * 工具按集合比（排序后），勾掉再勾回来不会误判成脏。
   */
  const initialForm = useRef<string | undefined>(undefined)
  const currentForm = JSON.stringify({
    templateKey,
    name,
    avatarKey,
    systemPrompt,
    persona,
    provider,
    model,
    tools: [...tools].sort(),
    permissionPreset,
  })
  if (initialForm.current === undefined) initialForm.current = currentForm
  const dirty = initialForm.current !== currentForm
  /** 音色目录：服务端是唯一真源（渲染层不再抄一份 id 清单）。 */
  const [voiceCatalog, setVoiceCatalog] = useState<VoiceCatalog | undefined>(undefined)
  const [voiceCatalogError, setVoiceCatalogError] = useState<string | undefined>(undefined)
  const voicePlayer = useMemo(() => {
    if (voice !== undefined) return voice
    return api === undefined ? undefined : voicePlayerFor(api.base)
  }, [api, voice])
  const voicePlayback = useVoicePlayback(voicePlayer)
  useEffect(() => {
    return () => {
      // 试听中关掉弹窗：不该让一句试听在背后继续念完。
      if (voicePlayer?.getState().key === 'voice-preview') voicePlayer.stop()
    }
  }, [voicePlayer])
  useEffect(() => {
    if (api === undefined) return
    let alive = true
    fetchVoiceCatalog(api.base)
      .then((catalog) => {
        if (!alive) return
        setVoiceCatalog(catalog)
        setVoiceCatalogError(undefined)
      })
      .catch((error: unknown) => {
        if (!alive) return
        // 目录读不到时如实说清，下拉仍可保住当前值与「不朗读」。
        setVoiceCatalogError(`音色目录没读出来：${humanError(error, '先保留当前音色，或稍后再试')}`)
      })
    return () => {
      alive = false
    }
  }, [api])
  useEffect(() => {
    if (api === undefined) return
    if (presets.length > 0) return
    // 旧服务端与测试替身可能没有这个接口：没有就���显示这个控件，别把整个表单炸掉。
    const load = api.permissionPresets
    if (typeof load !== 'function') return
    let alive = true
    // 权限档位清单：服务端出，界面不抄一份（抄了会与实际放行的工具漂）。
    load
      .call(api)
      .then((body) => {
        if (!alive) return
        // 回包形状不可信就当没有：档位清单是可选功能，缺了不该让建 agent 的表单崩。
        const list = Array.isArray(body?.presets) ? body.presets : []
        setPresets(list)
        // 没存过档位的助理，按现有工具清单反推一档；反推不出来就是「自定义」。
        setPermissionPreset((current) => {
          if (current !== '') return current
          return detectPreset(list, toolsRef.current) ?? ''
        })
      })
      .catch(() => {
        // 读不到清单就不给这个控件（下面的渲染按 presets.length 判断）。
        if (alive) setPresets([])
      })
    return () => {
      alive = false
    }
    // 清单只取一次：deps 里带上 presets.length 是为了「取到就别再取」。
  }, [api, presets.length])
  const voiceProfiles = voiceCatalog?.profiles ?? []
  const voiceEngines = voiceCatalog?.engines ?? []
  const selectedVoice = voiceProfiles.find((profile) => {
    return profile.id === persona.voiceId
  })
  const voicePreviewSpeaking = voicePlayback.status === 'speaking' && voicePlayback.key === 'voice-preview'

  /** 试听一句：正在念就停，否则用当前音色的固定试听句入队。 */
  const previewVoice = (): void => {
    if (voicePlayer === undefined || selectedVoice === undefined) return
    if (voicePreviewSpeaking) {
      voicePlayer.stop()
      return
    }
    void voicePlayer.speak({ text: selectedVoice.sampleText, profileId: selectedVoice.id, key: 'voice-preview' })
  }

  const pickTemplate = (key: string): void => {
    setTemplateKey(key)
    const next = templates.find((t) => {
      return t.key === key
    })
    if (next === undefined) return
    setSystemPrompt(next.suggestedSystemPrompt)
    setModel(next.defaultModel)
    // 换模板连人格一起换：模板自带的性格不跟着走，用户看到的"默认助理"就成了没性格的。
    setPersona(normalizePersona(next.persona))
    // 立绘也跟着换：模板挑的正是「这一位」的长相，卡片与头像两处必须同时改。
    // 模板自带的 avatar 原样用（seed.ts 里是有立绘素材的助理给 cat/dog/fox，素材还没
    // 画出来的给 mask 占位），只有兜底的那张随机脸才走「列出的一族」。
    setAvatarKey(next.avatar ?? randomFaceSpec())
    setTools(
      next.defaultTools.filter((tool) => {
        return tool !== RISKY_TOOL
      }),
    )
  }

  const current = providers.find((p) => {
    return p.id === provider
  })
  /**
   * 选模型的那一格接的是目录真源（model-catalog），不是裸的 `models` 列表：
   * 用户建 agent 时做的正是"要不要选上下文更大的那个"这个决定，而此前这个下拉
   * 只显示一个模型名，contextWindow 全库无人读。上下文长度按厂商前缀分组、已知长度
   * 排在前，未知的照实写「上下文未知」——端点没报就是没报（见 model-catalog 顶部）。
   *
   * 这里读的是服务端给的那份，也正是内核算请求预算时用的那一份：用户在设置页补录
   * 的长度会存进 providers.json，于是"下拉里显 128K"与"内核按 128K 留历史"必然同值。
   */
  const models = groupModels(catalogFromProvider(current))
  /** 没配 key 的供应商降权排后，但仍然可选：先建好 agent 再去补 key 也是条路。 */
  const orderedProviders = providersByReadiness(providers)
  const modelIds = providerModelIds(current)
  const modelValid = modelIds.includes(model)
  const modelHint =
    model.length === 0
      ? explainModelMismatch(current?.displayName ?? provider, modelIds)
      : modelValid
        ? undefined
        : explainModelMismatch(current?.displayName ?? provider, modelIds)

  /**
   * 重名提示：通讯录、群成员选择、气泡署名全都按名字认人，两个都叫「CodeBot」
   * 的 Agent 根本没法区分。编辑时排除自己（改自己的名字不算撞名）。
   */
  const nameHint = (() => {
    const wanted = name.trim().toLowerCase()
    if (wanted.length === 0) return undefined
    const clash = (agents ?? []).find((agent) => {
      return agent.id !== editing?.id && agent.name.trim().toLowerCase() === wanted
    })
    if (clash === undefined) return undefined
    return `已经有叫「${name.trim()}」的 ${clash.isBuiltin ? '内置助理' : '助理'}了，换个名字`
  })()

  /** 切供应商必须连 model 一起换：留着别家的模型标识等于建出一个永远 404 的 agent。 */
  const pickProvider = (id: string): void => {
    setProvider(id)
    const next = providers.find((p) => {
      return p.id === id
    })
    // 默认取目录里排第一的那个（已知上下文长度的在前），而不是配置里的原始顺序——
    // 列表按什么排、默认就落在哪一条上，用户才不会对着下拉猜"为什么选中的是它"。
    const groups = groupModels(catalogFromProvider(next))
    setModel(groups[0]?.models[0]?.id ?? '')
    // 换到不认思考参数的那家时把档位一并清掉：留着会在提交时被运行时拒成
    // UNSUPPORTED_REASONING_EFFORT，而用户看不出是自己没管那个下拉框。
    if (!(next?.reasoningEfforts ?? []).includes(reasoningEffort)) setReasoningEffort('')
  }

  // 档位目录跟着所选供应商走：切到不认思考参数的那家（本地 Ollama、聚合网关）时
  // 选择器整个消失，而不是留在那儿提交一个会被拒的值。
  const reasoningEfforts =
    providers.find((p) => {
      return p.id === provider
    })?.reasoningEfforts ?? []

  /** 供应商选项：没配 key 的降权排后但仍可选（先建好 agent 再去补 key 也是条路）。 */
  const providerOptions: SelectOption[] = orderedProviders.map((p) => {
    return {
      value: p.id,
      label: `${p.displayName}${p.apiKeyConfigured ? '' : isLocalService(p) ? '（本地服务）' : '（未配置 key）'}`,
    }
  })
  /**
   * 模型选项（按上下文长度分组的小标题 = 原生 `<optgroup>`）。
   * 手上这个模型不属于所选供应商时把它显式列出来：静默落空会让用户以为是自己操作错了，
   * 而不是"这个组合存不下来"。
   */
  const modelOptions: SelectOption[] = [
    ...(!modelValid && model.length > 0 ? [{ value: model, label: `${model}（不属于当前供应商）` }] : []),
    ...models.flatMap((group) => {
      return group.models.map((m) => {
        return { value: m.id, group: group.label, label: `${modelTitle(m)} — ${modelMeta(m)}` }
      })
    }),
  ]
  const effortOptions: SelectOption[] = [
    { value: '', label: '默认' },
    ...reasoningEfforts.map((effort) => {
      return { value: effort, label: EFFORT_LABEL[effort] ?? effort }
    }),
  ]

  const submit = async (): Promise<void> => {
    if (!modelValid) return
    setBusy(true)
    try {
      await onSubmit({
        ...(editing === undefined ? { templateKey } : {}),
        name: name || editing?.name || template?.name,
        avatar: avatarKey,
        systemPrompt,
        provider,
        model,
        tools,
        // 权限档位：空字符串 = 自定义（工具被手动改过，不再属于任何一档），不发这个字段。
        ...(permissionPreset === '' ? {} : { permissionPreset }),
        // 留空就是「用模型默认」，不发任何字段；发一个供应商不认的值会被运行时
        // 拒成 UNSUPPORTED_REASONING_EFFORT，整轮失败。
        ...(reasoningEffort.length === 0 ? {} : { reasoningEffort }),
        // 口头禅/形象在这里收口（输入期不 trim，见 PersonaEditor）：两端空白去掉，
        // 全空按「没填」的既有逻辑走；性格四维与音色不在裁剪之列，交给内核兜底。
        persona: {
          ...persona,
          catchphrase: persona.catchphrase.trim(),
          appearance: persona.appearance.trim(),
        },
      })
      toast.success(editing === undefined ? '助理已创建' : '修改已保存')
      onClose()
    } catch (error) {
      // 保存失败不能悄悄关窗：用户会以为已经建好。留在原地并说清原因。
      toast.error(
        `${editing === undefined ? '创建' : '保存'}失败：${humanError(error, '这位助理没能存下来，再试一次')}`,
      )
    } finally {
      setBusy(false)
    }
  }

  /** 折叠态那一行摘要：当前供应商 · 模型 · 工具数量，折叠不等于把选择藏起来。 */
  const advancedSummary = `${current?.displayName ?? providerLabel(provider)} · ${
    model.length === 0 ? '未选模型' : model.slice(model.lastIndexOf('/') + 1)
  } · ${tools.length} 个工具`

  return (
    <Modal
      title={editing === undefined ? '新建 Agent' : `编辑 ${editing.name}`}
      onClose={onClose}
      onBeforeClose={() => {
        if (!dirty) return true
        setConfirmDiscard(true)
        return false
      }}
    >
      <div className="modal-scroll">
        <div className="studio">
          <div className="studio-main">
            {editing === undefined && templates.length > 0 && (
              <section className="studio-section">
                <SectionTitle icon="users" title="挑一个起点" hint="名字、性格和工具都会一起换。" />
                <TemplatePicker templates={templates} value={templateKey} onPick={pickTemplate} />
              </section>
            )}
            <section className="studio-section">
              <SectionTitle
                icon="user"
                title="它是谁"
                hint="通讯录里最先被看见的两样：名字和脸。"
                action={
                  // 「换一批」挂在分区标题行：它原先和头像预览各占一行，而右栏身份卡
                  // 已经把这张脸放到最大的一处，这里再来一遍就是同一张脸在首屏出现三次。
                  <button
                    type="button"
                    className="btn btn-mini studio-section-action"
                    onClick={() => {
                      setAvatarKey(randomFaceSpec())
                    }}
                  >
                    <Icon name="dices" size={16} /> 换一批
                  </button>
                }
              />
              <label className="field">
                <span>名字</span>
                <input
                  value={name}
                  placeholder={editing?.name ?? template?.name ?? '给它起个名字'}
                  onChange={(e) => {
                    setName(e.target.value)
                  }}
                />
                {nameHint !== undefined && (
                  <p className="apikey-error" role="alert">
                    {nameHint}
                  </p>
                )}
              </label>
              <AvatarPicker value={avatarKey} onChange={setAvatarKey} />
            </section>
            <section className="studio-section">
              <SectionTitle icon="brain" title="它什么脾气" hint="这四维连同生日与口头禅会直接写进系统提示。" />
              <PersonaEditor
                persona={persona}
                basePrompt={systemPrompt}
                voiceProfiles={voiceProfiles}
                voiceEngines={voiceEngines}
                {...(voiceCatalogError === undefined ? {} : { voiceCatalogError })}
                voicePreviewSpeaking={voicePreviewSpeaking}
                {...(api === undefined ? {} : { apiBase: api.base })}
                onPreviewVoice={previewVoice}
                {...(onOpenProviderSettings === undefined ? {} : { onOpenProviderSettings })}
                onCatalogChange={(catalog) => {
                  setVoiceCatalog(catalog)
                  setVoiceCatalogError(undefined)
                }}
                onChange={setPersona}
              />
            </section>
            <section className="studio-section">
              <SectionTitle icon="clipboard-list" title="它会做什么" hint="性格之外还想交代的：职责、称呼、忌讳。" />
              <label className="field">
                <span>补充说明（人格之外的交代）</span>
                <textarea
                  rows={4}
                  value={systemPrompt}
                  onChange={(e) => {
                    setSystemPrompt(e.target.value)
                  }}
                />
                <small className="provider-note">这段排在性格前面。下面是它最终收到的样子。</small>
              </label>
            </section>
            <div className="advanced">
              <button
                type="button"
                className="advanced-toggle"
                aria-expanded={advancedOpen}
                aria-controls="advanced-settings"
                onClick={() => {
                  setAdvancedOpen(!advancedOpen)
                }}
              >
                <span className="studio-section-icon">
                  <Icon name="gear" size={16} />
                </span>
                <span className="advanced-text">
                  <strong>高级设置</strong>
                  <small>{advancedSummary}</small>
                </span>
                {/* 组合存不下来时先说清要改，而不是让人自己发现保存键点不动。 */}
                {modelHint !== undefined && <span className="advanced-flag">需修改</span>}
                {/* 这块能折起来：光靠一个转圈的箭头说不清眼下是折着还是开着，
                    直接写「展开 / 收起」。 */}
                <span className="advanced-state">{advancedOpen ? '收起' : '展开'}</span>
                <Icon name="chevron-right" size={16} className={`advanced-chevron${advancedOpen ? ' is-open' : ''}`} />
              </button>
              {advancedOpen && (
                <div id="advanced-settings" className="advanced-panel">
                  <div className="field-row">
                    {/* 这三格是 button/div 而不是 label：可访问名由 Select 自己的 aria-label
                        给出（原生 <select> 在其中两格上根本没有名字）。 */}
                    <div className="field">
                      <span>供应商</span>
                      <Select
                        value={provider}
                        options={providerOptions}
                        ariaLabel="供应商"
                        onChange={(next) => {
                          pickProvider(next)
                        }}
                      />
                    </div>
                    <div className="field">
                      <span>模型</span>
                      <Select
                        value={model}
                        options={modelOptions}
                        ariaLabel="模型"
                        searchable
                        onChange={(next) => {
                          setModel(next)
                        }}
                      />
                      {/* 未知就是未知：宁可把"厂家没报"说清楚，也不要留一个空白让人以为没有这回事。 */}
                      <small className="provider-note">{MODEL_HINT}</small>
                    </div>
                    {/* 思考强度只在供应商声明支持时才出现。给它一个常驻的控件而模型
                        根本不认，用户改完会以为生效了——那比没有这个选项糟得多。 */}
                    {reasoningEfforts.length > 0 && (
                      <div className="field">
                        <span>思考强度</span>
                        <Select
                          value={reasoningEffort}
                          options={effortOptions}
                          ariaLabel="思考强度"
                          onChange={(next) => {
                            setReasoningEffort(next)
                          }}
                        />
                        <small className="provider-note">{REASONING_HINT}</small>
                      </div>
                    )}
                  </div>
                  {/* 权限档位：先说清「能碰到什么」，再让用户逐个微调。
                      档位清单由服务端给（渲染层不抄一份）——抄了就会与实际放行的
                      工具漂，漂了之后界面上写着「只读」、实际还挂着执行命令。 */}
                  <fieldset className="field" aria-label="权限档位">
                    <span>权限档位</span>
                    <div className="tool-checks tool-picker">
                      {presets.map((preset) => (
                        <label key={preset.id}>
                          <input
                            type="radio"
                            name="permission-preset"
                            checked={permissionPreset === preset.id}
                            onChange={() => {
                              setPermissionPreset(preset.id)
                              setTools(applyPreset(presets, preset.id, tools))
                            }}
                          />
                          {preset.name}
                        </label>
                      ))}
                      {permissionPreset === '' && (
                        <label>
                          <input type="radio" name="permission-preset" checked readOnly />
                          自定义
                        </label>
                      )}
                    </div>
                    <p className="provider-note">
                      {presets.find((preset) => {
                        return preset.id === permissionPreset
                      })?.summary ?? '这一档只管内置工具；插件给的工具（待办、提问、网页、MCP…）不受影响。'}
                    </p>
                  </fieldset>
                  {/* .tool-checks 负责排布（styles.css），.tool-picker 把每一格改成可点的胶囊。 */}
                  <fieldset className="field" aria-label="工具白名单">
                    <span>工具白名单</span>
                    <div className="tool-checks tool-picker">
                      {ALL_TOOLS.map((tool) => (
                        <label key={tool}>
                          <input
                            type="checkbox"
                            checked={tools.includes(tool)}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...tools, tool]
                                : tools.filter((t) => {
                                    return t !== tool
                                  })
                              setTools(next)
                              // 手动改过工具之后，这一档就不再是任何一档了：显示「自定义」，
                              // 别硬报成某一档——那会让用户以为权限还是那一档。
                              setPermissionPreset(detectPreset(presets, next) ?? '')
                            }}
                          />
                          {toolLabel(tool)}
                        </label>
                      ))}
                    </div>
                    {tools.includes(RISKY_TOOL) && <p className="provider-note">{RISKY_TOOL_HINT}</p>}
                  </fieldset>
                </div>
              )}
            </div>
            {/* 报错留在折叠区外面：模型组合存不下来是「这个助理建不出来」，不能让它
                跟着修法一起缩进去——否则用户只看到一行摘要和一个灰掉的保存键。 */}
            {modelHint !== undefined && (
              <p className="apikey-error" role="alert">
                {modelHint}
              </p>
            )}
          </div>
          <div className="studio-rail">
            <IdentityCard
              name={name}
              fallbackName={editing?.name ?? template?.name ?? '新助理'}
              avatarKey={avatarKey}
              persona={persona}
              voiceName={persona.voiceId === NO_VOICE_ID ? undefined : (selectedVoice?.name ?? '已下架的旧音色')}
            />
          </div>
        </div>
      </div>
      <div className="modal-actions modal-actions-sticky">
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (dirty) {
              setConfirmDiscard(true)
              return
            }
            onClose()
          }}
        >
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !modelValid || nameHint !== undefined}
          aria-busy={busy}
          title={nameHint ?? (modelValid ? undefined : modelHint)}
          onClick={() => {
            void submit()
          }}
        >
          {busy ? '保存中…' : editing === undefined ? '保存' : '保存修改'}
        </button>
      </div>
      {confirmDiscard && (
        <ConfirmDialog
          title="放弃未保存的修改？"
          body="关闭后，这次填的名字、性格与设置都不会保存。"
          confirmLabel="放弃修改"
          onConfirm={async () => {
            setConfirmDiscard(false)
            onClose()
          }}
          onCancel={() => {
            setConfirmDiscard(false)
          }}
        />
      )}
    </Modal>
  )
}

/**
 * 建群：转发到 {@link GroupSettingsModal} 的建群态。
 *
 * 成员多选与调度员逻辑只有一份（GroupSettingsModal.tsx）：此前它写死在本文件里，
 * 于是「建完即冻结」——同一个群的改人换调度员没有第二个入口去复用它。
 */
export function CreateGroupModal({
  agents,
  onSubmit,
  onClose,
}: {
  agents: AgentDef[]
  onSubmit: (input: { memberAgentIds: string[]; dispatcherAgentId: string; title: string }) => Promise<void>
  onClose: () => void
}) {
  return <GroupSettingsModal mode="create" agents={agents} onSubmit={onSubmit} onClose={onClose} />
}
