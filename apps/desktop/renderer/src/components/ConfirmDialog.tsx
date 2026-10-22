/**
 * 危险操作确认弹窗（Modal 皮肤）。
 *
 * 此前删除 agent 走的是 `window.confirm` + 失败时 `window.alert`：系统弹窗脱离应用
 * 窗口、样式割裂、失败信息还把用户从自己的上下文里弹出去。改成应用内弹窗后，确认
 * 按钮天然拿到焦点陷阱，失败也能就地用 toast 说明。
 *
 * 失败时**不自动关闭**：原因要留在原地，用户能看清、能重试，而不是对着一个已经
 * 关掉的弹窗猜发生了什么。
 */
import { useState } from 'react'
import { humanError } from '../lib/error-text.ts'
import { toast } from '../lib/toast.ts'
import { Modal } from './Modal.tsx'

export function ConfirmDialog({
  title,
  body,
  confirmLabel = '删除',
  onConfirm,
  onCancel,
}: {
  title: string
  /** 会一起被删掉的东西、删不回来的后果，写清楚（不要承诺后端做不到的事）。 */
  body: string
  confirmLabel?: string
  onConfirm: () => Promise<void>
  onCancel: () => void
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="confirm-body">{body}</p>
      <div className="modal-actions">
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary btn-danger"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            onConfirm()
              .catch((error: unknown) => {
                // 弹窗自己不知道这次确认在做什么（关插件 / 删会话 / 删助理），
                // 所以给一句中性兜底，而不是把英文原话甩到 toast 上。
                toast.error(humanError(error, '这一步没能完成，再试一次'))
              })
              .finally(() => {
                setBusy(false)
              })
          }}
        >
          {busy ? '处理中' : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
