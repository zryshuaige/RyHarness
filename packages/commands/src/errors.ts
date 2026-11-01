/**
 * 斜杠命令这一层的失败原因。
 *
 * 为什么要有错误码：命令注册时的失败只有两类——「名字不合法」与「名字被占用」。
 * 后者尤其不能静默：用户敲了 `/plan`，跑的却是别人注册的那条命令，界面上还
 * 什么都没显示——这种错必须当场报出来。
 * @module @ryharness/commands/errors
 */

/** 命令相关的失败类别（机器可读）。 */
export type CommandErrorCode = 'invalid-name' | 'invalid-definition' | 'duplicate-name'

/** 命令这一层抛出的错误。 */
export class CommandError extends Error {
  override name = 'CommandError'

  constructor(
    readonly code: CommandErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/**
 * 把任意抛出的东西翻成一句能读的文本。
 * @param error - 抛出来的东西。
 * @returns 一句能给人看的说明。
 */
export function describeCommandFailure(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}
