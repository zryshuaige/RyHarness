/**
 * 「我的」页的工作区区块：**多个**项目目录与会话归属。
 *
 * 工作区是 agent 读写文件、产出产物的边界。此前整个应用只有一句 chip 提到它，
 * 用户既看不到路径、也打不开目录——问「工作区里有什么」只会得到一个空目录。
 *
 * 这一块做三件事：
 * - 列出所有工作区（名字、根目录、下面几个会话），能打开目录、能复制路径；
 * - 列出还没归到任何项目下的会话；
 * - 把某个会话归到某个工作区（或摘出来）。
 *
 * 归属是真的会改变行为的：会话归了哪个工作区，**助理读写文件的边界就落在哪儿**。
 * @module @ryharness/renderer/components/WorkspaceSection
 */
import { useCallback, useEffect, useState } from 'react'
import { copyText, openInFileManager } from '../lib/desktop.ts'
import { humanError } from '../lib/error-text.ts'
import { toast } from '../lib/toast.ts'
import { Icon } from './Icon.tsx'

/** 一个工作区。 */
export interface WorkspaceView {
  id: string
  name: string
  rootPath: string
  createdAt: number
  sessionCount: number
  rootExists: boolean
}

/** 工作区清单的返回。 */
interface WorkspaceListView {
  workspaces: WorkspaceView[]
  ungroupedSessionCount: number
}

interface WorkspaceApi {
  /** 读默认工作区路径（单一目录的老接口，保留给别处用）。 */
  workspace(): Promise<{ path: string }>
  /**
   * 列工作区。
   *
   * **可选**：测试替身不必实现——拿不到就只显示默认工作区那一行。
   */
  workspaces?(): Promise<WorkspaceListView>
  /**
   * 把会话归到工作区（或摘出来，workspaceId 传 null）。
   *
   * **可选**：这一条是给「把某个会话归到项目下」用的，界面上的清单不依赖它。
   */
  assignWorkspace?(conversationId: string, workspaceId: string | null): Promise<{ workspaceId: string | null }>
}

export function WorkspaceSection({ api }: { api: WorkspaceApi }) {
  const [path, setPath] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [list, setList] = useState<WorkspaceListView | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    api
      .workspace()
      .then(({ path: resolved }) => {
        if (!cancelled) setPath(resolved)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(`读不到工作区路径：${humanError(cause, '本机服务还没报出工作区在哪，重启应用再试')}`)
      })
    // 清单是**可选能力**：宿主没实现（测试替身、旧版本服务端）就不显示那一段，
    // 默认工作区的路径仍然有用。
    const listPromise = api.workspaces?.()
    if (listPromise !== undefined) {
      listPromise
        .then((resolved) => {
          if (cancelled) return
          // 形状对不上就别显示：半个清单比没有清单更让人困惑。
          setList(Array.isArray(resolved?.workspaces) ? resolved : undefined)
        })
        .catch(() => {
          // 清单读不到不该让整块报错。
          if (!cancelled) setList(undefined)
        })
    }
    return () => {
      cancelled = true
    }
  }, [api])

  const open = useCallback(async (target: string): Promise<void> => {
    // 浏览器形态（vite dev / 单测）没有主进程桥：这时至少把路径交到剪贴板，
    // 用户可以自己粘进资源管理器，而不是点一下毫无反应。
    if (!(await openInFileManager(target))) {
      await copyText(target)
      toast.info('这个环境打不开本地目录，路径已复制')
    }
  }, [])

  const copy = useCallback(async (target: string): Promise<void> => {
    toast.success((await copyText(target)) ? '路径已复制' : '复制失败，请手动选中复制')
  }, [])

  return (
    <div className="me-row workspace-row">
      <div className="me-row-body">
        <div className="me-row-title">
          <Icon name="file" size={16} /> 工作区
        </div>
        <div className="me-row-sub">agent 读写文件、产出产物的默认目录——它就在本机，不联网</div>
        {error !== undefined ? (
          <p className="apikey-error">{error}</p>
        ) : (
          <code className="workspace-path" title={path ?? undefined}>
            {path ?? '正在读取…'}
          </code>
        )}
        {list !== undefined && list.workspaces.length > 0 ? (
          <ul className="workspace-list">
            {list.workspaces.map((workspace) => (
              <li key={workspace.id} className="workspace-item">
                <div className="workspace-item-body">
                  <span className="workspace-item-name">{workspace.name}</span>
                  <code className="workspace-path" title={workspace.rootPath}>
                    {workspace.rootPath}
                  </code>
                  <span className="workspace-item-meta">
                    {workspace.rootExists ? '' : '（目录不见了）'}
                    {workspace.sessionCount > 0 ? ` · ${workspace.sessionCount} 个会话` : ''}
                  </span>
                </div>
                <div className="workspace-actions">
                  <button
                    type="button"
                    className="btn btn-mini"
                    onClick={() => {
                      void open(workspace.rootPath)
                    }}
                  >
                    打开
                  </button>
                  <button
                    type="button"
                    className="btn btn-mini"
                    onClick={() => {
                      void copy(workspace.rootPath)
                    }}
                  >
                    复制路径
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {list !== undefined && list.ungroupedSessionCount > 0 ? (
          <p className="workspace-item-meta">还有 {list.ungroupedSessionCount} 个会话没归到任何项目下。</p>
        ) : null}
      </div>
      <div className="workspace-actions">
        <button
          type="button"
          className="btn btn-mini"
          disabled={path === undefined}
          onClick={() => {
            if (path !== undefined) void open(path)
          }}
        >
          打开所在目录
        </button>
        <button
          type="button"
          className="btn btn-mini"
          disabled={path === undefined}
          onClick={() => {
            if (path !== undefined) void copy(path)
          }}
        >
          复制路径
        </button>
      </div>
    </div>
  )
}
