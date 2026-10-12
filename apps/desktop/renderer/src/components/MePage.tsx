import { useEffect, useState } from 'react'
import type { AgentDef, MemoryRow, ProviderInfo } from '../api.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { Icon } from './Icon.tsx'

interface MeApi {
  listAgentMemories(agentId: string): Promise<{ agent: MemoryRow[]; shared: MemoryRow[] }>
  patchAgent(id: string, patch: Record<string, unknown>): Promise<{ agent: AgentDef }>
}

/** 「我的」页：用户卡（昵称可编辑）、设置分组、供应商状态灯、共享画像、关于。 */
export function MePage({
  api,
  ryen,
  providers,
  theme,
  onThemeChange,
  onRyenPatched,
}: {
  api: MeApi
  ryen: AgentDef | undefined
  providers: ProviderInfo[]
  theme: 'light' | 'dark'
  onThemeChange: (theme: 'light' | 'dark') => void
  onRyenPatched?: () => void
}) {
  const [shared, setShared] = useState<MemoryRow[] | undefined>(undefined)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  useEffect(() => {
    if (ryen === undefined) return
    api.listAgentMemories(ryen.id)
      .then(({ shared: profile }) => { setShared(profile) })
      .catch(() => { setShared([]) })
  }, [api, ryen])

  const saveName = async (): Promise<void> => {
    if (ryen === undefined) return
    const trimmed = nameDraft.trim()
    setEditingName(false)
    if (trimmed.length === 0 || trimmed === ryen.name) return
    await api.patchAgent(ryen.id, { name: trimmed }).catch(() => {})
    onRyenPatched?.()
  }

  return (
    <section className="page">
      <header className="page-header">
        <h2>我的</h2>
      </header>
      <div className="page-scroll">
        <div className="page-scroll-col me-page">
          {ryen !== undefined && (
            <div className="me-usercard">
              <span className="me-avatar">
                <Avatar avatarKey={ryen.avatar} name={ryen.name} seed={ryen.id} size={96} />
              </span>
              {editingName ? (
                <input
                  className="me-name-input"
                  value={nameDraft}
                  autoFocus
                  onChange={(e) => { setNameDraft(e.target.value) }}
                  onBlur={() => { void saveName() }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveName()
                    if (e.key === 'Escape') setEditingName(false)
                  }}
                />
              ) : (
                <button
                  className="me-name"
                  title="点击修改昵称"
                  onClick={() => {
                    setNameDraft(ryen.name)
                    setEditingName(true)
                  }}
                >
                  {ryen.name} <Icon name="pencil" size={14} className="me-pencil" />
                </button>
              )}
              <p className="me-sub">你的猫管家总管 · 内置 Agent</p>
            </div>
          )}

          <div className="me-section">
            <div className="me-row">
              <div className="me-row-body">
                <div className="me-row-title">外观主题</div>
                <div className="me-row-sub">暖琥珀浅色 / 暖黑暗色</div>
              </div>
              <span className="theme-toggle" role="radiogroup" aria-label="主题">
                <button className={theme === 'light' ? 'is-active' : ''} onClick={() => { onThemeChange('light') }}><Icon name="sun" size={14} /> 浅色</button>
                <button className={theme === 'dark' ? 'is-active' : ''} onClick={() => { onThemeChange('dark') }}><Icon name="moon" size={14} /> 暗色</button>
              </span>
            </div>
            {providers.map((provider) => (
              <div key={provider.id} className="me-row">
                <span className={`status-dot ${provider.apiKeyConfigured ? 'ok' : 'warn'}`} aria-hidden="true" />
                <div className="me-row-body">
                  <div className="me-row-title">{provider.displayName}</div>
                  <div className="me-row-sub">
                    {provider.apiKeyConfigured
                      ? `已配置 key · ${provider.models.length} 个模型`
                      : '未配置 key——设置 SILICONFLOW_API_KEY 环境变量后重启'}
                  </div>
                </div>
                <span className="me-chevron" aria-hidden="true">›</span>
              </div>
            ))}
            <div className="me-row">
              <div className="me-row-body">
                <div className="me-row-title">关于 RyAgent</div>
                <div className="me-row-sub">精简 agent 内核 + 社交化桌面 · 本地数据 SQLite</div>
              </div>
              <span className="me-chevron" aria-hidden="true">›</span>
            </div>
            <div className="me-row" style={{ alignItems: 'flex-start' }}>
              <div className="me-row-body">
                <div className="me-row-title"><Icon name="brain" size={15} /> {ryen?.name ?? 'Ryen'} 了解你</div>
                <div className="me-row-sub">共享画像——从你们的对话中沉淀，注入每轮记忆</div>
                {shared !== undefined && (
                  <ul className="memory-list" style={{ marginTop: 8 }}>
                    {shared.length === 0 && <li className="panel-empty">还没有画像，聊几轮就有了。</li>}
                    {shared.map((memory) => (
                      <li key={memory.id} className="memory-row">
                        <span className={`memory-kind kind-${memory.kind}`}>{memory.kind}</span>
                        <span className="memory-content">{memory.content}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
