/**
 * 「归到项目」弹窗：把一个会话挂到某个工作区，或摘出来。
 *
 * **归属是真的会改变行为的**：会话归了哪个工作区，助理读写文件的边界就落在那儿
 * （见服务端的 `PATCH /api/conversations/:id/workspace`）。所以这个弹窗要说清
 * 「归过去之后，助理就在那个目录里干活了」，而不是只改个分组标签。
 *
 * 界面在「我的」页的工作区清单与这里共用同一份数据——挂到哪儿、那儿有谁，两边
 * 说的是同一件事。
 */
import { useCallback, useEffect, useState } from 'react'
import type { Conversation } from '../api.ts'
import { humanError } from '../lib/error-text.ts'
import { toast } from '../lib/toast.ts'
import { Modal } from './Modal.tsx'

/** 一个工作区。 */
export interface WorkspaceOption {
  readonly id: string
  readonly name: string
  readonly rootPath: string
  readonly sessionCount: number
  readonly rootExists: boolean
}

/** 这个弹窗要用的能力。 */
export interface WorkspacePickerApi {
  /** 列工作区。 */
  workspaces(): Promise<{ workspaces: WorkspaceOption[] }>
  /** 把会话归到某个工作区（传 null 就是摘出来）。 */
  assignWorkspace(conversationId: string, workspaceId: string | null): Promise<{ workspaceId: string | null }>
}

export function WorkspacePicker({
  api,
  conversation,
  onCancel,
  onAssigned,
}: {
  api: WorkspacePickerApi
  conversation: Conversation
  onCancel: () => void
  /** 归属改完之后通知宿主（重拉会话列表）。 */
  onAssigned: () => void
}) {
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .workspaces()
      .then((result) => {
        if (!cancelled) setWorkspaces(result.workspaces)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(`读不到工作区清单：${humanError(cause, '本机服务还没报出有哪些工作区')}`)
      })
    return () => {
      cancelled = true
    }
  }, [api])

  const assign = useCallback(
    async (workspaceId: string | null): Promise<void> => {
      setBusy(true)
      try {
        await api.assignWorkspace(conversation.id, workspaceId)
        toast.success(workspaceId === null ? '已从项目里摘出来' : '已归到项目')
        onAssigned()
      } catch (cause) {
        toast.error(`没归上：${humanError(cause, '本机服务没接受这次改动')}`)
      } finally {
        setBusy(false)
      }
    },
    [api, conversation.id, onAssigned],
  )

  return (
    <Modal title="归到项目" onClose={onCancel}>
      <p className="me-row-sub">归过去之后，助理读写文件的范围就落在那个目录里。没归的会话用默认工作区。</p>
      {error !== undefined ? <p className="apikey-error">{error}</p> : null}
      {workspaces === undefined ? (
        <p className="me-row-sub">正在读工作区…</p>
      ) : workspaces.length === 0 ? (
        <p className="me-row-sub">还没有工作区。到「我的」页的工作区那块加一个目录再来。</p>
      ) : (
        <ul className="workspace-picker-list">
          {workspaces.map((workspace) => (
            <li key={workspace.id} className="workspace-picker-item">
              <div className="workspace-item-body">
                <span className="workspace-item-name">{workspace.name}</span>
                <code className="workspace-path">{workspace.rootPath}</code>
                <span className="workspace-item-meta">
                  {workspace.rootExists ? '' : '（目录不见了）'}
                  {workspace.sessionCount > 0 ? ` · ${workspace.sessionCount} 个会话` : ''}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-mini"
                disabled={busy}
                onClick={() => {
                  void assign(workspace.id)
                }}
              >
                归到这里
              </button>
            </li>
          ))}
          <li className="workspace-picker-item">
            <div className="workspace-item-body">
              <span className="workspace-item-name">不归任何项目</span>
              <span className="workspace-item-meta">助理用默认工作区</span>
            </div>
            <button
              type="button"
              className="btn btn-mini"
              disabled={busy}
              onClick={() => {
                void assign(null)
              }}
            >
              摘出来
            </button>
          </li>
        </ul>
      )}
    </Modal>
  )
}
