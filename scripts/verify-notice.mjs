#!/usr/bin/env node
/**
 * 门禁：NOTICE.md 里的每个数都必须等于仓库事实，逐字节比对。
 *
 * 为什么不让人肉核对：这份文件以「可核对的总账」为卖点，而它此前唯一的核对方法是
 * 跑一次 electron-builder 打包、再 `ls` 一遍安装目录——事实上没人跑，于是图标数与
 * 工作区包数各漂了一处（30→31、10→18）而无人发现。门禁化之后，漂移在每次提交上红，
 * 成本是几百毫秒的目录扫描。
 *
 * 它拦两类退化，且刻意不只拦数字：
 *   1. 不相等——已安装的版本/许可、图标数、随包交付的工作区包闭包变了，NOTICE 没跟上；
 *   2. 标记缺失或未登记——有人把 `<!-- notice:... -->` 删掉，等于把这个数退回手维护，
 *      那是绕过门禁的后门，所以同样算失败。
 *
 * 用法：
 *   node scripts/verify-notice.mjs            # 校验，0 = 通过
 *   node scripts/verify-notice.mjs --json     # 机器可读输出（CI 日志用）
 *   node scripts/verify-notice.mjs --write    # 按仓库事实重写 NOTICE.md（随提交一起评审）
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMarkers, auditNotice } from './notice-audit.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const JSON_OUT = process.argv.includes('--json')
const WRITE = process.argv.includes('--write')

/**
 * README 顶部的 shields 徽章里也有一个仓库事实（测试文件数）。徽章不像 NOTICE
 * 那样有 `<!-- notice: -->` 标记可登记，所以这里按 README 自己写下的模式重写它：
 * 与 NOTICE 同源的那套核对的价值就在于「数是数出来的，不是人肉填的」，徽章同理。
 * 加测试文件时忘了改徽章，就是一次没人发现的漂移（此前正是 118 vs 151）。
 */
// 只匹配到数字为止：徽章 URL 里紧跟其后的是 `%20files`，中间没有空格，
// 正则若要求 `tests-<n> files` 会整条不匹配，于是 --write 静默不落盘。
const BADGE_PATTERN = /badge\/tests-(\d+)/

function syncReadmeBadge(actual, write) {
  const file = path.join(ROOT, 'README.md')
  const source = readFileSync(file, 'utf8')
  const stated = source.match(BADGE_PATTERN)?.[1]
  if (stated === undefined) {
    return { ok: false, message: 'README.md 里找不到 tests 徽章，无法核对。' }
  }
  if (stated === actual) return { ok: true }
  if (write) {
    writeFileSync(file, source.replace(BADGE_PATTERN, `badge/tests-${actual}`))
    return { ok: false, message: `README.md 的 tests 徽章已按仓库事实改为 ${actual} 个测试文件。` }
  }
  return { ok: false, message: `README.md 的 tests 徽章写的是 ${stated}，仓库实际 ${actual} 个测试文件。` }
}

/** 测试文件数：与 vitest.config.ts 的 include 模式保持一致（排除 node_modules/lib/dist）。 */
function countTestFiles() {
  let total = 0
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'lib' && entry.name !== 'dist') walk(full)
      } else if (/\.test\.tsx?$/.test(entry.name)) {
        total += 1
      }
    }
  }
  for (const top of ['apps', 'packages']) walk(path.join(ROOT, top))
  return total
}

const result = auditNotice(ROOT)
const badge = syncReadmeBadge(String(countTestFiles()), WRITE)

if (WRITE) {
  const file = path.join(ROOT, 'NOTICE.md')
  const next = applyMarkers(result.source, result.rendered)
  if (next === result.source) {
    console.log('NOTICE.md 已经与仓库事实一致，无需重写。')
  } else {
    writeFileSync(file, next)
    console.log(`已按仓库事实重写 ${path.relative(ROOT, file)} 的 ${result.checks.length} 处标记，请连同改动一起提交。`)
  }
  // 徽章在 syncReadmeBadge 里已经按 --write 改过；这里再报一次改了什么，
  // 否则「NOTICE 无需重写」会让人以为整个脚本什么都没做。
  if (!badge.ok) console.log(`已按仓库事实修正 README.md 的 tests 徽章（${badge.message}）`)
  process.exit(0)
}

const failed = result.checks.filter((check) => !check.ok)

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: result.ok, checks: result.checks }, null, 2))
} else {
  console.log(`NOTICE 核对：${result.checks.length} 处标记 / ${failed.length} 处对不上。`)
  for (const check of failed) {
    if (check.reason !== undefined) {
      console.log(`  ✗ ${check.key}：${check.reason}（来源 ${check.from}）`)
      continue
    }
    console.log(`\n  ✗ ${check.key}（来源 ${check.from}）`)
    console.log(`    NOTICE.md 写的是：${check.actual}`)
    console.log(`    仓库事实是：    ${check.expected}`)
  }
  if (failed.length === 0) console.log('  通过：文档里的每个数都与仓库事实一致。')
  else console.log('\n  改资产或依赖后跑 node scripts/verify-notice.mjs --write 让数字跟上事实。')
}
if (!badge.ok) console.log(`  ✗ ${badge.message}`)

process.exit(result.ok && badge.ok ? 0 : 1)
