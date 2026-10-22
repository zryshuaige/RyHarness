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
import { type ChangeEvent, useRef, useState } from 'react'
import type { AgentDef, Conversation } from '../api.ts'
import { agentById } from '../lib/agents.ts'
import { humanError } from '../lib/error-text.ts'
import { modelPair } from '../lib/humanize.ts'
import { toast } from '../lib/toast.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { Modal } from './Modal.tsx'
import { Select, type SelectOption } from './Select.tsx'

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
  /** 脏表单关闭前的二次确认。 */
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  /**
   * 表单初始快照：脏判定只比「用户改了什么」，不把「打开弹窗」本身算成修改。
   * 成员顺序不影响语义，排序后再比，勾掉再勾回来不会误判成脏。
   */
  const initialForm = useRef<string | undefined>(undefined)
  const currentForm = JSON.stringify({
    title,
    selected: [...selected].sort(),
    dispatcher,
  })
  if (initialForm.current === undefined) initialForm.current = currentForm
  const dirty = initialForm.current !== currentForm

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
      setBlocked(`${nameOf(id)} 现在是调度员，不能退出这个群。`)
      return
    }
    setSelected(next)
    // 取消勾选调度员本人时，调度员要同步落到剩下的第一个成员。少了这一步，下拉里
    // 已经没有当前值了：触发器只能显示兜底文案（没人可派时是一句说明，值还在时是那个
    // 原始 id），state 还指着被摘掉的那个，提交上去的 dispatcherAgentId 不在成员
    // 名单里，服务端直接 400（「群一进去就哑」）。
    setDispatcher((current) => {
      return next.includes(current) ? current : (next[0] ?? '')
    })
  }

  /**
   * 下拉里的调度员候选：只有已勾选的成员（不可能选到没勾的人），没人可派时占一行说明，
   * 免得空下拉看起来像坏了。
   */
  const dispatcherOptions: SelectOption[] =
    selected.length === 0
      ? [{ value: '', label: '先勾选成员' }]
      : selected.flatMap((id) => {
          const agent = agentById(agents, id)
          return agent === undefined ? [] : [{ value: id, label: agent.name }]
        })

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
        `${editing === undefined ? '建群' : '保存群设置'}失败：${humanError(error, '这个群没能存下来，再试一次')}`,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={editing === undefined ? '新建群聊' : '群设置'}
      onClose={onClose}
      onBeforeClose={() => {
        if (!dirty) return true
        setConfirmDiscard(true)
        return false
      }}
    >
      <label className="field">
        <span>群名</span>
        <input
          value={title}
          placeholder="给这个群起个名字"
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
                {/* 副行答「这位助理是什么」，不答「它的系统提示词写了什么」：
                    systemPrompt 是英文提示词，截断 18 个字上屏只剩半句没头没尾的话。
                    模型与供应商回答的是同一个问题，且是人话（modelPair）。 */}
                <small className="member-sub">{modelPair(agent.provider, agent.model)}</small>
              </span>
              {agent.id === dispatcher && <span className="badge">调度员</span>}
            </label>
          ))}
        </div>
        {blocked !== undefined && <p className="provider-note">{blocked}</p>}
        {!membersValid && (
          <p className="apikey-error" role="alert">
            群里至少要留一位成员。
          </p>
        )}
      </fieldset>
      {/* div 而不是 label：可访问名由 Select 自己的 aria-label 给出，一个不包住原生
          表单控件的 label 反而是个空壳。 */}
      <div className="field">
        <span>调度员（无 @ 消息的默认响应者）</span>
        <Select
          value={dispatcher}
          options={dispatcherOptions}
          ariaLabel="调度员"
          placeholder="先勾选成员"
          // 既有群的调度员在服务端还改不了：这里直接锁住，别让用户先选一遍再在保存时
          // 发现「选了也没用」。建群时仍可选——那是新记录，不涉及这个限制。
          disabled={editing !== undefined || selected.length === 0}
          onChange={(next) => {
            setBlocked(undefined)
            setDispatcher(next)
          }}
        />
        {editing !== undefined && (
          <small className="provider-note">已有群的调度员暂不支持修改，这里显示的是当前记录里的那一位。</small>
        )}
      </div>
      {/* 信息性说明用灰字（provider-note），红色只留给真的会挡住保存的问题：
          调度员改不了不是错误，只是这一版服务端还没这个字段。 */}
      <div className="modal-actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (dirty) {
              setConfirmDiscard(true)
              return
            }
            onClose()
          }}
        >
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSubmit}
          aria-busy={busy}
          title={dispatcherProblem}
          onClick={() => {
            void submit()
          }}
        >
          {busy ? '保存中…' : editing === undefined ? '创建' : '保存修改'}
        </button>
      </div>
      {confirmDiscard && (
        <ConfirmDialog
          title="放弃未保存的修改？"
          body="关闭后，这次改的群名与成员都不会保存。"
          confirmLabel="放弃修改"
          onConfirm={async () => {
            setConfirmDiscard(false)
            onClose()
          }}
          onCancel={() => {
            setConfirmDiscard(false)
          }}
        />
      )}
    </Modal>
  )
}
