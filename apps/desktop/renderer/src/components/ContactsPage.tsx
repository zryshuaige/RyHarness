import { useState } from 'react'
import type { AgentDef, AgentTemplate, ProviderInfo } from '../api.ts'
import { AgentAvatar } from './Cat.tsx'

const TOOL_LABELS: Record<string, string> = {
  fs_read: '读文件', fs_write: '写文件', shell_exec: '执行命令', file_produce: '产出文件',
}
const ALL_TOOLS = Object.keys(TOOL_LABELS)

/** 通讯录：agent 卡片网格（Ryen 置顶）+ 新建/建群入口。 */
export function ContactsPage({
  agents,
  templates,
  providers,
  onChat,
  onCreateAgent,
  onCreateGroup,
  onBack,
}: {
  agents: AgentDef[]
  templates: AgentTemplate[]
  providers: ProviderInfo[]
  onChat: (agentId: string) => void
  onCreateAgent: () => void
  onCreateGroup: () => void
  onBack: () => void
}) {
  const sorted = [...agents].sort((a, b) => {
    if (a.id === 'ryen') return -1
    if (b.id === 'ryen') return 1
    return a.name.localeCompare(b.name)
  })
  return (
    <section className="contacts-page">
      <header className="page-header">
        <button onClick={onBack}>← 返回</button>
        <h2>通讯录</h2>
        <div>
          <button className="primary" onClick={onCreateGroup}>＋ 建群</button>
          <button className="primary" onClick={onCreateAgent}>＋ 新建 Agent</button>
        </div>
      </header>
      <div className="contact-grid">
        {sorted.map((agent) => (
          <article key={agent.id} className="contact-card">
            <AgentAvatar agent={agent} size={56} />
            <h3>{agent.name}</h3>
            {agent.isBuiltin && <span className="badge">内置</span>}
            <p className="contact-model">{agent.provider} / {agent.model}</p>
            <p className="contact-prompt">{agent.systemPrompt.slice(0, 60)}…</p>
            <button onClick={() => { onChat(agent.id) }}>发消息</button>
          </article>
        ))}
      </div>
      <p className="page-hint">模板 {templates.length} 个 · 供应商 {providers.length} 个</p>
    </section>
  )
}

/** 新建 Agent：选模板 → 编辑表单。 */
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
  const [avatar, setAvatar] = useState('')
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
  }

  const models = providers.find((p) => { return p.id === provider })?.models ?? []

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      await onSubmit({
        templateKey,
        name: name || template?.name,
        ...avatar ? { avatar } : {},
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
        <label className="field">
          <span>头像 emoji</span>
          <input value={avatar} placeholder="💻" onChange={(e) => { setAvatar(e.target.value) }} />
        </label>
      </div>
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
        <button onClick={onClose}>取消</button>
        <button className="primary" disabled={busy} onClick={() => { void submit() }}>保存</button>
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
              <AgentAvatar agent={agent} size={22} /> {agent.name}
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
        <button onClick={onClose}>取消</button>
        <button className="primary" disabled={busy || selected.length === 0} onClick={() => { void submit() }}>创建</button>
      </div>
    </Modal>
  )
}

/** 设置面板：改 Ryen + 供应商状态。 */
export function SettingsModal({
  ryen,
  providers,
  onPatchRyen,
  onClose,
}: {
  ryen: AgentDef | undefined
  providers: ProviderInfo[]
  onPatchRyen: (patch: { name: string; systemPrompt: string }) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(ryen?.name ?? 'Ryen')
  const [systemPrompt, setSystemPrompt] = useState(ryen?.systemPrompt ?? '')
  const [busy, setBusy] = useState(false)

  return (
    <Modal title="设置" onClose={onClose}>
      <h4>内置管家</h4>
      <label className="field">
        <span>名字</span>
        <input value={name} onChange={(e) => { setName(e.target.value) }} />
      </label>
      <label className="field">
        <span>人设</span>
        <textarea rows={5} value={systemPrompt} onChange={(e) => { setSystemPrompt(e.target.value) }} />
      </label>
      <div className="modal-actions">
        <button
          className="primary"
          disabled={busy || ryen === undefined}
          onClick={() => {
            setBusy(true)
            void onPatchRyen({ name, systemPrompt }).finally(() => { setBusy(false) })
          }}
        >
          保存
        </button>
      </div>
      <h4>供应商</h4>
      {providers.map((provider) => (
        <p key={provider.id} className={`provider-status ${provider.apiKeyConfigured ? 'ok' : 'missing'}`}>
          {provider.apiKeyConfigured ? '✓' : '⚠️'} {provider.displayName}：
          {provider.apiKeyConfigured
            ? `已配置 key，${provider.models.length} 个模型`
            : '未配置 key——设置 SILICONFLOW_API_KEY 环境变量后重启'}
        </p>
      ))}
    </Modal>
  )
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => { e.stopPropagation() }}>
        <header className="modal-header">
          <h3>{title}</h3>
          <button onClick={onClose}>✕</button>
        </header>
        {children}
      </div>
    </div>
  )
}
