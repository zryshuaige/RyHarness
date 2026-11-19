/**
 * 全局命令面板（Cmd/Ctrl+K）。
 *
 * 复用 `/` 面板那套命令表（`App` 的 `commands` useMemo）与 `lib/commands.ts` 的纯过滤逻辑，
 * 只把作用域从输入框扩到全局：在任何页面按 Cmd+K 都能跳页签、开新对话、切主题、打开
 * 工作区——不必先切回聊天页去摸那枚 `/`。命令表刻意仍只放本机动作，不发明后端语义。
 *
 * 键盘走位照抄 CLI 命令面板的惯例：焦点全程留在搜索框（列表项不接管焦点），↑↓ 移高亮、
 * Enter 执行、Esc 关闭；`aria-activedescendant` + `aria-selected` 把「当前选中哪一项」暴露给读屏。
 *
 * @module @ryharness/renderer/components/CommandPalette
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { type Command, filterCommands } from '../lib/commands.ts'
import { Icon } from './Icon.tsx'

export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean
  commands: readonly Command[]
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const results = useMemo(() => {
    return filterCommands(commands, query)
  }, [commands, query])

  // 打开：清空查询、选中第一项、把焦点送进搜索框，并记下打开前焦点在哪。
  // 关闭（effect 清理）：把焦点还回去——面板关掉后焦点掉进 body 是键盘用户最烦的一种。
  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery('')
    setActive(0)
    const id = window.setTimeout(() => {
      inputRef.current?.focus()
    }, 0)
    return () => {
      window.clearTimeout(id)
      restoreRef.current?.focus?.()
    }
  }, [open])

  // 结果集变短时把高亮夹回范围内：删字之后高亮不会指向一个已经不存在的项。
  useEffect(() => {
    setActive((prev) => {
      return prev > results.length - 1 ? Math.max(0, results.length - 1) : prev
    })
  }, [results.length])

  if (!open) return null

  const runAt = (index: number): void => {
    const command = results[index]
    if (command === undefined) return
    onClose()
    command.run()
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: 点击遮罩空白处关闭面板（Esc 由面板内 keydown 处理）
    <div
      className="command-palette-mask"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="command-palette-search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="command-palette-input"
            value={query}
            placeholder="输入命令或页面名…"
            aria-label="搜索命令"
            aria-controls="command-palette-list"
            aria-activedescendant={results.length > 0 ? `command-palette-${results[active]?.id ?? ''}` : undefined}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActive((prev) => {
                  return results.length === 0 ? 0 : (prev + 1) % results.length
                })
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActive((prev) => {
                  return results.length === 0 ? 0 : (prev - 1 + results.length) % results.length
                })
              } else if (event.key === 'Enter') {
                event.preventDefault()
                runAt(active)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              } else if (event.key === 'Tab') {
                // 面板内不散焦：Tab 也不把焦点带出去（焦点该留在搜索框）。
                event.preventDefault()
              }
            }}
          />
          <kbd className="command-palette-kbd">Esc</kbd>
        </div>
        {results.length === 0 ? (
          <p className="command-palette-empty">没有匹配的命令</p>
        ) : (
          <ul
            id="command-palette-list"
            className="command-palette-list"
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: 焦点留在搜索框，选中态经 aria-selected 暴露
            role="listbox"
            aria-label="命令"
          >
            {results.map((command, index) => {
              return (
                // biome-ignore lint/a11y/useFocusableInteractive: 焦点不离开搜索框，选中态经 aria-selected 暴露
                <li
                  key={command.id}
                  id={`command-palette-${command.id}`}
                  // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: 命令项由键盘在搜索框内驱动
                  role="option"
                  aria-selected={index === active}
                  className={index === active ? 'command-palette-item is-active' : 'command-palette-item'}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    runAt(index)
                  }}
                  onMouseEnter={() => {
                    setActive(index)
                  }}
                >
                  <span className="command-palette-label">{command.label}</span>
                  {command.hint !== undefined && <span className="command-palette-hint">{command.hint}</span>}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
