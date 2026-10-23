/**
 * RyVibe 的产物落盘：把一份方案变成一个**能打开的项目骨架**。
 *
 * 为什么要有这一步：「一句话做出完整产品」如果只产出一段 Markdown，用户手上拿到的
 * 还是一段**描述**，不是东西：点不开、没法接着改、也没有下一步该做什么的清单。
 * 所以 RyVibe 的终点不是一段文字，而是工作区里的一个目录：
 *
 * ```text
 * projects/<项目名>/
 *   README.md    项目是什么、怎么跑起来、做到什么算完成
 *   PLAN.md      完整方案（目标用户、功能清单、技术方案、里程碑）
 *   TODO.md      任务清单（每条一个勾选框）
 *   index.html   首个能打开的页面
 * ```
 *
 * 目录名由项目名推导，但**只允许安全字符**：项目名来自模型，而模型可能把
 * `../../etc` 当成项目名。路径最后还要经 resolveInWorkspace 过一遍，逃不出工作区。
 * @module @ryharness/server/vibe/project
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { resolveInWorkspace } from '@ryharness/tools'

/** 项目统一落在工作区下的这个子目录里。 */
export const PROJECTS_DIR = 'projects'

/** 项目名的字数上限：它要当目录名，太长在 Windows 上会截断路径。 */
export const MAX_PROJECT_NAME_LENGTH = 60
/** 一句话说明的字数上限。 */
export const MAX_PROJECT_SUMMARY_LENGTH = 300
/** 任务条数的上下限：一条是清单，两条是凑数，十几条就是需求说明书。 */
export const MIN_PROJECT_TASKS = 1
export const MAX_PROJECT_TASKS = 12
/** 单条任务的字数上限。 */
export const MAX_PROJECT_TASK_LENGTH = 120

/** 落盘后的一个文件。 */
export interface VibeProjectFile {
  /** 文件名（如 README.md）。 */
  name: string
  /** 绝对路径。 */
  path: string
  size: number
}

/** 一次落盘的项目骨架。 */
export interface VibeProject {
  /** 项目名（人类可读，页面上显示的就是它）。 */
  name: string
  /** 目录名（slug）。 */
  slug: string
  /**
   * 产物形态。
   *
   * 落库而不只是存在当次响应里：页面要说得清「这是个软件还是一张表」，重落盘也要
   * 知道上一形态是什么、该清掉哪些残留。
   */
  kind: DeliverableKind
  /** 项目目录的绝对路径。 */
  dir: string
  /** 写出去的文件。 */
  files: VibeProjectFile[]
  createdAt: number
}

/** 产物形态：用户到底要个什么东西。 */
export type DeliverableKind = 'app' | 'doc' | 'sheet' | 'flow'

/** 允许的形态（入参校验用）。 */
export const DELIVERABLE_KINDS: readonly DeliverableKind[] = ['app', 'doc', 'sheet', 'flow']

/**
 * 各形态的默认交付物文件名（不含扩展名）。
 *
 * 只有非 app 形态有「交付物」这个角色——app 形态的交付物就是那个 HTML 页面，名字固定
 * 成 `index.html`。
 */
const DEFAULT_ARTIFACT_NAME: Record<Exclude<DeliverableKind, 'app'>, string> = {
  doc: '交付物',
  sheet: '清单',
  flow: '流程',
}

/** 落盘要什么。 */
export interface ScaffoldInput {
  /** 工作区根目录（绝对路径）。 */
  workspaceRoot: string
  /** 项目名。 */
  name: string
  /** 一句话说明：这个东西做什么。 */
  summary: string
  /** 任务清单。 */
  tasks: readonly string[]
  /**
   * 产物形态。
   *
   * 此前只有一种（app），于是「帮我写封邮件」也会被落成一个软件项目骨架——那不是
   * 用户要的东西。四个形态对应四种真实诉求：
   * - `app`：一个能打开的小程序（网页 / 桌面）。
   * - `doc`：一份文档（方案、报告、邮件、说明）。
   * - `sheet`：一张表或一份清单。
   * - `flow`：一个以后每次照着做的流程。
   */
  deliverable?: DeliverableKind
  /** 交付物的文件名（不含扩展名）。缺省按形态给一个默认名。 */
  artifactName?: string
  /** 交付物正文（doc / flow 是 markdown，sheet 是 CSV）。缺省给一份骨架。 */
  content?: string
  /** README 正文；不给就按形态自动生成一份。 */
  readme?: string
  /** 完整方案正文（Markdown）；不给就写一份最小的。 */
  plan?: string
  /** 首个页面的 HTML；不给就按 summary 与任务清单生成一个能打开的骨架页。 */
  page?: string
}

/**
 * Windows 的保留设备名：CON、PRN、NUL、COM1… 用它们当目录名会建不出目录。
 * 命中就加个前缀，而不是报错——项目名是模型给的，用户不该为一个词看到一句失败。
 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * 项目名 → 目录名。
 *
 * 规则：路径分隔符与 Windows 非法字符换成空格 → 空白折叠成 `-` → 掐头去尾的点
 * （`.` 与 `..` 会在这一步消失）→ 限长 40。剩下的中文照原样保留：目录名给用户看的，
 * 把它转成拼音或哈希只会让用户在文件管理器里认不出自己的项目。
 */
