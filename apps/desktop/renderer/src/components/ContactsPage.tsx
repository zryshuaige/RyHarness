import { useState } from 'react'
import type { AgentDef, AgentTemplate, ProviderInfo } from '../api.ts'
import { stagger } from '../lib/stagger.ts'
import { toast } from '../lib/toast.ts'
import { ALL_TOOLS, toolLabel } from '../lib/tool-labels.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { AVATAR_STYLES, dicebearSvg, randomAvatarSpec } from './avatars/avatars.tsx'
import { Cat } from './Cat.tsx'
import { Icon } from './Icon.tsx'
import { Modal } from './Modal.tsx'

/** 头像选择器：预置 SVG 库网格预览。 */
/** 头像选择器：DiceBear 风格画廊 + 随机换一批。 */
export function AvatarPicker({
  value,
  onChange,
}: {
  /** `db:{style}:{seed}` 或 'cat'。 */
  value: string
  onChange: (spec: string) => void
}) {
  const current = parsePickerValue(value)
  return (
    <div className="avatar-picker-wrap">
      <div className="avatar-picker-preview">
        <Avatar avatarKey={`db:${current.styleKey}:${current.seed}`} name="预览" size={64} />
        <div className="avatar-picker-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              onChange(randomAvatarSpec())
            }}
          >
            <Icon name="dices" size={14} /> 换一批
          </button>
          <small>
            当前：
            {AVATAR_STYLES.find((s) => {
              return s.key === current.styleKey
            })?.name ?? current.styleKey}
          </small>
        </div>
      </div>
      <div className="avatar-picker" role="radiogroup" aria-label="选择风格">
        {AVATAR_STYLES.map((style) => {
          const preview = dicebearSvg(style.key, current.seed) ?? ''
          return (
            // biome-ignore lint/a11y/useSemanticElements: 卡片式单选，原生 radio 样式无法满足设计
            <button
              key={style.key}
              type="button"
              role="radio"
              aria-checked={current.styleKey === style.key}
              className={current.styleKey === style.key ? 'is-selected' : ''}
              title={`${style.name}（${style.license === 'CC0-1.0' ? 'CC0 公有领域' : 'CC BY 4.0'}）`}
              onClick={() => {
                onChange(`db:${style.key}:${current.seed}`)
              }}
            >
              <span className="avatar-cell">
                <span
                  style={{ width: 40, height: 40, display: 'inline-flex', borderRadius: '50%', overflow: 'hidden' }}
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: 头像预览为本地生成的 SVG，无外部输入
                  dangerouslySetInnerHTML={{ __html: preview.replace('<svg', '<svg width="40" height="40"') }}
                />
                <small>{style.name}</small>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function parsePickerValue(value: string): { styleKey: string; seed: string } {
  const match = /^db:([a-zA-Z]+):(.+)$/.exec(value)
  if (match !== null && match[1] !== undefined && match[2] !== undefined) {
    return { styleKey: match[1], seed: match[2] }
  }
  return { styleKey: 'lorelei', seed: Math.random().toString(36).slice(2, 10) }
}

/** 通讯录：agent 卡片网格（Ryen 置顶）+ 新建/建群入口。 */
export function ContactsPage({
  agents,
  templates,
  onChat,
  onCreateAgent,
  onEditAgent,
  onDeleteAgent,
  onCreateGroup,
}: {
  agents: AgentDef[]
  templates: AgentTemplate[]
  providers: ProviderInfo[]
  onChat: (agentId: string) => void
  /** 传入模板 key 时以该模板为初始值新建（此前恒为第一个模板，等于假按钮）。 */
  onCreateAgent: (templateKey?: string) => void
  onEditAgent: (agent: AgentDef) => void
  onDeleteAgent: (agent: AgentDef) => void
  onCreateGroup: () => void
}) {
  const sorted = [...agents].sort((a, b) => {
    if (a.id === 'ryen') return -1
    if (b.id === 'ryen') return 1
    return a.name.localeCompare(b.name)
  })
  return (
    <section className="page">
      <header className="page-header">
        <h2>通讯录</h2>
        <div className="page-actions">
          <button type="button" className="btn" onClick={onCreateGroup}>
            <Icon name="group" size={15} /> 建群
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              onCreateAgent()
            }}
          >
            <Icon name="plus" size={15} /> 新建 Agent
          </button>
        </div>
      </header>
      <div className="page-scroll">
        <div className="page-scroll-col">
          {sorted.length === 0 ? (
            <div className="empty-state">
              <span className="empty-cat">
                <Cat mood="thinking" size={88} />
              </span>
              <h3>通讯录还是空的</h3>
              <p>从模板新建一位 agent 吧，挑个顺眼的头像。</p>
            </div>
          ) : (
            <>
              <p className="section-title">我的 Agent（{sorted.length}）</p>
              <div className="contact-grid">
                <button
                  type="button"
                  className="contact-card contact-create"
                  style={stagger(0)}
                  onClick={() => {
                    onCreateAgent()
                  }}
                >
                  <span className="contact-create-icon">
                    <Icon name="plus" size={22} />
                  </span>
                  <h3>新建 Agent</h3>
                  <p className="contact-prompt">从模板开始，挑头像、定人设</p>
                </button>
                {sorted.map((agent, index) => (
                  <article key={agent.id} className="contact-card" style={stagger(index + 1)}>
                    <Avatar avatarKey={agent.avatar} name={agent.name} seed={agent.id} size={56} />
                    <h3>
                      {agent.name}
                      {agent.isBuiltin && <span className="badge">内置</span>}
                    </h3>
                    <p className="contact-model">
                      {agent.provider} / {agent.model}
                    </p>
                    <p className="contact-prompt">{agent.systemPrompt.slice(0, 48)}…</p>
                    <div className="contact-actions">
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => {
                          onChat(agent.id)
                        }}
                      >
                        发消息
                      </button>
                      {!agent.isBuiltin && (
                        <>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => {
                              onEditAgent(agent)
                            }}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger"
                            onClick={() => {
                              onDeleteAgent(agent)
                            }}
                          >
                            删除
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              <p className="section-title" style={{ marginTop: 24 }}>
                可用模板（{templates.length}）
              </p>
              <div className="template-rail">
                {templates.map((template, index) => (
                  <button
                    type="button"
                    key={template.key}
                    className="template-card"
                    style={stagger(index)}
                    onClick={() => {
                      onCreateAgent(template.key)
                    }}
                  >
                    <strong>{template.name}</strong>
                    <span>{template.description}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

/** 新建/编辑 Agent：选模板 → 编辑表单（含头像选择器）。内容区可滚动，操作条吸底。 */
export function CreateAgentModal({
  templates,
  providers,
  initialTemplateKey,
  editing,
  onSubmit,
  onClose,
}: {
  templates: AgentTemplate[]
  providers: ProviderInfo[]
  /** 初始模板（通讯录模板轨点进来时带 key）。 */
  initialTemplateKey?: string
  /** 非空 = 编辑既有 agent（此时模板选择隐藏，保存走 PATCH）。 */
  editing?: AgentDef
  onSubmit: (input: Record<string, unknown>) => Promise<void>
  onClose: () => void
}) {
  const [templateKey, setTemplateKey] = useState(initialTemplateKey ?? templates[0]?.key ?? 'general')
  const template = templates.find((t) => {
    return t.key === templateKey
  })
  const [name, setName] = useState(editing?.name ?? '')
  const [avatarKey, setAvatarKey] = useState(() => {
    return editing?.avatar ?? randomAvatarSpec()
  })
  const [systemPrompt, setSystemPrompt] = useState(editing?.systemPrompt ?? template?.suggestedSystemPrompt ?? '')
  const [provider, setProvider] = useState(editing?.provider ?? providers[0]?.id ?? 'siliconflow')
  const [model, setModel] = useState(editing?.model ?? template?.defaultModel ?? '')
  const [tools, setTools] = useState<string[]>(editing?.tools ?? template?.defaultTools ?? [])
  const [busy, setBusy] = useState(false)

  const pickTemplate = (key: string): void => {
    setTemplateKey(key)
    const next = templates.find((t) => {
      return t.key === key
    })
    if (next === undefined) return
    setSystemPrompt(next.suggestedSystemPrompt)
    setModel(next.defaultModel)
    setTools(next.defaultTools)
  }

  const models =
    providers.find((p) => {
      return p.id === provider
    })?.models ?? []

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      await onSubmit({
        ...(editing === undefined ? { templateKey } : {}),
        name: name || editing?.name || template?.name,
        avatar: avatarKey,
        systemPrompt,
        provider,
        model: model || models[0]?.id,
        tools,
      })
      onClose()
    } catch (error) {
      // 保存失败不能悄悄关窗：用户会以为已经建好。留在原地并说清原因。
      toast.error(
        `${editing === undefined ? '创建' : '保存'}失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={editing === undefined ? '新建 Agent' : `编辑 ${editing.name}`} onClose={onClose}>
      <div className="modal-scroll">
        {editing === undefined && (
          <label className="field">
            <span>从模板开始</span>
            <select
              value={templateKey}
              onChange={(e) => {
                pickTemplate(e.target.value)
              }}
            >
              {templates.map((t) => {
                return (
                  <option key={t.key} value={t.key}>
                    {t.name} — {t.description}
                  </option>
                )
              })}
            </select>
          </label>
        )}
        <div className="field-row">
          <label className="field">
            <span>名字</span>
            <input
              value={name}
              placeholder={template?.name}
              onChange={(e) => {
                setName(e.target.value)
              }}
            />
          </label>
        </div>
        <fieldset className="field">
          <span>头像</span>
          <AvatarPicker value={avatarKey} onChange={setAvatarKey} />
        </fieldset>
        <label className="field">
          <span>人设（system prompt）</span>
          <textarea
            rows={5}
            value={systemPrompt}
            onChange={(e) => {
              setSystemPrompt(e.target.value)
            }}
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>供应商</span>
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value)
              }}
            >
              {providers.map((p) => {
                return (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                    {p.apiKeyConfigured ? '' : '（未配置 key）'}
                  </option>
                )
              })}
            </select>
          </label>
          <label className="field">
            <span>模型</span>
            <select
              value={model}
              onChange={(e) => {
                setModel(e.target.value)
              }}
            >
              {models.map((m) => {
                return (
                  <option key={m.id} value={m.id}>
                    {m.name ?? m.id}
                  </option>
                )
              })}
            </select>
          </label>
        </div>
        <fieldset className="field">
          <span>工具白名单</span>
          <div className="tool-checks">
            {ALL_TOOLS.map((tool) => (
              <label key={tool}>
                <input
                  type="checkbox"
                  checked={tools.includes(tool)}
                  onChange={(e) => {
                    setTools(
                      e.target.checked
                        ? [...tools, tool]
                        : tools.filter((t) => {
                            return t !== tool
                          }),
                    )
                  }}
                />
                {toolLabel(tool)}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="modal-actions modal-actions-sticky">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => {
            void submit()
          }}
        >
          {editing === undefined ? '保存' : '保存修改'}
        </button>
      </div>
    </Modal>
  )
}

/** 建群：多选成员 + 群名 + 调度员。 */
export function CreateGroupModal({
  agents,
  onSubmit,
  onClose,
}: {
  agents: AgentDef[]
  onSubmit: (input: { memberAgentIds: string[]; dispatcherAgentId: string; title: string }) => Promise<void>
  onClose: () => void
}) {
  const [selected, setSelected] = useState<string[]>(
    agents
      .filter((a) => {
        return a.id === 'ryen'
      })
      .map((a) => {
        return a.id
      }),
  )
  const [dispatcher, setDispatcher] = useState('ryen')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const toggle = (id: string): void => {
    setSelected((prev) => {
      return prev.includes(id)
        ? prev.filter((x) => {
            return x !== id
          })
        : [...prev, id]
    })
  }

  const submit = async (): Promise<void> => {
    if (selected.length === 0) return
    setBusy(true)
    try {
      await onSubmit({ memberAgentIds: selected, dispatcherAgentId: dispatcher, title: title || '群聊' })
      onClose()
    } catch (error) {
      toast.error(`建群失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="新建群聊" onClose={onClose}>
      <label className="field">
        <span>群名</span>
        <input
          value={title}
          placeholder="群聊"
          onChange={(e) => {
            setTitle(e.target.value)
          }}
        />
      </label>
      <fieldset className="field">
        <span>选择成员</span>
        <div className="member-checks">
          {agents.map((agent) => (
            <label key={agent.id}>
              <input
                type="checkbox"
                checked={selected.includes(agent.id)}
                onChange={() => {
                  toggle(agent.id)
                }}
              />
              <Avatar avatarKey={agent.avatar} name={agent.name} seed={agent.id} size={22} />
              <span className="member-label">
                <span className="member-name">{agent.name}</span>
                <small className="member-sub">
                  {agent.provider} · {agent.systemPrompt.slice(0, 18)}
                </small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span>调度员（无 @ 消息的默认响应者）</span>
        <select
          value={dispatcher}
          onChange={(e) => {
            setDispatcher(e.target.value)
          }}
        >
          {selected.map((id) => {
            const agent = agents.find((a) => {
              return a.id === id
            })
            return agent === undefined ? null : (
              <option key={id} value={id}>
                {agent.name}
              </option>
            )
          })}
        </select>
      </label>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || selected.length === 0}
          onClick={() => {
            void submit()
          }}
        >
          创建
        </button>
      </div>
    </Modal>
  )
}
