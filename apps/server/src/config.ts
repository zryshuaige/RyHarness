/**
 * 供应商配置：data/config/providers.json 读写。
 *
 * 首启时写入内置默认条目（SiliconFlow）；apiKey 一律走 apiKeyEnv
 * 引用，配置文件不存明文 key。
 * @module @ryagent/server/config
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as ProvidersConfigFile).providers !== 'object' ||
    (parsed as ProvidersConfigFile).providers === null
  ) {
    throw new Error(`@ryagent/server: invalid providers config at ${path}`)
  }
  return parsed as ProvidersConfigFile
}

/**
 * 应用内配置的 API key 存储：config/api-keys.json（0600）。
 *
 * providers.json 坚持只存 apiKeyEnv 引用、不落明文；但桌面应用要让用户
 * 首启就能粘贴 key 用起来，所以明文 key 单独放一个 0600 的文件，且**只**在
 * 进程内合并进适配器配置，不回显给前端。
 */
export function loadApiKeys(dataDir: string): Record<string, string> {
  const path = join(dataDir, 'config', 'api-keys.json')
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const entries = Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string' && entry[1].length > 0
    })
    return Object.fromEntries(entries)
  } catch {
    return {}
  }
}

/** 原子写入某个供应商的 key；返回是否写入成功（供应商未知时 false）。 */
export function saveApiKey(dataDir: string, providerId: string, key: string): boolean {
  const configPath = join(dataDir, 'config', 'providers.json')
  const config = loadProvidersConfig(configPath)
  if (config.providers[providerId] === undefined) return false
  const path = join(dataDir, 'config', 'api-keys.json')
  mkdirSync(dirname(path), { recursive: true })
  const keys = loadApiKeys(dataDir)
  if (key.length === 0) delete keys[providerId]
  else keys[providerId] = key
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(keys, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows 上 chmod 语义有限，失败不阻塞启动。
  }
  return true
}

/**
 * 把本地存储的 key 合并进供应商配置（apiKeyEnv 优先级更高：显式环境变量
 * 仍然覆盖应用内设置，方便开发时用 .env 覆盖）。
 */
export function mergeApiKeys(config: ProvidersConfigFile, keys: Record<string, string>): ProvidersConfigFile {
  if (Object.keys(keys).length === 0) return config
  const providers = { ...config.providers }
  for (const [providerId, key] of Object.entries(keys)) {
    const provider = providers[providerId]
    if (provider === undefined || provider.apiKey !== undefined) continue
    providers[providerId] = { ...provider, apiKey: key }
  }
  return { providers }
}

/** 由配置文件构造适配器配置。 */
export function toAdapterConfig(config: ProvidersConfigFile): OpenAiAdapterConfig {
  return { providers: config.providers }
}

/** 某个供应商的凭据是否已配置（apiKey 直接给出，或 apiKeyEnv 指向的环境变量存在）；只看存在性，不泄露值。 */
export function providerKeyConfigured(
  provider: OpenAiProviderConfig,
  env: (name: string) => string | undefined = (name) => {
    return process.env[name]
  },
): boolean {
  if (provider.apiKey !== undefined) return true
  if (provider.apiKeyEnv === undefined) return false
  const value = env(provider.apiKeyEnv)
  return value !== undefined && value.length > 0
}
