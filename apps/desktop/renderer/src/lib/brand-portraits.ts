/**
 * 助理立绘（头像候选项）注册表 —— 唯一真源。
 *
 * 四张立绘来自仓库根 `src/`（cat / dog / fox / mask），由
 * `apps/desktop/scripts/gen-portraits.mjs` 归一化成「圆形透明底 + 24/64/256 三档
 * WebP」，落在 `apps/desktop/assets/portraits/`（构建时带 hash）：
 * - 圆形遮罩是刻意的：头像壳本来就是 50% 圆（AVATAR_SPEC），方形立绘进去会被切角；
 * - 透明底让浅色/暗色两套主题都能直接用，不必给每个人物配两版；
 * - **256 档**给 40–96px 的头像与资料页，**64 档**给列表小头像，**24 档**给接力链
 *   （20px）与群九宫格内格（22–24px）——24 档是新增的：此前最小档是 64，浏览器把它
 *   缩到 20px 时人物直接缩成一团色斑，看不出是谁。
 *
 * 此前四张立绘是三套语言（底色琥珀/饱和蓝/紫蓝，构图脸部特写/全身带道具/头戴贝雷帽，
 * 渲染 3D 与平面剪影各半），同屏就是拼盘。现在统一到「暖琥珀底 + 头肩构图 + 3D 渲染」，
 * 剪影作为「还没有立绘」的占位例外保留。
 *
 * `cat` 是与应用图标同源的那只橘猫（`Cat.tsx`，走 icon-* 分档位图），
 * 其余三张走本文件的 `<img>` 通道。`mask` 是「还没有立绘」的占位剪影。
 *
 * 命名注意：素材原名 `NaN.png` 是导出管线的产物名（不是「非数字」语义），
 * 进入产品后统一叫 `mask`（占位剪影），避免在代码里出现 NaN 这种会误导的名字。
 */

import catSm from '../../../assets/portraits/cat-24.webp'
/**
 * 立绘图像资源。Vite 会把它换成带 hash 的产物 URL，测试里则是一个路径字符串；
 * 三档（24/64/256）对应「接力链与群头像格」「列表小头像」「资料页与列表大头像」。
 */
import catMd from '../../../assets/portraits/cat-64.webp'
import catLg from '../../../assets/portraits/cat-256.webp'
import dogSm from '../../../assets/portraits/dog-24.webp'
import dogMd from '../../../assets/portraits/dog-64.webp'
import dogLg from '../../../assets/portraits/dog-256.webp'
import foxSm from '../../../assets/portraits/fox-24.webp'
import foxMd from '../../../assets/portraits/fox-64.webp'
import foxLg from '../../../assets/portraits/fox-256.webp'
import maskSm from '../../../assets/portraits/mask-24.webp'
import maskMd from '../../../assets/portraits/mask-64.webp'
import maskLg from '../../../assets/portraits/mask-256.webp'

/** 立绘键。`cat` 复用品牌位图通道，其余走本注册表的图片通道。 */
export type PortraitKey = 'cat' | 'dog' | 'fox' | 'mask'

/**
 * 立绘的视觉规范 —— 验收项，不是描述。
 *
 * 「四张立绘要成一家」此前只是一句口头约定，谁改图谁拍脑袋，于是四张图各长各的。
 * 把它写成字段之后，它就成了**可被测试断言的数字**：改了图不合规，测试会红。
 *
 * - plate：底板色系。全家只有暖琥珀一系——系统里蓝是 --info 语义色，出现在头像上
 *   会读成「这是出错了」。
 * - subjectRatio：主体面积占圆面积的比例（见 gen-portraits.mjs 的 subjectRatio）。
 *   头肩构图 0.62–0.70，脸部特写档 0.72–0.86。
 * - placeholder：true = 占位立绘（剪影）。它在选择器里要降权并标明「占位」，
 *   否则用户会把它当成第 4 个正式角色。
 */
export interface PortraitVisualSpec {
  plate: 'amber'
  /** 主体面积 / 圆面积。 */
  subjectRatio: number
  /** 是否是「还没有专属立绘」的占位。 */
  placeholder: boolean
}

export interface PortraitDef {
  key: PortraitKey
  /** 选择器与「当前：…」里显示的名字。 */
  label: string
  /** 一句话人物设定（选择器 title，也方便模板复用）。 */
  hint: string
  /** 视觉规范：可被测试断言的验收项。 */
  visualSpec: PortraitVisualSpec
}

export const PORTRAITS: readonly PortraitDef[] = [
  {
    key: 'cat',
    label: '橘猫',
    hint: 'RyHarness 品牌主角：总管、日常问答与事务安排',
    visualSpec: { plate: 'amber', subjectRatio: 0.62, placeholder: false },
  },
  {
    key: 'dog',
    label: '柴犬',
    hint: '计划型：清单、日程、待办与执行跟进',
    visualSpec: { plate: 'amber', subjectRatio: 0.62, placeholder: false },
  },
  {
    key: 'fox',
    label: '灰狐',
    hint: '沟通型：写作、润色、对外表达与翻译',
    visualSpec: { plate: 'amber', subjectRatio: 0.62, placeholder: false },
  },
  {
    key: 'mask',
    label: '剪影',
    hint: '占位立绘：还没有专属形象的助理',
    visualSpec: { plate: 'amber', subjectRatio: 0.63, placeholder: true },
  },
]

const BY_KEY: ReadonlyMap<string, PortraitDef> = new Map(
  PORTRAITS.map((portrait) => {
    return [portrait.key, portrait]
  }),
)

/** 是否是立绘键（含 cat）。 */
export function isPortraitKey(value: string | undefined): value is PortraitKey {
  return value !== undefined && BY_KEY.has(value)
}

/** 取立绘定义；未知返回 undefined。 */
export function portraitOf(value: string | undefined): PortraitDef | undefined {
  return value === undefined ? undefined : BY_KEY.get(value)
}

/** 立绘展示名；未知返回 undefined（调用方自己决定兜底文案）。 */
export function portraitLabel(value: string | undefined): string | undefined {
  return portraitOf(value)?.label
}

/** 资源走 Vite 导入（构建后带 hash），不走 renderer/public
 *  —— 那里有一份「只能放 gen-icon 声明产物」的契约测试守着。 */
const FILES: Record<PortraitKey, { sm: string; md: string; lg: string }> = {
  cat: { sm: catSm, md: catMd, lg: catLg },
  dog: { sm: dogSm, md: dogMd, lg: dogLg },
  fox: { sm: foxSm, md: foxMd, lg: foxLg },
  mask: { sm: maskSm, md: maskMd, lg: maskLg },
}

/** 某档立绘的 URL（构建产物 URL，带 hash）。 */
export function portraitSrc(key: PortraitKey, size: 24 | 64 | 256): string {
  const files = FILES[key]
  return size === 24 ? files.sm : size === 64 ? files.md : files.lg
}

/**
 * 头像 `<img>` 用的 srcset：三档覆盖 16–96px 的所有头像位。
 *
 * 24 档是给接力链（20px）与群九宫格内格（22–24px）的——此前最小档是 64，
 * 浏览器缩到 20px 时整个人物糊成色斑。
 */
export function portraitSrcSet(key: PortraitKey): string {
  const files = FILES[key]
  return `${files.sm} 24w, ${files.md} 64w, ${files.lg} 256w`
}