export function slugOf(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 40)
    .replace(/[.\s]+$/g, '')
  if (cleaned.length === 0) return 'project'
  return RESERVED_NAMES.test(cleaned) ? `项目-${cleaned}` : cleaned
}

/** HTML 转义：生成页面时要把模型给的文字放进去，不转义就是让模型注入脚本。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 任务清单 → README 里的勾选块。 */
function taskLines(tasks: readonly string[]): string {
  return tasks
    .map((task, index) => {
      return `- [ ] ${index + 1}. ${task}`
    })
    .join('\n')
}

/**
 * README 正文。
 *
 * 按形态换内容：app 讲「怎么跑起来」，文档讲「这份东西给谁看、怎么用」，表讲
 * 「口径是什么」，流程讲「什么时候触发、谁来接手」。一份 README 说错形态的话，
 * 用户打开目录第一眼就觉得"这不是我要的"。
 */
export function renderReadme(input: ScaffoldInput): string {
  if (input.readme !== undefined && input.readme.trim().length > 0) {
    return input.readme.trim()
  }
  const kind = input.deliverable ?? 'app'
  const head = [`# ${input.name.trim()}`, '', input.summary.trim(), '']
  if (kind === 'app') {
    return [
      ...head,
      '## 怎么跑起来',
      '',
      '双击 `index.html` 就能看到首个页面。它不依赖任何构建步骤，也不需要联网。',
      '',
      '## 做到什么算完成',
      '',
      taskLines(input.tasks),
      '',
      '## 这个目录里有什么',
      '',
      '- `README.md` —— 这个文件',
      '- `PLAN.md` —— 完整方案（目标用户、功能清单、技术方案、里程碑）',
      '- `TODO.md` —— 任务清单，逐条打勾',
      '- `index.html` —— 首个能打开的页面',
    ].join('\n')
  }
  const artifact = artifactFileName(input, kind)
  const what =
    kind === 'doc'
      ? ['## 这份东西给谁看', '', '读者是谁、他在什么场合看、看完要做什么决定。', '']
      : kind === 'sheet'
        ? ['## 口径', '', '每一列是什么、从哪来、什么时候更新。空着的列不要留。', '']
        : ['## 什么时候走这个流程', '', '触发条件、每一步谁做、交给谁。', '']
  return [
    ...head,
    ...what,
    '## 做到什么算完成',
    '',
    taskLines(input.tasks),
    '',
    '## 这个目录里有什么',
    '',
    '- `README.md` —— 这个文件',
    `- \`${artifact}\` —— ${kind === 'sheet' ? '数据表' : kind === 'flow' ? '流程' : '正文'}`,
    '- `TODO.md` —— 任务清单，逐条打勾',
  ].join('\n')
}

