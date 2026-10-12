/**
 * 头像体系：DiceBear 本地 SVG 生成（@dicebear/core + @dicebear/collection，无网络）。
 *
 * 预置 6 个可爱风格（license 已核实并记录于 README/NOTICE）：
 * - lorelei / notionists / thumbs —— CC0 1.0（公有领域，无需署名）
 * - adventurer / bigEars / funEmoji —— CC BY 4.0（免费商用，需署名，见 NOTICE）
 *
 * agent.avatar 字段编码：`db:{styleKey}:{seed}`；'cat' 保留 Ryen 定制橘猫；
 * 未知值回退首字符暖色块（旧库数据平滑降级）。
 */
import { createAvatar } from '@dicebear/core'
import { adventurer, bigEars, funEmoji, lorelei, notionists, thumbs } from '@dicebear/collection'
import type { Style } from '@dicebear/core'

export interface AvatarStyleDef {
  key: string
  name: string
  license: 'CC0-1.0' | 'CC-BY-4.0'
  style: Style<any>
}

export const AVATAR_STYLES: AvatarStyleDef[] = [
  { key: 'lorelei', name: '洛丽', license: 'CC0-1.0', style: lorelei },
  { key: 'notionists', name: '文艺', license: 'CC0-1.0', style: notionists },
  { key: 'thumbs', name: '拇指', license: 'CC0-1.0', style: thumbs },
  { key: 'adventurer', name: '冒险家', license: 'CC-BY-4.0', style: adventurer },
  { key: 'bigEars', name: '大耳', license: 'CC-BY-4.0', style: bigEars },
  { key: 'funEmoji', name: '趣脸', license: 'CC-BY-4.0', style: funEmoji },
]

export const AVATAR_STYLE_BY_KEY: Readonly<Record<string, AvatarStyleDef>> = Object.freeze(
  Object.fromEntries(AVATAR_STYLES.map((s) => { return [s.key, s] })),
)

/** 解析 avatar 字段。 */
export function parseAvatarSpec(avatar: string | undefined): { styleKey: string; seed: string } | null {
  if (avatar === undefined) return null
  const match = /^db:([a-zA-Z]+):(.+)$/.exec(avatar)
  if (match === null || match[1] === undefined || match[2] === undefined) return null
  if (AVATAR_STYLE_BY_KEY[match[1]] === undefined) return null
  return { styleKey: match[1], seed: match[2] }
}

/** 生成随机 avatar 字段值。 */
export function randomAvatarSpec(random: () => string = () => {
  return Math.random().toString(36).slice(2, 10)
}): string {
  const style = AVATAR_STYLES[Math.floor(Math.random() * AVATAR_STYLES.length)]!
  return `db:${style.key}:${random()}`
}

/** 生成 DiceBear SVG（宽高置 100% 由容器控制；剥离 metadata 减体积）。 */
export function dicebearSvg(styleKey: string, seed: string): string | null {
  const def = AVATAR_STYLE_BY_KEY[styleKey]
  if (def === undefined) return null
  const svg = createAvatar(def.style, { seed }).toString()
  return svg
    .replace(/<metadata[\s\S]*?<\/metadata>/, '')
    .replace(/width="\d+"\s*height="\d+"/, 'width="100%" height="100%" style="display:block"')
}

/** 首字符兜底色环（暖色系 12 色，按 seed 哈希取色）。 */
export const FALLBACK_COLORS = [
  '#F59E0B', '#F2752B', '#E8845C', '#D9A06B',
  '#C98D5A', '#EFC883', '#E5B25C', '#F3C6C6',
  '#B9AE9F', '#F2A03D', '#E58A7E', '#D98A7E',
] as const

export function fallbackColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length] as string
}
