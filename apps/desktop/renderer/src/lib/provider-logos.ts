/**
 * 供应商品牌标识 —— 真实 logo，不是首字母色块。
 *
 * 为什么换：此前每家画的是「品牌色圆角方块 + 首字母」，DeepSeek 和 OpenAI 都是
 * 「D」「O」，用户根本认不出是哪家。一屏排开像一堆占位符——这是设置页最像「原型」
 * 的地方，也正是竞品（Cursor / Continue / Cline）都用真 logo 的原因。
 *
 * 形态是「品牌色圆角底 + 白色标识」，与 Cursor / Continue / Vercel 一致：单色
 * path 直接铺在界面上会像贴纸，给它一块品牌底才是各家官方在自家产品里的用法。
 *
 * 来源与授权：
 * - 标识图形来自 Simple Icons（CC0-1.0，单色 path，24×24 归一化 viewBox），
 *   由构建前的一次性脚本光栅化成 256px PNG（见下「怎么加一家」）。
 * - 硅基流动的标识不在 Simple Icons 里，取自其官网 favicon——它本身是彩色
 *   带透明底的图形，因此不再套品牌底（套了会把阶梯块的层次糊掉）。
 * - 各品牌标识的著作权仍归各公司，CC0 只覆盖 Simple Icons 的图形整理。
 *   这是「指示性使用」——在设置里标明你正在配置哪家的服务，不是在宣称关联。
 *   署名见根目录 NOTICE.md。
 *
 * 挑 Simple Icons 而不是各站 favicon 的原因：favicon 是多尺寸位图、清晰度不一、
 * 带透明边缘，在 20px 的列表行里糊成一团；单色 path 放大到 256 再缩到 20 依然干净。
 *
 * **OpenAI 没有 logo**：其标识因商标原因不在 Simple Icons（连 openai / chatgpt 都已
 * 下架），官方 favicon 也拒绝跨站引用。宁可留首字母兜底，也不挂一张来源不明的图。
 */
import anthropicLogo from '../../../assets/providers/anthropic.png'
import deepseekLogo from '../../../assets/providers/deepseek.png'
import googleLogo from '../../../assets/providers/google.png'
import huggingfaceLogo from '../../../assets/providers/huggingface.png'
import kimiLogo from '../../../assets/providers/kimi.png'
import minimaxLogo from '../../../assets/providers/minimax.png'
import moonshotLogo from '../../../assets/providers/moonshot.png'
import ollamaLogo from '../../../assets/providers/ollama.png'
import openrouterLogo from '../../../assets/providers/openrouter.png'
import qwenLogo from '../../../assets/providers/qwen.png'
import siliconflowLogo from '../../../assets/providers/siliconflow.png'
import zhipuLogo from '../../../assets/providers/zhipu.png'

/** 供应商标识 → Vite 产物 URL。 */
const BRAND_LOGOS: Readonly<Record<string, string | undefined>> = Object.freeze({
  siliconflow: siliconflowLogo,
  deepseek: deepseekLogo,
  moonshot: moonshotLogo,
  kimi: kimiLogo,
  zhipu: zhipuLogo,
  minimax: minimaxLogo,
  openrouter: openrouterLogo,
  // OpenAI 的标识因商标原因不可用，见文件头说明。
  openai: undefined,
  ollama: ollamaLogo,
  anthropic: anthropicLogo,
  google: googleLogo,
  huggingface: huggingfaceLogo,
  qwen: qwenLogo,
})

export function providerLogo(id: string | undefined): string | undefined {
  return id === undefined ? undefined : BRAND_LOGOS[id]
}

/**
 * 首字母兜底的底色。
 *
 * 只给「没有 logo 的供应商」用，所以刻意避开品牌色——一旦沿用品牌色，同一个圆角
 * 方块在有 logo 与没 logo 的行之间会看起来像两套设计。中性灰也如实说明「这是占位」。
 */
export const PROVIDER_LETTER_BG = '#8A7F72'

/**
 * 个别供应商的兜底底色：按它自己的品牌色垫。
 *
 * OpenAI 的标识因商标原因不能随包分发（Simple Icons 已下架、官网也拒绝跨站引用），
 * 所以那一格只能首字母。但用中性灰会变成一排彩色标识里最突兀的一块，改用它自己的
 * 品牌绿之后，一眼能对上是谁——底色是它家的绿，字是它家的 O。
 */
const LETTER_BG_BY_ID: Readonly<Record<string, string>> = Object.freeze({
  openai: '#10A37F',
})

/** 首字母兜底的底色：这家有品牌色就用品牌色，否则用中性灰。 */
export function providerLetterBg(id: string | undefined): string {
  if (id === undefined) return PROVIDER_LETTER_BG
  return LETTER_BG_BY_ID[id] ?? PROVIDER_LETTER_BG
}

/**
 * 怎么加一家新供应商的 logo
 *
 * 1. 从 Simple Icons 取图形（`https://cdn.simpleicons.org/<slug>`，CC0）；
 * 2. 一次性脚本把它光栅化成「品牌色底 + 白标识」的 256px PNG，落到
 *    `apps/desktop/assets/providers/<id>.png`（品牌色取各家官网主色）；
 * 3. 在本文件的静态 import 与 {@link BRAND_LOGOS} 里各加一行。
 *
 * 别在渲染层做「剥 fill 再反相」那类处理：SVG 的 fill 写在文件内部，CSS 变量覆盖
 * 不了；实测剥掉 fill 后 path 会退回默认黑，压在深色底上整排全黑。
 */
