import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { parseMentions } from '../lib/mention-text.ts'
import { Avatar } from './avatars/Avatar.tsx'

/**
 * @提及的正文渲染：把「@某人」画成一枚琥珀标签，悬停出这位的名片。
 *
 * 为什么 @ 要有特殊效果：正文里的 @某人 是一句「这件事归你」的标记，不画出来就
 * 只是几个字。标成标签之后，用户一眼能看出这句话是点名的，鼠标一停还能看到
 * 对方是谁、用什么模型、能调哪些工具——不必切到通讯录去找。
 *
 * 两处刻意的取舍：
 * - **靠形状而不是颜色来区分**：正文里的网址链接是琥珀色的无底色文字，@ 也用品牌
 *   琥珀，但它带底色、是圆角标签，一眼就知道哪个是人、哪个是网址。（颜色上曾经
 *   用蓝，可正文里的**助理名字**本身就是 12 支身份色里的一支，其中就有蓝——两处
 *   蓝并排出现，用户分不清哪个是「在叫这个人」、哪个只是「这个人在说话」。）
 * - **名片在悬停那一刻现读**：亲密度每轮都在涨，资料放进 props 会让所有气泡每轮
 *   重渲一遍（见 ChatView 里 bubbleAgents 的同款处理）。所以 props 里只留稳定的
 *   「id + 名字」，资料由 onProfile 在打开那一刻去取。
 */

/** 名单里的一位：认得出名字就行。 */
export interface MentionEntry {
  id: string
  name: string
}

/** 名片上要摆的东西。 */
export interface MentionProfile {
  /** 头像位。 */
  avatar?: string
  /** 供应商 · 模型。 */
  model?: string
  /** 工具数。 */
  tools?: number
  /** 内置徽标文案。 */
  badge?: string
  /** 性格四维（标签 + 档位名）。 */
  traits?: { label: string; band: string }[]
  /** 相处档位（亲密度现读）。 */
  bond?: { label: string; value: number }
}

/** 卡片宽度与高度估值：定位置用，不需要精确。 */
const CARD_WIDTH = 268
const CARD_ESTIMATE_H = 180
const VIEWPORT_MARGIN = 12
const CARD_GAP = 8
/**
 * 打开的意图延迟 / 关闭的宽限。
 *
 * 之前是「开得急、关得黏」：鼠标扫过就弹，要等 220ms 才消失。扫读一段带 @ 的
 * 消息时，卡片会连着弹好几次，眼睛被迫在正文和卡片之间来回跳。
 * 现在反过来：指针**停住不动** 250ms 才开（那才是在看它），离开 120ms 就收。
 */
const OPEN_DELAY_MS = 250
const CLOSE_DELAY_MS = 120

interface CardPlace {
  left: number
  /** 放下面时用 top，放上面时用 bottom——两种位置都不与入场动画的 transform 打架。 */
  top?: number
  bottom?: number
}

function placeCard(rect: DOMRect): CardPlace {
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN)
  const left = Math.min(Math.max(rect.left, VIEWPORT_MARGIN), maxLeft)
  const below = rect.bottom + CARD_GAP
  const above = below + CARD_ESTIMATE_H > window.innerHeight && rect.top > CARD_ESTIMATE_H
  if (above) {
    return { left, bottom: Math.max(VIEWPORT_MARGIN, window.innerHeight - (rect.top - CARD_GAP)) }
  }
  return { left, top: below }
}

/** 名片本体。 */
function MentionCard({
  id,
  entry,
  profile,
  place,
  onEnter,
  onLeave,
  onMention,
}: {
  id: string
  entry: MentionEntry
  profile: MentionProfile | undefined
  place: CardPlace
  onEnter: () => void
  onLeave: () => void
  /** 没有它就没有「点一下」这回事，名片上那句提示也就不该出现。 */
  onMention?: (entry: MentionEntry) => void
}) {
  return (
    <div
      id={id}
      className="mention-card"
      style={{
        left: place.left,
        ...(place.top === undefined ? {} : { top: place.top }),
        ...(place.bottom === undefined ? {} : { bottom: place.bottom }),
      }}
      role="tooltip"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="mention-card-head">
        <Avatar avatarKey={profile?.avatar} name={entry.name} seed={entry.id} size={36} />
        <div className="mention-card-title">
          <strong>{entry.name}</strong>
          {profile?.badge !== undefined && <span className="badge">{profile.badge}</span>}
        </div>
      </div>
      <dl className="mention-card-fields">
        {profile?.model !== undefined && (
          <>
            <dt>模型</dt>
            <dd>{profile.model}</dd>
          </>
        )}
        {profile?.tools !== undefined && (
          <>
            <dt>工具</dt>
            <dd>{profile.tools} 个</dd>
          </>
        )}
        {profile?.traits !== undefined && profile.traits.length > 0 && (
          <>
            <dt>性格</dt>
            <dd>
              <span className="tool-chips">
                {profile.traits.map((trait) => {
                  // 轴名与档位名撞了就只说一遍（"外向 · 外向" 是同一个词说两遍）。
                  const text = trait.label === trait.band ? trait.band : `${trait.label} · ${trait.band}`
                  return (
                    <span key={trait.label} className="chip">
                      {text}
                    </span>
                  )
                })}
              </span>
            </dd>
          </>
        )}
        {profile?.bond !== undefined && (
          <>
            <dt>相处</dt>
            <dd>
              {profile.bond.label}（{profile.bond.value}/100）
            </dd>
          </>
        )}
      </dl>
      {onMention !== undefined && <p className="mention-card-hint">点一下，把它 @ 回输入框</p>}
    </div>
  )
}

