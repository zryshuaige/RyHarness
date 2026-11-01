/**
 * 分层装配的配置：`<dataDir>/config/bundle.json`。
 *
 * 文件不存在 = 用默认那套插件清单；存在 = 按 bundle 叠出来的决定裁剪（哪几个插件
 * 装、哪几个不装）。
 *
 * 这就是「profile」那层意思的落点：用户可以在自己的机器上定义一套装配，不用改代码。
 * @module @ryharness/server/bundle-config
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveBundle, type Bundle } from '@ryharness/bundle'

/**
 * 读 bundle 配置并叠出插件决定。
 *
 * @param dataDir - 数据目录。
 * @returns 插件 id → 装不装；没有配置文件是 undefined（用默认清单）。
 */
export function readBundleDecisions(dataDir: string): Map<string, boolean> | undefined {
  const path = join(dataDir, 'config', 'bundle.json')
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const bundle = parsed as Bundle
  if (typeof bundle.name !== 'string' || !Array.isArray(bundle.layers)) return undefined
  const decisions = new Map<string, boolean>()
  for (const plugin of resolveBundle(bundle).plugins) decisions.set(plugin.id, plugin.enabled)
  return decisions
}
