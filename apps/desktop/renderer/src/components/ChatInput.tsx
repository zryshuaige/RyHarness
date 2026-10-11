import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { filterMentions, mentionQueryAt } from '../store.ts'

interface MentionMember {
  id: string
  name: string
}

/**
 * 聊天输入框：Enter 发送（Shift+Enter 换行）；输入 @ 弹出成员补全
 * （群聊传入成员列表时），点击或回车补全。
 */
export function ChatInput({
  members,
  onSend,
  disabled,
  hint,
}: {
  members: MentionMember[]
  onSend: (text: string) => void
  disabled?: boolean
  hint?: string
}) {
  const [text, setText] = useState('')
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)

  const mention = mentionQueryAt(text, cursor)
  const candidates = mention === null ? [] : filterMentions(members, mention.query).slice(0, 6)

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
      // 用零宽空格打断补全查询。
      setText(`${text.slice(0, cursor)}​${text.slice(cursor)}`)
    }
  }

  const submit = (): void => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    onSend(trimmed)
    setText('')
    setCursor(0)
  }

  return (
    <div className="chat-input-wrap">
      {hint !== undefined && <p className="queue-hint">{hint}</p>}
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
              @{member.name}
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={ref}
        value={text}
        disabled={disabled}
        placeholder={members.length > 0 ? '输入消息，@ 可提及成员…' : '输入消息…'}
        rows={3}
        onChange={(event) => {
          setText(event.target.value)
          setCursor(event.target.selectionStart ?? event.target.value.length)
        }}
        onKeyDown={handleKey}
        onSelect={(event) => { setCursor(event.currentTarget.selectionStart ?? 0) }}
      />
      <button className="send-btn" onClick={submit} disabled={disabled || text.trim().length === 0}>发送</button>
    </div>
  )
}
