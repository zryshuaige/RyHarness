/**
 * 分页游标：一个不透明字符串，装着「上一页最后一条的序号」与「这页筛选条件的指纹」。
 *
 * 为什么用游标而不是偏移量：历史是活的——新消息不断落库，偏移量翻页会漏消息
 * 也会重消息（翻页期间前面插了三条，第二页就错位了）。游标记的是「seq 小于
 * 这个数」，与前面插了多少条无关。
 *
 * 为什么带指纹：同一枚游标被用在另一组筛选条件上（比如上一页按「用户说的」筛，
 * 下一页忘了带筛选条件），返回的东西会莫名其妙。指纹对不上就直接报错，
 * 好过给一页看起来正常但其实是另一组结果的数据。
 * @module @ryharness/session-query/cursor
 */

import { SessionQueryError } from './errors.ts'
import type { MessageFilter } from './types.ts'

/** 游标里装的东西。 */
interface CursorPayload {
  /** 上一页最后一条消息的 seq。 */
  s: number
  /** 筛选条件指纹。 */
  f: string
}

/**
 * 筛选条件的指纹：影响结果的字段拼成一段文本，再取 32 位 FNV-1a。
 *
 * 不取哈希库（crypto）是因为这里不需要防篡改，只需要「认出这不是同一组条件」。
 */
export function filterFingerprint(filter: MessageFilter): string {
  const canonical = JSON.stringify([
    filter.conversationId ?? '',
    filter.senderType ?? '',
    filter.senderId ?? '',
    filter.kind ?? '',
    filter.fromTime ?? '',
    filter.toTime ?? '',
    filter.text ?? '',
    filter.order ?? '',
  ])
  return fnv1a(canonical)
}

/** 编一枚游标。 */
export function encodeCursor(seq: number, fingerprint: string): string {
  const payload: CursorPayload = { s: seq, f: fingerprint }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * 解一枚游标，返回它记的 seq。
 *
 * 游标坏了（不是本服务发的、被截断过）报 `CURSOR_INVALID`；游标是好的但用在了
 * 另一组筛选条件上，报 `CURSOR_MISMATCH`——两者的处置不同，别混成一个错。
 */
export function decodeCursor(cursor: string, fingerprint: string): number {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new SessionQueryError('CURSOR_INVALID', '游标格式不对：翻页参数可能被截断了，重新从头查一次。')
  }
  if (!isCursorPayload(parsed)) {
    throw new SessionQueryError('CURSOR_INVALID', '游标格式不对：翻页参数可能被截断了，重新从头查一次。')
  }
  if (parsed.f !== fingerprint) {
    throw new SessionQueryError('CURSOR_MISMATCH', '这个游标是另一组筛选条件留下的：换了条件就要从第一页重新查。')
  }
  return parsed.s
}

/** 32 位 FNV-1a（返回 8 位十六进制）。 */
function fnv1a(text: string): string {
  let hash = 0x81_1c_9d_c5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 解出来的 JSON 是不是一枚完整游标。 */
function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { s?: unknown; f?: unknown }
  return typeof record.s === 'number' && Number.isFinite(record.s) && typeof record.f === 'string'
}
