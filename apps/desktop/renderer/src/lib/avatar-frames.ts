/**
 * 动物形象的动作帧：真正的逐帧动画素材。
 *
 * ## 为什么要有这一层
 *
 * 此前"动物在动"是 CSS 变换：1–2px 位移、1° 摇摆、2% 缩放。那是**一张静止的头在抖**，
 * 不是动物在干活。用户在聊天里要看到的是"这只动物真的在敲键盘、真的在想"——那就只能
 * 给它真的帧。
 *
 * 素材是 AI 生成的 4×4 帧表（16 帧一张），构建期切好、抠成透明底、拼成一张精灵图，
 * 运行时用 `background-position` 切帧播放。见 scripts/gen-animal-frames.mjs 与
 * scripts/cutout-animal-frames.mjs。
 *
 * ## 三个动作怎么对应
 *
 * | 动作 | 帧 | 为什么是它 |
 * |---|---|---|
 * | `pondering`（等首 token） | `thinking` | 托腮、眼睛左右转——在琢磨 |
 * | `speaking`（正在流式输出） | `talking` | 嘴一张一合——在说话 |
 * | `speaking` 且在敲键盘位 | `typing` | 爪子落在键上——在写 |
 *
 * 其余动作（`idle` / `breathing` / `listening` / `greeting`）没有帧：闲置呼吸仍走
 * CSS 微动效，够用且不费流量。
 *
 * ## 节奏随性格走
 *
 * 每帧的时长按 persona 的性格四维算（见 lib/avatar-motion.ts 的 `avatarTemperamentOf`）：
 * 外向的说话快、严谨的思考慢。同一套帧，节奏不同——这是"每个助理不一样"里最容易
 * 看出差别的一处。
 *
 * @module @ryharness/desktop/renderer/lib/avatar-frames
 */

import { parseAnimalAvatar } from './animal-3d.ts'
import type { AvatarAction, avatarTemperamentOf } from './avatar-motion.ts'
import type { StyleVars } from './stagger.ts'

/**
 * 一套帧的键。
 *
 * `an3d-*` 是立体动物通道（3D 卡通渲染）；`cat` / `dog` / `fox` 是立绘通道（写实毛发）；
 * `brand` 是 Ryen 的品牌橘猫徽标。
 */
export type AvatarFrameSet =
  | 'an3d-dog'
  | 'an3d-fox'
  | 'an3d-rabbit'
  | 'an3d-bear'
  | 'an3d-panda'
  | 'an3d-mouse'
  | 'cat'
  | 'dog'
  | 'fox'
  | 'brand'

/** 帧表里的三种状态。 */
export type AvatarFrameState = 'typing' | 'thinking' | 'talking'

/** 精灵图是 4 列 4 行 = 16 帧。 */
export const FRAME_COLS = 4
export const FRAME_ROWS = 4
export const FRAME_COUNT = FRAME_COLS * FRAME_ROWS

/**
 * 精灵图资源（构建期由 Vite 展开成静态映射）。
 *
 * 一套形象一个文件，而不是 16 个：一次对话里好几个助理同时在动，16 个文件就是
 * 16 个请求；一张精灵图只解码一次，切帧是纯 GPU 的位移。
 */
