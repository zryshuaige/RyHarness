/**
 * OTel 遥测配置：`<dataDir>/config/telemetry.json`。
 *
 * 文件不存在 = 不往外送（本地环形缓冲照常有，那是给界面看的）。
 * @module @ryharness/server/otel-config
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 遥测配置。 */
export interface TelemetryConfig {
  /**
   * OTLP/HTTP 端点。
   *
   * 给的是**基址**（例如 `http://127.0.0.1:4318`），导出器自己拼 `/v1/traces` 与
   * `/v1/metrics`。
   */
  readonly otlpEndpoint?: string
  /** 请求头（鉴权之类）。 */
  readonly headers?: Readonly<Record<string, string>>
  /** 多久冲一次（毫秒）。默认 10 秒。 */
  readonly flushIntervalMs?: number
}

/**
 * 读服务端自己的版本号（给 OTel 的 resource 用）。
 *
 * 从 `apps/server/package.json` 读——版本号因此只有一个来源（改版本只需要改
 * package.json）。读不到就退回 `'unknown'`：版本是标识信息，不是必需项。
 * @returns 版本号。
 */
export function readServerVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return 'unknown'
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' && version.length > 0 ? version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 读遥测配置。
 *
 * 读不出来就是「不往外送」：配置坏了不该让服务端起不来。
 * @param dataDir - 数据目录。
 * @returns 配置；没有或坏了都是空对象。
 */
export function readTelemetryConfig(dataDir: string): TelemetryConfig {
  const path = join(dataDir, 'config', 'telemetry.json')
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as Record<string, unknown>
    const endpoint = record.otlpEndpoint
    const headers = record.headers
    const interval = record.flushIntervalMs
    const result: {
      otlpEndpoint?: string
      headers?: Record<string, string>
      flushIntervalMs?: number
    } = {}
    if (typeof endpoint === 'string' && endpoint.length > 0) result.otlpEndpoint = endpoint
    if (typeof headers === 'object' && headers !== null) {
      const entries: Record<string, string> = {}
      for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (typeof value === 'string') entries[key] = value
      }
      if (Object.keys(entries).length > 0) result.headers = entries
    }
    if (typeof interval === 'number' && Number.isFinite(interval) && interval > 0) {
      result.flushIntervalMs = Math.trunc(interval)
    }
    return result
  } catch {
    return {}
  }
}
