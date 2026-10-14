import { useEffect, useState } from 'react'
import type { AgentDef, MemoryRow, ProviderInfo } from '../api.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { Icon } from './Icon.tsx'
import { Modal } from './Modal.tsx'
import type { ProviderApi } from './ProviderSettings.tsx'
import { ProviderSettings } from './ProviderSettings.tsx'
import { WorkspaceSection } from './WorkspaceSection.tsx'

interface MeApi extends ProviderApi {
  listAgentMemories(agentId: string): Promise<{ agent: MemoryRow[]; shared: MemoryRow[] }>
  patchAgent(id: string, patch: Record<string, unknown>): Promise<{ agent: AgentDef }>
  workspace(): Promise<{ path: string }>
}

/**
 * 「我的」页：用户卡（你）、猫管家卡（Ryen，昵称可改）、工作区、供应商、共享画像、关于。
 *
 * 此前这一页只有一张卡，画的是 Ryen 的猫、写的是它的名字——页面叫「我的」，
 * 用户却找不到自己，编辑的还总是内置 agent 的名字。用户与 agent 是两件事，分开说。
 */
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
          <div className="me-usercard">
            <span className="me-avatar">
              <Avatar name="你" seed="you" size={96} />
            </span>
            <p className="me-name is-static">你</p>
            <p className="me-sub">这台电脑上的使用者 · 数据都在本机，不上传</p>
          </div>

          {ryen !== undefined && (
            <div className="me-section">
              <div className="me-row me-butler">
                <Avatar avatarKey={ryen.avatar} name={ryen.name} seed={ryen.id} size={44} />
                <div className="me-row-body">
                  {editingName ? (
                    <input
                      className="me-name-inline"
                      value={nameDraft}
                      aria-label="猫管家昵称"
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
                      className="me-row-title me-inline-edit"
                      title="给它改个昵称"
                      onClick={() => {
                        setNameDraft(ryen.name)
                        setEditingName(true)
                      }}
                    >
                      {ryen.name} <Icon name="pencil" size={12} className="me-pencil" />
                    </button>
                  )}
                  <div className="me-row-sub">猫管家总管 · 内置 Agent（改的是它的名字，不是你的）</div>
                </div>
                <span className="badge">内置</span>
              </div>
            </div>
          )}

          <div className="me-section">
            <WorkspaceSection api={api} />
          </div>

          <div className="me-section">
            <ProviderSettings
              api={api}
              providers={providers}
              onChanged={() => {
                onRyenPatched?.()
              }}
            />
          </div>

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
          <AboutContent />
        </Modal>
      )}
    </section>
  )
}

/**
 * 关于弹窗正文。单独导出是为了能被测试直接断言——署名写错是最难靠肉眼复查、
 * 又最容易在重构里悄悄漂移的一处（此前就署着早已不用的 Fluent Emoji 与四个
 * DiceBear 家族）。只写**实际在用**的资产，数量以 renderer 的注册表为准。
 */
export function AboutContent() {
  return (
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
        <li>应用图标与猫管家形象：本仓库原创（随本项目 MIT）</li>
        <li>
          Agent 头像：<strong>DiceBear</strong>（框架 MIT；本地生成，不联网）
        </li>
        <li>
          CC BY 4.0 署名：DiceBear <strong>Dylan!</strong>（人物）by Natalia Spivak；DiceBear <strong>Fun Emoji</strong>
          （吉祥物）by Davis Uche
        </li>
        <li>Agent 内核：cordis / cosmokit / schemastery（MIT，vendor 自上游）</li>
      </ul>
      <p className="about-note">完整许可文本见仓库 NOTICE.md 与 vendor/*/LICENSE。</p>
    </div>
  )
}
