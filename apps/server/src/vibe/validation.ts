import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { VibeProject, VibeProjectFile } from './project.ts'

export interface VibeValidationCheck {
  id: string
  label: string
  ok: boolean
  detail: string
}

export interface VibeValidationReport {
  ok: boolean
  kind: VibeProject['kind']
  checks: VibeValidationCheck[]
  summary: string
  validatedAt: number
}

function check(id: string, label: string, ok: boolean, detail: string): VibeValidationCheck {
  return { id, label, ok, detail }
}

function readArtifact(project: VibeProject, extension: string): { file?: VibeProjectFile; content: string } {
  const file = project.files.find((candidate) => {
    return extname(candidate.name).toLowerCase() === extension
  })
  if (file === undefined) return { content: '' }
  try {
    return { file, content: readFileSync(file.path, 'utf8') }
  } catch {
    return { file, content: '' }
  }
}

export function parseCsv(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < content.length; index++) {
    const char = content[index] as string
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') {
        field += '"'
        index++
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
      continue
    }
    if (char === '"') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''))
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  row.push(field.replace(/\r$/, ''))
  rows.push(row)
  return rows.filter((cells) => {
    return cells.some((cell) => {
      return cell.trim().length > 0
    })
  })
}

function validateApp(project: VibeProject): VibeValidationCheck[] {
  const { file, content } = readArtifact(project, '.html')
  const checks = [
    check('app-entry', '应用入口', file !== undefined && content.trim().length > 0, '必须有可读取的 HTML 入口'),
    check(
      'app-not-template',
      '不是需求展板',
      content.length > 0 && !content.includes('由 RyHarness 的 RyVibe 生成') && !content.includes('第一版要做的事'),
      '不能只做项目名称和 TODO 展示页',
    ),
    check(
      'app-interaction',
      '核心交互',
      /<script\b/i.test(content) && /<(button|input|select|textarea)\b/i.test(content),
      '至少包含脚本和真实交互控件',
    ),
    check(
      'app-placeholders',
      '没有待填占位',
      !/(?:TODO|待实现|待填|coming soon)/i.test(content),
      '交付页面不能留待实现占位',
    ),
  ]
  if (/记账|刷新后|持久|保存数据/.test(project.name + project.summary)) {
    checks.push(
      check('app-persistence', '数据持久化', /localStorage|indexedDB/i.test(content), '此类应用刷新后必须能找回数据'),
    )
  }
  return checks
}

function validateDocument(project: VibeProject, flow: boolean): VibeValidationCheck[] {
  const { file, content } = readArtifact(project, '.md')
  const trimmed = content.trim()
  const emptySection = /^#{2,6}\s+[^\n]+\n(?:[ \t]*\n)*(?=#{1,6}\s|(?![\s\S]))/m.test(trimmed)
  const steps = trimmed.match(/^\s*\d+\.\s+\S.+$/gm) ?? []
  const checks = [
    check(
      'doc-file',
      flow ? '流程正文' : '文档正文',
      file !== undefined && trimmed.length >= 40,
      '正文至少要有 40 个字符',
    ),
    check(
      'doc-complete',
      '没有空章节或占位',
      trimmed.length > 0 && !emptySection && !/(?:TODO|待填|待补充|在这里写)/i.test(trimmed),
      '不能交一份待填模板',
    ),
  ]
  if (flow) {
    checks.push(
      check('flow-steps', '可执行步骤', steps.length >= 2, '至少两步，每步都要有具体内容'),
      check(
        'flow-trigger',
        '触发与交接',
        /触发|何时|什么时候/.test(trimmed) && /负责|交接|输出|产物/.test(trimmed),
        '说清何时触发、谁负责以及交出什么',
      ),
    )
  }
  return checks
}

function validateSheet(project: VibeProject): VibeValidationCheck[] {
  const { file, content } = readArtifact(project, '.csv')
  const rows = parseCsv(content)
  const headers = rows[0] ?? []
  const width = headers.length
  const consistent = rows.every((cells) => {
    return cells.length === width
  })
  const checks = [
    check('sheet-file', '表格文件', file !== undefined && rows.length >= 2, 'CSV 必须包含表头和至少一行数据'),
    check(
      'sheet-header',
      '列定义',
      width >= 2 && headers.every((cell) => cell.trim().length > 0),
      '至少两列且每列有名字',
    ),
    check('sheet-shape', '行列一致', rows.length > 0 && consistent, '每一行的列数必须与表头一致'),
  ]
  const numericColumns = headers
    .map((header, index) => {
      return { header: header.trim(), index }
    })
    .filter(({ header }) => {
      return /金额|数量|单价|总价|收入|支出/.test(header)
    })
  if (numericColumns.length > 0 && rows.length > 1) {
    const numeric = rows.slice(1).every((cells) => {
      return numericColumns.every(({ index }) => {
        const value = (cells[index] ?? '').replace(/[￥¥,\s]/g, '')
        return value.length > 0 && Number.isFinite(Number(value))
      })
    })
    checks.push(check('sheet-numbers', '数值可计算', numeric, '金额、数量等数值列必须是有效数字'))
  }
  return checks
}

export function validateVibeProject(project: VibeProject): VibeValidationReport {
  const checks =
    project.kind === 'app'
      ? validateApp(project)
      : project.kind === 'sheet'
        ? validateSheet(project)
        : validateDocument(project, project.kind === 'flow')
  const failed = checks.filter((item) => {
    return !item.ok
  })
  return {
    ok: failed.length === 0,
    kind: project.kind,
    checks,
    summary:
      failed.length === 0
        ? `通过 ${checks.length} 项交付验收`
        : failed
            .map((item) => {
              return `${item.label}：${item.detail}`
            })
            .join('；'),
    validatedAt: Date.now(),
  }
}
