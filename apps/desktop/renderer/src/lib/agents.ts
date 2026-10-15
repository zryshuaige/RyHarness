/**
 * agents 列表的查表助手。
 *
 * 渲染层到处都在按 id 找 agent（气泡署名、会话列表、右栏资料卡、建群弹窗），
 * 每处各写一遍 `agents.find((a) => a.id === id) ?? id`：漏一个 `??` 兜底就渲染出
 * 一段 undefined，漏一次 filter 就把 undefined 塞进 .map 的下游。这里把四条口径
 * 钉死成一个来源。
 *
 * 组件里用 {@link useAgents}：它按 Map 建索引（O(1) 而非每处 O(n)），并且返回的
 * 闭包身份在 agents 不变时保持稳定——MessageBubble 的 RelayChain 是 memo 组件，
 * 每次渲染新建 nameOf/avatarOf 会让它跟着每个 token 重绘。非组件的纯函数场景
 * 直接用导出的同名函数。
 */
import { useMemo } from 'react'
import type { AgentDef } from '../api.ts'

/** 头像位需要的最小字段（agent 缺失时 name 退回 id，avatarKey 留空走兜底色块）。 */
export interface AgentAvatarRef {
  avatarKey?: string
  name: string
}

export interface AgentIndex {
  /** agent 名；查不到时退回 id，保证界面上永远有一行可读的署名。 */
  nameOf: (id: string) => string
  agentById: (id: string) => AgentDef | undefined
  /** 按 id 顺序取成员，自动剔除已删除的 agent（会话数据可以比通讯录新）。 */
  membersOf: (ids: readonly string[]) => AgentDef[]
  avatarOf: (id: string) => AgentAvatarRef
}

export function agentById(agents: readonly AgentDef[], id: string): AgentDef | undefined {
  return agents.find((a) => {
    return a.id === id
  })
}

export function nameOf(agents: readonly AgentDef[], id: string): string {
  return agentById(agents, id)?.name ?? id
}

export function membersOf(agents: readonly AgentDef[], ids: readonly string[]): AgentDef[] {
  return ids
    .map((id) => {
      return agentById(agents, id)
    })
    .filter((a): a is AgentDef => {
      return a !== undefined
    })
}

export function avatarOf(agents: readonly AgentDef[], id: string): AgentAvatarRef {
  const agent = agentById(agents, id)
  return { avatarKey: agent?.avatar, name: agent?.name ?? id }
}

/** Map 索引版：适合一个组件里反复查同一份列表的场合。 */
export function useAgents(agents: readonly AgentDef[]): AgentIndex {
  const byId = useMemo(() => {
    return new Map(
      agents.map((a) => {
        return [a.id, a]
      }),
    )
  }, [agents])

  return useMemo(() => {
    const nameOf = (id: string): string => {
      return byId.get(id)?.name ?? id
    }
    const agentById = (id: string): AgentDef | undefined => {
      return byId.get(id)
    }
    return {
      nameOf,
      agentById,
      membersOf: (ids: readonly string[]) => {
        return ids
          .map((id) => {
            return byId.get(id)
          })
          .filter((a): a is AgentDef => {
            return a !== undefined
          })
      },
      avatarOf: (id: string): AgentAvatarRef => {
        const agent = byId.get(id)
        return { avatarKey: agent?.avatar, name: agent?.name ?? id }
      },
    }
  }, [byId])
}