/**
 * 跨进程传值时用的小工具：把值变成能过 IPC 的形状，以及把错误变成一句人话。
 *
 * 为什么单独一个文件：宿主这边与子进程那边都要用同一套口径（尤其是「错误叫什么名字」
 * 这件事——子进程里抛的 Error 与宿主进程里的 Error 不是同一个类，`instanceof` 不可靠，
 * 只能看 `name`）。
 * @module @ryharness/ptc/wire
 */

/**
 * 把一个值转成能过 IPC 的形状（JSON 往返一趟）。
 *
 * 函数、`undefined`、BigInt 这类过不去的值会变成 `undefined` 或者直接报错——返回值
 * 必须是能序列化的东西，这条限制写进 README 了。
 * @param value - 要传的值。
 * @returns 传得过去的值。
 */
export function toWire(value: unknown): unknown {
  if (value === undefined) return undefined
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    throw new Error('这个值不能序列化成 JSON（多半是有循环引用）。')
  }
  if (json === undefined) return undefined
  return JSON.parse(json) as unknown
}

/**
 * 错误的一句话说明。
 *
 * 不走 `instanceof Error`：子进程里抛的错与宿主进程里的 Error 不是同一个类。
 * @param error - 任意错误。
 * @returns 一句话说明。
 */
export function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}
