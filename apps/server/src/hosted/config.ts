/**
 * Hosted Agents 的本地配置与凭据。
 *
 * 两件事分开存：`config/hosted.json` 是非敏感设置（环境 id、baseUrl），
 * `config/hosted-key.json` 只有 API Key，按 0600 原子写入——与 providers 的
 * 凭据文件同一套权限口径。环境变量 `KIMI_API_KEY` 作为兜底，方便命令行与 CI。
 * @module @ryharness/server/hosted/config
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 官方 API 根地址。测试里可以换成假的 baseUrl。 */
export const HOSTED_DEFAULT_BASE_URL = 'https://api.moonshot.cn'

/**
 * 托管智能体 API 的版本头。
 *
 * 契约还是 beta：升级时只改这一个常量与适配层，不要把字符串散到各处。
 */
export const HOSTED_API_VERSION = '2026-09-01-beta'

/** `config/hosted.json` 的形状。 */
export interface HostedConfigFile {
  /** API 根地址（缺省 {@link HOSTED_DEFAULT_BASE_URL}）。 */
  baseUrl?: string
  /** 默认执行环境；雇佣时没给就复用它。 */
  environmentId?: string
  /** 上次雇佣的远端 agent（给界面预选，不参与运行）。 */
  defaultAgentId?: string
}

/** 配置文件路径。 */
export function hostedConfigPath(dataDir: string): string {
  return join(dataDir, 'config', 'hosted.json')
}

function hostedKeyPath(dataDir: string): string {
  return join(dataDir, 'config', 'hosted-key.json')
}

/** 0600 原子写入（先 tmp 再 rename），Windows 上 chmod 失败不阻塞。 */
function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows 上 chmod 语义有限。
  }
}

/** 读设置；文件坏了按"没配"处理，不让一条脏 JSON 拦住启动。 */
export function readHostedConfig(dataDir: string): HostedConfigFile {
  const path = hostedConfigPath(dataDir)
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as Record<string, unknown>
    return {
      ...(typeof record.baseUrl === 'string' && record.baseUrl.length > 0 ? { baseUrl: record.baseUrl } : {}),
      ...(typeof record.environmentId === 'string' && record.environmentId.length > 0
        ? { environmentId: record.environmentId }
        : {}),
      ...(typeof record.defaultAgentId === 'string' && record.defaultAgentId.length > 0
        ? { defaultAgentId: record.defaultAgentId }
        : {}),
    }
  } catch {
    return {}
  }
}

/** 合并写设置（未出现的字段保持不变）。 */
export function writeHostedConfig(dataDir: string, patch: HostedConfigFile): HostedConfigFile {
  const next: HostedConfigFile = { ...readHostedConfig(dataDir), ...patch }
  writePrivateJson(hostedConfigPath(dataDir), next)
  return next
}

/** 读 API Key：文件优先，其次 `KIMI_API_KEY`。 */
export function readHostedApiKey(dataDir: string): string | undefined {
  const path = hostedKeyPath(dataDir)
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        const key = (parsed as Record<string, unknown>).apiKey
        if (typeof key === 'string' && key.length > 0) return key
      }
    } catch {
      // 落到环境变量。
    }
  }
  const fromEnv = process.env.KIMI_API_KEY
  return fromEnv === undefined || fromEnv.length === 0 ? undefined : fromEnv
}

/** 写 API Key；空串 = 删除。 */
export function writeHostedApiKey(dataDir: string, apiKey: string): void {
  if (apiKey.length === 0) {
    writePrivateJson(hostedKeyPath(dataDir), {})
    return
  }
  writePrivateJson(hostedKeyPath(dataDir), { apiKey })
}

/** 这个数据目录配没配好（有 key 就能调）。 */
export function hostedConfigured(dataDir: string): boolean {
  return readHostedApiKey(dataDir) !== undefined
}
