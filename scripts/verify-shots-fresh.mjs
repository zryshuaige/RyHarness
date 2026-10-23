#!/usr/bin/env node
/**
 * 门禁 6：入库的实拍图不能比渲染层旧。
 *
 * 存在的理由：docs/ 里那几张 PNG 是这个项目对外的正式画面，也是评审时唯一的**像素
 * 证据**。此前踩过一次：服务端的数据换了新、渲染层还停在旧版，图于是是"新数据 + 旧
 * 界面"的混搭——图上写着上一轮就要换掉的文案，照着它评审会得出相反的结论，而且
 * 从图上完全看不出错。
 *
 * 判据：渲染层源码（renderer/src）里最新的改动时间，必须晚于 docs/ 下所有实拍图里
 * 最旧的那张。换句话说：改过界面就得重拍。
 *
 * 判据之外还提醒一句「别把图当唯一真相」——图会过期，代码不会。
 */
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER = path.join(ROOT, 'apps/desktop/renderer/src')
const SHOTS = path.join(ROOT, 'apps/desktop/docs')

/** 目录里最新的 mtime（毫秒）；目录不存在时返回 undefined。 */
function newestMtime(dir, suffix) {
  let newest = 0
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = newestMtime(full, suffix)
      if (nested !== undefined && nested > newest) newest = nested
      continue
    }
    if (!entry.name.endsWith(suffix)) continue
    const mtime = statSync(full).mtimeMs
    if (mtime > newest) newest = mtime
  }
  return newest === 0 ? undefined : newest
}

const rendererNewest = newestMtime(RENDERER, '.ts')
// 只管**当前界面**的实拍（capture-*.png / dark-capture-*.png）。redesign4-* 是设计
// 演进的历史留档（2026-10 的旧界面），它们本来就该比现在旧，拿它们比"新鲜度"是
// 比错了对象。
const shots = readdirSync(SHOTS)
  .filter((name) => {
    return /^dark-capture.*\.png$|^capture.*\.png$/u.test(name)
  })
  .map((name) => {
    return { name, mtime: statSync(path.join(SHOTS, name)).mtimeMs }
  })
  .sort((a, b) => {
    return a.mtime - b.mtime
  })

if (shots.length === 0) {
  console.log('[shots] docs/ 下没有实拍图：跳过。')
  process.exit(0)
}
if (rendererNewest === undefined) {
  console.log('[shots] 找不到渲染层源码：跳过。')
  process.exit(0)
}

const oldest = shots[0]
if (oldest.mtime < rendererNewest) {
  console.error(
    `\n[shots] 实拍图比渲染层旧：${oldest.name}（${new Date(oldest.mtime).toISOString()}）\n` +
      `        渲染层最新改动：${new Date(rendererNewest).toISOString()}\n` +
      '        改过界面就要重拍：pnpm --filter @ryharness/desktop capture\n' +
      '        （否则评审会对着上一版的像素说话，图上看不出错。）\n',
  )
  process.exit(1)
}
console.log(`[shots] 实拍图是最新的（最旧的一张 ${oldest.name} 晚于渲染层最后改动）。`)
