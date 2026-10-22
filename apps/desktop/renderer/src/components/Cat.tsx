/**
 * RyHarness 品牌主角：橘猫位图徽标（琥珀圆角方形底板 + 大眼 + 两只前爪搭在底板边缘）。
 *
 * 图像来自 assets/brand/mark.png 这一份母版，与应用图标、任务栏、托盘、favicon、启动屏
 * 同源：渲染层吃的那张图是 gen:icon 导出的 256 档（renderer/public/cat.png），全应用
 * 只有这一只猫。
 *
 * 为什么是 <img> 而不是内联 SVG / dangerouslySetInnerHTML：
 *   - 母版是**位图**。此前那套矢量母版才有条件在渲染时拼 SVG（每只猫一个渐变 id、三态
 *     换眼形、小尺寸档按 tiers.json 改坐标）；换成位图之后那些几何全都不存在了，留着的
 *     只会是一整套改写 SVG 字符串的代码。
 *   - 位图走 <img> 由浏览器解码，缩放到各档都是浏览器自己的高质量缩放，不需要渲染层
 *     再实现一遍多档取样。
 *   - 走 public/ 而不是打包进 JS：图片不进 bundle，走 vite 的 /app 静态资源路径，
 *     浏览器能缓存，渲染层也不用背一段 base64。
 *
 * 三态（idle / thinking / happy）随矢量母版一起作废：位图没有可换的眼形与嘴形。
 * 「正在思考」改由 components/TypingDots.tsx 的打字动画表达——那才是真正在动的状态。
 */
import '../assets/brand/cat.css'
// 逐档候选直接进 vite 的资源管线：它们是托盘/任务栏在用的那几张位图，每一张都独立从
// 953 母版直缩（见 docs/brand/icon.md）。renderer/public/ 里刻意不放它们——那份目录是
// gen-icon 声明过的集合，brand-tiers.test.ts 逐字校验，多几张会让启动屏与托盘的接线
// 契约失去意义；vite 把 import 进来的图写成 dist/assets/ 下带 hash 的产物，由
// renderer-assets.ts 一并伺服（vite 的 base='/'，页面挂在 /app 上仍能解析）。
import icon16 from '../../../assets/icon-16.png'
import icon24 from '../../../assets/icon-24.png'
import icon32 from '../../../assets/icon-32.png'
import icon48 from '../../../assets/icon-48.png'
import icon64 from '../../../assets/icon-64.png'

/** 资源挂载前缀，与 electron/renderer-assets.ts 的 RENDERER_MOUNT 一致。 */
const MOUNT = '/app'
/** gen:icon 导出的 256 档整幅（renderer/public/cat.png 是它的逐字节副本）。 */
const MARK = `${MOUNT}/cat.png`

/**
 * srcset 候选：从母版逐档直缩，按宽度描述符交给浏览器挑「最小的够用档」。
 *
 * 此前 24px 头像吃的是 256→24 这条二次降采样——母版的缩放核在小尺寸上把五官糊掉之后，
 * 后面的降采样拿不回细节。逐档直缩的版本才是托盘与任务栏在用的那几张。
 * src 仍留 256 档：它是不认 srcset 时的兜底，也是启动屏 / 托盘档位同源的那一份；
 * sizes 报的是布局宽度（每处 <Cat> 都把 size 写进了 width/height），
 * 于是 1x 屏上的 16px 头像拿到 icon-16 而不是被缩到 16 的 256 档。
 */
const TIERS: readonly { url: string; width: number }[] = [
  { url: icon16, width: 16 },
  { url: icon24, width: 24 },
  { url: icon32, width: 32 },
  { url: icon48, width: 48 },
  { url: icon64, width: 64 },
  { url: MARK, width: 256 },
]
const SRCSET = TIERS.map((tier) => {
  return `${tier.url} ${tier.width}w`
}).join(', ')

export function Cat({
  size = 40,
  shape = 'squircle',
}: {
  size?: number
  /** 底板形状：应用图标位用圆角方形（母版自带），头像位用 circle 裁成满幅圆。 */
  shape?: 'squircle' | 'circle'
}) {
  return (
    <img
      className={shape === 'circle' ? 'cat cat-circle' : 'cat'}
      src={MARK}
      srcSet={SRCSET}
      sizes={`${size}px`}
      width={size}
      height={size}
      alt=""
      // 纯装饰：头像位外面已经有一层带 aria-label 的 role="img" 外壳（AvatarShell），
      // 这里再挂 role="img" 会让读屏念两遍；徽标单独出现时也没有可念的信息。
      aria-hidden="true"
      decoding="async"
    />
  )
}
