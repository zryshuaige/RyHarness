/**
 * Electron Fuses 契约：打包配置里那几条安全熔断不许回退。
 *
 * fuses 的默认值是不安全的：runAsNode 与 nodeCliInspect 默认开，等于装了一个
 * 「任何父进程都能用应用身份跑任意 Node 代码」的解释器（ELECTRON_RUN_AS_NODE /
 * --inspect / NODE_OPTIONS 都是现成的入口）。打包产物要到 CI 打包时才生成，
 * 回归最便宜的钉法是钉住 package.json 的 electronFuses 配置本身。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')) as {
  build: { electronFuses?: Record<string, unknown> }
}

/** 必须为 false 的熔断：开着就是把 Node 解释器随应用一起发出去。 */
const MUST_BE_FALSE = [
  'runAsNode',
  'enableNodeCliInspectArguments',
  'enableNodeOptionsEnvironmentVariable',
  'grantFileProtocolExtraPrivileges',
]

describe('electron-builder electronFuses', () => {
  it('五条关键熔断都显式配置（打包时才会烧进产物，缺省即回退到不安全默认）', () => {
    const fuses = pkg.build.electronFuses
    expect(fuses).toBeDefined()
    for (const key of [...MUST_BE_FALSE, 'enableCookieEncryption']) {
      expect(fuses, key).toHaveProperty(key)
    }
  })

  it('runAsNode / nodeCliInspect / nodeOptions / file 协议额外特权一律关闭', () => {
    const fuses = pkg.build.electronFuses
    for (const key of MUST_BE_FALSE) {
      expect(fuses?.[key], key).toBe(false)
    }
  })

  it('cookie 存盘加密开启（默认明文 SQLite）', () => {
    expect(pkg.build.electronFuses?.enableCookieEncryption).toBe(true)
  })
})
