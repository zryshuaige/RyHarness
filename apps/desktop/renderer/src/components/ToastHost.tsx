import { useCallback, useEffect, useState } from 'react'
import type { ToastItem } from '../lib/toast.ts'
import { toast, useToasts } from '../lib/toast.ts'
import { LEAVE_MS, useLeaving } from '../lib/useLeaving.ts'
import { Icon } from './Icon.tsx'

/**
 * 单条 toast：store 移除后先挂 .is-leaving 播退场，播完才让宿主摘掉这一格。
 * 退场期间不卸载内容（.is-leaving 已让 pointer-events 失效，不会误触下面的按钮）。
 */
function ToastSlot({ item, live, onDone }: { item: ToastItem; live: boolean; onDone: (id: number) => void }) {
  const { shown, leaving, ref } = useLeaving(LEAVE_MS, live ? item : undefined)
  useEffect(() => {
    if (shown === undefined) onDone(item.id)
  }, [shown, item.id, onDone])
  if (shown === undefined) return null
  const { action } = shown
  return (
    <div ref={ref} className={`toast toast-${shown.kind}${leaving ? ' is-leaving' : ''}`}>
      {shown.kind === 'error' ? <Icon name="alert" size={16} /> : null}
      <span className="toast-text">{shown.text}</span>
      {action !== undefined && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            action.run()
            toast.dismiss(shown.id)
          }}
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        className="toast-close"
        aria-label="关闭提示"
        onClick={() => {
          toast.dismiss(shown.id)
        }}
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  )
}

/**
 * toast 宿主：聊天页挂在输入区上沿、其余页面由 App 挂在窗口底部（定位由样式表按
 * 挂载点决定）。每条 toast 各自播退场，而不是从数组里直接消失。
 */
export function ToastHost() {
  const items = useToasts()
  // 屏上实际渲染的格子：store 移除的条目留在里面等退场，播完再摘。
  const [slots, setSlots] = useState<ToastItem[]>([])
  const fresh = items.filter((item) => {
    return !slots.some((slot) => {
      return slot.id === item.id
    })
  })
  if (fresh.length > 0) setSlots([...slots, ...fresh])

  const drop = useCallback((id: number) => {
    setSlots((prev) => {
      return prev.filter((item) => {
        return item.id !== id
      })
    })
  }, [])

  if (slots.length === 0) return null
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {slots.map((item) => (
        <ToastSlot
          key={item.id}
          item={item}
          live={items.some((live) => {
            return live.id === item.id
          })}
          onDone={drop}
        />
      ))}
    </div>
  )
}
