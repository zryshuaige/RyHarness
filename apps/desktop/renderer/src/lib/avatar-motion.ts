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
 * ## 一套动作包
 *
 * 每个助理能做的动作收成一组（见 {@link AvatarAction}）。此前是三个散落的布尔开关
 * （speaking / pondering / breathing）铺在各个调用点上，同一个状态在不同页面有两套
 * 写法，"这位此刻在干什么"没有一处能说全。现在：动作有名字、有动画、有性格参数，
 * 也有明确的一句话说明它什么时候用。
 *
 * | 动作 | 什么时候 | 幅度 |
 * |---|---|---|
 * | `idle` | 默认：列表里、历史消息里 | 0 |
 * | `breathing` | 单独出现的大头像（资料页、身份卡、形象预览） | 极浅，1.2% |
 * | `speaking` | 正在流式输出（气泡里的署名头像）、正在出声（试听） | 中，1–1.6px |
 * | `pondering` | 已发请求、等首 token（打字行、小队面板） | 中，1.8–2.4px |
 * | `listening` | 别人在说话时（小队面板里的其余成员） | 极浅，0.6% |
 * | `greeting` | 指针停在卡片上（一次性的点头） | 小，一次 |
 *
 * ## 三条硬规矩（调研 + 规范共同指向的）
 *
 * 1. **同屏只许有一个在**大幅**动**。周边运动会抢注意力（Nielsen Norman），几十个头像
 *    一起呼吸，界面就在微微发颤——用户读不出"这位在说话"，只读得出"这里有点乱"。所以：
 *    说话动效只给**此刻正在输出**的那一位，思考动效只给**正在等首 token**的那一位；
 *    「在听」的那几个只做**极浅的呼吸**（幅度三分之一、周期长一倍），是底噪不是表演；
 *    闲置呼吸只给**单独出现**的头像（资料页、身份卡）。列表里的头像一律静态。
 * 2. **小尺寸不缩放**。≤24px 的头像动起来是闪烁不是生命感；24–40px 的幅度要再打折
 *    （同样 1.5px 的位移，在 40px 上是一下点头，在 24px 上是整张脸在抖）。
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
 * 一套动作包：这位助理此刻在做哪件事。
 *
 * 用一个词而不是三个布尔开关：三个开关铺在各个调用点上，同一个状态会出现两套写法，
 * 而且"这位此刻在干什么"没有一处能说全。
 */
export type AvatarAction = 'idle' | 'breathing' | 'speaking' | 'pondering' | 'listening' | 'greeting'

/** 每个动作对应的类名（与 styles-avatar-motion.css 一一对应）。 */
const ACTION_CLASS: Record<AvatarAction, string> = {
  idle: '',
  breathing: 'is-breathing',
  speaking: 'is-speaking',
  pondering: 'is-pondering',
  listening: 'is-listening',
  greeting: 'is-greeting',
}

/**
 * 小于此尺寸不给**说话/思考/在听**动效。
 *
 * 24px 的立绘动起来是噪点；24–40px 幅度还要再打折（见 {@link avatarMotionScale}）；
 * 40px 是气泡头像的尺寸，正好是能看出"在动"又不吵的尺寸。
 */
export const AVATAR_MOTION_MIN_SIZE = 24

/**
 * 小于此尺寸不给**闲置呼吸**。
 *
 * 呼吸是"没在说话时也活着"的底噪。同一屏里有好几个头像时它就是噪声，所以只给
 * 单独出现的那一个（资料页、身份卡、「我的」页）。
 */
export const AVATAR_BREATHE_MIN_SIZE = 48

/**
 * 小头像的幅度打折。
 *
 * 24–40px 的头像动起来是噪点不是生命感：同样 1.5px 的位移，在 40px 上是一下点头，
 * 在 24px 上是整张脸在抖。所以按尺寸折半；再小（<24px）干脆不给动效。
 */
