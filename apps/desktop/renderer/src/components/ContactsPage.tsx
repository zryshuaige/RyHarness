import { useState } from 'react'
import type { AgentDef, AgentTemplate, ProviderInfo } from '../api.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { AVATARS } from './avatars/avatars.tsx'
import { Cat } from './Cat.tsx'
import { Icon } from './Icon.tsx'

const TOOL_LABELS: Record<string, string> = {
  fs_read: '读文件', fs_write: '写文件', shell_exec: '执行命令', file_produce: '产出文件',
}
const ALL_TOOLS = Object.keys(TOOL_LABELS)

/** 头像选择器：预置 SVG 库网格预览。 */
export function AvatarPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (key: string) => void
}) {
  return (
    <div className="avatar-picker" role="radiogroup" aria-label="选择头像">
      {AVATARS.map((avatar) => (
        <button
          key={avatar.key}
          type="button"
          role="radio"
          aria-checked={value === avatar.key}
          className={value === avatar.key ? 'is-selected' : ''}
          title={avatar.name}
          onClick={() => { onChange(avatar.key) }}
        >
          <span
            className="avatar-cell"
            onClick={(event) => {
              event.stopPropagation()
              onChange(avatar.key)
            }}
          >
            <span
              style={{ width: 40, height: 40, display: 'inline-flex', borderRadius: '50%', overflow: 'hidden' }}
              dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 64 64" width="40" height="40">${avatar.svg}</svg>` }}
            />
            <small>{avatar.name}</small>
          </span>
        </button>
      ))}
    </div>
  )
}

