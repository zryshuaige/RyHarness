/**
 * 工作区指令文件：把 AGENTS.md 这类项目规矩变成给模型的指引。
 * @module @ryharness/context/instructions
 */

import { readFileSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { DEFAULT_CONTEXT_LIMITS } from './types.ts'
import { resolveWorkspaceFile } from './workspace.ts'

/** 默认找哪些指令文件（按顺序取第一个有内容的）。 */
export const DEFAULT_INSTRUCTION_FILES: readonly string[] = ['AGENTS.md', 'RYHARNESS.md']

/** 装配出来的一段项目指引。 */
export interface InstructionBlock {
  /** 指令文件相对工作区根的路径：模型得知道这段规矩是从哪来的。 */
  source: string
  /** 给模型的正文。 */
  text: string
  /** 正文是否被截断。 */
  truncated: boolean
}

/** 读指令文件的参数。 */
export interface InstructionOptions {
  /** 工作区根目录。 */
  workspaceRoot: string
  /** 候选文件名（相对工作区根）；缺省用 {@link DEFAULT_INSTRUCTION_FILES}。 */
  fileNames?: readonly string[]
  /** 正文上限；缺省 8000 字符。 */
  maxChars?: number
}

/**
 * 读工作区里的指令文件，装配成一段给模型的指引。
 *
 * 找不到就不注入：留一个空块只会占位置，还会让模型以为「项目没规矩」也是一条信息。
 * @param options - 读取参数。
 * @returns 装配结果；没有可用指令文件时为 undefined。
 */
export function loadWorkspaceInstructions(options: InstructionOptions): InstructionBlock | undefined {
  const names = options.fileNames ?? DEFAULT_INSTRUCTION_FILES
  const maxChars = options.maxChars ?? DEFAULT_CONTEXT_LIMITS.instructionsMaxChars
  for (const name of names) {
    const found = resolveWorkspaceFile(options.workspaceRoot, name)
    if (found.kind !== 'ok') continue
    let raw: string
    try {
      raw = readFileSync(found.path, 'utf8')
    } catch {
      // 读不出来（是指令目录、权限不够）就当它没有：把一段报错塞进上下文，
      // 比不注入更糟——模型会照着报错里的路径去找。
      continue
    }
    if (raw.trim() === '') continue
    const source = relative(options.workspaceRoot, found.path).split(sep).join('/')
    const truncated = raw.length > maxChars
    const body = truncated ? raw.slice(0, maxChars) : raw
    const notice = truncated ? `\n\n（已截断：全文 ${raw.length} 字符，这里只保留前 ${maxChars} 字符）` : ''
    return {
      source,
      truncated,
      text: `[项目指引 · 来自工作区文件 ${source}]\n以下是工作区里的项目规矩（不是用户这轮说的话），请照它行事。\n\n${body}${notice}`,
    }
  }
  return undefined
}
