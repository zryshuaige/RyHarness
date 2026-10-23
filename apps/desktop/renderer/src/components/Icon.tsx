/**
 * Lucide 图标注册表（lucide-static，ISC license，资产经 scripts/gen-lucide-icons.mjs
 * 从 node_modules 拷入 src/assets/lucide/ 并入库）。全站 UI 图标只有这一套：
 * 24 viewBox、圆角线帽、currentColor、线宽 ICON_STROKE_WIDTH（2，24 网格用户单位）。
 *
 * 两条不可绕开的约束：
 * - **不引入第二套图标库**。两套线宽与端点风格并排，比风格不统一更糟。
 * - **不按调用点改线宽**。线宽只在根 <svg> 上出现一次，由常量回填；想要更细的图标
 *   说明这个图标选错了（该换一个图形），而不是该调粗细。
 *
 * 这里只登记通用 UI 图标。猫是品牌资产，由 Cat.tsx 的位图母版独占——Lucide 的
 * `cat-face` 曾被注册进来又从不被渲染，等于第三只几何不同的猫，随时可能被人
 * "顺手用上"。
 *
 * 猫（填充）与 UI 图标（描边）并排时，猫取 16、比同排图标小一档：读作"主角色旁边
 * 放着界面元素"，而不是两个图标互撞。调大猫、调细图标都只会让两者更像同一件东西。
 *
 * 用法：<Icon name="send" size={16} />
 */

import rawAlert from '../assets/lucide/alert.svg?raw'
import rawArrowUp from '../assets/lucide/arrow-up.svg?raw'
import rawArrowUpRight from '../assets/lucide/arrow-up-right.svg?raw'
import rawAtSign from '../assets/lucide/at-sign.svg?raw'
import rawBlocks from '../assets/lucide/blocks.svg?raw'
import rawBrain from '../assets/lucide/brain.svg?raw'
import rawCalendarDays from '../assets/lucide/calendar-days.svg?raw'
import rawChatBubble from '../assets/lucide/chat-bubble.svg?raw'
import rawCheck from '../assets/lucide/check.svg?raw'
import rawChevronLeft from '../assets/lucide/chevron-left.svg?raw'
import rawChevronRight from '../assets/lucide/chevron-right.svg?raw'
import rawClipboardList from '../assets/lucide/clipboard-list.svg?raw'
import rawCopy from '../assets/lucide/copy.svg?raw'
import rawCrown from '../assets/lucide/crown.svg?raw'
import rawDices from '../assets/lucide/dices.svg?raw'
import rawEllipsis from '../assets/lucide/ellipsis.svg?raw'
import rawFile from '../assets/lucide/file.svg?raw'
import rawGear from '../assets/lucide/gear.svg?raw'
import rawGroup from '../assets/lucide/group.svg?raw'
import rawMail from '../assets/lucide/mail.svg?raw'
import rawMoon from '../assets/lucide/moon.svg?raw'
import rawPanelRight from '../assets/lucide/panel-right.svg?raw'
import rawPencil from '../assets/lucide/pencil.svg?raw'
import rawPlus from '../assets/lucide/plus.svg?raw'
import rawSearch from '../assets/lucide/search.svg?raw'
import rawSend from '../assets/lucide/send.svg?raw'
import rawSparkles from '../assets/lucide/sparkles.svg?raw'
import rawSpeaker from '../assets/lucide/speaker.svg?raw'
import rawSquare from '../assets/lucide/square.svg?raw'
import rawSun from '../assets/lucide/sun.svg?raw'
import rawThumbsDown from '../assets/lucide/thumbs-down.svg?raw'
import rawThumbsUp from '../assets/lucide/thumbs-up.svg?raw'
import rawUser from '../assets/lucide/user.svg?raw'
import rawUsers from '../assets/lucide/users.svg?raw'
import rawVolume2 from '../assets/lucide/volume-2.svg?raw'
import rawX from '../assets/lucide/x.svg?raw'

