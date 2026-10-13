import { toast, useToasts } from '../lib/toast.ts'
import { Icon } from './Icon.tsx'

/** toast 宿主：挂在聊天视图底部，自动退场（退场 class 由样式表处理）。 */
export function ToastHost() {
  const items = useToasts()
  if (items.length === 0) return null
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast toast-${item.kind}`}>
          {item.kind === 'error' ? <Icon name="alert" size={14} /> : null}
          <span className="toast-text">{item.text}</span>
          <button
            type="button"
            className="toast-close"
            aria-label="关闭提示"
            onClick={() => {
              toast.dismiss(item.id)
            }}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
