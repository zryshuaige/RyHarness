/**
 * 两处共用的文本小工具：把任意 thrown value 说成人话、把长文本截成一行摘要。
 *
 * 单独放一个文件是因为服务与工具两边都要用：抄一份的话，两边的截断口径迟早会
 * 差几个字，列表里就会出现「同一个任务在两处显示得不一样」。
 * @module @ryharness/subagent/format
 */

/** 任意 thrown value 的人类可读说明。 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 截一段摘要：列表里一行放不下整段任务描述。
 * @param text - 原文。
 * @param max - 最多留多少字。
 * @returns 压掉空白后的摘要，超长时截断并加省略号。
 */
export function summary(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
