/**
 * 「我的」页的工作区区块。
 *
 * 工作区是 agent 读写文件、产出产物的默认目录，此前整个应用只有欢迎页一句 chip
 * 提到它，用户既看不到路径、也打不开目录——问「工作区里有什么」只会得到一个空目录。
 * 这里把路径亮出来，并给出"打开所在目录 / 复制路径"两个出口。路径由服务端
 * （GET /api/workspace）给出，渲染层不自己拼，避免与服务端解析口径漂移。
 */
import { useCallback, useEffect, useState } from 'react'
import { copyText, openInFileManager } from '../lib/desktop.ts'
import { humanError } from '../lib/error-text.ts'
import { toast } from '../lib/toast.ts'
import { Icon } from './Icon.tsx'

interface WorkspaceApi {
  workspace(): Promise<{ path: string }>
}

export function WorkspaceSection({ api }: { api: WorkspaceApi }) {
  const [path, setPath] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

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
    return () => {
      cancelled = true
    }
  }, [api])

  const open = useCallback(async (): Promise<void> => {
    if (path === undefined) return
    // 浏览器形态（vite dev / 单测）没有主进程桥：这时至少把路径交到剪贴板，
    // 用户可以自己粘进资源管理器，而不是点一下毫无反应。
    if (!(await openInFileManager(path))) {
      await copyText(path)
      toast.info('这个环境打不开本地目录，路径已复制')
    }
  }, [path])

  const copy = useCallback(async (): Promise<void> => {
    if (path === undefined) return
    toast.success((await copyText(path)) ? '路径已复制' : '复制失败，请手动选中复制')
  }, [path])

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
      </div>
      <div className="workspace-actions">
        <button
          type="button"
          className="btn btn-mini"
          disabled={path === undefined}
          onClick={() => {
            void open()
          }}
        >
          打开所在目录
        </button>
        <button
          type="button"
          className="btn btn-mini"
          disabled={path === undefined}
          onClick={() => {
            void copy()
          }}
        >
          复制路径
        </button>
      </div>
    </div>
  )
}
