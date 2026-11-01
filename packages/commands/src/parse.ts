/**
 * 命令行解析：把一行输入认成「命令名 + 参数」。
 *
 * 语法只有一条规矩：**斜杠必须在第一个字节**，后面紧跟命令名，命令名后面要么
 * 到行尾、要么是空白。剩下的都是参数，归命令自己解释。
 *
 * 认不出来就返回 undefined，由调用方回一句「这不是命令」——绝不能把普通消息
 * 当成命令跑：用户发了一句「今天天气不错」，结果系统去执行了一条命令，那是
 * 出了事。
 * @module @ryharness/commands/parse
 */

/** 解析出来的一条命令。 */
export interface ParsedCommand {
  /** 命令名（小写，不含斜杠）。 */
  readonly name: string
  /** 参数文本（首尾空白已去掉）。 */
  readonly input: string
  /** 参数原文（保留分隔空白）。 */
  readonly raw: string
}

/** 命令名那一段。 */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/u

/**
 * 解析一行输入。
 *
 * `/goal 继续` → `{ name: 'goal', input: '继续' }`；
 * `今天天气不错` → `undefined`（这不是命令）。
 * @param line - 用户敲的一行。
 * @returns 解析结果；不是命令就返回 undefined。
 */
export function parseCommandLine(line: string): ParsedCommand | undefined {
  if (!line.startsWith('/')) return undefined
  const rest = line.slice(1)
  const nameEnd = firstNonNameIndex(rest)
  if (nameEnd <= 0) return undefined
  const name = rest.slice(0, nameEnd)
  if (!NAME_PATTERN.test(name)) return undefined
  const raw = rest.slice(nameEnd)
  // 名字后面必须紧跟空白或者就是行尾：`/goal?x` 不是命令，`/goal` 才是。
  if (raw.length > 0 && !/^\s/u.test(raw)) return undefined
  return { name: name.toLowerCase(), input: raw.trim(), raw }
}

/**
 * 判断一段文字是不是合法的命令名。
 * @param name - 命令名（不含斜杠）。
 * @returns 合法返回 true。
 */
export function isCommandName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/u.test(name)
}

/** 找到命令名结束的位置（第一个不属于命令名的字符）。 */
function firstNonNameIndex(text: string): number {
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === undefined) break
    if (!/[A-Za-z0-9_-]/u.test(char)) return i
  }
  return text.length
}