/** 一条 @提及：本体是琥珀标签，悬停出名片。 */
function MentionLink({
  entry,
  onProfile,
  onMention,
}: {
  entry: MentionEntry
  onProfile?: (id: string) => MentionProfile | undefined
  onMention?: (entry: MentionEntry) => void
}) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<CardPlace | undefined>(undefined)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const cardId = useId()

  const clearTimer = useCallback((): void => {
    if (timerRef.current === undefined) return
    window.clearTimeout(timerRef.current)
    timerRef.current = undefined
  }, [])

  const show = useCallback((): void => {
    clearTimer()
    // 意图延迟：指针停住不动才算"要看这张名片"。扫过就开会把正文读得断断续续。
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined
      const node = anchorRef.current
      if (node === null) return
      setPlace(placeCard(node.getBoundingClientRect()))
      setOpen(true)
    }, OPEN_DELAY_MS)
  }, [clearTimer])

  /** 延迟关闭：指针从链接挪到卡片上时，中间那一小段不该把卡片甩掉。 */
  const hideSoon = useCallback((): void => {
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined
      setOpen(false)
    }, CLOSE_DELAY_MS)
  }, [clearTimer])

  const hideNow = useCallback((): void => {
    clearTimer()
    setOpen(false)
  }, [clearTimer])

  useEffect(() => {
    return () => {
      clearTimer()
    }
  }, [clearTimer])

  // 页面一滚，卡片就与它的锚点脱节了：跟着滚会在正文上留一条错位的影子，
  // 直接收掉更干净（滚动的当下用户也看不清卡片上的字）。
  useEffect(() => {
    if (!open) return
    const onScroll = (): void => {
      hideNow()
    }
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [open, hideNow])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hideNow()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, hideNow])

  const profile = open ? onProfile?.(entry.id) : undefined

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="mention-link"
        aria-label={`@${entry.name}`}
        aria-describedby={open ? cardId : undefined}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
        onFocus={show}
        onBlur={hideSoon}
        onClick={() => {
          onMention?.(entry)
        }}
      >
        @{entry.name}
      </button>
      {open &&
        place !== undefined &&
        createPortal(
          <MentionCard
            id={cardId}
            entry={entry}
            profile={profile}
            place={place}
            onEnter={clearTimer}
            onLeave={hideSoon}
            onMention={onMention}
          />,
          document.body,
        )}
    </>
  )
}

/**
 * @提及的接线：名单 + 悬停取资料 + 点一下送回输入框。
 *
 * 这一份对象会被传进每一个气泡，所以它的身份必须稳定：每轮重建一次等于让所有
 * 气泡每轮重渲一遍（见 ChatView 里 bubbleAgents 的同款处理）。
 */
export interface MentionOptions {
  /** 名单：id + 名字。 */
  entries: readonly MentionEntry[]
  /** 悬停那一刻现读这位的资料。 */
  onProfile?: (id: string) => MentionProfile | undefined
  /** 点一下这个 @：把它送回输入框。 */
  onMention?: (entry: MentionEntry) => void
}

/**
 * 把一段正文里的 @某人 渲染成琥珀标签。
 *
 * 名单（entries）里没有的名字仍是普通文字：随手写的 @某个邮箱 不该被染成一枚
 * 谁也点不动的标签。
 */
export function MentionText({
  text,
  entries,
  onProfile,
  onMention,
}: {
  text: string
} & MentionOptions): ReactNode {
  const segments = parseMentions(text, entries)
  if (segments.length === 0) return null
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'text') {
          return <span key={`text-${index}`}>{segment.text}</span>
        }
        return (
          <MentionLink
            key={`mention-${index}`}
            entry={{ id: segment.target.id, name: segment.target.name }}
            onProfile={onProfile}
            onMention={onMention}
          />
        )
      })}
    </>
  )
}
