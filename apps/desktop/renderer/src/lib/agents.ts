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
  /** agent 名；查不到时退回「已删除的助理」，绝不把内部 id 摆到署名位置上。 */
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

/**
 * 内置 agent 卡片上的徽标文案（非内置返回 undefined，调用处据此不渲染）。
 *
 * 名字本身就是职能的助理（工程师 / 文案 / 翻译 / 管家）不需要额外标注——名字已经
 * 说清了它是干什么的；内置总管 Ryen 是品牌名不是职能名，徽标补一句它的定位，
 * 否则通讯录与资料卡上只有「Ryen」两个字，用户无从判断该找它办什么事。
 */
/** 已删除助理在聊天记录里留下的中性署名。 */
export const DELETED_AGENT_LABEL = '已删除的助理'

export function builtinBadge(agent: Pick<AgentDef, 'id' | 'isBuiltin'>): string | undefined {
  if (!agent.isBuiltin) return undefined
  return agent.id === 'ryen' ? '内置 · 总管' : '内置'
}

/**
 * 名字回退：查不到就说「已删除的助理」，不退回 id。
 *
 * 退回 id 是把内部标识原样上屏——用户自建的助理 id 是 randomUUID，历史消息在
 * 删掉助理之后仍然留在会话里（删除确认框也这么承诺），于是那一整段聊天的署名
 * 全变成一串机器 id。一句中性标签既诚实（那位确实不在了）又可读。
 *
 * 保留原始 id 的地方是详情面板与排查路径，不是在署名单行。
 */
export function nameOf(agents: readonly AgentDef[], id: string): string {
  return agentById(agents, id)?.name ?? DELETED_AGENT_LABEL
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
