import { useEffect, useState } from 'react'
import type { AgentDef, MemoryRow, ProviderInfo } from '../api.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { Icon } from './Icon.tsx'
import { Modal } from './Modal.tsx'

interface MeApi {
  listAgentMemories(agentId: string): Promise<{ agent: MemoryRow[]; shared: MemoryRow[] }>
  patchAgent(id: string, patch: Record<string, unknown>): Promise<{ agent: AgentDef }>
  setApiKey(providerId: string, apiKey: string): Promise<{ providerId: string; configured: boolean }>
}

/**
 * 供应商行：可展开。未配置凭据时直接在这里填 key（此前只有一行不可点的
 * 状态文字 + 一个点不动的箭头，比没有还糟）。
 */
function ProviderRow({ provider, api, onSaved }: { provider: ProviderInfo; api: MeApi; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  return (
    <div className="me-row provider-row">
      <button
        type="button"
        className="me-row-btn provider-row-head"
        aria-expanded={open}
        onClick={() => {
          setOpen((prev) => {
            return !prev
          })
        }}
      >
        <span className={`status-dot ${provider.apiKeyConfigured ? 'ok' : 'warn'}`} aria-hidden="true" />
        <span className="me-row-body">
          <span className="me-row-title">{provider.displayName}</span>
          <span className="me-row-sub">
            {provider.apiKeyConfigured ? `已配置 key · ${provider.models.length} 个模型` : '未配置 key——点这里填上'}
          </span>
        </span>
        <span className="me-chevron" aria-hidden="true">
          {open ? '⌄' : '›'}
        </span>
      </button>
      {open && (
        <div className="provider-detail">
          {provider.apiKeyConfigured ? (
            <ul className="model-list">
              {provider.models.map((model) => {
                return (
                  <li key={model.id}>
                    {model.name ?? model.id}
                    <small>{model.id}</small>
                  </li>
                )
              })}
            </ul>
          ) : (
            <>
              <div className="apikey-row">
                <input
                  type="password"
                  value={key}
                  placeholder="粘贴 API Key"
                  autoComplete="off"
                  onChange={(event) => {
                    setKey(event.target.value)
                  }}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || key.trim().length === 0}
                  onClick={() => {
                    setBusy(true)
                    setError(undefined)
                    api
                      .setApiKey(provider.id, key.trim())
                      .then(() => {
                        setKey('')
                        onSaved()
                      })
                      .catch((cause: unknown) => {
                        setError(cause instanceof Error ? cause.message : String(cause))
                      })
                      .finally(() => {
                        setBusy(false)
                      })
                  }}
                >
                  {busy ? '保存中' : '保存'}
                </button>
              </div>
              {error !== undefined && <p className="apikey-error">{error}</p>}
              <p className="provider-note">Key 只写在本机配置文件（api-keys.json，权限 0600）。</p>
            </>
          )}
        </div>
      )}
    </div>
  )
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
  const [showAbout, setShowAbout] = useState(false)
  useEffect(() => {
    if (ryen === undefined) return
    api
      .listAgentMemories(ryen.id)
      .then(({ shared: profile }) => {
        setShared(profile)
      })
      .catch(() => {
        setShared([])
      })
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
                  // biome-ignore lint/a11y/noAutofocus: 点击昵称进入行内编辑，聚焦输入框是预期行为
                  autoFocus
                  onChange={(e) => {
                    setNameDraft(e.target.value)
                  }}
                  onBlur={() => {
                    void saveName()
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveName()
                    if (e.key === 'Escape') setEditingName(false)
                  }}
                />
              ) : (
                <button
                  type="button"
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
                <button
                  type="button"
                  className={theme === 'light' ? 'is-active' : ''}
                  onClick={() => {
                    onThemeChange('light')
                  }}
                >
                  <Icon name="sun" size={14} /> 浅色
                </button>
                <button
                  type="button"
                  className={theme === 'dark' ? 'is-active' : ''}
                  onClick={() => {
                    onThemeChange('dark')
                  }}
                >
                  <Icon name="moon" size={14} /> 暗色
                </button>
              </span>
            </div>
            {providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                api={api}
                onSaved={() => {
                  onRyenPatched?.()
                }}
              />
            ))}
            <button
              type="button"
              className="me-row me-row-btn"
              onClick={() => {
                setShowAbout(true)
              }}
            >
              <div className="me-row-body">
                <div className="me-row-title">关于 RyAgent</div>
                <div className="me-row-sub">版本、开源许可与第三方署名</div>
              </div>
              <span className="me-chevron" aria-hidden="true">
                ›
              </span>
            </button>
            <div className="me-row" style={{ alignItems: 'flex-start' }}>
              <div className="me-row-body">
                <div className="me-row-title">
                  <Icon name="brain" size={15} /> {ryen?.name ?? 'Ryen'} 了解你
                </div>
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
      {showAbout && (
        <Modal
          title="关于 RyAgent"
          onClose={() => {
            setShowAbout(false)
          }}
        >
          <div className="about-body">
            <p>
              <strong>RyAgent</strong> v0.1.0 · 单机多 Agent 即时通讯桌面应用
            </p>
            <p>
              本体以 <strong>MIT License</strong> 发布（见仓库 LICENSE）。
            </p>
            <p className="about-heading">第三方资产与署名</p>
            <ul className="about-list">
              <li>
                界面图标：<strong>Lucide</strong>（ISC License）
              </li>
              <li>
                应用图标与欢迎页图形：<strong>Microsoft Fluent Emoji</strong>（MIT License）
              </li>
              <li>
                Agent 头像：<strong>DiceBear</strong>（框架 MIT；lorelei / notionists / thumbs 为 CC0 1.0）
              </li>
              <li>
                CC BY 4.0 署名：DiceBear <strong>Adventurer</strong> by Lisa Wischofsky；DiceBear{' '}
                <strong>Big Ears</strong> by The Visual Team；DiceBear <strong>Fun Emoji</strong> by Davis Uche
              </li>
              <li>Agent 内核：cordis / cosmokit / schemastery（MIT，vendor 自上游）</li>
            </ul>
            <p className="about-note">完整许可文本见仓库 NOTICE.md 与 vendor/*/LICENSE。</p>
          </div>
        </Modal>
      )}
    </section>
  )
}
