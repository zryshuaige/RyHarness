/**
 * 内置插件：OpenAI 兼容模型路由。
 *
 * 配置对象由组合根持有并原地更新（供应商增删时刷新 routes），所以这里**不能**
 * 复制它——适配器每次请求现读的必须是同一份对象，复制出来的副本只会留住启动
 * 那一刻的供应商。
 * @module @ryharness/server/plugins/llm-openai
 */

import type { OpenAiPluginConfig } from '@ryharness/llm-openai'
import { apply } from '@ryharness/llm-openai'
import type { PluginEntry } from './host.ts'

export const LLM_OPENAI_PLUGIN_ID = 'llm-openai'

export function llmOpenAiPlugin(config: OpenAiPluginConfig): PluginEntry {
  return {
    id: LLM_OPENAI_PLUGIN_ID,
    name: 'OpenAI 兼容模型',
    description: '把你在设置里配好的模型供应商接到对话内核，所有回复都经过它。',
    group: 'core',
    capabilities: {},
    impact: '关闭后所有模型调用都会失败，应用无法对话。',
    core: true,
    inject: ['llm'],
    apply,
    config,
  }
}
