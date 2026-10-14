/**
 * 从 lucide-static 拷贝 UI 需要的图标到 src/assets/lucide/（一次性，资产入库）。
 * 用法：pnpm --filter @ryagent/desktop gen:icons
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '../node_modules/lucide-static/icons')
const outDir = join(here, '../renderer/src/assets/lucide')

// 与 Icon.tsx 注册表一一对应（手绘版 → Lucide 正式名）。
// 猫是品牌资产（Cat.tsx 矢量母版），不进本表——lucide 的 cat 是另一只几何不同的猫。
const ICONS = {
  'chat-bubble': 'message-circle',
  users: 'users',
  sun: 'sun',
  moon: 'moon',
  gear: 'settings-2',
  search: 'search',
  send: 'send',
  brain: 'brain',
  plus: 'plus',
  x: 'x',
  'chevron-right': 'chevron-right',
  'chevron-left': 'chevron-left',
  'panel-right': 'panel-right',
  copy: 'copy',
  check: 'check',
  file: 'file-text',
  'thumbs-up': 'thumbs-up',
  'thumbs-down': 'thumbs-down',
  'at-sign': 'at-sign',
  group: 'users-round',
  pencil: 'pencil',
  alert: 'triangle-alert',
  dices: 'dices',
  'clipboard-list': 'clipboard-list',
  mail: 'mail',
  'calendar-days': 'calendar-days',
}

mkdirSync(outDir, { recursive: true })
let copied = 0
for (const [key, lucideName] of Object.entries(ICONS)) {
  const from = join(srcDir, `${lucideName}.svg`)
  if (!existsSync(from)) {
    console.error(`missing lucide icon: ${lucideName}`)
    continue
  }
  copyFileSync(from, join(outDir, `${key}.svg`))
  copied++
}
console.log(`[gen:icons] copied ${copied}/${Object.keys(ICONS).length} lucide icons (ISC license)`)
