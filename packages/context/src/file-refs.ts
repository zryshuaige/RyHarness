/**
 * @文件引用：把用户消息里 @ 到的文件装配进上下文。
 * @module @ryharness/context/file-refs
 */

import { readFileSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { DEFAULT_CONTEXT_LIMITS } from './types.ts'
import { resolveWorkspaceFile } from './workspace.ts'

/**
 * 候选串：@ 后面跟一段不含空白与常见标点的文本。
 *
 * 引号形式（@"带空格的 name.md"）单独认：文件名里有空格时只有它能用。
 * 候选串允许 ASCII 冒号与点（Windows 盘符、扩展名都要用），其余标点收尾。
 */
const MENTION_PATTERN = /@(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"'`()[\]{}<>,;!?，。；：！？、【】「」《》、]+))/g

/** 结尾的标点不算路径的一部分（"看 @notes/todo.md。" 里的句号）。 */
const TRAILING_PUNCTUATION = /[.:,;!?]+$/

/** 像路径的判据之一：带扩展名。 */
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,8}$/

/** 一个 @引用的装配结果。 */
export interface FileReferenceEntry {
  /** 用户原样写的路径。 */
  ref: string
  /** 结果。 */
  status: 'included' | 'missing' | 'outside' | 'skipped'
  /** included 时：装配进去的正文。 */
  text?: string
  /** included 时：文件在工作区里的相对路径。 */
  path?: string
  /** 正文是否被截断。 */
  truncated?: boolean
}

/** @文件引用这一块的装配结果。 */
export interface FileReferenceBlock {
  /** 逐个引用的结果。 */
  entries: FileReferenceEntry[]
  /** 给模型的正文。 */
  text: string
}

/** 装配 @文件引用的参数。 */
export interface FileReferenceOptions {
  /** 工作区根目录：工作区外的引用不装配。 */
  workspaceRoot: string
  /** 用户这轮的文本。 */
  text: string
  /** 单个文件上限；缺省 4000 字符。 */
  maxCharsPerFile?: number
  /** 所有文件加起来的上限；缺省 12000 字符。 */
  maxTotalChars?: number
  /** 最多装配几个文件；缺省 8。 */
  maxFiles?: number
}

/**
 * 从文本里找出像路径的 @ 引用。
 *
 * 本仓的 @ 也用于 @ 某个 agent（群聊里 @阿码 派工），所以只有「长得像路径」的
 * 候选才算文件引用：带分隔符，或带扩展名。其余按人名看待，不动。
 * @param text - 用户输入。
 * @returns 引用路径（按首次出现顺序，去重）。
 */
export function parseFileMentions(text: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  MENTION_PATTERN.lastIndex = 0
  let match = MENTION_PATTERN.exec(text)
  while (match !== null) {
    const raw = match[1] ?? match[2] ?? match[3] ?? ''
    const candidate = raw.replace(TRAILING_PUNCTUATION, '')
    if (candidate !== '' && looksLikePath(candidate) && !seen.has(candidate)) {
      seen.add(candidate)
      found.push(candidate)
    }
    match = MENTION_PATTERN.exec(text)
  }
  return found
}

/** 候选串长得像不像路径。 */
function looksLikePath(candidate: string): boolean {
  if (candidate.includes('/') || candidate.includes('\\')) return true
  return HAS_EXTENSION.test(candidate)
}

/**
 * 把用户消息里的 @文件引用装配成上下文。
 *
 * 找不到文件也要说一声：静默丢掉会让模型以为文件已经读过了，于是它照着
 * 「用户提到的那个文件」继续编。
 * @param options - 装配参数。
 * @returns 装配结果；文本里没有文件引用时为 undefined。
 */
export function collectFileReferences(options: FileReferenceOptions): FileReferenceBlock | undefined {
  const refs = parseFileMentions(options.text)
  if (refs.length === 0) return undefined
  const maxFiles = options.maxFiles ?? DEFAULT_CONTEXT_LIMITS.maxFileRefs
  const maxPerFile = options.maxCharsPerFile ?? DEFAULT_CONTEXT_LIMITS.fileMaxChars
  const maxTotal = options.maxTotalChars ?? DEFAULT_CONTEXT_LIMITS.filesTotalMaxChars
  const entries: FileReferenceEntry[] = []
  let used = 0
  for (const ref of refs.slice(0, maxFiles)) {
    const found = resolveWorkspaceFile(options.workspaceRoot, ref)
    if (found.kind === 'outside' || found.kind === 'link-escape') {
      entries.push({ ref, status: 'outside' })
      continue
    }
    if (found.kind === 'missing') {
      entries.push({ ref, status: 'missing' })
      continue
    }
    let raw: string
    try {
      raw = readFileSync(found.path, 'utf8')
    } catch {
      entries.push({ ref, status: 'missing' })
      continue
    }
    const room = maxTotal - used
    if (room <= 0) {
      entries.push({ ref, status: 'skipped' })
      continue
    }
    const limit = Math.min(maxPerFile, room)
    const truncated = raw.length > limit
    const body = truncated ? raw.slice(0, limit) : raw
    used += body.length
    entries.push({
      ref,
      status: 'included',
      text: truncated ? `${body}\n（已截断：全文 ${raw.length} 字符，这里只保留前 ${limit} 字符）` : body,
      path: relative(options.workspaceRoot, found.path).split(sep).join('/'),
      truncated,
    })
  }
  // 超出文件数上限的那些也要说一句，否则模型以为它们已经读过了。
  for (const ref of refs.slice(maxFiles)) {
    entries.push({ ref, status: 'skipped' })
  }
  return { entries, text: renderFileReferences(entries) }
}

/** 把逐个结果拼成给模型的一段话。 */
function renderFileReferences(entries: readonly FileReferenceEntry[]): string {
  const lines: string[] = [
    '[用户提到的文件]',
    '以下是用户这轮消息里 @ 到的文件：工作区里的按内容装配，其余只说明结果。',
  ]
  for (const entry of entries) {
    lines.push('')
    lines.push(`--- ${entry.ref} ---`)
    if (entry.status === 'included') {
      lines.push(entry.text ?? '')
    } else if (entry.status === 'missing') {
      lines.push('没找到这个文件（工作区里没有这个路径）。')
    } else if (entry.status === 'outside') {
      lines.push('这个路径不在工作区里，没有装配它的内容。')
    } else {
      lines.push('超过本轮的装配上限，没有装配它的内容。')
    }
  }
  return lines.join('\n')
}
