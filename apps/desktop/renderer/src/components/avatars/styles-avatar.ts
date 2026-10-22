/**
 * DiceBear 风格懒加载入口：被 avatars.tsx 动态 import，整块成为按需 chunk。
 *
 * 刻意只从 @dicebear/collection 取用到的两个风格（包标了 sideEffects: false，
 * Rollup 会把其余 38 个风格摇掉，产物约 50KB 而不是全量 565KB）；渲染用的
 * createAvatar 也一并留在这个 chunk 里，入口包因此完全不碰 @dicebear。
 *
 * 文件名也刻意排在 renderer 入口 chunk（index-*.js）之后——scripts/inline-dist.mjs
 * 只把 assets 里第一个 .js 内联进 index.html，文件名乱序会导致入口没内联。
 */
import { dylan, funEmoji } from '@dicebear/collection'
import { createAvatar } from '@dicebear/core'

/** seed → SVG 源码。 */
export type AvatarRenderer = (seed: string) => string

/**
 * 剥掉 DiceBear v9 的视口遮罩。
 *
 * v9 把「满幅底色 + 视口裁切」实现成 `<mask id="viewboxMask">`，由内层
 * `<g mask="url(#viewboxMask)">` 引用——两个家族都这么生成。这个 id 是**文档全局**的，
 * 于是同屏第二枚及以后的 DiceBear 头像里的 url(#viewboxMask) 解析到的是文档里**第一枚**
 * 头像的遮罩，而不是自己的：通讯录里 dylan（80×80 视口）排在 mascot 之前，mascot 就只剩
 * 自己视口左上 80/232 ≈ 34% 见方那一块可见，其余全透明——真机首屏那个「空白圆盘 + 左上角
 * 一小块蓝图形」就是它。dylan 排在第一位所以看着正常，同一 seed 单独渲染永远正常，
 * 于是按 seed 复现不出来，上一轮只能靠「视口外扩」去堵症状。
 *
 * 这层遮罩在这里并没有做事：两族的美术都严格落在各自视口内（funEmoji 实测包围盒
 * x 5..194、y 42..194，dylan 铺满 0..80），底色 rect 本身就满幅。删掉它之后全局 id 消失，
 * 并排卡片 / 换一批 / 九宫格都不再互相污染；SVG 视口本身仍然会把出界的笔触裁掉。
 */
const stripViewboxMask = (svg: string): string => {
  return svg.replace(/<mask\b[^>]*>[\s\S]*?<\/mask>/g, '').replace(/\smask="url\(#viewboxMask\)"/g, '')
}

export const LAZY_RENDERERS: Record<string, AvatarRenderer> = {
  dylan: (seed) => stripViewboxMask(createAvatar(dylan, { seed }).toString()),
  mascot: (seed) => stripViewboxMask(createAvatar(funEmoji, { seed }).toString()),
}
