import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Icon } from './Icon.tsx'

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * 通用弹窗：遮罩点击 / Esc 关闭；打开时聚焦第一个可交互元素；
 * Tab/Shift+Tab 焦点圈禁在弹窗内；关闭后焦点还原到触发元素。
 */
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const modalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const modal = modalRef.current
    if (modal === null) return
    const restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusables = (): HTMLElement[] => {
      return Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => { return !el.hasAttribute('disabled') })
    }
    ;(focusables()[0] ?? modal).focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        event.preventDefault()
        modal.focus()
        return
      }
      const first = items[0]!
      const last = items[items.length - 1]!
      const active = document.activeElement
      if (event.shiftKey && (active === first || !modal.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !modal.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      restoreTo?.focus()
    }
  }, [onClose])

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={modalRef}
        onClick={(event) => { event.stopPropagation() }}
      >
        <header className="modal-header">
          <h3>{title}</h3>
          <button onClick={onClose} aria-label="关闭"><Icon name="x" size={15} /></button>
        </header>
        {children}
      </div>
    </div>
  )
}