/** 交付物的文件名（含扩展名）。 */
function artifactFileName(input: ScaffoldInput, kind: Exclude<DeliverableKind, 'app'>): string {
  const base = input.artifactName?.trim() ?? ''
  const cleaned = base.replace(/[\\/:*?"<>|]/gu, '').trim()
  const name = cleaned.length === 0 ? DEFAULT_ARTIFACT_NAME[kind] : cleaned
  return kind === 'sheet' ? `${name}.csv` : `${name}.md`
}

/**
 * 交付物正文（doc / sheet / flow）。
 *
 * 模型给了就用它给的（那才是用户要的东西）；没给就给一份**该形态的骨架**——
 * 文档骨架是章节，表骨架是列，流程骨架是步骤。宁可给一个能接着填的空架子，
 * 也不给一份别的形态的东西。
 */
export function renderArtifact(input: ScaffoldInput, kind: DeliverableKind): string {
  const content = input.content?.trim() ?? ''
  if (content.length > 0) return content
  const title = input.name.trim()
  const summary = input.summary.trim()
  if (kind === 'doc') {
    return [`# ${title}`, '', summary, '', '## 背景', '', '## 要点', '', '## 下一步', ''].join('\n')
  }
  if (kind === 'sheet') {
    return ['名称,数量,备注', `${title},,${summary}`].join('\n')
  }
  return [`# ${title}`, '', summary, '', '## 步骤', '', '1. ', '2. ', '3. ', '', '## 谁接下一步', ''].join('\n')
}

/** 任务清单文件。 */
export function renderTodo(input: ScaffoldInput): string {
  return [
    `# ${input.name.trim()} · 任务清单`,
    '',
    taskLines(input.tasks),
    '',
    '> 这份清单同时进了 RyHarness 的待办：在聊天页右侧能勾。',
  ].join('\n')
}

/** 方案文件：模型给了就用它给的。 */
export function renderPlan(input: ScaffoldInput): string {
  if (input.plan !== undefined && input.plan.trim().length > 0) {
    return input.plan.trim()
  }
  return [
    `# ${input.name.trim()} · 方案`,
    '',
    input.summary.trim(),
    '',
    '## 第一版要做的事',
    '',
    taskLines(input.tasks),
  ].join('\n')
}

/**
 * 首个页面。
 *
 * 模型给了 HTML 就用它的（那才是"这个产品的样子"）；没给就生成一个能打开的骨架页：
 * 标题、一句话说明、任务清单。**不联网、不引第三方**——用户双击就能看到东西，
 * 是"方案变成了产品"这件事最直接的证据。
 */
export function renderPage(input: ScaffoldInput): string {
  if (input.page !== undefined && input.page.trim().length > 0) {
    return input.page
  }
  const title = escapeHtml(input.name.trim())
  const summary = escapeHtml(input.summary.trim())
  const items = input.tasks
    .map((task, index) => {
      return `<li><span class="n">${index + 1}</span>${escapeHtml(task)}</li>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; padding: 48px 24px;
    background: #FAF7F2; color: #292524;
    font: 15px/1.7 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  main { max-width: 720px; margin: 0 auto; }
  h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: -.01em; }
  p.lead { margin: 0 0 32px; color: #736B65; }
  h2 { margin: 32px 0 12px; font-size: 15px; color: #736B65; font-weight: 600; }
  ul { margin: 0; padding: 0; list-style: none; border-top: 1px solid rgba(41,37,36,.10); }
  li { display: flex; gap: 12px; align-items: baseline; padding: 12px 2px; border-bottom: 1px solid rgba(41,37,36,.10); }
  .n {
    flex: none; width: 22px; height: 22px; border-radius: 999px;
    background: #F59E0B; color: #3D2E12; font-size: 12px; font-weight: 700;
    display: inline-flex; align-items: center; justify-content: center;
  }
  footer { margin-top: 40px; color: #6B635C; font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p class="lead">${summary}</p>
  <h2>第一版要做的事</h2>
  <ul>
${items}
  </ul>
  <footer>由 RyHarness 的 RyVibe 生成 · 任务清单见 TODO.md</footer>
</main>
</body>
</html>
`
}

/**
 * 把项目骨架落进工作区。
 *
 * 文件清单**按产物形态走**：用户要一张表，就不该在目录里看见 `index.html` 与
 * `PLAN.md`；要一份邮件，就不该落成一堆代码骨架。
 *
 * 同一项目重复落盘会覆盖同名目录里的同名文件：RyVibe 的重试与「改一版再来」
 * 走的都是这条路，覆盖正是想要的行为（不该每次都留一份 `记账工具-2`）。
 *
 * **换形态重落盘时会清掉上一形态的残留**：同一个项目名先落成 app、再落成 sheet，
 * 目录里不该同时躺着 `index.html`（上一形态的）与 `开支表.csv`（这一形态的）——
 * 界面上只列本次的文件，用户打开文件夹看到多出来的两个，只会觉得落盘坏了。
 */
export function scaffoldProject(input: ScaffoldInput): VibeProject {
  const slug = slugOf(input.name)
  const dir = resolveInWorkspace(input.workspaceRoot, join(PROJECTS_DIR, slug))
  mkdirSync(dir, { recursive: true })
  const kind = input.deliverable ?? 'app'
  const documents: { name: string; content: string }[] =
    kind === 'app'
      ? [
          { name: 'README.md', content: renderReadme(input) },
          { name: 'PLAN.md', content: renderPlan(input) },
          { name: 'TODO.md', content: renderTodo(input) },
          { name: 'index.html', content: renderPage(input) },
        ]
      : [
          { name: 'README.md', content: renderReadme(input) },
          { name: 'TODO.md', content: renderTodo(input) },
          { name: artifactFileName(input, kind), content: renderArtifact(input, kind) },
        ]
  removeStaleArtifacts(
    dir,
    documents.map((document) => document.name),
  )
  const files: VibeProjectFile[] = []
  for (const document of documents) {
    const path = join(dir, document.name)
    writeFileSync(path, document.content, 'utf8')
    files.push({ name: document.name, path, size: statSync(path).size })
  }
  return {
    name: input.name.trim(),
    slug,
    kind,
    dir,
    files,
    createdAt: Date.now(),
  }
}

/**
 * 清掉上一形态留下的文件。
 *
 * 只删**本次不产出、且是我们自己会产出的那类文件**（.md / .csv / .html）：
 * - 限定在项目目录的**直接子文件**：用户自己放进去的东西不碰。
 * - 限定扩展名：源码、图片、数据文件一律不碰。
 * - 删失败只记一笔：清理是锦上添花，删不掉不该让整轮落盘失败。
 */
function removeStaleArtifacts(dir: string, keep: readonly string[]): void {
  const kept = new Set(keep)
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (kept.has(entry)) continue
    const ext = extname(entry).toLowerCase()
    if (ext !== '.md' && ext !== '.csv' && ext !== '.html') continue
    try {
      const full = join(dir, entry)
      if (!statSync(full).isFile()) continue
      rmSync(full, { force: true })
    } catch {
      // 删不掉就留着：下一次落盘会覆盖同名文件，残留顶多是多一个文件。
    }
  }
}
