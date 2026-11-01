/**
 * 命令注册表：登记命令、解析输入、执行命令。
 *
 * 三件事，一件都不多：
 * - **登记**：命令名唯一，重名直接报错（静默覆盖会让用户敲了命令却跑了另一个）；
 * - **清单**：给界面补全用，只要名字与说明；
 * - **执行**：一行输入进来，要么跑命令，要么明确说「这不是命令」/「没有这个命令」。
 *
 * 执行结果不碰模型，也不进对话历史——那是宿主的事。这个包只管「敲了 /x 之后
 * 到底发生了什么」。
 * @module @ryharness/commands/registry
 */

import { CommandError, describeCommandFailure } from './errors.ts'
import { parseCommandLine } from './parse.ts'
import type { CommandContext, CommandDefinition, CommandExecution, CommandSummary } from './types.ts'
import { COMMAND_NAME_PATTERN } from './types.ts'

/**
 * 命令注册表。
 *
 * 用法：`register(...)` 登记命令，`list()` 拿清单，`execute(line)` 跑一行输入。
 */
export class CommandRegistry {
  private readonly byName = new Map<string, CommandDefinition>()
  /** 别名 → 命令名。 */
  private readonly aliasToName = new Map<string, string>()

  /**
   * 登记一条命令。
   *
   * 重名（含别名撞车）直接报错，不做静默覆盖：命令是**人**在敲的东西，覆盖掉
   * 的后果是「用户敲了 A，跑了 B，而界面上一句提示都没有」。
   * @param command - 命令定义。
   * @returns 注销函数（重复调用是幂等的）。
   */
  register(command: CommandDefinition): () => void {
    const name = command.name
    if (typeof name !== 'string' || !COMMAND_NAME_PATTERN.test(name)) {
      throw new CommandError('invalid-name', `命令名不合法："${String(name)}"`)
    }
    if (typeof command.description !== 'string' || command.description.length === 0) {
      throw new CommandError('invalid-definition', `命令 "/${name}" 缺说明`)
    }
    if (this.byName.has(name)) {
      throw new CommandError('duplicate-name', `命令 "/${name}" 已经注册过了`)
    }
    const aliases = command.aliases ?? []
    for (const alias of aliases) {
      if (!COMMAND_NAME_PATTERN.test(alias)) {
        throw new CommandError('invalid-name', `命令 "/${name}" 的别名不合法："${alias}"`)
      }
      if (this.byName.has(alias)) {
        throw new CommandError('duplicate-name', `别名 "/${alias}" 已经是别的命令了`)
      }
      if (this.aliasToName.has(alias)) {
        throw new CommandError('duplicate-name', `别名 "/${alias}" 已经被别的命令用过了`)
      }
    }
    this.byName.set(name, command)
    for (const alias of aliases) this.aliasToName.set(alias, name)
    return () => {
      if (!this.byName.has(name)) return
      this.byName.delete(name)
      for (const alias of aliases) this.aliasToName.delete(alias)
    }
  }

  /**
   * 命令清单（给界面补全用），按名字排好。
   * @returns 清单条目。
   */
  list(): CommandSummary[] {
    return [...this.byName.values()]
      .map((command) => {
        return {
          name: command.name,
          description: command.description,
          aliases: command.aliases ?? [],
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 按名字找命令（别名也算）。
   * @param name - 命令名或别名（不含斜杠）。
   * @returns 找到就返回命令；没有返回 undefined。
   */
  find(name: string): CommandDefinition | undefined {
    if (typeof name !== 'string' || name.length === 0) return undefined
    const key = name.toLowerCase()
    const direct = this.byName.get(key)
    if (direct !== undefined) return direct
    const aliased = this.aliasToName.get(key)
    if (aliased === undefined) return undefined
    return this.byName.get(aliased)
  }

  /**
   * 跑一行输入。
   *
   * 不是命令就明说「这不是命令」，不命令存在就明说「没有这个命令」——这两种
   * 都不该被当成普通消息丢给模型，也不该被当成命令乱跑。
   * @param line - 用户敲的一行。
   * @returns 执行结果。
   */
  async execute(line: string, context?: CommandContext): Promise<CommandExecution> {
    const parsed = parseCommandLine(line)
    if (parsed === undefined) {
      return { ran: false, isError: true, text: '这不是命令' }
    }
    const command = this.find(parsed.name)
    if (command === undefined) {
      return { ran: false, isError: true, name: parsed.name, text: `没有这个命令：/${parsed.name}` }
    }
    try {
      const result = await command.execute({ input: parsed.input, raw: parsed.raw, line }, context)
      return { ...result, ran: true, name: command.name }
    } catch (error) {
      return {
        ran: true,
        isError: true,
        name: command.name,
        text: `命令 /${command.name} 跑失败：${describeCommandFailure(error)}`,
      }
    }
  }
}
