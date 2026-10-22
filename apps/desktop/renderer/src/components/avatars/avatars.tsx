/**
 * 头像体系：DiceBear 本地 SVG 生成（@dicebear/collection + @dicebear/core，按需加载）。
 *
 * 收敛为 2 个家族（同屏不再黑白线稿与彩色卡通混排）：
 * - dylan    人物类：扁平插画人物，CC BY 4.0（DiceBear Dylan! by Natalia Spivak）
 * - mascot   吉祥物/机械类：彩色表情脸，CC BY 4.0（DiceBear Fun Emoji by Davis Uche）
 * 署名见根目录 NOTICE.md。两族的生成后处理都在 styles-avatar.ts 里做。
 *
 * 首包瘦身：不再静态 import @dicebear/collection（40 个风格、~565KB SVG path
 * 数据），而是动态 import styles-avatar.ts（独立 chunk，摇树后约 50KB），
 * 头像真正出现时才下载加载。
 *
 * agent.avatar 字段编码：`db:{styleKey}:{seed}`；{@link BRAND_AVATAR} 保留 Ryen
 * 品牌橘猫；未知值回退首字符饱和色块（旧库数据平滑降级）。
 */

import type { CSSProperties } from 'react'
import type { AvatarRenderer } from './styles-avatar.ts'

export interface AvatarStyleDef {
  key: string
  name: string
  license: 'CC0-1.0' | 'CC-BY-4.0'
}

/**
 * 品牌橘猫在 agent.avatar 里的取值（不是 DiceBear 风格，故不进 AVATAR_STYLES）。
 * 它由 Avatar 组件转成 Cat.tsx 的位图母版，头像位与选择器共用这一个常量，
 * 免得「'cat' 这个字面量」在多处各写一遍。
 */
export const BRAND_AVATAR = 'cat'

/**
 * 头像统一规格。此前「品牌橘猫」与「DiceBear 风格头像」是两套处理并排：猫自己一套
 * 底板半径（留了 1.5/64 的白边），风格头像满幅，兜底色块又是另一套字号——同屏摆一
 * 排就是两种零件。现在四条分支（猫 / 风格 / 骨架 / 首字符）共用同一块画布：
 * 正方形 size×size、圆形、图案满幅、同一圈描边。描边用 outline 而不是 box-shadow，
 * 这样和 .avatar-lg-ring 那套外发光 box-shadow 叠加时不互相覆盖。
 *
 * 复查过与品牌猫的视觉语言：圆角（全部 50%）、描边（全部 AVATAR_SPEC.stroke）、
 * 尺寸（全部 avatarCanvas(size)）、满幅方式（猫走 shape="circle" 的满幅圆板，
 * 两个 DiceBear 家族的背景都铺满各自视口）四项已经统一。线宽那一项此前对不上：
 * 猫的母版缩到 24px 头像上五官只剩 2px 宽，比旁边 DiceBear 的线细一档；矢量时代靠
 * <Cat> 按 tiers.json 在小尺寸档加粗五官、加鼻、去嘴把线宽拉回来，那套补偿随矢量
 * 母版一起作废——位图母版的五官是实心的，缩到 24px 由浏览器自己取样，不存在可补偿的
 * 线宽。像素级的视觉是否够粗属于母版与导出档的判断，见 docs/brand/icon.md。
 */
export const AVATAR_SPEC = {
  /** 圆角：全规格只有圆形一种（群聊九宫格的单格同样圆）。 */
  radius: '50%',
  /** 描边宽度（px）：小尺寸 1px 就够，≥48px 给 2px，否则会被图案边缘吃掉。 */
  stroke: (size: number): number => {
    return size >= 48 ? 2 : 1
  },
  /** 首字符色块的字号比例（24px 头像下是 11px，仍读得出来）。 */
  letterRatio: 0.44,
} as const

/** 头像画布样式：全应用只有这一处定义，四种头像共用。 */
export function avatarCanvas(size: number): CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: AVATAR_SPEC.radius,
    outline: `${AVATAR_SPEC.stroke(size)}px solid var(--edge)`,
  }
}

