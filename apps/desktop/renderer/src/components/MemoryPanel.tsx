import { useCallback, useEffect, useState } from 'react'
import type { ApiClient, MemoryRow } from '../api.ts'
import { Icon } from './Icon.tsx'
import { Modal } from './Modal.tsx'

const KIND_LABELS: Record<MemoryRow['kind'], string> = {
  profile: '画像', fact: '事实', preference: '偏好', event: '事件',
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/**
 * 记忆面板（弹层）：某 agent 的私有记忆 + 共享画像列表。
 * kind 徽章 + 内容 + 时间 + 来源会话 + 软删按钮。
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

  const reload = useCallback(() => {
    api.listAgentMemories(agentId).then(setMemories).catch(() => { setMemories({ agent: [], shared: [] }) })
  }, [api, agentId])
  useEffect(reload, [reload])

  const remove = async (id: string): Promise<void> => {
    await api.deleteMemory(id).catch(() => {})
    reload()
  }

  const renderRow = (memory: MemoryRow, isShared: boolean) => (
    <li key={memory.id} className="memory-row">
      <span className={`memory-kind kind-${memory.kind}`}>{KIND_LABELS[memory.kind]}{isShared ? ' · 共享' : ''}</span>
      <span className="memory-content">{memory.content}</span>
      <span className="memory-meta">
        {formatDate(memory.updatedAt)}
        {memory.sourceConversationId !== undefined
          ? ` · ${conversationTitles.get(memory.sourceConversationId) ?? '会话'}`
          : ''}
      </span>
      <button className="memory-delete" title="删除（软删）" onClick={() => { void remove(memory.id) }}><Icon name="x" size={11} /></button>
    </li>
  )

  return (
    <Modal title={`${agentName} 的记忆`} onClose={onClose}>
      {memories === undefined ? (
        <p className="panel-empty">载入中…</p>
      ) : (
        <>
          {memories.shared.length > 0 && (
            <>
              <p className="section-title">共享画像（Ryen 了解你）</p>
              <ul className="memory-list">{memories.shared.map((m) => { return renderRow(m, true) })}</ul>
            </>
          )}
          <p className="section-title">{agentName} 的私有记忆（{memories.agent.length}）</p>
          {memories.agent.length === 0 && memories.shared.length === 0 ? (
            <p className="panel-empty">还没有记忆——多聊几轮，我会默默记住重要的事情。</p>
          ) : (
            <ul className="memory-list">{memories.agent.map((m) => { return renderRow(m, false) })}</ul>
          )}
        </>
      )}
    </Modal>
  )
}
