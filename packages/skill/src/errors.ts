/**
 * 技能这一层的失败原因。
 *
 * 为什么单开一个错误类型：技能失败最常见的两种是「名字不合法」和「没有这个
 * 技能」，而这两种要给的答复完全不同——前者是调用方写错了，后者是技能真的不在。
 * 混成一句「加载失败」，模型只能瞎猜。
 *
 * 错误码是**公开契约**：调用方按 code 分支，文案随便改。
 * @module @ryharness/skill/errors
 */

/** 技能相关的失败类别（机器可读）。 */
export type SkillErrorCode = 'invalid-name' | 'invalid-skill' | 'duplicate-name' | 'not-found'

/** 技能这一层抛出的错误。 */
export class SkillError extends Error {
  override name = 'SkillError'

  constructor(
    readonly code: SkillErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/**
 * 把任意抛出的东西翻成一句能读的文本。
 *
 * 不改写异常类别：那些多半是**我们自己的 bug**，改写成一句中文只会把 bug 藏起来。
 * @param error - 抛出来的东西。
 * @returns 一句能给人看的说明。
 */
export function describeSkillFailure(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}