/**
 * 线宽（24 网格里的用户单位，即 lucide 原生档）。全站唯一值：源文件自带的
 * stroke-width 在 bodyOf 里被剥掉，渲染时由 Icon 统一回填，调用点无从覆盖。
 */
export const ICON_STROKE_WIDTH = 2

/** 去掉 lucide 源文件里的固定宽高与许可注释，只留 <svg> 元素本体。 */
function bodyOf(raw: string): string {
  const match = /<svg[\s\S]*<\/svg>/.exec(raw)
  if (match === null) return ''
  return (
    match[0]
      .replace(/\n\s*<!-- @license [^>]*-->\n/, '')
      .replace(/width="24"\s*height="24"\s*/, '')
      // 线宽是全站唯一的常量，留在这里就是第二个真源（源文件里是 2，但它跟着上游版本走）。
      .replaceAll(/\s*stroke-width="[\d.]+"/g, '')
  )
}

export const ICONS = {
  'chat-bubble': bodyOf(rawChatBubble),
  users: bodyOf(rawUsers),
  user: bodyOf(rawUser),
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
  'clipboard-list': bodyOf(rawClipboardList),
  mail: bodyOf(rawMail),
  'calendar-days': bodyOf(rawCalendarDays),
  // 界面 chrome 此前用字符画冒充图标（⋯ / ↑ / ↗ / ★），它们既不进图标体系也
  // 随系统字体变粗细——这四个是它们的图形版，语义一一对应。
  ellipsis: bodyOf(rawEllipsis),
  'arrow-up': bodyOf(rawArrowUp),
  'arrow-up-right': bodyOf(rawArrowUpRight),
  crown: bodyOf(rawCrown),
  // 朗读：volume-2 = 开始朗读（喇叭 + 声波），square = 播放中的停止键。
  // 另有一个 speaker（硬件音箱的图形）留给语音插件——它是「一台音箱」，不是「发声」。
  speaker: bodyOf(rawSpeaker),
  'volume-2': bodyOf(rawVolume2),
  square: bodyOf(rawSquare),
  // 独立「插件」页签：能力由一块块插件拼起来，图形比插头/齿轮更贴切。
  blocks: bodyOf(rawBlocks),
  // 独立「RyVibe」页签：一句话生成点什么，图形用「闪」这一族。
  sparkles: bodyOf(rawSparkles),
} as const

export type IconName = keyof typeof ICONS

/**
 * 尺寸网格：16 / 20 / 24 三档，下限 16。16 是图标在 100% 下还能读出形状的下限，
 * 再小只能靠猜；非三档的旧调用点（11/13/14/15/18/22…）量化到最近的一档
 * （等距时取大档），保证同类图标的视觉粗细与基线一致。
 */
export const ICON_SIZE_STEPS = [16, 20, 24] as const

export function quantizeIconSize(size: number): number {
  for (const step of ICON_SIZE_STEPS) {
    // 等距时进位：17 → 16，18 → 20，22 → 24。
    if (size < step + 2) return step
  }
  return ICON_SIZE_STEPS[ICON_SIZE_STEPS.length - 1]
}

/** 统一图标组件：颜色继承 currentColor，尺寸默认 20，线宽全站固定 ICON_STROKE_WIDTH。 */
export function Icon({ name, size = 20, className = '' }: { name: IconName; size?: number; className?: string }) {
  const body = ICONS[name]
  if (body === undefined || body.length === 0) return null
  const px = quantizeIconSize(size)
  return (
    <span
      className={`icon ${className}`}
      style={{ width: px, height: px, display: 'inline-flex' }}
      aria-hidden="true"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: lucide 本地静态图标 SVG，无外部输入
      dangerouslySetInnerHTML={{
        // 线宽与尺寸只在这一处落到 svg 上：根元素一份，子元素全部继承。
        __html: body.replace('<svg', `<svg width="${px}" height="${px}" stroke-width="${ICON_STROKE_WIDTH}"`),
      }}
    />
  )
}
