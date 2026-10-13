/**
 * DiceBear 风格懒加载入口：被 avatars.tsx 动态 import，整块成为按需 chunk。
 *
 * 刻意只从 @dicebear/collection 取用到的两个风格（包标了 sideEffects: false，
 * Rollup 会把其余 38 个风格摇掉，产物约 50KB 而不是全量 565KB）；渲染用的
 * createAvatar 也一并留在这个 chunk 里，入口包因此完全不碰 @dicebear。
 *
 * 文件名也刻意排在 renderer 入口 chunk（index-*.js）之后——scripts/inline-dist.mjs
 * 只把 assets 里第一个 .js 内联进 index.html，文件名乱序会导致入口没被内联。
 */
import { dylan, funEmoji } from '@dicebear/collection'
import { createAvatar } from '@dicebear/core'

/** seed → SVG 源码。 */
export type AvatarRenderer = (seed: string) => string

export const LAZY_RENDERERS: Record<string, AvatarRenderer> = {
  dylan: (seed) => createAvatar(dylan, { seed }).toString(),
  mascot: (seed) => createAvatar(funEmoji, { seed }).toString(),
}