const SHEETS = import.meta.glob('../../../assets/animals/frames/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

/**
 * 底板：帧是透明底的，静态立绘原本烤在像素里的暖奶油底板得由 CSS 补回来。
 *
 * `none` = 透明（立体动物、品牌徽标：徽标本身不透明，不需要补）；
 * `cream` = 暖奶油 rgb(252,236,204)（立绘通道，与 gen-portraits.mjs 的 PLATE 同色）；
 * `amber` = 品牌琥珀（徽标被裁圆后露出的四角）。
 */
export type AvatarFramePlate = 'none' | 'cream' | 'amber'

/** 每套帧的底板。 */
const PLATES: Record<AvatarFrameSet, AvatarFramePlate> = {
  'an3d-dog': 'none',
  'an3d-fox': 'none',
  'an3d-rabbit': 'none',
  'an3d-bear': 'none',
  'an3d-panda': 'none',
  'an3d-mouse': 'none',
  cat: 'cream',
  dog: 'cream',
  fox: 'cream',
  brand: 'none',
}

/**
 * 底板颜色。
 *
 * 暖奶油 rgb(252,236,204) 与 gen-portraits.mjs 的 PLATE 完全一致——静态立绘的底板
 * 是烤在位图里的，动画帧是透明底的，两边得是同一个颜色，切换时才不闪。
 */
const PLATE_COLORS: Record<AvatarFramePlate, string> = {
  none: 'transparent',
  cream: 'rgb(252, 236, 204)',
  amber: 'var(--amber-500)',
}

/** 立绘通道的键（品牌橘猫走 brand 那一套，它有徽标底板）。 */
const PORTRAIT_SETS: readonly AvatarFrameSet[] = ['cat', 'dog', 'fox']

/**
 * 头像字段 → 帧集。
 *
 * - `an3d:<种类>:<色相>` → `an3d-<种类>`
 * - `dog` / `fox` → 立绘那套
 * - `cat` → 品牌橘猫徽标（`brand`）
 * - 其余（DiceBear、剪影、用户自建）没有帧
 */
export function frameSetOf(avatarKey: string | undefined): AvatarFrameSet | undefined {
  if (avatarKey === undefined) return undefined
  const animal = parseAnimalAvatar(avatarKey)
  if (animal !== undefined) {
    return `an3d-${animal.kind}` as AvatarFrameSet
  }
  if (avatarKey === 'cat') return 'brand'
  if (PORTRAIT_SETS.includes(avatarKey as AvatarFrameSet)) {
    return avatarKey as AvatarFrameSet
  }
  return undefined
}

/**
 * 动作 → 帧状态。
 *
 * `speaking` 有两个去处：气泡里的署名头像（正在出声）与打字位（正在写）。默认取
 * `talking`（嘴动），要 `typing`（爪子敲键盘）时由调用点显式指定。
 */
export function frameStateOf(action: AvatarAction): AvatarFrameState | undefined {
  if (action === 'pondering') return 'thinking'
  if (action === 'speaking') return 'talking'
  return undefined
}

/** 精灵图的 URL；没有这一份时返回 undefined。 */
export function frameSheetUrl(set: AvatarFrameSet, state: AvatarFrameState): string | undefined {
  return SHEETS[`../../../assets/animals/frames/${set}-${state}.webp`]
}

/**
 * 一轮循环的时长（毫秒）：16 帧走完一遍要多久。
 *
 * 数字取自动效性格表（`avatarTemperamentOf`）：
 * - 说话用 `speakMs`：外向的快、内向的慢。
 * - 思考用 `ponderMs`：严谨的慢、幽默的快。
 * - 打字比说话再快一档——敲键本来就比说话密。
 *
 * 两条硬约束：
 *
 * - **一轮必须是 4 的整数倍**。列动画的时长是行时长的四分之一（列每 4 帧走一格），
 *   取整会在两者之间差出几毫秒，帧就错位。
 * - **帧率落在 8–20fps**。低于 8fps 会一顿一顿，高于 20fps 只是多烧点电——
 *   相邻两帧的动作差别本来就很小，看不出更流畅。
 */
export function frameCycleMs(state: AvatarFrameState, motion: ReturnType<typeof avatarTemperamentOf>): number {
  const base = state === 'thinking' ? motion.ponderMs : motion.speakMs
  const raw = state === 'typing' ? base * 0.95 : base
  // 每种状态的时长下限：打字最快、思考最慢
  const floor = state === 'typing' ? 820 : state === 'thinking' ? 1100 : 800
  const cycle = Math.min(2300, Math.max(floor, Math.round(raw)))
  return Math.round(cycle / FRAME_COLS) * FRAME_COLS
}

/**
 * 播放这一套帧需要的样式变量。
 *
 * 一个时长：一轮循环（16 帧走完一遍）要多久。CSS 里用 `step-end` 让 16 个关键帧
 * 各占十六分之一。
 *
 * @param set - 帧集。
 * @param state - 帧状态。
 * @param profile - 形象与性格算出的表演参数（决定节奏）。
 */
export function frameSheetStyle(
  set: AvatarFrameSet,
  state: AvatarFrameState,
  profile: ReturnType<typeof avatarTemperamentOf>,
): StyleVars {
  const cycle = frameCycleMs(state, profile)
  return {
    '--avatar-frame-cycle-ms': `${cycle}ms`,
    '--avatar-frame-plate': PLATE_COLORS[PLATES[set]],
  } as StyleVars
}

/**
 * 这一次该不该播帧。
 *
 * 尺寸门槛沿用动效那套：≤24px 的头像动起来是闪烁不是生命感，24–40px 幅度要打折。
 * 帧动画比 CSS 位移更"重"（一整张精灵图），门槛抬到 28px。
 */
export const AVATAR_FRAME_MIN_SIZE = 28

/** 这个尺寸下播不播帧。 */
export function frameAllowed(size: number): boolean {
  return size >= AVATAR_FRAME_MIN_SIZE
}
