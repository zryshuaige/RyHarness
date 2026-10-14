import { useCallback, useEffect, useState } from 'react'
import type { ApiClient, MemoryRow } from '../api.ts'
import { toast } from '../lib/toast.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { Icon } from './Icon.tsx'
import { Modal } from './Modal.tsx'
import { PanelSkeleton } from './Skeleton.tsx'

const KIND_LABELS: Record<MemoryRow['kind'], string> = {
  profile: '画像',
  fact: '事实',
  preference: '偏好',
  event: '事件',
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/**
 * 记忆面板（弹层）：某 agent 的私有记忆 + 共享画像列表。
 * kind 徽章 + 内容 + 时间 + 来源会话 + 软删按钮。
 * 底部：已归档分区（可折叠、可恢复）与「重建向量索引」（embedding 模型变更后的回填）。
 */
export function MemoryPanel({
  api,
  agentId,
  agentName,
  conversationTitles,
  onClose,
}: {
  api: ApiClient
  agentId: string
  agentName: string
  /** 会话 id → 标题（来源会话显示用）。 */
  conversationTitles: Map<string, string>
  onClose: () => void
}) {
  const [memories, setMemories] = useState<{ agent: MemoryRow[]; shared: MemoryRow[] } | undefined>(undefined)
  const [archived, setArchived] = useState<MemoryRow[] | undefined>(undefined)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [restoringId, setRestoringId] = useState<string | undefined>(undefined)
  const [confirmingReembed, setConfirmingReembed] = useState(false)
  const [reembedding, setReembedding] = useState(false)

  const reload = useCallback(() => {
    api
      .listAgentMemories(agentId)
      .then(setMemories)
      .catch(() => {
        setMemories({ agent: [], shared: [] })
      })
  }, [api, agentId])
  const reloadArchived = useCallback(() => {
    api
      .listArchivedMemories()
      .then(({ items }) => {
        setArchived(
          items.filter((item) => {
            return item.agentId === agentId
          }),
        )
      })
      .catch(() => {
        setArchived([])
      })
  }, [api, agentId])
  useEffect(() => {
    reload()
    reloadArchived()
  }, [reload, reloadArchived])

  const remove = async (id: string): Promise<void> => {
    await api.deleteMemory(id).catch(() => {})
    reload()
  }

  const restore = async (id: string): Promise<void> => {
    setRestoringId(id)
    try {
      await api.restoreMemory(id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setRestoringId(undefined)
    }
    reload()
    reloadArchived()
  }

  const reembed = async (): Promise<void> => {
    setReembedding(true)
    try {
      await api.reembedMemories()
      toast.success('向量索引已重建')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setReembedding(false)
      setConfirmingReembed(false)
    }
  }

  const renderRow = (memory: MemoryRow, isShared: boolean) => (
    <li key={memory.id} className="memory-row">
      <span className={`memory-kind kind-${memory.kind}`}>
        {KIND_LABELS[memory.kind]}
        {isShared ? ' · 共享' : ''}
      </span>
      <span className="memory-content">{memory.content}</span>
      <span className="memory-meta">
        {formatDate(memory.updatedAt)}
        {memory.sourceConversationId !== undefined
          ? ` · ${conversationTitles.get(memory.sourceConversationId) ?? '会话'}`
          : ''}
      </span>
      <button
        type="button"
        className="memory-delete"
        title="删除（软删）"
        onClick={() => {
          void remove(memory.id)
        }}
      >
        <Icon name="x" size={11} />
      </button>
    </li>
  )

  return (
    <Modal title={`${agentName} 的记忆`} onClose={onClose}>
      {memories === undefined ? (
        <PanelSkeleton rows={4} />
      ) : (
        <>
          {memories.shared.length > 0 && (
            <>
              <p className="section-title">共享画像（Ryen 了解你）</p>
              <ul className="memory-list">
                {memories.shared.map((m) => {
                  return renderRow(m, true)
                })}
              </ul>
            </>
          )}
          <p className="section-title">
            {agentName} 的私有记忆（{memories.agent.length}）
          </p>
          {memories.agent.length === 0 && memories.shared.length === 0 ? (
            <p className="panel-empty">还没有记忆——多聊几轮，我会默默记住重要的事情。</p>
          ) : (
            <ul className="memory-list">
              {memories.agent.map((m) => {
                return renderRow(m, false)
              })}
            </ul>
          )}
          {archived !== undefined && archived.length > 0 && (
            <div className="memory-archived">
              <button
                type="button"
                className="memory-archived-toggle"
                aria-expanded={archivedOpen}
                onClick={() => {
                  setArchivedOpen((open) => {
                    return !open
                  })
                }}
              >
                <span className="memory-chevron">
                  <Icon name="chevron-right" size={12} />
                </span>
                已归档（{archived.length}）
              </button>
              {archivedOpen && (
                <ul className="memory-list">
                  {archived.map((memory) => {
                    return (
                      <li key={memory.id} className="memory-row is-archived">
                        <span className={`memory-kind kind-${memory.kind}`}>{KIND_LABELS[memory.kind]}</span>
                        <span className="memory-content">{memory.content}</span>
                        <span className="memory-meta">{formatDate(memory.updatedAt)}</span>
                        <button
                          type="button"
                          className="memory-restore"
                          disabled={restoringId === memory.id}
                          onClick={() => {
                            void restore(memory.id)
                          }}
                        >
                          {restoringId === memory.id ? '恢复中' : '恢复'}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}
          <div className="memory-footer">
            <p className="memory-footer-hint">更换 embedding 模型后，重建一次让旧记忆重新可被检索。</p>
            <button
              type="button"
              className="btn memory-reembed"
              disabled={reembedding}
              onClick={() => {
                setConfirmingReembed(true)
              }}
            >
              {reembedding ? '重建中…' : '重建向量索引'}
            </button>
          </div>
        </>
      )}
      {confirmingReembed && (
        <ConfirmDialog
          title="重建向量索引？"
          body="会为全部记忆重新生成检索向量，记忆越多耗时越长，期间检索可能暂时变慢。"
          confirmLabel="重建"
          onConfirm={reembed}
          onCancel={() => {
            setConfirmingReembed(false)
          }}
        />
      )}
    </Modal>
  )
}
