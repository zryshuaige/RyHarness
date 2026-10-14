import type { KeyboardEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { LEAVE_MS, useLeaving } from '../lib/useLeaving.ts'
import { filterMentions, mentionQueryAt } from '../store.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { Icon } from './Icon.tsx'

interface MentionMember {
  id: string
  name: string
  avatar?: string
  /** 工具数（补全弹层的徽章）。 */
  tools?: string[]
}

/**
 * 聊天输入框：Enter 发送（Shift+Enter 换行）、自动增高到 6 行；
 * 输入 @ 弹出成员补全（头像 + ↑↓ + Enter/点击 + Esc）。
 *
 * 文本默认自管；传 `draft` 则改为受控（欢迎页用它把建议 chip 的文案填进来而不是
 * 替用户直接发出去——发出去就改不回来了）。`focusToken` 每次变化即聚焦并把光标
 * 放到末尾，chip 填词后用户可以接着改。
 */
export function ChatInput({
  members,
  onSend,
  disabled,
  streaming,
  onStop,
  draft,
  onDraftChange,
  focusToken,
}: {
  members: MentionMember[]
  onSend: (text: string) => void
  disabled?: boolean
  /** 对方正在生成：显示停止按钮与"已用时"。 */
  streaming?: boolean
  onStop?: () => void
  /** 受控草稿；不传则用内部状态。 */
  draft?: string
  onDraftChange?: (text: string) => void
  /** 变化即聚焦输入框并把光标移到末尾。 */
  focusToken?: number
}) {
  const [ownText, setOwnText] = useState('')
  const text = draft ?? ownText
  const setText = (next: string): void => {
    if (draft === undefined) setOwnText(next)
    onDraftChange?.(next)
  }
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState(0)
  /** Esc 显式关闭补全菜单；文本变动时复位（不往文本里塞魔法字符）。 */
  const [dismissed, setDismissed] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  const mention = dismissed ? null : mentionQueryAt(text, cursor)
  const candidates = mention === null ? [] : filterMentions(members, mention.query).slice(0, 6)
  /** 补全菜单走统一退场体系：关掉时先播 .is-leaving 再卸载。 */
  const menu = useLeaving(LEAVE_MS, candidates.length > 0 ? candidates : undefined)
  const [busyElapsed, setBusyElapsed] = useState<number | undefined>(undefined)

  // Esc = 停止生成（按钮上的承诺）：补全菜单在屏上（含退场中）时 Esc 仍然只关菜单。
  const menuOpenRef = useRef(false)
  menuOpenRef.current = menu.shown !== undefined
  const stopRef = useRef(onStop)
  stopRef.current = onStop
  useEffect(() => {
    if (streaming !== true) return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || menuOpenRef.current) return
      // 弹窗打开时 Esc 归弹窗：它的捕获阶段监听会 stopPropagation，这里收不到。
      stopRef.current?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [streaming])

  // 生成中的秒表：让"正在生成"有进度感，也给用户一个判断卡死的依据
  // （实测出现过 40 秒无任何反馈，用户只能以为应用死了）。
  useEffect(() => {
    if (streaming !== true) {
      setBusyElapsed(undefined)
      return
    }
    const started = Date.now()
    setBusyElapsed(0)
    const timer = setInterval(() => {
      setBusyElapsed(Math.floor((Date.now() - started) / 1000))
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [streaming])

  /** textarea 自动增高（上限 6 行 ≈ 148px）。 */
  const autoGrow = (node: HTMLTextAreaElement | null): void => {
    if (node === null) return
    node.style.height = '0px'
    node.style.height = `${Math.min(node.scrollHeight, 148)}px`
  }

  // 外部把草稿塞进来（欢迎页 chip）：聚焦并把光标放到末尾，用户可以接着改。
  useEffect(() => {
    if (focusToken === undefined) return
    const node = ref.current
    if (node === null) return
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
    setCursor(node.value.length)
    autoGrow(node)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken])

  const complete = (name: string): void => {
    if (mention === null) return
    const next = `${text.slice(0, mention.start)}@${name} ${text.slice(cursor)}`
    setText(next)
    setSelected(0)
    requestAnimationFrame(() => {
      const node = ref.current
      if (node !== null) {
        const pos = mention.start + name.length + 2
        node.focus()
        node.setSelectionRange(pos, pos)
        setCursor(pos)
      }
    })
  }

  const handleKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && candidates.length === 0) {
      event.preventDefault()
      submit()
    } else if (event.key === 'Enter' && candidates.length > 0) {
      event.preventDefault()
      const pick = candidates[Math.min(selected, candidates.length - 1)]
      if (pick !== undefined) complete(pick.name)
    } else if (event.key === 'ArrowDown' && candidates.length > 0) {
      event.preventDefault()
      setSelected((selected + 1) % candidates.length)
    } else if (event.key === 'ArrowUp' && candidates.length > 0) {
      event.preventDefault()
      setSelected((selected + candidates.length - 1) % candidates.length)
    } else if (event.key === 'Escape' && candidates.length > 0) {
      event.preventDefault()
      setDismissed(true)
    }
  }

  const submit = (): void => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    onSend(trimmed)
    setText('')
    setCursor(0)
    requestAnimationFrame(() => {
      autoGrow(ref.current)
    })
  }

  return (
    <>
      <div className="chat-input-box">
        {menu.shown !== undefined && (
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: 提及菜单焦点留在 textarea，aria-selected 表达选中态
          <ul ref={menu.ref} className={menu.leaving ? 'mention-menu is-leaving' : 'mention-menu'} role="listbox">
            {menu.shown.map((member, index) => (
              // biome-ignore lint/a11y/useFocusableInteractive: 焦点不离开输入框，选中态经 aria-selected 暴露
              <li
                key={member.id}
                // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: 提及菜单项由键盘在 textarea 内驱动
                role="option"
                aria-selected={index === selected}
                className={index === selected ? 'is-selected' : ''}
                onMouseDown={(event) => {
                  event.preventDefault()
                  complete(member.name)
                }}
                onMouseEnter={() => {
                  setSelected(index)
                }}
              >
                <Avatar avatarKey={member.avatar} name={member.name} seed={member.id} size={24} />
                <span className="mention-name">
                  <Icon name="at-sign" size={12} />
                  {member.name}
                </span>
                {(member.tools?.length ?? 0) > 0 && <span className="mention-badge">{member.tools!.length} 工具</span>}
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={(node) => {
            ref.current = node
            autoGrow(node)
          }}
          value={text}
          disabled={disabled}
          placeholder={members.length > 0 ? '输入消息，@ 可提及成员…' : '输入消息…'}
          rows={1}
          onChange={(event) => {
            setText(event.target.value)
            setCursor(event.target.selectionStart ?? event.target.value.length)
            setDismissed(false)
            autoGrow(event.target)
          }}
          onKeyDown={handleKey}
          onSelect={(event) => {
            setCursor(event.currentTarget.selectionStart ?? 0)
          }}
        />
      </div>
      <button type="button" className="send-btn" onClick={submit} disabled={disabled || text.trim().length === 0}>
        <Icon name="send" size={16} />
        <span>发送</span>
      </button>
      {busyElapsed !== undefined && onStop !== undefined && (
        <button type="button" className="btn stop-btn" onClick={onStop} title="停止生成（Esc）" aria-label="停止生成">
          <span className="stop-dot" aria-hidden="true" />
          停止
          <span className="stop-elapsed">{busyElapsed}s</span>
        </button>
      )}
    </>
  )
}
