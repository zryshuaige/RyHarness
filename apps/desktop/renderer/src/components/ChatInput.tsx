import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react'
import { memo, useEffect, useRef, useState } from 'react'
import { type Command, commandQueryAt, filterCommands, stripCommand } from '../lib/commands.ts'
import { humanError } from '../lib/error-text.ts'
import { formatSize } from '../lib/format.ts'
import { filterMentions, mentionQueryAt } from '../lib/mentions.ts'
import { LEAVE_MS, useLeaving } from '../lib/useLeaving.ts'
import type { MessageAttachment } from '../store.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { Icon } from './Icon.tsx'

export interface ChatInputProps {
  members: MentionMember[]
  onSend: (text: string, attachments?: MessageAttachment[]) => void
  disabled?: boolean
  /** 对方正在生成：显示停止按钮与"已用时"。 */
  streaming?: boolean
  onStop?: () => void
  /** 受控草稿；不传则用内部状态。 */
  draft?: string
  onDraftChange?: (text: string) => void
  /** 变化即聚焦输入框并把光标移到末尾。 */
  focusToken?: number
  /** 附件落库通道：把文件交上去，返回落库后的卡片元数据（与 file_produce 同构）。 */
  onUpload?: (file: File) => Promise<MessageAttachment>
  /** `/` 命令面板的候选（壳构建：每条命令要拿到应用级动作）。 */
  commands?: readonly Command[]
}

interface MentionMember {
  id: string
  name: string
  avatar?: string
  /** 工具数（补全弹层的徽章）。 */
  tools?: string[]
}

/** 预览条上的一个附件：粘贴/拖进来即开始上传，落库成功后随消息一起发出去。 */
interface AttachmentEntry {
  id: string
  name: string
  size: number
  mime: string
  status: 'uploading' | 'ready' | 'error'
  /** 上传失败原因（中文，直接给用户看）。 */
  error?: string
  file: File
}

let attachmentSeq = 0

/** 附件 id：单调计数即可，同一进程内不会与 DOM key 撞车。 */
function nextAttachmentId(): string {
  attachmentSeq += 1
  return `att:${attachmentSeq}`
}

/** 文件类型优先取浏览器给的 MIME，剪贴板/拖放常常给空串。 */
function mimeOf(file: File): string {
  return file.type !== '' ? file.type : 'application/octet-stream'
}

/**
 * 聊天输入框：Enter 发送（Shift+Enter 换行）、自动增高到 6 行；
 * 输入 @ 弹出成员补全（头像 + ↑↓ + Enter/点击 + Esc）；支持粘贴/拖放附件。
 *
 * 文本默认自管；传 `draft` 则改为受控（欢迎页用它把建议 chip 的文案填进来而不是
 * 替用户直接发出去——发出去就改不回来了）。`focusToken` 每次变化即聚焦并把光标
 * 放到末尾，chip 填词后用户可以接着改。
 */
