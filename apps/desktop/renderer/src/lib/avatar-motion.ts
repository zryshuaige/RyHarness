/**
 * 头像动效：让每位助理看起来是活的，而且**每位不一样**。
 *
 * ## 为什么要有这一层
 *
 * 此前预制的几位助理（Ryen 橘猫、工程师柴犬、文案灰狐）用的是**静态立绘**——一张图，
 * 不动。会动的只有用户自选的"立体动物"通道，于是恰恰是用户第一眼看到的那几位最没有
 * 生气。立绘只有一张图，做不了"换表情/转头"，能做的是整体运动：呼吸、说话时的
 * 动作、思考时的游走。
 *
 * ## 三条硬规矩（调研 + 规范共同指向的）
 *
 * 1. **同屏只许有一个在动**。周边运动会抢注意力（Nielsen Norman），几十个头像一起
 *    呼吸，界面就在微微发颤——用户读不出"这位在说话"，只读得出"这里有点乱"。所以：
 *    说话动效只给**此刻正在输出**的那一位，思考动效只给**正在等首 token**的那一位，
 *    闲置呼吸只给**单独出现**的头像（资料页、身份卡）。列表里的头像一律静态。
 * 2. **小尺寸不缩放**。≤24px 的头像动起来是闪烁不是生命感；24–40px 幅度也要压到
 *    scale ≤1.5%、位移 ≤1.5px。
 * 3. **只动 transform**。合成层上的 transform 可以被浏览器丢帧跳过；动 width/height
 *    会触发布局，每帧都重排。也不加 will-change（滥用它反而更慢）。
 *
 * ## 性格从 persona 派生
 *
 * 同一套动画给所有助理用，就成了"每个人长得一样只是换了脸"。所以幅度与节奏按性格
 * 四维走：严谨的呼吸慢、外向的说话幅度大、幽默的思考游走得远。这一条抄的是 D-ID
 * Expressive 的做法（sentiment 枚举，每个 sentiment 自带一套表演参数），而不是给
 * 每个角色重做一套动画。
 * @module @ryharness/desktop/renderer/lib/avatar-motion
 */

import type { StyleVars } from './stagger.ts'

/**
 * 小于此尺寸不给**说话/思考**动效。
 *
 * 24px 的立绘动起来是噪点；40px 是气泡头像的尺寸，正好是能看出"在动"又不吵的下限。
 */
export const AVATAR_MOTION_MIN_SIZE = 32

/**
 * 小于此尺寸不给**闲置呼吸**。
 *
 * 呼吸是"没在说话时也活着"的底噪。同一屏里有好几个头像时它就是噪声，所以只给
 * 单独出现的那一个（资料页、身份卡、「我的」页）。
 */
export const AVATAR_BREATHE_MIN_SIZE = 48

/**
 * 形象 → 动效性格（基础层）。
 *
 * 与头像通道无关：立体动物（`an3d:dog:0`）与立绘（`dog`）都是"柴犬"，不该因为
 * 画风不同就换一副脾性。
 */
export type AvatarMotion = 'cat' | 'dog' | 'fox' | 'plain'

/**
 * 性格四维里与表演有关的三维。
 *
 * 刻意不接整个 persona：**亲密度每轮都在涨**，把整个 persona 塞进气泡的 props，
 * memo 就每轮失效一次——几十条气泡为了一次用不上的分数全部重渲染。这三维是用户
 * 在编辑里定的，一轮之内不动。
 */
export interface AvatarTemperament {
  /** 外向 0–100：说话时动作幅度。 */
  extroversion: number
  /** 严谨 0–100：呼吸周期（严谨的慢）。 */
  rigor: number
  /** 幽默 0–100：思考时游走的幅度。 */
  humor: number
}

/** 每个形象的一套基础参数。 */
interface MotionProfile {
  /** 呼吸的缩放幅度（百分比）。 */
  breathe: number
  /** 呼吸周期（毫秒）。 */
  breatheMs: number
  /** 说话时的上下位移（px）。 */
  lift: number
  /** 说话时的左右摇摆角（度）。 */
  sway: number
  /** 说话时的放大倍数。 */
  scale: number
  /** 说话周期（毫秒）。 */
  speakMs: number
  /** 思考时游走的幅度（px）。 */
  ponder: number
  /** 思考周期（毫秒）。 */
  ponderMs: number
}

/**
 * 四套基础参数。
 *
 * 数字的来由：呼吸幅度全部压在 2% 以内——那是"几乎看不见但确实在动"的量；说话时
 * 位移给到 1–1.6px、摇摆给到 0.8–1.6°、放大到 1.5–2%，在 40px 的头像上刚好读得出
 * "在动"，又不像在点头哈腰。
 */
