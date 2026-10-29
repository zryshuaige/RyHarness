/**
 * JSON 值的窄化助手。
 *
 * 为什么不直接写 `as`：MCP server 回什么不由我们控制，协议里每个字段都是
 * 「可能有、也可能形状不对」。写成类型守卫，源码里就不会出现断言——类型逃逸
 * 那道门禁查的是 `as unknown as`，但单写一个 `as` 一样会盖住真问题。
 * @module @ryharness/mcp/json
 */

/** 是不是一个普通对象（不是 null、不是数组）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取字符串字段；不是字符串就返回 undefined。 */
export function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

/** 取对象字段；不是对象就返回 undefined。 */
export function readObject(source: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = source[key]
  return isPlainObject(value) ? value : undefined
}

/** 取数组字段；不是数组就返回 undefined。 */
export function readArray(source: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = source[key]
  return Array.isArray(value) ? value : undefined
}
