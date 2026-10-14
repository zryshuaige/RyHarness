/**
 * RyAgent 品牌主角：极简几何橘猫（琥珀渐变底板 + 圆头三角耳 + 极简五官）。
 *
 * 矢量母版在 apps/desktop/assets/brand/cat-face*.svg —— 与 scripts/gen-icon.mjs
 * 导出应用图标、以及 renderer/index.html 启动屏引用的是同一份几何，全应用只有
 * 这一只猫（三态 idle / thinking / happy 只改眼神、嘴与星光，不改轮廓）。
 *
 * `shape="circle"` 供头像位使用：满幅圆底板，与 DiceBear 风格头像是同一个画布。
 * 脸底色随主题翻（assets/brand/cat.css），否则暗色下浅墨压在奶油底上没有五官。
 */
import { useId } from 'react'
import '../assets/brand/cat.css'
import catIdle from '../../../assets/brand/cat-face.svg?raw'
import catHappy from '../../../assets/brand/cat-face-happy.svg?raw'
import catThinking from '../../../assets/brand/cat-face-thinking.svg?raw'

/** 64×64 设计网格下的底板：应用图标用 squircle，头像圆形裁切用满幅圆。 */
const PLATES = {
  squircle: 'M32 2 C46.375 2 62 10.75 62 32 C62 53.25 46.375 62 32 62 C17.625 62 2 53.25 2 32 C2 10.75 17.625 2 32 2 Z',
  circle: 'M32 0 A32 32 0 1 1 32 64 A32 32 0 1 1 32 0 Z',
} as const

const FACES: Record<'idle' | 'thinking' | 'happy', string> = {
  idle: catIdle.trim(),
  thinking: catThinking.trim(),
  happy: catHappy.trim(),
}

export function Cat({
  mood,
  size = 40,
  shape = 'squircle',
}: {
  mood: 'idle' | 'thinking' | 'happy'
  size?: number
  /** 底板形状：应用图标用 squircle，头像圆形裁切用 circle。 */
  shape?: keyof typeof PLATES
}) {
  // 多只猫同屏时渐变 id 不能重名（否则后渲染的会引用到别人的 defs）。
  const uid = `plate${useId().replace(/[^\dA-Za-z]/g, '')}`
  const svg =
    `<svg class="cat" width="${size}" height="${size}" viewBox="0 0 64 64" fill="none">` +
    `<defs><linearGradient id="${uid}" x1="0%" y1="0%" x2="100%" y2="100%">` +
    `<stop offset="0%" stop-color="#FBBF24"/><stop offset="100%" stop-color="#D97706"/>` +
    `</linearGradient></defs>` +
    `<path fill="url(#${uid})" d="${PLATES[shape]}"/>` +
    FACES[mood] +
    `</svg>`
  // biome-ignore lint/security/noDangerouslySetInnerHtml: 仓库内置的静态母版 SVG，无外部输入
  return <span data-mood={mood} dangerouslySetInnerHTML={{ __html: svg }} aria-label={`Ryen ${mood}`} role="img" />
}
