/**
 * Token 预算的估算口径：中文一字算一个 token，其余按字符密度折算。
 *
 * 为什么不能只写 `text.length / 4`：那是英文的口径。中文一字就是一个 token
 * （多数 BPE 里还会被拆成 2–3 个子词），同一个「30k 预算」在两种语言下实际
 * 送出去的 prompt 差 4 倍——本项目的目标用户用中文，于是中文对话恰好是预算
 * 算得最松的那种，供应商在真正超限时只会回一个没有线索的 400。
 *
 * 口径（对齐 dsh token-meter 的 CHARS_PER_TOKEN = 4，其余档位为本仓补充）：
 * - ASCII 4 字符 ≈ 1 token（dsh 既有口径，保持可比）
 * - 拉丁扩展 / 西里尔 / 希腊等窄字符 2 字符 ≈ 1 token（子词切分更碎）
 * - emoji 与常见符号 1 个码点 ≈ 2 token（多数分词器按 2–3 个 token 收）
 * - CJK 汉字、假名、谚文、全角标点与全角字母 1 字符 ≈ 1 token
 *
 * 估算只服务于**预算裁剪**，方向上宁可略微高估：少送一点历史只是丢上下文，
 * 顶满窗口是直接失败。
 *
 * @module @ryharness/llm/token-estimate
 */

import type { ContentBlock, Message, ToolSchema } from './types.ts'

/** ASCII 字符密度（dsh token-meter 的 CHARS_PER_TOKEN）。 */
const ASCII_CHARS_PER_TOKEN = 4
/** 非 ASCII 的窄字符（拉丁扩展、西里尔、希腊、阿拉伯、印地…）密度。 */
const NARROW_CHARS_PER_TOKEN = 2
/** emoji / 符号类码点的 token 数（多数分词器按 2–3 个收，取下限）。 */
const SYMBOL_TOKENS = 2
/** 每个内容块的 JSON 结构与类型标签开销（对齐 dsh 的 BLOCK_OVERHEAD）。 */
const BLOCK_OVERHEAD = 4
/** 每条消息的 role 字段开销（对齐 dsh 的 ROLE_OVERHEAD）。 */
const ROLE_OVERHEAD = 4
/** 图片的近似体积（高细节档 ≈1100 token）。 */
const IMAGE_BLOCK_TOKENS = 1_100
/** 文件句柄文本的近似体积（name + 字节数 + 只读路径）。 */
const FILE_BLOCK_TOKENS = 64

/** 码点的密度档。 */
type Density = 'latin' | 'narrow' | 'symbol' | 'wide'

/**
 * 单个码点的密度档。
 *
 * CJK 的判定覆盖汉字、假名、谚文与全角形式：全角标点（0x3000 起的一串）与
 * 全角字母（0xFF00 起）同样一字一 token，把它们漏出去按 ASCII 折算会把
 * 「，。」和「Ａ」这类字符少算 3/4——中文正文里它们的密度并不低。
 */
function densityOf(code: number): Density {
  if (code < 0x80) return 'latin'
  if (
    // 谚文与各类 CJK 书写系统（含全角形式）
    code === 0x30_00 ||
    (code >= 0x11_00 && code <= 0x11_ff) ||
    (code >= 0x2e_80 && code <= 0x2e_ff) ||
    (code >= 0x2f_ff && code <= 0x30_ff) ||
    (code >= 0x31_00 && code <= 0x9f_ff) ||
    (code >= 0xa9_60 && code <= 0xa9_7f) ||
    (code >= 0xac_00 && code <= 0xd7_af) ||
    (code >= 0xf9_00 && code <= 0xfa_ff) ||
    (code >= 0xfe_30 && code <= 0xfe_4f) ||
    (code >= 0xff_01 && code <= 0xff_ef)
  ) {
    return 'wide'
  }
  if (
    // 常用标点与符号（省略号、破折号、箭头、emoji 主体）
    (code >= 0x20_00 && code <= 0x20_6f) ||
    (code >= 0x21_00 && code <= 0x2b_ff) ||
    (code >= 0x26_00 && code <= 0x27_ff) ||
    (code >= 0x1f_000 && code <= 0x1f_aff)
  ) {
    return 'symbol'
  }
  return 'narrow'
}

/**
 * 估算一段文本的 token 数。
 *
 * 单趟扫描按密度分桶累计，避免在长文本上反复做正则匹配（召回注入块与工具
 * 输出动辄几万字符，且这条估算在首 token 路径上）。
 * @param text - 待估文本；空串返回 0。
 * @returns 估算 token 数。
 */
export function estimateTokens(text: string): number {
  let latin = 0
  let narrow = 0
  let symbol = 0
  let wide = 0
  for (let index = 0; index < text.length; ) {
    const unit = text.charCodeAt(index)
    if (unit < 0x80) {
      latin += 1
      index += 1
      continue
    }
    // 代理对按一个码点计：emoji 与 CJK 扩展 B 都在补充平面。
    const codePoint =
      unit >= 0xd8_00 && unit <= 0xdb_ff && index + 1 < text.length
        ? (unit - 0xd8_00) * 0x4_00 + (text.charCodeAt(index + 1) - 0xdc_00) + 0x1_00_00
        : unit
    index += unit >= 0xd8_00 && unit <= 0xdb_ff ? 2 : 1
    const density = densityOf(codePoint)
    if (density === 'wide') wide += 1
    else if (density === 'symbol') symbol += 1
    else if (density === 'narrow') narrow += 1
    else latin += 1
  }
  return (
    Math.ceil(latin / ASCII_CHARS_PER_TOKEN) +
    Math.ceil(narrow / NARROW_CHARS_PER_TOKEN) +
    symbol * SYMBOL_TOKENS +
    wide
  )
}

/** 估算一组内容块的 token 数（含每块的结构开销）。 */
export function estimateContentTokens(blocks: readonly ContentBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += estimateTokens(block.text) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += estimateTokens(block.name) + estimateTokens(block.arguments) + BLOCK_OVERHEAD
        break
      case 'image':
        tokens += IMAGE_BLOCK_TOKENS + BLOCK_OVERHEAD
        break
      case 'file':
        tokens += FILE_BLOCK_TOKENS + BLOCK_OVERHEAD
        break
      default:
        // tool-addition / tool-removal 与后续合并进来的块：按固定结构价，
        // 宁可高估也别漏算（新块类型默认进这里，不会悄悄不计预算）。
        tokens += BLOCK_OVERHEAD
        break
    }
  }
  return tokens
}

/**
 * 估算一条消息的 token 数。
 *
 * reasoning 与 text 同价：它随历史一起回填并占供应商的输入预算，即便本仓的
 * OpenAI 序列化不上送它（那属于另一端的投影选择，不改变"这条历史有多重"）。
 */
export function estimateMessageTokens(message: Message): number {
  return estimateContentTokens(message.content) + ROLE_OVERHEAD
}

/**
 * 估算 tools schema 的 token 数。
 *
 * 工具声明每轮请求都原样上送，是 prompt 里仅次于历史的大头；不计它，预算就
 * 会被「系统提示 + 工具声明」悄悄吃掉一大块而看不出来。
 * @param tools - 本轮上送的工具声明；空表返回 0。
 * @returns 估算 token 数。
 */
export function estimateToolsTokens(tools: readonly ToolSchema[] | undefined): number {
  if (tools === undefined || tools.length === 0) return 0
  return estimateTokens(JSON.stringify(tools)) + BLOCK_OVERHEAD
}