export const AVATAR_STYLES: readonly AvatarStyleDef[] = [
  { key: 'dylan', name: '人物', license: 'CC-BY-4.0' },
  // 这一族画的是彩色表情脸，seed 只当随机数用——写 `owl` 不会得到猫头鹰。
  // 内置模板因此不用它（见 apps/server/src/seed.ts），只留给用户自己挑。
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
  // metadata 里也有 <svg> 命名空间声明，先剥掉，之后第一个 <svg> 才是根标签。
  const bare = svg.replace(/<metadata[\s\S]*?<\/metadata>/, '')
  // DiceBear v9 的根 <svg> **不带** width/height（靠 viewBox + 容器 CSS 撑满）。此前
  // 用 /width="\d+"\s*height="\d+"/ 改写宽高，实际改到的是文档里第一个匹配——也就是
  // 满幅底色 rect（v9 里它一度还写在 <mask> 里面），命中哪个纯属文档顺序的巧合。
  // 宽高只能改在根标签上。
  return bare.replace(/<svg\b([^>]*)>/, (_tag, attrs: string) => {
    return `<svg${attrs} width="100%" height="100%" style="display:block">`
  })
}

/**
 * 身份色三套 token，按**用途**分而不是按颜色分。
 *
 * WCAG 把「图形」和「正文」分成两套门槛：1.4.11 非文本对比度只要 3:1，1.4.3 正文要
 * 4.5:1。此前只有一套按 3:1 校过的色板，MessageBubble 却把它直接当 12px 的
 * `.bubble-name` 文字色用，白底 5/12 不达标（#D97706 3.19、#65A30D 3.09、#0284C7
 * 4.10…），暗色气泡底 7/12 不达标。同一个值满足不了两套门槛：亮底要 L ≤ 0.183、
 * 暗底要 L ≥ 0.203，没有交集，所以文字色必须**按主题分两套**。
 *
 * 三套值按下标一一对应，同一个 seed 在头像色块、气泡边框、发言人名字上是同一个色相。
 * 派生方式是从图形色向黑/向白混色到刚过门槛：保色相、不另挑色，向白混出来的暗色主题
 * 文字色也不会变成霓虹（见 scripts 下的调色脚本与 tests/avatars.test.tsx 的实测断言）。
 */
export const AGENT_HUE_GRAPHIC = [
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
  '#8346F0',
  '#9333EA',
] as const

/** 浅色主题的正文色：对白底气泡（--bubble-peer: #FFFFFF）≥4.5:1。 */
export const AGENT_HUE_TEXT_LIGHT = [
  '#AE5F05',
  '#C74B0A',
  '#C2410C',
  '#B45309',
  '#A16207',
  '#4F800A',
  '#047857',
  '#0B8277',
  '#0279B7',
  '#2563EB',
  '#8346F0',
  '#9333EA',
] as const

/** 暗色主题的正文色：对暗色气泡（--bubble-peer: #1C1E23）≥4.5:1。 */
export const AGENT_HUE_TEXT_DARK = [
  '#D97706',
  '#EA590D',
  '#D06D44',
  '#C3753A',
  '#B27E34',
  '#65A30D',
  '#3E977E',
  '#17988D',
  '#1B90CD',
  '#5485EF',
  '#9E6EF3',
  '#AE66EF',
] as const

/**
 * 图形色是头像色块底色与气泡左边框：1.4.11 的 3:1 门槛，对亮色卡片与暗色气泡都成立
 * （旧的 #B9AE9F/#C98D5A 在暗色下只有 1.6:1，头像糊成黑块）。#7C3AED 对暗色气泡
 * 实测 2.93 差一点点，换成同色相的 #8346F0。
 */
function hueIndex(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  return Math.abs(hash) % AGENT_HUE_GRAPHIC.length
}

export function fallbackColor(seed: string): string {
  return AGENT_HUE_GRAPHIC[hueIndex(seed)] as string
}

/** 同一个 seed 的三套 token（色相对齐），调用方按用途取自己那一套。 */
export function agentHues(seed: string): {
  graphic: string
  textLight: string
  textDark: string
} {
  const i = hueIndex(seed)
  return {
    graphic: AGENT_HUE_GRAPHIC[i] as string,
    textLight: AGENT_HUE_TEXT_LIGHT[i] as string,
    textDark: AGENT_HUE_TEXT_DARK[i] as string,
  }
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
