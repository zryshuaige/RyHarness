import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon.tsx'

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** 退场动画时长，需与 styles.css 的 --dur-leave 保持一致。 */
const LEAVE_MS = 150

/** 前庭障碍用户关闭动效时不需要等动画，直接卸载。 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * 通用弹窗：遮罩点击 / Esc 关闭；打开时聚焦第一个可交互元素；
 * Tab/Shift+Tab 焦点圈禁在弹窗内；关闭后焦点还原到触发元素。
 *
 * 关闭时先给遮罩与弹窗挂 .is-leaving 播退场动画（CSS `--dur-leave` = 150ms），
 * 动画结束才真正交回 onClose 卸载，焦点还原仍在卸载时执行（effect cleanup），
 * 因此不会「先跳焦点、后淡出」。
 */
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const modalRef = useRef<HTMLDivElement>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [leaving, setLeaving] = useState(false)

  // 关闭请求统一入口：幂等 + 延迟卸载。
  const requestClose = useCallback(() => {
    if (leaving) return
    setLeaving(true)
    if (prefersReducedMotion()) {
      onClose()
      return
    }
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null
      onClose()
    }, LEAVE_MS)
  }, [leaving, onClose])

  useEffect(() => {
    return () => {
      if (leaveTimer.current !== null) clearTimeout(leaveTimer.current)
    }
  }, [])

  useEffect(() => {
    const modal = modalRef.current
    if (modal === null) return
    const restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusables = (): HTMLElement[] => {
      return Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
        return !el.hasAttribute('disabled')
      })
    }
    ;(focusables()[0] ?? modal).focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        requestClose()
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
  }, [requestClose])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: 遮罩点击关闭（Esc 由全局 keydown 处理）
    <div className={leaving ? 'modal-mask is-leaving' : 'modal-mask'} onClick={requestClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 仅拦截点击冒泡到遮罩，本身不是交互 */}
      <div
        className={leaving ? 'modal is-leaving' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={modalRef}
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <header className="modal-header">
          <h3>{title}</h3>
          <button type="button" onClick={requestClose} aria-label="关闭">
            <Icon name="x" size={15} />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}