/** 通讯录：agent 卡片网格（Ryen 置顶）+ 新建/建群入口。 */
export function ContactsPage({
  agents,
  templates,
  onChat,
  onCreateAgent,
  onCreateGroup,
}: {
  agents: AgentDef[]
  templates: AgentTemplate[]
  providers: ProviderInfo[]
  onChat: (agentId: string) => void
  onCreateAgent: () => void
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
          <button className="btn" onClick={onCreateGroup}><Icon name="group" size={15} /> 建群</button>
          <button className="btn btn-primary" onClick={onCreateAgent}><Icon name="plus" size={15} /> 新建 Agent</button>
        </div>
      </header>
      <div className="page-scroll">
        <div className="page-scroll-col">
          {sorted.length === 0 ? (
            <div className="empty-state">
              <span className="empty-cat"><Cat mood="thinking" size={88} /></span>
              <h3>通讯录还是空的</h3>
              <p>从模板新建一位 agent 吧，挑个顺眼的头像。</p>
            </div>
          ) : (
            <>
              <p className="section-title">我的 Agent（{sorted.length}）</p>
              <div className="contact-grid">
                <button className="contact-card contact-create" onClick={onCreateAgent}>
                  <span className="contact-create-icon"><Icon name="plus" size={22} /></span>
                  <h3>新建 Agent</h3>
                  <p className="contact-prompt">从模板开始，挑头像、定人设</p>
                </button>
                {sorted.map((agent) => (
                  <article key={agent.id} className="contact-card">
                    <Avatar avatarKey={agent.avatar} name={agent.name} seed={agent.id} size={56} />
                    <h3>
                      {agent.name}
                      {agent.isBuiltin && <span className="badge">内置</span>}
                    </h3>
                    <p className="contact-model">{agent.provider} / {agent.model}</p>
                    <p className="contact-prompt">{agent.systemPrompt.slice(0, 48)}…</p>
                    <button className="btn" onClick={() => { onChat(agent.id) }}>发消息</button>
                  </article>
                ))}
              </div>
              <p className="section-title" style={{ marginTop: 24 }}>可用模板（{templates.length}）</p>
              <div className="template-rail">
                {templates.map((template) => (
                  <button key={template.key} className="template-card" onClick={onCreateAgent}>
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

/** 新建 Agent：选模板 → 编辑表单（含头像选择器）。 */
export function CreateAgentModal({
  templates,
  providers,
  onSubmit,
  onClose,
}: {
  templates: AgentTemplate[]
  providers: ProviderInfo[]
  onSubmit: (input: Record<string, unknown>) => Promise<void>
  onClose: () => void
}) {
  const [templateKey, setTemplateKey] = useState(templates[0]?.key ?? 'general')
  const template = templates.find((t) => { return t.key === templateKey })
  const [name, setName] = useState('')
  const [avatarKey, setAvatarKey] = useState('bot')
  const [systemPrompt, setSystemPrompt] = useState(template?.suggestedSystemPrompt ?? '')
  const [provider, setProvider] = useState(providers[0]?.id ?? 'siliconflow')
  const [model, setModel] = useState(template?.defaultModel ?? '')
  const [tools, setTools] = useState<string[]>(template?.defaultTools ?? [])
  const [busy, setBusy] = useState(false)

  const pickTemplate = (key: string): void => {
    setTemplateKey(key)
    const next = templates.find((t) => { return t.key === key })
    if (next === undefined) return
    setSystemPrompt(next.suggestedSystemPrompt)
    setModel(next.defaultModel)
    setTools(next.defaultTools)
    if (next.avatar !== undefined && AVATARS.some((a) => { return a.key === next.avatar })) {
      setAvatarKey(next.avatar as string)
    }
  }

  const models = providers.find((p) => { return p.id === provider })?.models ?? []

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      await onSubmit({
        templateKey,
        name: name || template?.name,
        avatar: avatarKey,
        systemPrompt,
        provider,
        model: model || models[0]?.id,
        tools,
      })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="新建 Agent" onClose={onClose}>
      <label className="field">
        <span>从模板开始</span>
        <select value={templateKey} onChange={(e) => { pickTemplate(e.target.value) }}>
          {templates.map((t) => { return <option key={t.key} value={t.key}>{t.name} — {t.description}</option> })}
        </select>
      </label>
      <div className="field-row">
        <label className="field">
          <span>名字</span>
          <input value={name} placeholder={template?.name} onChange={(e) => { setName(e.target.value) }} />
        </label>
      </div>
      <fieldset className="field">
        <span>头像</span>
        <AvatarPicker value={avatarKey} onChange={setAvatarKey} />
      </fieldset>
      <label className="field">
        <span>人设（system prompt）</span>
        <textarea rows={5} value={systemPrompt} onChange={(e) => { setSystemPrompt(e.target.value) }} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>供应商</span>
          <select value={provider} onChange={(e) => { setProvider(e.target.value) }}>
            {providers.map((p) => { return <option key={p.id} value={p.id}>{p.displayName}{p.apiKeyConfigured ? '' : '（未配置 key）'}</option> })}
          </select>
        </label>
        <label className="field">
          <span>模型</span>
          <select value={model} onChange={(e) => { setModel(e.target.value) }}>
            {models.map((m) => { return <option key={m.id} value={m.id}>{m.name ?? m.id}</option> })}
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
                  setTools(e.target.checked ? [...tools, tool] : tools.filter((t) => { return t !== tool }))
                }}
              />
              {TOOL_LABELS[tool]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => { void submit() }}>保存</button>
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
  const [selected, setSelected] = useState<string[]>(agents.filter((a) => { return a.id === 'ryen' }).map((a) => { return a.id }))
  const [dispatcher, setDispatcher] = useState('ryen')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const toggle = (id: string): void => {
    setSelected((prev) => {
      return prev.includes(id) ? prev.filter((x) => { return x !== id }) : [...prev, id]
    })
  }

  const submit = async (): Promise<void> => {
    if (selected.length === 0) return
    setBusy(true)
    try {
      await onSubmit({ memberAgentIds: selected, dispatcherAgentId: dispatcher, title: title || '群聊' })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="新建群聊" onClose={onClose}>
      <label className="field">
        <span>群名</span>
        <input value={title} placeholder="群聊" onChange={(e) => { setTitle(e.target.value) }} />
      </label>
      <fieldset className="field">
        <span>选择成员</span>
        <div className="member-checks">
          {agents.map((agent) => (
            <label key={agent.id}>
              <input type="checkbox" checked={selected.includes(agent.id)} onChange={() => { toggle(agent.id) }} />
              <Avatar avatarKey={agent.avatar} name={agent.name} seed={agent.id} size={22} />
              {agent.name}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span>调度员（无 @ 消息的默认响应者）</span>
        <select value={dispatcher} onChange={(e) => { setDispatcher(e.target.value) }}>
          {selected.map((id) => {
            const agent = agents.find((a) => { return a.id === id })
            return agent === undefined ? null : <option key={id} value={id}>{agent.name}</option>
          })}
        </select>
      </label>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={busy || selected.length === 0} onClick={() => { void submit() }}>创建</button>
      </div>
    </Modal>
  )
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => { e.stopPropagation() }}>
        <header className="modal-header">
          <h3>{title}</h3>
          <button onClick={onClose} aria-label="关闭"><Icon name="x" size={15} /></button>
        </header>
        {children}
      </div>
    </div>
  )
}
