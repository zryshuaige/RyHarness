import { useCallback, useEffect, useState } from 'react'
import type { ApiClient, PlaybookEntryRow, ReflectionRow } from '../api.ts'
import { Icon } from './Icon.tsx'
import { Modal } from './Modal.tsx'

const SECTION_LABELS: Record<PlaybookEntryRow['section'], string> = {
  strategy: '策略',
  pitfall: '坑',
  preference: '偏好',
  tooling: '工具用法',
}
const SECTION_ORDER: PlaybookEntryRow['section'][] = ['strategy', 'pitfall', 'preference', 'tooling']
const SOURCE_LABELS: Record<PlaybookEntryRow['source'], string> = {
  curator: '策展',
  reflection: '转正',
  seed: '种子',
  manual: '手动',
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/**
 * 经验手册面板（弹层）：playbook 条目按 section 分组（helpful/harmful
 * 计数、来源、状态、手动 deprecate/恢复）+ 待验证反思区块。
 */
export function PlaybookPanel({
  api,
  agentId,
  agentName,
  onClose,
}: {
  api: ApiClient
  agentId: string
  agentName: string
  onClose: () => void
}) {
  const [data, setData] = useState<{ entries: PlaybookEntryRow[]; reflections: ReflectionRow[] } | undefined>(undefined)

  const reload = useCallback(() => {
    api
      .getPlaybook(agentId)
      .then(setData)
      .catch(() => {
        setData({ entries: [], reflections: [] })
      })
  }, [api, agentId])
  useEffect(reload, [reload])

  const toggle = async (entry: PlaybookEntryRow): Promise<void> => {
    await api.setPlaybookStatus(entry.id, entry.status === 'active' ? 'deprecated' : 'active').catch(() => {})
    reload()
  }

  const net = (entry: PlaybookEntryRow): number => {
    return entry.helpful - entry.harmful
  }

  return (
    <Modal title={`${agentName} 的经验手册`} onClose={onClose}>
      {data === undefined ? (
        <p className="panel-empty">载入中…</p>
      ) : (
        <>
          {data.reflections.length > 0 && (
            <>
              <p className="section-title">反思中的教训（待验证，命中 {2} 次转正）</p>
              <ul className="memory-list">
                {data.reflections.map((reflection) => (
                  <li key={reflection.id} className="memory-row">
                    <span className="memory-kind kind-event">教训</span>
                    <span className="memory-content">{reflection.lesson}</span>
                    <span className="memory-meta">
                      命中 {reflection.hitCount}/2 · {formatDate(reflection.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {SECTION_ORDER.map((section) => {
            const entries = data.entries.filter((entry) => {
              return entry.section === section
            })
            if (entries.length === 0) return null
            return (
              <div key={section}>
                <p className="section-title">
                  {SECTION_LABELS[section]}（
                  {
                    entries.filter((e) => {
                      return e.status === 'active'
                    }).length
                  }{' '}
                  生效）
                </p>
                <ul className="memory-list">
                  {entries.map((entry) => (
                    <li key={entry.id} className={`memory-row ${entry.status === 'deprecated' ? 'is-deprecated' : ''}`}>
                      <span className="memory-content">{entry.content}</span>
                      <span className={`pb-count ${net(entry) >= 0 ? 'pos' : 'neg'}`} title="helpful - harmful">
                        +{entry.helpful}/-{entry.harmful}
                      </span>
                      <span className="memory-meta">{SOURCE_LABELS[entry.source]}</span>
                      <button
                        type="button"
                        className="memory-delete"
                        title={entry.status === 'active' ? '停用（软删）' : '恢复'}
                        onClick={() => {
                          void toggle(entry)
                        }}
                      >
                        <Icon name={entry.status === 'active' ? 'x' : 'check'} size={11} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
          {data.entries.length === 0 && data.reflections.length === 0 && (
            <p className="panel-empty">手册还是空的——多聊几轮，我会从轨迹里沉淀经验。</p>
          )}
        </>
      )}
    </Modal>
  )
}
