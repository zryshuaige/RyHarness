import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { filterMentions, mentionQueryAt } from '../store.ts'
import { Avatar } from './avatars/Avatar.tsx'

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
 */
export function ChatInput({
  members,
  onSend,
  disabled,
}: {
  members: MentionMember[]
  onSend: (text: string) => void
  disabled?: boolean
}) {
  const [text, setText] = useState('')
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)

  const mention = mentionQueryAt(text, cursor)
  const candidates = mention === null ? [] : filterMentions(members, mention.query).slice(0, 6)

  /** textarea 自动增高（上限 6 行 ≈ 148px）。 */
  const autoGrow = (node: HTMLTextAreaElement | null): void => {
    if (node === null) return
    node.style.height = '0px'
    node.style.height = `${Math.min(node.scrollHeight, 148)}px`
  }

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
      setText(`${text.slice(0, cursor)}​${text.slice(cursor)}`)
    }
  }

  const submit = (): void => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    onSend(trimmed)
    setText('')
    setCursor(0)
    requestAnimationFrame(() => { autoGrow(ref.current) })
  }

  return (
    <>
      <div className="chat-input-box">
        {candidates.length > 0 && (
          <ul className="mention-menu" role="listbox">
            {candidates.map((member, index) => (
              <li
                key={member.id}
                role="option"
                aria-selected={index === selected}
                className={index === selected ? 'is-selected' : ''}
                onMouseDown={(event) => {
                  event.preventDefault()
                  complete(member.name)
                }}
                onMouseEnter={() => { setSelected(index) }}
              >
                <Avatar avatarKey={member.avatar} name={member.name} seed={member.id} size={24} />
                <span className="mention-name">@{member.name}</span>
                {(member.tools?.length ?? 0) > 0 && (
                  <span className="mention-badge">{member.tools!.length} 工具</span>
                )}
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
            autoGrow(event.target)
          }}
          onKeyDown={handleKey}
          onSelect={(event) => { setCursor(event.currentTarget.selectionStart ?? 0) }}
        />
      </div>
      <button className="send-btn" onClick={submit} disabled={disabled || text.trim().length === 0}>发送</button>
    </>
  )
}
