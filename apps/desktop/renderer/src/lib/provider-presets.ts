/**
 * 供应商预设的共用文案：副标题与「这家要不要 key」。
 *
 * 这两件事以前只有设置页知道，于是欢迎页那张同样的网格出现了两套口径：
 * 本地 Ollama 在设置页写着「免 key」、点进去也确实不渲染密码框，而在欢迎页
 * 却无条件弹一个密码框——本地用户（唯一走得通 Ollama 的那批人）第一眼就撞进
 * 一个填不出东西的死胡同。口径得只有一份。
 */
import type { ProviderPreset } from '../api.ts'
import { protocolLabel } from './humanize.ts'
import { isKeylessProtocol } from './provider-health.ts'

/** 预设副标题：协议 + 推荐模型数。免 key 的协议直说，免得以为点进去还要填 key。 */
export function presetSummary(preset: ProviderPreset): string {
  if (isKeylessProtocol(preset.protocol)) return `${protocolLabel(preset.protocol)} · 免 key`
  return `${protocolLabel(preset.protocol)} · ${preset.models.length} 个模型`
}
