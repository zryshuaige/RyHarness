import { type CSSProperties, useState } from 'react'
import type { AgentDef, AgentTemplate, ProviderInfo } from '../api.ts'
import { agentById } from '../lib/agents.ts'
import {
  explainModelMismatch,
  firstUsableProviderId,
  isLocalService,
  providerModelIds,
  providersByReadiness,
} from '../lib/provider-health.ts'
import { stagger } from '../lib/stagger.ts'
import { toast } from '../lib/toast.ts'
import { ALL_TOOLS, toolLabel } from '../lib/tool-labels.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { AVATAR_STYLE_BY_KEY, AVATAR_STYLES, BRAND_AVATAR, dicebearSvg, randomAvatarSpec } from './avatars/avatars.tsx'
import { Cat } from './Cat.tsx'
import { Icon } from './Icon.tsx'
import { Modal } from './Modal.tsx'

/** 选择器缩略图统一裁成 40px 圆：DiceBear 母版是方形，品牌橘猫是圆形底板。 */
const cellStyle: CSSProperties = {
  width: 40,
  height: 40,
  display: 'inline-flex',
  borderRadius: '50%',
  overflow: 'hidden',
}

/** 品牌橘猫在选择器里的显示名（随选项走，不能散落在 JSX 里）。 */
const BRAND_AVATAR_NAME = '橘猫'