const PROFILES: Record<AvatarMotion, MotionProfile> = {
  // 橘猫（总管）：轻快，弹得高一点、频率快一点。
  cat: { breathe: 1.4, breatheMs: 3000, lift: 1.6, sway: 1.2, scale: 1.02, speakMs: 900, ponder: 2.4, ponderMs: 1600 },
  // 柴犬（工程师）：规整，点头，节奏慢而稳。
  dog: {
    breathe: 1.2,
    breatheMs: 3600,
    lift: 1.2,
    sway: 0.8,
    scale: 1.015,
    speakMs: 1200,
    ponder: 1.8,
    ponderMs: 1900,
  },
  // 灰狐（文案）：从容，侧倾，像在斟酌措辞。
  fox: {
    breathe: 1.2,
    breatheMs: 4200,
    lift: 1.0,
    sway: 1.6,
    scale: 1.015,
    speakMs: 1600,
    ponder: 2.0,
    ponderMs: 2200,
  },
  // 其余（DiceBear / 首字母色块 / 自建形象）：中性。
  plain: {
    breathe: 1.2,
    breatheMs: 3800,
    lift: 1.3,
    sway: 0.8,
    scale: 1.015,
    speakMs: 1400,
    ponder: 2.0,
    ponderMs: 2000,
  },
}

/** 把 0–100 的性格值夹进区间。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.max(0, Math.min(1, value / 100))
}

/**
 * 按头像值派生动效性格（基础层）。
 *
 * 认得出来的三种形象走各自的节奏；认不出来的（用户自建、DiceBear）走中性。
 * 「剪影」是占位立绘——它本来就表示"这位还没有形象"，给它表演反而别扭，
 * 所以按中性处理。
 */
export function avatarMotionOf(avatarKey: string | undefined): AvatarMotion {
  if (avatarKey === undefined) return 'plain'
  // 立体动物通道：`an3d:<种类>:<色相>`。柴犬与灰狐在两个通道里都有，
  // 同一个"柴犬"不该因为画风不同而换一副脾性。
  const animal = avatarKey.startsWith('an3d:') ? avatarKey.split(':')[1] : undefined
  const key = animal ?? avatarKey
  if (key === 'cat' || key === 'dog' || key === 'fox') return key
  return 'plain'
}

/**
 * 性格 → 表演参数。
 *
 * - **呼吸周期**：严谨的慢（3.0s → 4.0s）。一个严谨的助理不该手忙脚乱。
 * - **说话幅度**：外向的大（位移 0.8 → 1.6px、摇摆 0.6° → 1.8°）。外向的助理说话时
 *   更爱动。
 * - **思考游走**：幽默的远（1.4 → 2.6px）。想得越不着边际，眼珠子转得越远。
 */
export function avatarTemperamentOf(temperament: AvatarTemperament | undefined): MotionProfile {
  const base = PROFILES.plain
  if (temperament === undefined) return base
  const extro = clamp01(temperament.extroversion)
  const rigor = clamp01(temperament.rigor)
  const humor = clamp01(temperament.humor)
  return {
    breathe: base.breathe,
    // 呼吸周期：严谨的慢（rigor 越高越长，最多 +1.0s），外向的快（最多 −0.4s）。
    // 两者各让一步，别让一种性格把动画完全压死。
    breatheMs: Math.round(3000 + rigor * 1000 - extro * 400),
    lift: Number((0.8 + extro * 0.8).toFixed(2)),
    sway: Number((0.6 + extro * 1.2).toFixed(2)),
    scale: Number((1.01 + extro * 0.01).toFixed(3)),
    speakMs: Math.round(1600 - extro * 700),
    ponder: Number((1.4 + humor * 1.2).toFixed(2)),
    ponderMs: Math.round(2400 - humor * 800),
  }
}

/**
 * 这张头像该不该有动效（说话 / 思考）。
 *
 * @param size - 渲染尺寸（px）。
 */
export function avatarMotionAllowed(size: number): boolean {
  return size >= AVATAR_MOTION_MIN_SIZE
}

/**
 * 这张头像该不该有闲置呼吸。
 *
 * @param size - 渲染尺寸（px）。
 */
export function avatarBreathAllowed(size: number): boolean {
  return size >= AVATAR_BREATHE_MIN_SIZE
}

/**
 * 动效参数 → CSS 变量（挂在头像根节点上）。
 *
 * 走变量而不是走多套 class：同一张脸换节奏时只改变量，不必换样式表。
 *
 * 值的形状是**最终值**而不是"再由 CSS 算一遍"：位移给的是负的 translateY（向上），
 * 呼吸给的是缩放倍数而不是百分比——`calc()` 里的除法与乘法各家浏览器支持得不齐，
 * 这点计算不值得冒渲染差异的险。
 */
export function avatarMotionStyle(
  motion: AvatarMotion,
  temperament: AvatarTemperament | undefined,
  speaking: boolean,
): StyleVars {
  const profile = avatarTemperamentOf(temperament)
  return {
    '--motion-breathe-scale': `${(1 + profile.breathe / 100).toFixed(4)}`,
    '--motion-breathe-ms': `${profile.breatheMs}ms`,
    '--motion-lift': `${(-profile.lift).toFixed(2)}px`,
    '--motion-sway': `${profile.sway}deg`,
    '--motion-scale': `${profile.scale}`,
    '--motion-speak-ms': `${profile.speakMs}ms`,
    '--motion-ponder': `${profile.ponder}px`,
    '--motion-ponder-ms': `${profile.ponderMs}ms`,
    ...(speaking ? { '--motion-state': 'speaking' } : { '--motion-state': 'idle' }),
  } as StyleVars
}
