/**
 * 头像体系：DiceBear 本地 SVG 生成（@dicebear/collection + @dicebear/core，按需加载）。
 *
 * 收敛为 2 个家族（同屏不再黑白线稿与彩色卡通混排）：
 * - dylan    人物类：扁平插画人物，CC BY 4.0（DiceBear Dylan! by Natalia Spivak）
 * - mascot   吉祥物/机械类：彩色表情脸，CC BY 4.0（DiceBear Fun Emoji by Davis Uche）
 * 署名见根目录 NOTICE.md。
 *
 * 首包瘦身：不再静态 import @dicebear/collection（40 个风格、~565KB SVG path
 * 数据），而是动态 import styles-avatar.ts（独立 chunk，摇树后约 50KB），
 * 头像真正出现时才下载加载。
 *
 * agent.avatar 字段编码：`db:{styleKey}:{seed}`；{@link BRAND_AVATAR} 保留 Ryen
 * 品牌橘猫；未知值回退首字符饱和色块（旧库数据平滑降级）。
 */

import type { AvatarRenderer } from './styles-avatar.ts'

export interface AvatarStyleDef {
  key: string
  name: string
  license: 'CC0-1.0' | 'CC-BY-4.0'
}

/**
 * 品牌橘猫在 agent.avatar 里的取值（不是 DiceBear 风格，故不进 AVATAR_STYLES）。
 * 它由 Avatar 组件转成 Cat.tsx 的矢量母版，头像位与选择器共用这一个常量，
 * 免得「'cat' 这个字面量」在多处各写一遍。
 */
export const BRAND_AVATAR = 'cat'

export const AVATAR_STYLES: readonly AvatarStyleDef[] = [
  { key: 'dylan', name: '人物', license: 'CC-BY-4.0' },
  { key: 'mascot', name: '吉祥物', license: 'CC-BY-4.0' },
]

export const AVATAR_STYLE_BY_KEY: Readonly<Record<string, AvatarStyleDef>> = Object.freeze(
  Object.fromEntries(
    AVATAR_STYLES.map((s) => {
      return [s.key, s]
    }),
  ),
)

/** 懒加载器：渲染器打包成一个独立 chunk（见 styles-avatar.ts）。 */
const loaded = new Map<string, AvatarRenderer>()
const pending = new Map<string, Promise<void>>()

/** 某个风格是否已在内存里（同步取 SVG 用）。 */
export function isAvatarStyleLoaded(styleKey: string): boolean {
  return loaded.has(styleKey)
}

/** 按 styleKey 加载 DiceBear 渲染器（幂等，重复调用共用同一个 promise）。 */
export function loadAvatarStyle(styleKey: string): Promise<void> {
  const hit = pending.get(styleKey)
  if (hit !== undefined) return hit
  if (AVATAR_STYLE_BY_KEY[styleKey] === undefined) {
    return Promise.reject(new Error(`unknown avatar style "${styleKey}"`))
  }
  const task = import('./styles-avatar.ts').then((mod) => {
    const render = mod.LAZY_RENDERERS[styleKey]
    if (render !== undefined) loaded.set(styleKey, render)
  })
  pending.set(styleKey, task)
  return task
}

/** 解析 avatar 字段。 */
export function parseAvatarSpec(avatar: string | undefined): { styleKey: string; seed: string } | null {
  if (avatar === undefined) return null
  const match = /^db:([a-zA-Z]+):(.+)$/.exec(avatar)
  if (match === null || match[1] === undefined || match[2] === undefined) return null
  if (AVATAR_STYLE_BY_KEY[match[1]] === undefined) return null
  return { styleKey: match[1], seed: match[2] }
}

/**
 * 品牌橘猫在「换一批」里的命中概率。取 1/8 而不是更大的值：橘猫是品牌露出，
 * 但每次随机都发猫会让通讯录变成一片猫。
 */
const BRAND_AVATAR_CHANCE = 1 / 8

/** 生成随机 avatar 字段值。 */
export function randomAvatarSpec(
  random: () => string = () => {
    return Math.random().toString(36).slice(2, 10)
  },
): string {
  if (Math.random() < BRAND_AVATAR_CHANCE) return BRAND_AVATAR
  const style = AVATAR_STYLES[Math.floor(Math.random() * AVATAR_STYLES.length)]!
  return `db:${style.key}:${random()}`
}

/**
 * 生成 DiceBear SVG（宽高置 100% 由容器控制；剥离 metadata 减体积）。
 * 风格尚未加载时返回 null 并顺手触发加载 —— React 场景请直接用
 * {@link Avatar}，它会在加载完成后重渲染。
 */
export function dicebearSvg(styleKey: string, seed: string): string | null {
  const render = loaded.get(styleKey)
  if (render === undefined) {
    void loadAvatarStyle(styleKey).catch(() => {
      /* 未知风格：交给调用方走兜底色块 */
    })
    return null
  }
  const svg = render(seed)
  return svg
    .replace(/<metadata[\s\S]*?<\/metadata>/, '')
    .replace(/width="\d+"\s*height="\d+"/, 'width="100%" height="100%" style="display:block"')
}

/**
 * 兜底色板：12 支高饱和中间调，按名称哈希取色。
 * 相对亮度锁在 [0.13, 0.29] 区间，因此对暗色表面 #1A1714 与亮色表面 #FFFFFF
 * 都 ≥3:1 对比度（旧的 #B9AE9F/#C98D5A 在暗色下只有 1.6:1，头像糊成黑块），
 * 白色首字在这些色块上也 ≥3:1。
 */
export const FALLBACK_COLORS = [
  '#D97706',
  '#EA580C',
  '#C2410C',
  '#B45309',
  '#A16207',
  '#65A30D',
  '#047857',
  '#0D9488',
  '#0284C7',
  '#2563EB',
  '#7C3AED',
  '#9333EA',
] as const

export function fallbackColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length] as string
}

/**
 * 首屏渲染完成后的空闲预热（不影响首包：风格数据在独立 chunk 里）。
 * 目的：让「同步读 dicebearSvg」的调用方（ContactsPage 头像选择器的缩略图）
 * 在用户点开弹窗之前就能拿到 SVG；把选择器缩略图也换成 <Avatar> 后可删本段。
 */
function scheduleWarmup(): void {
  const warm = () => {
    for (const style of AVATAR_STYLES) {
      void loadAvatarStyle(style.key).catch(() => {
        /* 预热失败不影响真正出现头像时的再次加载 */
      })
    }
  }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 1500 })
  else setTimeout(warm, 800)
}
scheduleWarmup()