function ChatInputView({
  members,
  onSend,
  disabled,
  streaming,
  onStop,
  draft,
  onDraftChange,
  focusToken,
  onUpload,
  commands = [],
}: ChatInputProps) {
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
  /** 输入法组合中：部分 Electron 下的 IME 不给 keydown 带 isComposing，
   *  compositionstart/end 是不依赖该标志的兜底信号。 */
  const composingRef = useRef(false)
  const [attachments, setAttachments] = useState<AttachmentEntry[]>([])
  const [dragging, setDragging] = useState(false)

  const patchAttachment = (id: string, patch: Partial<AttachmentEntry>): void => {
    setAttachments((prev) => {
      return prev.map((item) => {
        return item.id === id ? { ...item, ...patch } : item
      })
    })
  }

  const runUpload = async (entry: AttachmentEntry): Promise<void> => {
    if (onUpload === undefined) {
      patchAttachment(entry.id, { status: 'error', error: '当前未开放附件上传' })
      return
    }
    try {
      const stored = await onUpload(entry.file)
      patchAttachment(entry.id, {
        status: 'ready',
        name: stored.name,
        size: stored.size,
        mime: stored.mime,
        error: undefined,
      })
    } catch (error) {
      patchAttachment(entry.id, {
        status: 'error',
        error: humanError(error, '这个文件没能加上，换一个再试'),
      })
    }
  }

  /** 粘贴/拖放进来的文件：先上屏（上传中），落库成功后转为已附加。 */
  const attachFiles = (files: FileList | null): void => {
    if (files === null || files.length === 0) return
    const entries: AttachmentEntry[] = []
    for (const file of Array.from(files)) {
      if (file.size === 0) continue
      entries.push({
        id: nextAttachmentId(),
        name: file.name,
        size: file.size,
        mime: mimeOf(file),
        status: 'uploading',
        file,
      })
    }
    if (entries.length === 0) return
    setAttachments((prev) => {
      return [...prev, ...entries]
    })
    for (const entry of entries) void runUpload(entry)
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = event.clipboardData?.files
    if (files === undefined || files.length === 0) return
    // 拦住默认插入：否则剪贴板里的文件会以残影形式跟着进文本框。
    event.preventDefault()
    attachFiles(files)
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    const types = event.dataTransfer?.types
    if (types === undefined || !Array.from(types).includes('Files')) return
    // 不 preventDefault 的话浏览器不会派发 drop，拖放等于没接。
    event.preventDefault()
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }

  const onDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDragging(false)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(false)
    attachFiles(event.dataTransfer?.files ?? null)
  }

  const readyAttachments = attachments.filter((item) => {
    return item.status === 'ready'
  })
  const uploading = attachments.some((item) => {
    return item.status === 'uploading'
  })

  const mention = dismissed ? null : mentionQueryAt(text, cursor)
  const candidates = mention === null ? [] : filterMentions(members, mention.query).slice(0, 6)
  /**
   * `/` 命令面板：行首斜杠触发（中间的斜杠是正文，见 lib/commands.ts 的口径）。
   * 与 @提及两套候选不会同时出现——一行里 `/` 与 `@` 谁在光标前谁生效。
   */
  const [commandDismissed, setCommandDismissed] = useState(false)
  const command = commandDismissed ? null : commandQueryAt(text, cursor)
  const commandCandidates = command === null ? [] : filterCommands(commands, command.query).slice(0, 8)
  const commandMenu = useLeaving(LEAVE_MS, commandCandidates.length > 0 ? commandCandidates : undefined)
  /** 补全菜单走统一退场体系：关掉时先播 .is-leaving 再卸载。 */
  const menu = useLeaving(LEAVE_MS, candidates.length > 0 ? candidates : undefined)
  const [busyElapsed, setBusyElapsed] = useState<number | undefined>(undefined)
  // 停止按钮同理：流式结束时不直接消失，先播 .stop-btn.is-leaving。
  // value 传秒数而不是布尔：退场期间秒表已停，shown 会一直拿着最后一个数字，
  // 按钮不会在淡出时把 "12s" 渲染成空的。
  const stopButton = useLeaving(LEAVE_MS, streaming === true && onStop !== undefined ? (busyElapsed ?? 0) : undefined)

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: autoGrow 是纯 DOM 操作（按内容改高度），不是需要进依赖的响应式值
  useEffect(() => {
    if (focusToken === undefined) return
    const node = ref.current
    if (node === null) return
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
    setCursor(node.value.length)
    autoGrow(node)
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
    // 输入法组合中的回车是「选词」，不是「发送」：拼音/日文输入法上按回车会把
    // 半截拼音当消息发出去（中文用户必踩）。nativeEvent.isComposing 是标准信号，
    // 部分 Electron 下的 IME 不带它，再由 compositionstart/end 的 ref 兜底。
    if (event.nativeEvent.isComposing || composingRef.current) return
    // 命令菜单优先于提及菜单：行首的 "/" 与 "@" 不会同时成立，但两套候选都非空时
    // 先响应命令（它是更靠前的那次触发）。
    if (commandCandidates.length > 0) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        const pick = commandCandidates[Math.min(selected, commandCandidates.length - 1)]
        if (pick !== undefined) runCommand(pick)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelected((selected + 1) % commandCandidates.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelected((selected + commandCandidates.length - 1) % commandCandidates.length)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setCommandDismissed(true)
      }
      return
    }
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

  /**
   * 执行一条命令：只删掉命令本身，命令之后用户写的正文留着。
   *
   * 此前这里 `setText('')` 把整个输入框清空——用户写了一半的草稿（"/help 帮我看看
   * 这段代码" 里后半截那段）会跟着命令一起静默消失。命令只是那一个词，草稿是用户
   * 自己的东西：删命令，不删草稿。删哪一段由 lib/commands.ts 的 stripCommand 算，
   * 组件与测试共用同一个纯函数。
   */
  const runCommand = (command: Command): void => {
    const stripped = stripCommand(text, cursor)
    setText(stripped.text)
    setCursor(stripped.cursor)
    setSelected(0)
    setCommandDismissed(true)
    command.run()
    // 文本变了，浏览器会把光标甩到末尾：把它放回剩下的正文里，用户能接着写。
    requestAnimationFrame(() => {
      const node = ref.current
      if (node === null) return
      node.focus()
      node.setSelectionRange(stripped.cursor, stripped.cursor)
    })
  }

  const submit = (): void => {
    // 附件还在路上就不发：宁可让用户看见"上传中"，也不要发出去一条缺文件的请求。
    if (uploading) return
    const files = readyAttachments.map((item) => {
      return { name: item.name, size: item.size, mime: item.mime }
    })
    const trimmed = text.trim()
    if (trimmed.length === 0 && files.length === 0) return
    onSend(trimmed, files.length === 0 ? undefined : files)
    setText('')
    setAttachments([])
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
                  <Icon name="at-sign" size={16} />
                  {member.name}
                </span>
                {(member.tools?.length ?? 0) > 0 && <span className="mention-badge">{member.tools!.length} 工具</span>}
              </li>
            ))}
          </ul>
        )}
        {commandMenu.shown !== undefined && (
          <ul
            ref={commandMenu.ref}
            className={commandMenu.leaving ? 'mention-menu is-leaving' : 'mention-menu'}
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: 命令菜单焦点留在 textarea，aria-selected 表达选中态
            role="listbox"
          >
            {commandMenu.shown.map((candidate, index) => (
              // biome-ignore lint/a11y/useFocusableInteractive: 焦点不离开输入框，选中态经 aria-selected 暴露
              <li
                key={candidate.id}
                // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: 命令菜单项由键盘在 textarea 内驱动
                role="option"
                aria-selected={index === selected}
                className={index === selected ? 'is-selected' : ''}
                onMouseDown={(event) => {
                  event.preventDefault()
                  runCommand(candidate)
                }}
                onMouseEnter={() => {
                  setSelected(index)
                }}
              >
                <span className="mention-name">
                  <Icon name="blocks" size={16} />
                  {candidate.label}
                </span>
                {candidate.hint !== undefined && <span className="mention-badge">{candidate.hint}</span>}
              </li>
            ))}
          </ul>
        )}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: 拖放区不是控件，只是接收 drop 的区域；键盘用户走粘贴同一条通道 */}
        <div
          className={dragging ? 'attach-zone is-dragover' : 'attach-zone'}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {attachments.length > 0 && (
            <div className="attach-strip">
              {attachments.map((item) => (
                <span key={item.id} className={`attach-item is-${item.status}`} title={item.error ?? item.name}>
                  <Icon name="file" size={16} />
                  <span className="attach-name">{item.name}</span>
                  <span className="attach-meta">
                    {item.status === 'uploading'
                      ? '上传中…'
                      : item.status === 'error'
                        ? (item.error ?? '上传失败')
                        : formatSize(item.size)}
                  </span>
                  {item.status === 'error' && (
                    <button
                      type="button"
                      className="attach-retry"
                      onClick={() => {
                        void runUpload(item)
                      }}
                    >
                      重试
                    </button>
                  )}
                  <button
                    type="button"
                    className="attach-remove"
                    aria-label={`移除 ${item.name}`}
                    onClick={() => {
                      setAttachments((prev) => {
                        return prev.filter((other) => {
                          return other.id !== item.id
                        })
                      })
                    }}
                  >
                    <Icon name="x" size={16} />
                  </button>
                </span>
              ))}
            </div>
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
              setCommandDismissed(false)
              autoGrow(event.target)
            }}
            onKeyDown={handleKey}
            onPaste={onPaste}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={() => {
              composingRef.current = false
            }}
            onSelect={(event) => {
              setCursor(event.currentTarget.selectionStart ?? 0)
            }}
          />
        </div>
      </div>
      <button
        type="button"
        className="send-btn"
        onClick={submit}
        disabled={disabled || uploading || (text.trim().length === 0 && readyAttachments.length === 0)}
      >
        <Icon name="send" size={16} />
        <span>发送</span>
      </button>
      {stopButton.shown !== undefined && (
        <button
          type="button"
          ref={stopButton.ref}
          className={stopButton.leaving ? 'btn stop-btn is-leaving' : 'btn stop-btn'}
          onClick={onStop}
          title="停止生成（Esc）"
          aria-label="停止生成"
        >
          <span className="stop-dot" aria-hidden="true" />
          停止
          <span className="stop-elapsed">{stopButton.shown}s</span>
        </button>
      )}
    </>
  )
}

/**
 * 输入框本体是 memo 的：流式期聊天区每 40ms 重渲染一次，而输入框真正关心的只有
 * 「这一轮还在不在跑」与草稿本身。此前它跟着消息流每帧重渲染——光标、输入法组合态、
 * 附件条全都在重新走一遍，而屏幕上一个字都没变。
 *
 * 前提是调用方给的 props 身份稳定：函数一律 useCallback，成员列表在单聊时传模块级
 * 常量而不是每次新建的 `[]`（见 ChatView 的 NO_MEMBERS）。
 */
export const ChatInput = memo(ChatInputView)
