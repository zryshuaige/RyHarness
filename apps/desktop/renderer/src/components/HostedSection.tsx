/**
 * 「我的 → 云成员」：配置 Kimi Hosted Agents、雇佣/解雇成员、手动对账。
 *
 * 这一块刻意不放进通讯录：雇佣是**花钱的事**（会话按沙箱时长 + token 计费），
 * 放在设置里，用户先看见 Key、环境和已有成员，再决定雇谁。雇佣完的成员会出现在
 * 通讯录里，像普通同事一样可以单聊、拉群。
 *
 * 方法全部按可选收：旧服务端（没有 hosted 路由）与只渲染页面的测试替身不必实现，
 * 缺方法时这一块显示一句说明，不让整页报错。
 * @module @ryharness/desktop/renderer/components/HostedSection
 */

import { useCallback, useEffect, useState } from 'react'
import type { AgentDef, HostedCatalog, HostedHireInput, HostedMember, HostedSession, HostedStatus } from '../api.ts'
import { humanError } from '../lib/error-text.ts'
import { toast } from '../lib/toast.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'

/** 云成员这一块要用的 API 面。 */
export interface HostedApi {
  hostedStatus?: () => Promise<HostedStatus>
  hostedCatalog?: () => Promise<HostedCatalog>
  hostedSettings?: (input: { apiKey?: string; baseUrl?: string; environmentId?: string }) => Promise<{
    configured: boolean
    baseUrl: string
    environmentId?: string
  }>
  hostedHire?: (input: HostedHireInput) => Promise<{ agent: AgentDef; member: HostedMember }>
  hostedFire?: (agentId: string) => Promise<{ member: HostedMember }>
  hostedSync?: () => Promise<{ ok: boolean; sessions: HostedSession[] }>
}