export function avatarMotionScale(size: number): number {
  if (size >= 40) return 1
  if (size >= AVATAR_MOTION_MIN_SIZE) return 0.5
  return 0
}

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
  /** 在听时的缩放幅度（百分比）：呼吸的三分之一，底噪级别。 */
  listen: number
  /** 在听时的周期（毫秒）：呼吸的一点七倍，更慢。 */
  listenMs: number
  /** 打招呼一次的时长（毫秒）。 */
  greetMs: number
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
  cat: {
    breathe: 1.4,
    breatheMs: 3000,
    lift: 1.6,
    sway: 1.2,
    scale: 1.02,
    speakMs: 900,
    ponder: 2.4,
    ponderMs: 1600,
    listen: 0.5,
    listenMs: 5100,
    greetMs: 680,
  },
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
    listen: 0.4,
    listenMs: 6100,
    greetMs: 780,
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
    listen: 0.4,
    listenMs: 7100,
    greetMs: 820,
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
    listen: 0.4,
    listenMs: 6500,
    greetMs: 720,
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
  const breatheMs = Math.round(3000 + rigor * 1000 - extro * 400)
  return {
    breathe: base.breathe,
    // 呼吸周期：严谨的慢（rigor 越高越长，最多 +1.0s），外向的快（最多 −0.4s）。
    // 两者各让一步，别让一种性格把动画完全压死。
    breatheMs,
    lift: Number((0.8 + extro * 0.8).toFixed(2)),
    sway: Number((0.6 + extro * 1.2).toFixed(2)),
    scale: Number((1.01 + extro * 0.01).toFixed(3)),
    speakMs: Math.round(1600 - extro * 700),
    ponder: Number((1.4 + humor * 1.2).toFixed(2)),
    ponderMs: Math.round(2400 - humor * 800),
    // 在听：底噪级别——比呼吸更浅、周期更长。严谨的连"在听"都更沉得住。
    listen: Number((base.listen * (1.1 - extro * 0.3)).toFixed(2)),
    listenMs: Math.round(breatheMs * 1.7),
    // 打招呼：外向的应得快，内向的慢半拍。
    greetMs: Math.round(base.greetMs - extro * 160),
  }
}

/**
 * 这个尺寸下能不能做这个动作。
 *
 * @param action - 动作。
 * @param size - 渲染尺寸（px）。
 */
export function avatarActionAllowed(action: AvatarAction, size: number): boolean {
  if (action === 'idle') return true
  if (action === 'breathing') return size >= AVATAR_BREATHE_MIN_SIZE
  return size >= AVATAR_MOTION_MIN_SIZE
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
 *
 * 幅度按尺寸打折（{@link avatarMotionScale}）：24–40px 的头像动同样的量会像在抖。
 */
export function avatarActionStyle(
  action: AvatarAction,
  motion: AvatarMotion,
  temperament: AvatarTemperament | undefined,
  size: number,
): StyleVars {
  const profile = avatarTemperamentOf(temperament)
  const k = avatarMotionScale(size)
  return {
    '--motion-breathe-scale': `${(1 + (profile.breathe * k) / 100).toFixed(4)}`,
    '--motion-breathe-ms': `${profile.breatheMs}ms`,
    '--motion-lift': `${(-profile.lift * k).toFixed(2)}px`,
    '--motion-sway': `${(profile.sway * k).toFixed(2)}deg`,
    '--motion-scale': `${(1 + (profile.scale - 1) * k).toFixed(4)}`,
    '--motion-speak-ms': `${profile.speakMs}ms`,
    '--motion-ponder': `${(profile.ponder * k).toFixed(2)}px`,
    '--motion-ponder-ms': `${profile.ponderMs}ms`,
    '--motion-listen-scale': `${(1 + (profile.listen * k) / 100).toFixed(4)}`,
    '--motion-listen-ms': `${profile.listenMs}ms`,
    '--motion-greet-ms': `${profile.greetMs}ms`,
    '--motion-state': action,
  } as StyleVars
}

/** 动作 → 类名（见 styles-avatar-motion.css）。 */
export function avatarActionClass(action: AvatarAction): string {
  return ACTION_CLASS[action]
}
