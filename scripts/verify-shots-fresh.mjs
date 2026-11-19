#!/usr/bin/env node
/**
 * 门禁 6：入库的实拍图不能比渲染层旧。
 *
 * 存在的理由：docs/ 里那几张 PNG 是这个项目对外的正式画面，也是评审时唯一的**像素
 * 证据**。此前踩过一次：服务端的数据换了新、渲染层还停在旧版，图于是是"新数据 + 旧
 * 界面"的混搭——图上写着上一轮就要换掉的文案，照着它评审会得出相反的结论，而且
 * 从图上完全看不出错。
 *
 * 判据一（新鲜）：渲染层源码（renderer/src 的 .ts/.tsx/.css）里最新的改动时间，必须
 * 晚于 docs/ 下所有实拍图里最旧的那张。换句话说：改过界面就得重拍。
 *
 * 判据二（拍对了页）：同一主题里任何两张实拍不许字节相同。mtime 新鲜只说明最近拍过，
 * 不说明拍对了页——导航失败会把「插件页」拍成个人资料、把暗色欢迎拍成恢复出来的会话，
 * 图看着正常、时间也新鲜，只有内容哈希能抓住。
 *
 * 判据之外还提醒一句「别把图当唯一真相」——图会过期，代码不会。
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER = path.join(ROOT, 'apps/desktop/renderer/src')
const SHOTS = path.join(ROOT, 'apps/desktop/docs')

/** 目录里最新的 mtime（毫秒）；目录不存在时返回 undefined。suffixes 命中的扩展名都算。 */
function newestMtime(dir, suffixes) {
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
      const nested = newestMtime(full, suffixes)
      if (nested !== undefined && nested > newest) newest = nested
      continue
    }
    if (!suffixes.some((suffix) => entry.name.endsWith(suffix))) continue
    const mtime = statSync(full).mtimeMs
    if (mtime > newest) newest = mtime
  }
  return newest === 0 ? undefined : newest
}

// 渲染层的真源是 .ts/.tsx/.css 三种：此前只比 .ts，改组件（.tsx）或改样式（.css）
// 永远不会触发「图比代码旧」——门禁瞎了一只眼，错页/过期图照样绿。三种都算。
const rendererNewest = newestMtime(RENDERER, ['.ts', '.tsx', '.css'])
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

/**
 * 同主题各页哈希互异：mtime 新鲜只说明「最近拍过」，不说明「拍对了页」。
 *
 * 此前踩过：capture-me/plugins/providers 三张画面完全相同（都是个人资料页），
 * dark-capture 与 dark-capture-chat 字节相同（暗色欢迎张拍成了恢复出来的会话）——
 * 导航失败拍错页/重复拍同一屏，图看着挺正常，mtime 也新鲜，门禁照样绿。只有内容
 * 哈希能抓住这类失败：同一主题里任何两张字节相同就红。浅色与暗色像素必然不同，
 * 跨主题不比（也不该比）。
 */
const byTheme = { light: new Map(), dark: new Map() }
for (const shot of shots) {
  const theme = shot.name.startsWith('dark-') ? 'dark' : 'light'
  const hash = createHash('sha256')
    .update(readFileSync(path.join(SHOTS, shot.name)))
    .digest('hex')
  const prior = byTheme[theme].get(hash)
  if (prior !== undefined) {
    console.error(
      `\n[shots] 同主题两张实拍字节相同：${prior} 与 ${shot.name}（${theme}，sha256 ${hash.slice(0, 12)}）\n` +
        '        这是导航拍错了页或重复拍了同一屏——图看着正常，证据却不作数。\n' +
        '        重拍：pnpm --filter @ryharness/desktop capture（capture.ts 拍前断言会拦住错页）。\n',
    )
    process.exit(1)
  }
  byTheme[theme].set(hash, shot.name)
}

console.log(
  `[shots] 实拍图是最新的（最旧的一张 ${oldest.name} 晚于渲染层最后改动），` +
    `且同主题各页哈希互异（浅色 ${byTheme.light.size} 张 / 暗色 ${byTheme.dark.size} 张）。`,
)
