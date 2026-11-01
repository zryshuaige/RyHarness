/**
 * 判定一个值是不是「键值对」。
 *
 * JSON 回包、请求体模板、工具入参都要先过这一关才能取字段，所以它单独成文件：
 * 放在任何一个业务模块里，另一个模块都得回头 import 那个业务模块。
 * @module @ryharness/web/parse
 */

/**
 * @param value - 任意值。
 * @returns 是普通对象（不是数组、不是 null）返回 true。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
