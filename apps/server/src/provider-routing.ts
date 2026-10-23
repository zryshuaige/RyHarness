/**
 * 供应商路由的默认值：内置助理跟着**用户自己挑的那家**走。
 *
 * 此前内置助理（Ryen 与两位常驻队友）的 provider 是写死的 `siliconflow`，模型也是
 * 写死的那家的一条 id。于是用户哪怕自己在设置里配好了 DeepSeek，助理仍然指着
 * 硅基流动——第一句话就报「没有凭据」。
 *
 * 正确的默认是：**谁有凭据就用谁**。用户第一次把某家的 key 填上时，把还指着
 * 「自己没凭据的那家」的内置助理切过去；已经能用的那家不动（他可能有意把某位
 * 助理留在别家），用户手动挑过路由的助理也不动。
 *
 * 「用户手动挑过」由 agent 上的 route_locked 标记记着，不能靠猜。
 * 早先的判据是「provider 等于种子默认值就算没被挑过」——那个判据在助理被自动
 * 搬过一次之后就失效了：搬完 provider 已经不等于种子默认值，于是那位助理从此
 * 再也不会跟着走，哪怕它现在指着的这家已经没凭据、用户也已经配好了别家，它会
 * 一直卡在「没有凭据」上。删掉 key 再换一家就足以触发，属于用户一定会做的事。
 *
 * 用户自建的助理一律不动：那位助理的供应商是用户自己挑的，不是默认值。
 * @module @ryharness/server/provider-routing
 */

import type { SessionStore } from '@ryharness/session'
import { PROVIDER_PRESETS, type ProviderConfig, type ProvidersConfigFile, providerKeyConfigured } from './config.ts'

/**
 * 目标供应商的「给新用户用的那一档」。
 *
 * 不盲取列表第一条：每家第一档不一定是新用户能用的（Moonshot 的 kimi-k3 要先充值
 * 才有权限，OpenRouter 头两档是旗舰价）。预设里标了 defaultModel 的按它来，没有
 * 标记的退回第一条。
 */
function defaultModelOf(target: ProviderConfig): string | undefined {
  const preset =
    target.presetId === undefined
      ? undefined
      : PROVIDER_PRESETS.find((candidate) => {
          return candidate.id === target.presetId
        })
  if (preset?.defaultModel !== undefined) {
    const exists = target.models.some((model) => {
      return model.id === preset.defaultModel
    })
    if (exists) return preset.defaultModel
  }
  return target.models[0]?.id
}

/**
 * 把「还指着没凭据的那家」的辅助切到刚配好凭据的那家。
 *
 * 切过去的是**内置**助理：用户自建的助理路由是他自己挑的，服务器不替他决定。
 *
 * @param store - 会话存储（改的是 agents 表）。
 * @param providers - 当前供应商配置。
 * @param targetId - 刚配好凭据的那家。
 * @returns 实际切过去的助理清单（谁、去了哪家、用的哪一档）。
 */
export interface RetargetedAgent {
  id: string
  name: string
  provider: string
  model: string
}

export function retargetBuiltinAgents(
  store: SessionStore,
  providers: ProvidersConfigFile,
  targetId: string,
): RetargetedAgent[] {
  const target = providers.providers[targetId]
  if (target === undefined) return []
  if (!providerKeyConfigured(target)) return []
  const model = defaultModelOf(target)
  if (model === undefined) return []
  const changed: RetargetedAgent[] = []
  for (const agent of store.listAgents()) {
    if (!agent.isBuiltin) continue
    // 用户手动挑过路由 → 不动。「我就是要用这家」是用户的选择，服务器不替他改。
    if (agent.routeLocked === true) continue
    // 种子默认那家已经有凭据 → 用户已经在用它了，不搬。
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
      // 自动搬的仍然是「自动」：routeLocked 保持 false，下次换家还能跟着走。
      routeLocked: false,
    })
    changed.push({ id: agent.id, name: agent.name, provider: targetId, model })
  }
  return changed
}