export function HostedSection({
  api,
  agents,
  onChanged,
}: {
  api: HostedApi
  /** 通讯录：把 member.agentId 映射回名字与解雇确认文案。 */
  agents?: AgentDef[]
  /** 雇佣/解雇成功后通知父级刷新通讯录。 */
  onChanged?: () => void
}) {
  const [status, setStatus] = useState<HostedStatus | undefined>(undefined)
  const [catalog, setCatalog] = useState<HostedCatalog | undefined>(undefined)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://api.moonshot.cn')
  const [customName, setCustomName] = useState('')
  const [customPrompt, setCustomPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [firing, setFiring] = useState<{ agentId: string; name: string } | undefined>(undefined)

  const refresh = useCallback(async () => {
    const statusFn = api.hostedStatus
    if (statusFn === undefined) return
    try {
      const next = await statusFn.call(api)
      setStatus(next)
      setBaseUrl(next.baseUrl)
      setError(undefined)
      if (next.configured) {
        const catalogFn = api.hostedCatalog
        if (catalogFn !== undefined) setCatalog(await catalogFn.call(api))
      } else {
        setCatalog(undefined)
      }
    } catch (failure) {
      setError(humanError(failure, '云成员状态没读出来，再试一次。'))
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const nameOf = (agentId: string): string => {
    return agents?.find((agent) => agent.id === agentId)?.name ?? agentId
  }

  const saveSettings = async (): Promise<void> => {
    const settings = api.hostedSettings
    if (settings === undefined) return
    setBusy(true)
    try {
      const next = await settings.call(api, {
        ...(apiKey.trim().length === 0 ? {} : { apiKey: apiKey.trim() }),
        baseUrl: baseUrl.trim(),
      })
      setApiKey('')
      toast.success(next.configured ? '云成员的凭据已保存' : '已保存，但还没填 API Key')
      await refresh()
    } catch (failure) {
      toast.error(humanError(failure, '保存失败，再试一次。'))
    } finally {
      setBusy(false)
    }
  }

  const hireOfficial = async (remoteAgentId: string, name: string): Promise<void> => {
    const hire = api.hostedHire
    if (hire === undefined) return
    setBusy(true)
    try {
      await hire.call(api, { source: 'official', remoteAgentId })
      toast.success(`已雇佣「${name}」，它现在在通讯录里`)
      await refresh()
      onChanged?.()
    } catch (failure) {
      toast.error(humanError(failure, '雇佣失败，再试一次。'))
    } finally {
      setBusy(false)
    }
  }

  const hireCustom = async (): Promise<void> => {
    const hire = api.hostedHire
    if (hire === undefined) return
    if (customName.trim().length === 0) {
      toast.error('先给它起个名字')
      return
    }
    setBusy(true)
    try {
      const result = await hire.call(api, {
        source: 'custom',
        name: customName.trim(),
        ...(customPrompt.trim().length === 0 ? {} : { systemPrompt: customPrompt.trim() }),
      })
      toast.success(`已雇佣「${result.agent.name}」`)
      setCustomName('')
      setCustomPrompt('')
      await refresh()
      onChanged?.()
    } catch (failure) {
      toast.error(humanError(failure, '雇佣失败，再试一次。'))
    } finally {
      setBusy(false)
    }
  }

  const sync = async (): Promise<void> => {
    const syncFn = api.hostedSync
    if (syncFn === undefined) return
    setBusy(true)
    try {
      const result = await syncFn.call(api)
      toast.success(`对账完成：${result.sessions.length} 个云会话`)
      await refresh()
    } catch (failure) {
      toast.error(humanError(failure, '对账失败，再试一次。'))
    } finally {
      setBusy(false)
    }
  }

  const supported =
    api.hostedStatus !== undefined &&
    api.hostedCatalog !== undefined &&
    api.hostedSettings !== undefined &&
    api.hostedHire !== undefined &&
    api.hostedFire !== undefined &&
    api.hostedSync !== undefined

  if (!supported) {
    return (
      <div className="me-section">
        <h3 className="me-group-title">云成员</h3>
        <p className="me-row-note">这个版本的服务端还不支持云成员（Kimi Hosted Agents）。</p>
      </div>
    )
  }

  return (
    <div className="me-section">
      <h3 className="me-group-title">云成员</h3>
      <p className="me-row-sub">
        从 Kimi
        开放平台雇一个跑在云沙箱里的成员。它不占用这台电脑，关掉客户端也会继续工作；下次打开时消息和产物会补回来。
      </p>
      {error !== undefined && <p className="apikey-error">{error}</p>}

      {status?.configured !== true ? (
        <div className="provider-form">
          <label className="field">
            <span>Kimi Open Platform API Key</span>
            <input
              className="input"
              type="password"
              value={apiKey}
              placeholder="sk-..."
              autoComplete="off"
              onChange={(event) => {
                setApiKey(event.target.value)
              }}
            />
          </label>
          <label className="field">
            <span>API 地址</span>
            <input
              className="input"
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.target.value)
              }}
            />
          </label>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void saveSettings()}>
              保存
            </button>
          </div>
          <p className="me-row-note">Key 只存在这台机器上。云会话按沙箱时长与 token 计费，费用由你的 Kimi 账户承担。</p>
        </div>
      ) : (
        <>
          <div className="me-row me-row-block">
            <div className="me-row-body">
              <div className="me-row-title">已连接</div>
              <div className="me-row-sub">
                {status.baseUrl}
                {status.environmentId === undefined ? ' · 环境将在首次雇佣时创建' : ` · 环境 ${status.environmentId}`}
              </div>
            </div>
            <button type="button" className="btn btn-mini" disabled={busy} onClick={() => void sync()}>
              对账
            </button>
          </div>

          {(status.members.length > 0 || status.sessions.length > 0) && (
            <div className="me-list">
              {status.members.map((member) => {
                const name = nameOf(member.agentId)
                const sessions = status.sessions.filter((session) => {
                  return session.agentId === member.agentId
                })
                return (
                  <div className="me-row" key={member.agentId}>
                    <div className="me-row-body">
                      <div className="me-row-title">
                        {name} <span className="me-row-note">{member.status === 'active' ? '在职' : '已解雇'}</span>
                      </div>
                      <div className="me-row-sub">
                        {member.scope === 'official' ? '官方成员（配置只读）' : '自建成员'} · {sessions.length} 个云会话
                      </div>
                    </div>
                    {member.status === 'active' && (
                      <button
                        type="button"
                        className="btn btn-mini btn-danger"
                        disabled={busy}
                        onClick={() => {
                          setFiring({ agentId: member.agentId, name })
                        }}
                      >
                        解雇
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          <div className="me-row me-row-block">
            <div className="me-row-body">
              <div className="me-row-title">雇佣一个官方成员</div>
              <div className="me-row-sub">官方成员由 Kimi 维护，配置只读；直接引用即可，不用自己写提示词。</div>
            </div>
          </div>
          <div className="me-list">
            {(catalog?.agents ?? [])
              .filter((agent) => {
                return agent.scope === 'official'
              })
              .slice(0, 12)
              .map((agent) => (
                <div className="me-row" key={agent.id}>
                  <div className="me-row-body">
                    <div className="me-row-title">{agent.name}</div>
                    <div className="me-row-sub">
                      {agent.description ?? agent.id}
                      {agent.model === undefined ? '' : ` · ${agent.model}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-mini btn-primary"
                    disabled={busy}
                    onClick={() => void hireOfficial(agent.id, agent.name)}
                  >
                    雇佣
                  </button>
                </div>
              ))}
            {catalog?.agents !== undefined && catalog.agents.length === 0 && (
              <p className="me-row-note">
                {catalog.error ?? '远端正版清单为空。确认这个 API Key 有托管智能体的权限。'}
              </p>
            )}
          </div>

          <div className="provider-form">
            <label className="field">
              <span>自建一个云成员</span>
              <input
                className="input"
                value={customName}
                placeholder="名字（会出现在通讯录里）"
                maxLength={64}
                onChange={(event) => {
                  setCustomName(event.target.value)
                }}
              />
            </label>
            <label className="field">
              <span>它怎么做事（可选）</span>
              <textarea
                className="input"
                rows={3}
                value={customPrompt}
                placeholder="例如：你在云沙箱里整理资料、做 PPT，并把成果作为产物交付。"
                onChange={(event) => {
                  setCustomPrompt(event.target.value)
                }}
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="btn" disabled={busy} onClick={() => void hireCustom()}>
                自建并雇佣
              </button>
            </div>
          </div>
        </>
      )}

      {firing !== undefined && (
        <ConfirmDialog
          title={`解雇「${firing.name}」？`}
          body="远端成员会被归档（不可逆），已有的云会话变成只读；本地聊天记录和产物都还在。"
          confirmLabel="解雇"
          onConfirm={async () => {
            const fireFn = api.hostedFire
            if (fireFn === undefined) return
            try {
              await fireFn.call(api, firing.agentId)
              toast.success(`已解雇「${firing.name}」`)
              setFiring(undefined)
              await refresh()
              onChanged?.()
            } catch (failure) {
              toast.error(humanError(failure, '解雇失败，再试一次。'))
            }
          }}
          onCancel={() => {
            setFiring(undefined)
          }}
        />
      )}
    </div>
  )
}
