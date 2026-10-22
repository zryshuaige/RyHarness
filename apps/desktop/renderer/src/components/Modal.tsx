import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { LEAVE_MS, useLeaving } from '../lib/useLeaving.ts'
import { Icon } from './Icon.tsx'

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * 通用弹窗：遮罩点击 / Esc 关闭；打开时聚焦第一个可交互元素；
 * Tab/Shift+Tab 焦点圈禁在弹窗内；关闭后焦点还原到触发元素。
 *
 * `onBeforeClose` 给「有未保存修改」的表单一个否决权：返回 false 时弹窗不进入退场，
 * 由调用方自己决定是弹确认还是别的。它必须走 ref——每次渲染换一个新闭包的话，
 * 焦点 effect 会跟着重跑，输入框每敲一个字就被抢一次焦点。
 *
 * 退场走 lib/useLeaving.ts：关闭请求只把 closing 置真，遮罩与弹窗先播 .is-leaving
 * （CSS `--dur-leave` = 150ms），播完（或 reduced-motion 下直接）才回调 onClose 卸载。
 * 焦点 effect 只认 requestClose 这一个稳定依赖，因此退场全程不会重跑——不会在
 * 150ms 里把焦点抢回弹窗再还回去；还原只发生在真正卸载时（effect cleanup）。
 */
export function Modal({
  title,
  children,
  onClose,
  onBeforeClose,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  /** 返回 false = 这次关闭被拦下（例如表单脏了，先问「放弃修改？」）。 */
  onBeforeClose?: () => boolean
}) {
  const modalRef = useRef<HTMLDivElement>(null)
  const [closing, setClosing] = useState(false)
  const closedRef = useRef(false)
  const beforeCloseRef = useRef(onBeforeClose)
  beforeCloseRef.current = onBeforeClose
  // value 传 undefined 即进入退场；shown 在退场期间保持 true，动画播完才变 undefined。
  const leave = useLeaving(LEAVE_MS, closing ? undefined : true)

  // 幂等：退场途中重复 Esc / 遮罩点击只是把同一个 true 再设一次，React 直接跳过。
  const requestClose = useCallback(() => {
    if (beforeCloseRef.current !== undefined && !beforeCloseRef.current()) return
    setClosing(true)
  }, [])

  useEffect(() => {
    // shown 为 undefined = 退场结束（reduced-motion 下同一帧就到这里）。
    if (leave.shown !== undefined || closedRef.current) return
    closedRef.current = true
    onClose()
  }, [leave.shown, onClose])

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

  if (leave.shown === undefined) return null
  const leaveClass = leave.leaving ? ' is-leaving' : ''
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: 遮罩点击关闭（Esc 由全局 keydown 处理）
    <div className={`modal-mask${leaveClass}`} ref={leave.ref} onClick={requestClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 仅拦截点击冒泡到遮罩，本身不是交互 */}
      <div
        className={`modal${leaveClass}`}
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
            <Icon name="x" size={16} />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}
