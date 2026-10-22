/**
 * 立体动物形象：数据与资源索引（**不画图形**）。
 *
 * 形象资产是**照片级 3D 渲染**的动物头（不是手画的图形）：`assets/animals/*.webp`，
 * 每只动物三个视角（正面 / 左 3/4 / 右 3/4），透明底。渲染层只按路径消费。
 *
 * 为什么不把图形写在渲染层：`apps/desktop/tests/brand.test.tsx` 钉着一条**既有
 * 不变量**——"渲染层里根本不写图形"。品牌标记只有一个来源（位图母版
 * assets/brand/mark.png），渲染层再手绘第二只猫的耳朵路径，"这只猫"就有两个
 * 来源了。图形属资产层，渲染层只消费。
 *
 * 为什么是三视图而不是真 3D 网格：
 * - 真 3D（three.js / WebGL）要背渲染库、模型文件与 GPU 上下文。主包现在 gzip
 *   116KB，three.js 一个就 +155KB，模型再 +100~300KB/只——单机应用要稳、要省
 *   内存，这条路直接被否。
 * - 3D 渲染图 + 三视角交叉淡入，**照片级的写实度一点不打折**（源图就是照片级
 *   3D 渲染），转头时看到的是真的侧脸，不是位移贴图糊出来的假象。
 * - 18 张 WebP 一共约 450KB，**全是本地文件**，不进主包、不进首屏：列表里的
 *   小头像只请求正面图，身份卡/弹层才用到侧脸。
 *
 * 毛色为什么不另存一套图：8 种毛色 = 8 条 CSS filter 链（sepia → hue-rotate →
 * saturate → brightness）。染色在 GPU 上跑，**零额外资产、零构建期成本、实时
 * 可切**。sepia 这一步是给灰白色动物（鼠、熊猫）一个色相锚——没有它，
 * hue-rotate 对灰色像素不生效，选了毛色却看不出变化。
 *
 * 动物家族里**没有猫**：全应用只有那一只品牌橘猫。要猫就用品牌那只。
 *
 * @module @ryharness/renderer/lib/animal-3d
 */

/** 可选的动物种类。 */
export type AnimalKind = 'dog' | 'fox' | 'rabbit' | 'bear' | 'panda' | 'mouse'

/** 一只动物的完整定义（选择器里显示的名字与一句话设定）。 */
export interface AnimalDef {
  kind: AnimalKind
  label: string
  hint: string
  /**
   * 主色的**原始色相**（度）。染色时按「目标色相 − 原色相」旋转，而不是给所有
   * 动物同一条 hue-rotate——否则选「天青」时狐狸变蓝、兔子却变绿，同一个选项
   * 出来六种颜色。
   */
  baseHue: number
  /**
   * 染色前的准备链：这��动物的主色要先归到"可旋转的色相"上才转得准。
   * 空 = 本身就有彩色主色，直接转即可（白胸白毛会保持白色——`hue-rotate`
   * 对无彩色像素不生效，这正好保住了胸口那一片浅色）。
   * 熊猫是黑白配色，没有色相可转，得先上一层棕调（sepia）才有色相。
   */
  dyeBase: string
}

/** 可选动物清单。顺序即选择器里的展示顺序。 */
export const ANIMALS: readonly AnimalDef[] = [
  { kind: 'dog', label: '狗', hint: '踏实、记性牢、爱提醒', baseHue: 38, dyeBase: '' },
  { kind: 'fox', label: '狐', hint: '灵巧、讲究措辞、擅长绕弯', baseHue: 25, dyeBase: '' },
  { kind: 'rabbit', label: '兔', hint: '轻快、跳脱、点子多', baseHue: 342, dyeBase: '' },
  { kind: 'bear', label: '熊', hint: '沉稳、慢热、认死理', baseHue: 22, dyeBase: '' },
  { kind: 'panda', label: '熊猫', hint: '佛系、慢半拍、关键时候顶得上', baseHue: 38, dyeBase: 'sepia(1)' },
  { kind: 'mouse', label: '鼠', hint: '机灵、藏不住话、跑得快', baseHue: 282, dyeBase: '' },
]

const ANIMAL_BY_KIND: ReadonlyMap<string, AnimalDef> = new Map(
  ANIMALS.map((animal) => {
    return [animal.kind, animal]
  }),
)

/**
 * 一只动物有几种"脸"。
 *
 * - `front` / `left` / `right`：三个视角，转头时换（看到的侧脸是真的侧脸）。
 * - `smile` / `blink`：小表情，闲置时偶尔来一下（让它是"活的"而不是贴纸）。
 * - `wave`：打招呼，举起一只爪子。
 *
 * 表情与动作只在**大头像**上播放（身份卡、我的页）：列表里几十张小头像各跑
 * 一套定时器既费电又互相干扰。
 */
export type AnimalFace = 'front' | 'left' | 'right' | 'smile' | 'blink' | 'wave'

