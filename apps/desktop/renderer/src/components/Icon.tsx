/**
 * Lucide 图标注册表（lucide-static，ISC license，资产经 scripts/gen-lucide-icons.mjs
 * 从 node_modules 拷入 src/assets/lucide/ 并入库）。stroke 风格 2px 线宽、
 * 圆角线帽、24 viewBox、currentColor —— 替换此前的手绘图标（用户反馈：
 * 手绘图标与专业前端产品差距明显）。
 * 用法：<Icon name="send" size={18} />
 */

import rawAlert from '../assets/lucide/alert.svg?raw'
import rawAtSign from '../assets/lucide/at-sign.svg?raw'
import rawBrain from '../assets/lucide/brain.svg?raw'
import rawCatFace from '../assets/lucide/cat-face.svg?raw'
import rawChatBubble from '../assets/lucide/chat-bubble.svg?raw'
import rawCheck from '../assets/lucide/check.svg?raw'
import rawChevronLeft from '../assets/lucide/chevron-left.svg?raw'
import rawChevronRight from '../assets/lucide/chevron-right.svg?raw'
import rawCopy from '../assets/lucide/copy.svg?raw'
import rawDices from '../assets/lucide/dices.svg?raw'
import rawFile from '../assets/lucide/file.svg?raw'
import rawGear from '../assets/lucide/gear.svg?raw'
import rawGroup from '../assets/lucide/group.svg?raw'
import rawMoon from '../assets/lucide/moon.svg?raw'
import rawPanelRight from '../assets/lucide/panel-right.svg?raw'
import rawPencil from '../assets/lucide/pencil.svg?raw'
import rawPlus from '../assets/lucide/plus.svg?raw'
import rawSearch from '../assets/lucide/search.svg?raw'
import rawSend from '../assets/lucide/send.svg?raw'
import rawSun from '../assets/lucide/sun.svg?raw'
import rawThumbsDown from '../assets/lucide/thumbs-down.svg?raw'
import rawThumbsUp from '../assets/lucide/thumbs-up.svg?raw'
import rawUsers from '../assets/lucide/users.svg?raw'
import rawX from '../assets/lucide/x.svg?raw'

/** 去掉 lucide 源文件里的固定宽高与许可注释，只留 <svg> 元素本体。 */
function bodyOf(raw: string): string {
  const match = /<svg[\s\S]*<\/svg>/.exec(raw)
  if (match === null) return ''
  return match[0].replace(/\n\s*<!-- @license [^>]*-->\n/, '').replace(/width="24"\s*height="24"\s*/, '')
}

export const ICONS = {
  'chat-bubble': bodyOf(rawChatBubble),
  users: bodyOf(rawUsers),
  'cat-face': bodyOf(rawCatFace),
  sun: bodyOf(rawSun),
  moon: bodyOf(rawMoon),
  gear: bodyOf(rawGear),
  search: bodyOf(rawSearch),
  send: bodyOf(rawSend),
  brain: bodyOf(rawBrain),
  plus: bodyOf(rawPlus),
  x: bodyOf(rawX),
  'chevron-right': bodyOf(rawChevronRight),
  'chevron-left': bodyOf(rawChevronLeft),
  'panel-right': bodyOf(rawPanelRight),
  copy: bodyOf(rawCopy),
  check: bodyOf(rawCheck),
  file: bodyOf(rawFile),
  'thumbs-up': bodyOf(rawThumbsUp),
  'thumbs-down': bodyOf(rawThumbsDown),
  'at-sign': bodyOf(rawAtSign),
  group: bodyOf(rawGroup),
  pencil: bodyOf(rawPencil),
  alert: bodyOf(rawAlert),
  dices: bodyOf(rawDices),
} as const

export type IconName = keyof typeof ICONS

/**
 * 尺寸网格：只保留 12/16/20/24 四档。非四档的旧调用点（11/13/15/18/22…）
 * 会量化到最近的一档（等距时取大档），保证同类图标的视觉粗细与基线一致。
 */
export const ICON_SIZE_STEPS = [12, 16, 20, 24] as const

export function quantizeIconSize(size: number): number {
  for (const step of ICON_SIZE_STEPS) {
    // 等距时进位：13 → 12，14 → 16，18 → 20，22 → 24。
    if (size < step + 2) return step
  }
  return ICON_SIZE_STEPS[ICON_SIZE_STEPS.length - 1]
}

/** 统一图标组件：颜色继承 currentColor，尺寸默认 20，线宽可用 strokeWidth 覆盖。 */
export function Icon({
  name,
  size = 20,
  className = '',
  strokeWidth,
}: {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
}) {
  const body = ICONS[name]
  if (body === undefined || body.length === 0) return null
  const px = quantizeIconSize(size)
  // replaceAll：lucide 多路径图标里每条路径各有一份 stroke-width，
  // 只替换第一个会让同一图标内出现两种粗细。
  const svg = strokeWidth === undefined ? body : body.replaceAll('stroke-width="2"', `stroke-width="${strokeWidth}"`)
  return (
    <span
      className={`icon ${className}`}
      style={{ width: px, height: px, display: 'inline-flex' }}
      aria-hidden="true"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: lucide 本地静态图标 SVG，无外部输入
      dangerouslySetInnerHTML={{
        __html: svg.replace('<svg', `<svg width="${px}" height="${px}"`),
      }}
    />
  )
}
