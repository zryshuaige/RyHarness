/**
 * 供应商配置：data/config/providers.json 读写。
 *
 * 首启时写入内置默认条目（SiliconFlow）；apiKey 一律走 apiKeyEnv
 * 引用，配置文件不存明文 key。
 * @module @ryagent/server/config
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { OpenAiAdapterConfig, OpenAiProviderConfig } from '@ryagent/llm-openai'

/** providers.json 的形状。 */
export interface ProvidersConfigFile {
  providers: Record<string, OpenAiProviderConfig>
}

/** 内置默认供应商（SiliconFlow，key 经 SILICONFLOW_API_KEY 环境变量）。 */
export const DEFAULT_PROVIDERS: Record<string, OpenAiProviderConfig> = {
  siliconflow: {
    baseURL: 'https://api.siliconflow.cn/v1',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    displayName: 'SiliconFlow',
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek-V3', contextWindow: 64_000 },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek-R1', contextWindow: 64_000 },
      { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5-72B', contextWindow: 32_000 },
    ],
  },
}

/** 读取 providers.json；不存在则写入默认配置后返回。 */
export function loadProvidersConfig(path: string): ProvidersConfigFile {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    const initial: ProvidersConfigFile = { providers: DEFAULT_PROVIDERS }
    writeFileSync(path, `${JSON.stringify(initial, null, 2)}\n`, 'utf8')
    return initial
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null
    || typeof (parsed as ProvidersConfigFile).providers !== 'object'
    || (parsed as ProvidersConfigFile).providers === null) {
    throw new Error(`@ryagent/server: invalid providers config at ${path}`)
  }
  return parsed as ProvidersConfigFile
}

/** 由配置文件构造适配器配置。 */
export function toAdapterConfig(config: ProvidersConfigFile): OpenAiAdapterConfig {
  return { providers: config.providers }
}

/** 某个供应商的凭据是否已配置（apiKey 直接给出，或 apiKeyEnv 指向的环境变量存在）；只看存在性，不泄露值。 */
export function providerKeyConfigured(
  provider: OpenAiProviderConfig,
  env: (name: string) => string | undefined = (name) => { return process.env[name] },
): boolean {
  if (provider.apiKey !== undefined) return true
  if (provider.apiKeyEnv === undefined) return false
  const value = env(provider.apiKeyEnv)
  return value !== undefined && value.length > 0
}
