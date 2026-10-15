/**
 * 群设置弹窗：建群与改群共用一套表单。
 *
 * 此前「建群」是一次性动作——成员多选与调度员逻辑写死在 CreateGroupModal 里，
 * 群建完就冻结：服务端 PATCH 早就接受 title / memberAgentIds，界面却没有入口，
 * 于是「多 agent 群聊」只能定型在第一秒。现在两种模式共用同一份状态机：
 * mode='create' 提交时建会话，mode='settings' 提交时改既有会话。
 *
 * 调度员必须在已勾选成员里（前端拦一道，服务端也会 400）。既有群里「把当前调度员
 * 直接退出去」也一并拦住：服务端会以 `dispatcher "x" must be one of
 * memberAgentIds` 拒绝这次 PATCH，与其让人撞一次 400，不如在点子上说明白。
 */
import { type ChangeEvent, useState } from 'react'
import type { AgentDef, Conversation } from '../api.ts'
import { agentById } from '../lib/agents.ts'
import { toast } from '../lib/toast.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { Modal } from './Modal.tsx'

/** 表单提交出去的东西：两种模式同构，宿主据此决定建还是改。 */
export interface GroupFormInput {
  title: string
  memberAgentIds: string[]
  dispatcherAgentId: string
}

export function GroupSettingsModal({
  mode,
  agents,
  conversation,
  onSubmit,
  onClose,
}: {
  /** create = 新建群聊；settings = 改既有群（此时 conversation 必填）。 */
  mode: 'create' | 'settings'
  agents: AgentDef[]
  /** mode='settings' 时被改的群；建群时留空。 */
  conversation?: Conversation
  onSubmit: (input: GroupFormInput) => Promise<void>
  onClose: () => void
}) {
  const editing = mode === 'settings' ? conversation : undefined
  const [selected, setSelected] = useState<string[]>(() => {
    if (editing !== undefined) return [...editing.memberAgentIds]
    return agents
      .filter((a) => {
        return a.id === 'ryen'
      })
      .map((a) => {
        return a.id
      })
  })
  const [dispatcher, setDispatcher] = useState<string>(
    editing?.dispatcherAgentId ??
      agents
        .filter((a) => {
          return a.id === 'ryen'
        })
        .map((a) => {
          return a.id
        })[0] ??
      '',
  )
  const [title, setTitle] = useState(editing?.title ?? '')
  const [busy, setBusy] = useState(false)
  /** 退不掉当前调度员时的那句解释（只在该动作真的被拦下时出现）。 */
  const [blocked, setBlocked] = useState<string | undefined>(undefined)

  /** 当前调度员是既有的那一位吗（改成员名单时要拿他当闸门）。 */
  const originalDispatcher = editing?.dispatcherAgentId
  const nameOf = (id: string): string => {
    return agentById(agents, id)?.name ?? id
  }

  const toggle = (id: string): void => {
    setBlocked(undefined)
    const next = selected.includes(id)
      ? selected.filter((x) => {
          return x !== id
        })
      : [...selected, id]
    // 服务端 PATCH memberAgentIds 时会校验「记录里的调度员仍在名单内」，而调度员
    // 本身目前改不了（PATCH 不落该字段），所以这一位现在退不出去。与其让人白等
    // 一次 400，不如在点子上把真实原因说清楚。
    if (next.length < selected.length && id === originalDispatcher) {
      setBlocked(
        `${nameOf(id)} 是这个群当前的调度员，服务端要求调度员始终在成员名单里——` +
          '改调度员的服务端字段还没上线，所以他现在退不出去。',
      )
      return
    }
    setSelected(next)
    // 取消勾选调度员本人时，调度员要同步落到剩下的第一个成员。少了这一步，
    // <select> 里已经没有当前值了：界面显示的是第一项，state 还指着被摘掉的那个，
    // 提交上去的 dispatcherAgentId 不在成员名单里，服务端直接 400（「群一进去就哑」）。
    setDispatcher((current) => {
      return next.includes(current) ? current : (next[0] ?? '')
    })
  }

  /** 调度员必须在已勾选成员里：不合法就不让提交，也不发请求。 */
  const dispatcherValid = selected.includes(dispatcher)
  /** 改群时不能把成员名单清空——服务端会以「非空」拒掉。 */
  const membersValid = selected.length > 0
  const canSubmit = dispatcherValid && membersValid && !busy
  const dispatcherProblem = dispatcherValid ? undefined : '调度员必须在已勾选的成员里'

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setBusy(true)
    try {
      await onSubmit({
        title: title.trim() || (editing === undefined ? '群聊' : (editing.title ?? '群聊')),
        memberAgentIds: selected,
        dispatcherAgentId: dispatcher,
      })
      onClose()
    } catch (error) {
      // 留在原地并说清原因：关掉弹窗等于让用户以为已经改好了。
      toast.error(
        `${editing === undefined ? '建群' : '保存群设置'}失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={editing === undefined ? '新建群聊' : '群设置'} onClose={onClose}>
      <label className="field">
        <span>群名</span>
        <input
          value={title}
          placeholder="群聊"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            setTitle(event.target.value)
          }}
        />
      </label>
      <fieldset className="field" aria-label="选择成员">
        <span>{editing === undefined ? '选择成员' : '群成员（勾掉即退群）'}</span>
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
              {agent.id === dispatcher && <span className="badge">调度员</span>}
            </label>
          ))}
        </div>
        {blocked !== undefined && (
          <p className="apikey-error" role="alert">
            {blocked}
          </p>
        )}
        {!membersValid && (
          <p className="apikey-error" role="alert">
            群里至少要留一位成员。
          </p>
        )}
      </fieldset>
      <label className="field">
        <span>调度员（无 @ 消息的默认响应者）</span>
        <select
          value={dispatcher}
          disabled={selected.length === 0}
          onChange={(event) => {
            setBlocked(undefined)
            setDispatcher(event.target.value)
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
      {/* 选了跟服务端记录不同的调度员时，先说清它现在还不生效——一个「保存成功」
          却什么都没变的入口，比没有这个入口更糟。 */}
      {editing !== undefined && originalDispatcher !== undefined && dispatcher !== originalDispatcher && (
        <p className="apikey-error">
          服务端目前还不支持改已有群的调度员（PATCH
          只落群名与成员）。这里选的值会随保存一起发过去，等服务端补上字段才真正生效。
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSubmit}
          title={dispatcherProblem}
          onClick={() => {
            void submit()
          }}
        >
          {editing === undefined ? '创建' : '保存修改'}
        </button>
      </div>
    </Modal>
  )
}