/** 头像选择器：DiceBear 风格画廊 + 品牌橘猫 + 随机换一批。 */
export function AvatarPicker({
  value,
  onChange,
}: {
  /** `db:{style}:{seed}` 或 {@link BRAND_AVATAR}。 */
  value: string
  onChange: (spec: string) => void
}) {
  const current = parsePickerValue(value)
  const styleName =
    value === BRAND_AVATAR ? BRAND_AVATAR_NAME : (AVATAR_STYLE_BY_KEY[current.styleKey]?.name ?? current.styleKey)
  return (
    <div className="avatar-picker-wrap">
      <div className="avatar-picker-preview">
        {/* 预览直接吃 agent.avatar 原值：橘猫才不会被降级成首字母色块。 */}
        <Avatar avatarKey={value} name="预览" size={64} />
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
          <small>当前：{styleName}</small>
        </div>
      </div>
      <div className="avatar-picker" role="radiogroup" aria-label="选择头像">
        {/* 品牌橘猫放在首位：它是 RyAgent 自己的脸，也是随机「换一批」的常客，
            此前它只存在于数据里，用户永远选不到。 */}
        {/* biome-ignore lint/a11y/useSemanticElements: 卡片式单选，原生 radio 样式无法满足设计 */}
        <button
          type="button"
          role="radio"
          aria-checked={value === BRAND_AVATAR}
          className={value === BRAND_AVATAR ? 'is-selected' : ''}
          title={`${BRAND_AVATAR_NAME}（RyAgent 品牌）`}
          onClick={() => {
            onChange(BRAND_AVATAR)
          }}
        >
          <span className="avatar-cell">
            <span style={cellStyle}>
              <Avatar avatarKey={BRAND_AVATAR} name={BRAND_AVATAR_NAME} size={40} />
            </span>
            <small>{BRAND_AVATAR_NAME}</small>
          </span>
        </button>
        {AVATAR_STYLES.map((style) => {
          const preview = dicebearSvg(style.key, current.seed) ?? ''
          return (
            // biome-ignore lint/a11y/useSemanticElements: 卡片式单选，原生 radio 样式无法满足设计
            <button
              key={style.key}
              type="button"
              role="radio"
              aria-checked={value !== BRAND_AVATAR && current.styleKey === style.key}
              className={value !== BRAND_AVATAR && current.styleKey === style.key ? 'is-selected' : ''}
              title={`${style.name}（${style.license === 'CC0-1.0' ? 'CC0 公有领域' : 'CC BY 4.0'}）`}
              onClick={() => {
                onChange(`db:${style.key}:${current.seed}`)
              }}
            >
              <span className="avatar-cell">
                <span
                  style={cellStyle}
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

/**
 * 把 agent.avatar 拆成选择器的 (风格, seed)。
 *
 * 品牌橘猫与一切不认识的值都落到首个在册风格：兜底早先硬编码 'lorelei'——一个
 * 早已从 AVATAR_STYLES 收敛掉、界面上根本不存在的风格，于是橘猫被选中时预览退化
 * 成首字母色块，标签还把 "lorelei" 当成风格名念给用户听。
 */
function parsePickerValue(value: string): { styleKey: string; seed: string } {
  const match = /^db:([a-zA-Z]+):(.+)$/.exec(value)
  const styleKey = match?.[1]
  const seed = match?.[2]
  if (styleKey !== undefined && seed !== undefined && AVATAR_STYLE_BY_KEY[styleKey] !== undefined) {
    return { styleKey, seed }
  }
  return { styleKey: AVATAR_STYLES[0]!.key, seed: seed ?? randomSeed() }
}

function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10)
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

/** 需要单独告知的工具：勾上它等于把这台机器的一部分交给 agent。 */
const RISKY_TOOL = 'shell_exec'

/** 勾上执行命令时的一次性风险说明（只告知，不做审批流）。 */
const RISKY_TOOL_HINT = '执行命令能在你这台电脑上直接跑 shell：改文件、装东西、删东西都做得到。只在任务来源可信时勾选。'

/**
 * 新建/编辑 Agent：选模板 → 编辑表单（含头像选择器）。内容区可滚动，操作条吸底。
 *
 * 供应商与模型必须成对成立：切换供应商时把 model 重置成那家的第一个模型，提交前再
 * 断言 model ∈ 该供应商的 models——此前 model 可以是模板留下的、属于别家供应商的
 * 标识，服务端照单全收，agent 建出来第一句话就 404。
 */
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
  // 默认供应商 = 第一个配好凭据（或免 key 的本地服务）的；否则第一个（多半是没 key 的）。
  const [provider, setProvider] = useState(
    editing?.provider ?? firstUsableProviderId(providers) ?? providers[0]?.id ?? 'siliconflow',
  )
  const [model, setModel] = useState(editing?.model ?? template?.defaultModel ?? '')
  // 新建时默认不勾「执行命令」：模板给的默认工具里带着它，但用户从没为它点过头。
  const [tools, setTools] = useState<string[]>(() => {
    if (editing !== undefined) return editing.tools
    return (template?.defaultTools ?? []).filter((tool) => {
      return tool !== RISKY_TOOL
    })
  })
  const [busy, setBusy] = useState(false)

  const pickTemplate = (key: string): void => {
    setTemplateKey(key)
    const next = templates.find((t) => {
      return t.key === key
    })
    if (next === undefined) return
    setSystemPrompt(next.suggestedSystemPrompt)
    setModel(next.defaultModel)
    setTools(
      next.defaultTools.filter((tool) => {
        return tool !== RISKY_TOOL
      }),
    )
  }

  const current = providers.find((p) => {
    return p.id === provider
  })
  const models = current?.models ?? []
  /** 没配 key 的供应商降权排后，但仍然可选：先建好 agent 再去补 key 也是条路。 */
  const orderedProviders = providersByReadiness(providers)
  const modelIds = providerModelIds(current)
  const modelValid = modelIds.includes(model)
  const modelHint =
    model.length === 0
      ? explainModelMismatch(current?.displayName ?? provider, modelIds)
      : modelValid
        ? undefined
        : explainModelMismatch(current?.displayName ?? provider, modelIds)

  /** 切供应商必须连 model 一起换：留着别家的模型标识等于建出一个永远 404 的 agent。 */
  const pickProvider = (id: string): void => {
    setProvider(id)
    const next = providers.find((p) => {
      return p.id === id
    })
    setModel(next?.models[0]?.id ?? '')
  }

  const submit = async (): Promise<void> => {
    if (!modelValid) return
    setBusy(true)
    try {
      await onSubmit({
        ...(editing === undefined ? { templateKey } : {}),
        name: name || editing?.name || template?.name,
        avatar: avatarKey,
        systemPrompt,
        provider,
        model,
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
        {/* fieldset 里的 <span> 不是 <legend>，读屏器只会念「分组」——补上名字。 */}
        <fieldset className="field" aria-label="头像">
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
                pickProvider(e.target.value)
              }}
            >
              {orderedProviders.map((p) => {
                return (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                    {p.apiKeyConfigured ? '' : isLocalService(p) ? '（本地服务）' : '（未配置 key）'}
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
              {/* 手上这个模型不属于所选供应商时把它显式列出来：<select> 静默落空会让
                  用户以为是自己操作错了，而不是"这个组合存不下来"。 */}
              {!modelValid && model.length > 0 && <option value={model}>{model}（不属于当前供应商）</option>}
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
        {modelHint !== undefined && (
          <p className="apikey-error" role="alert">
            {modelHint}
          </p>
        )}
        <fieldset className="field" aria-label="工具白名单">
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
          {tools.includes(RISKY_TOOL) && <p className="provider-note">{RISKY_TOOL_HINT}</p>}
        </fieldset>
      </div>
      <div className="modal-actions modal-actions-sticky">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !modelValid}
          title={modelValid ? undefined : modelHint}
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
    const next = selected.includes(id)
      ? selected.filter((x) => {
          return x !== id
        })
      : [...selected, id]
    setSelected(next)
    // 取消勾选调度员本人时，调度员要同步落到剩下的第一个成员。少了这一步，
    // <select> 里已经没有当前值了：界面显示的是第一项，state 还指着被摘掉的那个，
    // 提交上去的 dispatcherAgentId 不在成员名单里，服务端直接 400（"群一进去就哑"）。
    setDispatcher((current) => {
      return next.includes(current) ? current : (next[0] ?? '')
    })
  }

  /** 调度员必须在已勾选成员里：不合法就不让建群，也不发请求。 */
  const dispatcherValid = selected.includes(dispatcher)

  const submit = async (): Promise<void> => {
    if (!dispatcherValid) return
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
      <fieldset className="field" aria-label="选择成员">
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
          disabled={selected.length === 0}
          onChange={(e) => {
            setDispatcher(e.target.value)
          }}
        >
          {/* 没人可派时占一行说明，免得空 select 看起来像坏了。 */}
          {selected.length === 0 && <option value="">先勾选成员</option>}
          {selected.map((id) => {
            const agent = agentById(agents, id)
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
          disabled={busy || !dispatcherValid}
          title={dispatcherValid ? undefined : '调度员必须在已勾选的成员里'}
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