/** 闲置时会随机播的小表情。 */
export const ANIMAL_IDLE_FACES: readonly AnimalFace[] = ['smile', 'blink']

/** 全部的脸（渲染层按这个顺序准备图）。 */
export const ANIMAL_FACES: readonly AnimalFace[] = ['front', 'left', 'right', 'smile', 'blink', 'wave']

/** 三个视角的展示顺序（正面在中间，转头时按鼠标方向换到左右）。 */
export const ANIMAL_VIEWS: readonly AnimalFace[] = ['left', 'front', 'right']

/**
 * 可选毛色。
 *
 * 染色在 GPU 上跑：`hue-rotate` 改色相、`saturate` 补回转色相后掉下去的艳度、
 * `brightness` 微调明暗。**没有第二套图**——8 种毛色 = 8 条 filter 链，零资产。
 */
export interface AnimalHueDef {
  hue: number
  label: string
  /** 转色相之后补回来的饱和度。 */
  sat: number
  /** 明暗微调。 */
  bright: number
}

/** 可选毛色。色相角度与品牌色板同一族：饱和度压在中低档，不出现霓虹。 */
export const ANIMAL_HUES: readonly AnimalHueDef[] = [
  { hue: 30, label: '暖橘', sat: 1.3, bright: 1 },
  { hue: 14, label: '砖红', sat: 1.35, bright: 0.95 },
  { hue: 42, label: '奶黄', sat: 1.25, bright: 1.08 },
  { hue: 78, label: '橄榄', sat: 1.2, bright: 0.96 },
  { hue: 158, label: '松绿', sat: 1.15, bright: 0.93 },
  { hue: 200, label: '天青', sat: 1.15, bright: 0.98 },
  { hue: 222, label: '靛蓝', sat: 1.2, bright: 0.92 },
  { hue: 264, label: '雾紫', sat: 1.1, bright: 1 },
]

const HUE_BY_ID: ReadonlyMap<number, AnimalHueDef> = new Map(
  ANIMAL_HUES.map((item) => {
    return [item.hue, item]
  }),
)

/**
 * 形象资产表：路径 → 构建后的 URL。
 *
 * `import.meta.glob` 由 Vite 在构建期展开成静态映射（不引入运行时的目录扫描）。
 * 18 个 WebP 每个 25KB 上下，**超过内联阈值**（4KB），所以 Vite 会把它们留成
 * 独立文件而不是 data URI：主包一点不涨，列表页只请求用得到的那几张。
 */
const ASSETS = import.meta.glob('../../../assets/animals/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

/** 某个动物某张脸的资源 URL；没有这一份时返回 undefined。 */
export function animalAssetUrl(kind: AnimalKind, face: AnimalFace): string | undefined {
  return ASSETS[`../../../assets/animals/${kind}-${face}.webp`]
}

/** 取动物定义；未知返回 undefined。 */
export function animalOf(kind: string): AnimalDef | undefined {
  return ANIMAL_BY_KIND.get(kind)
}

/** 取毛色定义；未知时回落到第一个（暖橘）。 */
export function animalHueOf(hue: number): AnimalHueDef {
  return HUE_BY_ID.get(hue) ?? ANIMAL_HUES[0]
}

/**
 * 某只动物在某条毛色下的 CSS filter 值。
 *
 * 角度按「目标色相 − 这只动物的原色相」算：所有动物转到**同一个**色相，
 * 而不是各转各的（否则选「天青」时狐狸蓝、兔子绿，同一个选项六种颜色）。
 */
export function animalHueFilter(kind: AnimalKind, hue: number): string {
  const def = animalHueOf(hue)
  const animal = animalOf(kind)
  const base = animal?.baseHue ?? 25
  const shift = (((def.hue - base) % 360) + 360) % 360
  const prep = animal?.dyeBase ?? ''
  const chain = `${prep} hue-rotate(${shift}deg) saturate(${def.sat}) brightness(${def.bright})`
  return chain.trim()
}

/** 判断某个 avatar 字段是不是"立体动物"（`an3d:<种类>:<色相>`）。 */
export function isAnimalAvatar(value: string | undefined): boolean {
  return value !== undefined && /^an3d:[a-z]+:\d+$/.test(value)
}

/** 造一个"立体动物"头像字段值。 */
export function animalAvatar(kind: AnimalKind, hue: number): string {
  return `an3d:${kind}:${hue}`
}

/** 解析"立体动物"头像字段；不是这个形态或字段不合法时返回 undefined。 */
export function parseAnimalAvatar(value: string | undefined): { kind: AnimalKind; hue: number } | undefined {
  if (value === undefined) return undefined
  const match = /^an3d:([a-z]+):(\d+)$/.exec(value)
  if (match === null) return undefined
  const kind = match[1] as string
  const hue = Number(match[2])
  if (ANIMAL_BY_KIND.get(kind) === undefined) return undefined
  if (!Number.isInteger(hue) || hue < 0 || hue > 360) return undefined
  return { kind: kind as AnimalKind, hue }
}
