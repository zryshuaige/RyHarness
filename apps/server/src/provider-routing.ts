/**
 * 供应商路由的默认值：内置助理跟着**用户自己挑的那家**走。
 *
 * 此前内置助理（Ryen 与两位常驻队友）的 provider 是写死的 `siliconflow`，模型也是
 * 写死的那家的一条 id。于是用户哪怕自己在设置里配好了 DeepSeek，助理仍然指着
 * 硅基流动——第一句话就报「没有凭据」。
 *
 * 正确的默认是：**谁有凭据就用谁**。用户第一次把某家的 key 填上时，把还指着
 * 「没有凭据的供应商」的内置助理切过去；已经能用的那家不动（他可能有意把某位
 * 助理留在别家）。
 *
 * 用户自建的助理一律不动：那位助理的供应商是用户自己挑的，不是默认值。
 * @module @ryharness/server/provider-routing
 */

import type { SessionStore } from '@ryharness/session'
import { type ProvidersConfigFile, providerKeyConfigured } from './config.ts'

/**
 * 第一个有可用凭据的供应商 id；一家都没有时是 undefined。
 *
 * 「第一个」而不是「最后一个」：providers.json 里的次序是写入次序，内置条目永远
 * 在最前，用户后加的排在后面——用户自己加的那家排在后面才符合直觉（他刚配的
 * 那家是他正在用的那家）。
 */
export function defaultProviderId(providers: ProvidersConfigFile): string | undefined {
  for (const [providerId, provider] of Object.entries(providers.providers)) {
    if (providerKeyConfigured(provider)) return providerId
  }
  return undefined
}

/**
 * 把还指着「没凭据的供应商」的内置助理，切到刚配好凭据的那家。
 *
 * 三个不做就不做的事：
 * - 目标自己没凭据 → 不切（否则会把助理切到一个同样用不了的路由上）；
 * - 助理当前那家已经有凭据 → 不切（用户有意留在别家，或已经配好了）；
 * - 用户自建的助理 → 不切（那是用户自己挑的）。
 *
 * 模型取目标供应商目录里的第一条：换成别家之后模型 id 必然不同，沿用旧 id 会让
 * 请求带着一个那家不认的模型名出去。
 *
 * @param store - 会话存储（改的是 agents 表）。
 * @param providers - 当前供应商配置。
 * @param targetId - 刚配好凭据的那家。
 * @returns 实际切过去的助理数量。
 */
export function retargetBuiltinAgents(store: SessionStore, providers: ProvidersConfigFile, targetId: string): number {
  const target = providers.providers[targetId]
  if (target === undefined) return 0
  if (!providerKeyConfigured(target)) return 0
  const model = target.models[0]?.id
  if (model === undefined) return 0
  let changed = 0
  for (const agent of store.listAgents()) {
    if (!agent.isBuiltin) continue
    const current = providers.providers[agent.provider]
    if (current !== undefined && providerKeyConfigured(current)) continue
    store.upsertAgent({
      id: agent.id,
      name: agent.name,
      ...(agent.avatar === undefined ? {} : { avatar: agent.avatar }),
      systemPrompt: agent.systemPrompt,
      provider: targetId,
      model,
      ...(agent.temperature === undefined ? {} : { temperature: agent.temperature }),
      ...(agent.reasoningEffort === undefined ? {} : { reasoningEffort: agent.reasoningEffort }),
      tools: [...agent.tools],
      persona: agent.persona,
      isBuiltin: true,
    })
    changed += 1
  }
  return changed
}
