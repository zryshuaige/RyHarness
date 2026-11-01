/**
 * 边界：授权、大小、页数、时限。
 *
 * 这一族真正的价值在**边界**，不在转换本身。转换是宿主给的引擎干的活，本包管的是
 * 「什么样的输入允许进去转，转出来的东西放在哪，能放多大」。
 *
 * 三个上限各有各的理由：
 * - **输入字节上限**：一份畸形文档能把引擎的内存吃穿。
 * - **页数上限**：页数是「工作量」的度量——500 页的 PPT 转换要跑很久。
 * - **转换时限**：引擎卡死时必须有兜底，否则这一轮就停在那儿。
 *
 * 授权是**显式开关**：调用方必须说「这份文件我有权转」。没说就不做——不是「默认允许」，
 * 也不是「默认拒绝但可以偷偷做」。
 * @module @ryharness/document/policy
 */

import { DocumentError } from './errors.ts'

/** 边界参数。 */
export interface DocumentPolicy {
  /** 输入字节上限。 */
  readonly maxInputBytes: number
  /** 页数上限。 */
  readonly maxPages: number
  /** 单次转换的时限（毫秒）。 */
  readonly timeoutMs: number
}

/** 默认边界：64 MiB / 500 页 / 120 秒。 */
export const DEFAULT_DOCUMENT_POLICY: DocumentPolicy = {
  maxInputBytes: 64 * 1024 * 1024,
  maxPages: 500,
  timeoutMs: 120_000,
}

/**
 * 把零散的覆盖项合成一份完整的边界。
 *
 * 非法值（负数、NaN）一律退回默认值——边界宁可宽一点也不要有「负数上限」这种荒唐配置。
 * @param overrides - 覆盖项。
 * @returns 完整的边界。
 */
export function resolvePolicy(overrides?: Partial<DocumentPolicy>): DocumentPolicy {
  const pick = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  return {
    maxInputBytes: pick(overrides?.maxInputBytes, DEFAULT_DOCUMENT_POLICY.maxInputBytes),
    maxPages: pick(overrides?.maxPages, DEFAULT_DOCUMENT_POLICY.maxPages),
    timeoutMs: pick(overrides?.timeoutMs, DEFAULT_DOCUMENT_POLICY.timeoutMs),
  }
}

/**
 * 授权检查：调用方必须显式授权。
 * @param authorized - 调用方是不是明说了「有权转」。
 */
export function checkAuthorized(authorized: boolean): void {
  if (authorized) return
  throw new DocumentError('NOT_AUTHORIZED', '这份文件没有获得转换授权，转换没有开始。')
}

/**
 * 输入大小检查。
 * @param bytes - 输入字节数。
 * @param policy - 边界。
 */
export function checkInputSize(bytes: number, policy: DocumentPolicy): void {
  if (bytes <= policy.maxInputBytes) return
  throw new DocumentError('INPUT_TOO_LARGE', `文件太大：${bytes} 字节，上限 ${policy.maxInputBytes} 字节。`)
}

/**
 * 页数检查。
 *
 * 转换器没报页数就跳过（报不出来不等于超限）。
 * @param pages - 页数；undefined 表示转换器没报。
 * @param policy - 边界。
 */
export function checkPageCount(pages: number | undefined, policy: DocumentPolicy): void {
  if (pages === undefined) return
  if (pages <= policy.maxPages) return
  throw new DocumentError('PAGE_LIMIT_EXCEEDED', `页数超上限：${pages} 页，上限 ${policy.maxPages} 页。`)
}
