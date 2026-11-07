/**
 * 文件系统技能来源：从磁盘上发现技能。
 *
 * 技能文件长这样（二选一）：
 * - 一个目录 `<root>/<name>/SKILL.md`；
 * - 一个平铺文件 `<root>/<name>.md`。
 *
 * 只看根目录的**第一层**：再往下的嵌套 `SKILL.md` 一律不认。理由是「哪一层算
 * 根」一旦放开就说不清了——一个技能目录里带个 `references/` 子目录是常事，
 * 递归下去迟早把别人的文件当成技能。
 *
 * 目录与正文是**两套生命周期**：发现时只解析 frontmatter 拿目录，每次加载正文
 * 都重新读文件。所以改了技能正文不用刷新目录，改了 frontmatter（名字、说明）
 * 才需要刷新。
 * @module @ryharness/skill/filesystem
 */

import { type Dirent, existsSync, type FSWatcher, readdirSync, readFileSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { describeSkillFailure } from './errors.ts'
import { frontmatterList, frontmatterText, parseFrontmatter } from './frontmatter.ts'
import type { Skill, SkillDiagnostic, SkillProvider, SkillSummary } from './types.ts'
import { SKILL_NAME_PATTERN } from './types.ts'

/** 目录型技能里的正文文件名。 */
export const SKILL_FILE_NAME = 'SKILL.md'

/**
 * 一个技能根目录。
 *
 * `label` 会写进技能的 source 字段——它是「这条技能从哪儿来」在人能看懂的层面
 * 的答案（项目里 / 用户目录 / 自定义目录）。
 */
export interface SkillRoot {
  /** 目录路径。 */
  readonly path: string
  /** 来源标签（写进 skill 的 source）。 */
  readonly label: string
  /** 优先级：数字小的赢。缺省 100。 */
  readonly priority?: number
}

/** 文件系统来源的配置。 */
export interface FileSystemSkillProviderOptions {
  /** 要扫的根目录。 */
  readonly roots: readonly SkillRoot[]
  /** provider 名（注册表里唯一）。缺省 `filesystem`。 */
  readonly providerName?: string
  /** provider 优先级。缺省 100。 */
  readonly priority?: number
}

/**
 * 按常见约定拼出默认的技能根目录。
 *
 * 顺序就是优先级：项目里的技能最该赢（它是**这个项目**的做法），自定义目录
 * 居中，`~/.agents/skills` 通用根其次（跨工具共享的全局技能），应用自带用户
 * 目录垫底（它是全局的，可能跟项目冲突）。
 * @param options - 项目目录、数据目录与自定义目录；homeDir 供测试注入主目录。
 * @returns 根目录列表（按优先级排好）。
 */
export function defaultSkillRoots(options: {
  readonly workspaceRoot?: string
  readonly dataDir?: string
  readonly customDirs?: readonly string[]
  /** 测试注入口：覆盖「用户主目录」（缺省用 os.homedir()）。 */
  readonly homeDir?: string
}): SkillRoot[] {
  const roots: SkillRoot[] = []
  if (options.workspaceRoot !== undefined) {
    roots.push({ path: join(options.workspaceRoot, '.skills'), label: 'project', priority: 100 })
  }
  for (const dir of options.customDirs ?? []) {
    roots.push({ path: dir, label: 'custom', priority: 200 })
  }
  // ~/.agents/skills 是跨工具的通用技能根（agents 生态的约定位置，kimicode 同款）：
  // 生态互通靠的就是大家都认这一个目录。只在目录真的存在时收进来——不存在的根
  // 没有可扫的东西，还省得白挂一个 watcher；用户后来建了目录，重启应用即生效。
  const universalRoot = join(options.homeDir ?? homedir(), '.agents', 'skills')
  if (existsSync(universalRoot)) {
    roots.push({ path: universalRoot, label: 'agents', priority: 250 })
  }
  if (options.dataDir !== undefined) {
    roots.push({ path: join(options.dataDir, 'skills'), label: 'user', priority: 300 })
  }
  return roots
}

/** 发现出来的一条技能：目录上的那几项，加上正文所在的文件。 */
interface DiscoveredSkill {
  readonly summary: SkillSummary
  /** 正文文件（每次加载都重读它）。 */
  readonly file: string
}

/**
 * 从磁盘发现技能的来源。
 *
 * 用法：`await provider.refresh()` 扫一遍，`provider.list()` 看目录，
 * `provider.resolve(name)` 取正文。
 */
export class FileSystemSkillProvider implements SkillProvider {
  /** provider 名。 */
  readonly name: string
  /** provider 优先级。 */
  readonly priority: number

  private readonly roots: readonly SkillRoot[]
  private discovered = new Map<string, DiscoveredSkill>()
  private diagnosticsList: SkillDiagnostic[] = []
  private scanned = false
  private readonly listeners = new Set<() => void>()
  private readonly watchers = new Map<string, FSWatcher>()
  private debounceMs = 150
  private debounceTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: FileSystemSkillProviderOptions) {
    this.name = options.providerName ?? 'filesystem'
    this.priority = options.priority ?? 100
    this.roots = [...options.roots].sort((a, b) => {
      return (a.priority ?? 100) - (b.priority ?? 100)
    })
  }

  /**
   * 目录（不含正文）。
   *
   * 第一次调用会先扫一遍；之后返回缓存，目录变了要靠 {@link refresh} 或监听器
   * 才会更新。
   * @returns 目录条目（按名字排好）。
   */
  async list(): Promise<readonly SkillSummary[]> {
    if (!this.scanned) await this.refresh()
    return [...this.discovered.values()].map((found) => found.summary).sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 取技能全文。
   *
   * 每次都重读文件：技能正文改了，不需要刷新目录就能取到新的。
   * @param name - 技能名。
   * @returns 技能全文；没有这个技能（或文件已经不在了）返回 undefined。
   */
  async resolve(name: string): Promise<Skill | undefined> {
    const found = this.discovered.get(name)
    if (found === undefined) return undefined
    let text: string
    try {
      text = readFileSync(found.file, 'utf8')
    } catch {
      return undefined
    }
    const parsed = parseFrontmatter(text)
    if (!parsed.hasFrontmatter) return undefined
    // 名字变了说明这一份已经不是同一个技能了，不能拿它冒充。
    if (frontmatterText(parsed.fields, 'name') !== name) return undefined
    return {
      name,
      title: frontmatterText(parsed.fields, 'title') ?? found.summary.title,
      description: frontmatterText(parsed.fields, 'description') ?? found.summary.description,
      source: found.summary.source,
      tags: frontmatterList(parsed.fields, 'tags') ?? found.summary.tags,
      content: parsed.body,
    }
  }

  /**
   * 重新扫一遍所有根目录。
   *
   * 目录变了（加了、删了、改了 frontmatter）之后调它，目录就更新了。
   * @returns 扫完之后的目录条目。
   */
  async refresh(): Promise<readonly SkillSummary[]> {
    const found = new Map<string, DiscoveredSkill>()
    const diagnostics: SkillDiagnostic[] = []
    for (const root of this.roots) {
      let entries: Dirent[]
      try {
        entries = readdirSync(root.path, { withFileTypes: true })
      } catch (error) {
        // 目录不存在是常态（用户还没建），不算故障；别的错要记下来。
        if (errorCode(error) !== 'ENOENT') {
          diagnostics.push({ path: root.path, reason: `目录读不了：${describeSkillFailure(error)}` })
        }
        continue
      }
      for (const entry of entries) {
        const full = join(root.path, entry.name)
        if (entry.isDirectory()) {
          const file = join(full, SKILL_FILE_NAME)
          if (!existsSync(file)) {
            diagnostics.push({ path: full, reason: `目录里没有 ${SKILL_FILE_NAME}` })
            continue
          }
          this.consider(found, diagnostics, file, entry.name, root)
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          this.consider(found, diagnostics, full, entry.name.slice(0, -'.md'.length), root)
        }
      }
    }
    this.discovered = found
    this.diagnosticsList = diagnostics
    this.scanned = true
    if (this.watchers.size > 0) this.syncWatchers()
    this.notify()
    return [...this.discovered.values()].map((item) => item.summary).sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 被跳过的候选与原因。
   *
   * 技能「不见了」最常见的原因是它自己写坏了（少一个字段、名字不合法），这个
   * 列表能让人一眼看出是哪一条、为什么。
   * @returns 诊断列表。
   */
  diagnostics(): readonly SkillDiagnostic[] {
    return this.diagnosticsList
  }

  /**
   * 订阅「目录变了」。
   * @param listener - 回调。
   * @returns 退订函数（重复调用是幂等的）。
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 开始盯着目录。
   *
   * 盯的是根目录与每个技能自己的目录（改 `SKILL.md` 要能看见）。变化会被合并
   * 成一次刷新——一次保存往往触发好几个事件，逐个刷新没意义。
   * @param options - 合并窗口（毫秒）。缺省 150。
   */
  startWatching(options: { readonly debounceMs?: number } = {}): void {
    this.debounceMs = options.debounceMs ?? 150
    this.syncWatchers()
  }

  /** 停止盯着目录（重复调用是幂等的）。 */
  stopWatching(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close()
    }
    this.watchers.clear()
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
  }

  /** 考察一个候选文件：合法就收进目录，不合法就记一条诊断。 */
  private consider(
    found: Map<string, DiscoveredSkill>,
    diagnostics: SkillDiagnostic[],
    file: string,
    entryName: string,
    root: SkillRoot,
  ): void {
    if (!SKILL_NAME_PATTERN.test(entryName)) {
      diagnostics.push({ path: file, reason: `名字不合法："${entryName}"` })
      return
    }
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      diagnostics.push({ path: file, reason: `文件读不了：${describeSkillFailure(error)}` })
      return
    }
    const parsed = parseFrontmatter(text)
    if (!parsed.hasFrontmatter) {
      diagnostics.push({ path: file, reason: '开头没有 frontmatter（--- 包起来的 yaml 头）' })
      return
    }
    const name = frontmatterText(parsed.fields, 'name')
    if (name === undefined || name.length === 0) {
      diagnostics.push({ path: file, reason: 'frontmatter 里没有 name' })
      return
    }
    if (!SKILL_NAME_PATTERN.test(name)) {
      diagnostics.push({ path: file, reason: `frontmatter 里的名字不合法："${name}"` })
      return
    }
    const description = frontmatterText(parsed.fields, 'description')
    if (description === undefined || description.length === 0) {
      diagnostics.push({ path: file, reason: 'frontmatter 里没有 description' })
      return
    }
    if (found.has(name)) {
      // 同一个 provider 内部：先扫到的根目录赢（根目录已按优先级排好）。
      diagnostics.push({ path: file, reason: `同名技能 "${name}"，优先级低的这一份被跳过` })
      return
    }
    found.set(name, {
      summary: {
        name,
        title: frontmatterText(parsed.fields, 'title') ?? name,
        description,
        source: root.label,
        tags: frontmatterList(parsed.fields, 'tags'),
      },
      file,
    })
  }

  /** 要盯的目录：根目录 + 每个技能自己的目录。 */
  private watchTargets(): string[] {
    const dirs = new Set<string>()
    for (const root of this.roots) dirs.add(root.path)
    for (const skill of this.discovered.values()) dirs.add(dirname(skill.file))
    return [...dirs]
  }

  /** 盯一个目录（已经盯着的不重复盯）。 */
  private watchDir(dir: string): void {
    if (this.watchers.has(dir)) return
    try {
      const watcher = watch(dir, () => {
        this.scheduleRefresh()
      })
      // 不占着事件循环：没人等这个监听器时，进程该走就走。
      watcher.unref()
      this.watchers.set(dir, watcher)
    } catch {
      // 目录不存在（还没建）就跳过，等它出现时靠 refresh 补上。
    }
  }

  /** 目录集合变了：补上新的监听，去掉已经不用的。 */
  private syncWatchers(): void {
    const targets = new Set(this.watchTargets())
    for (const [dir, watcher] of [...this.watchers]) {
      if (targets.has(dir)) continue
      watcher.close()
      this.watchers.delete(dir)
    }
    for (const dir of targets) this.watchDir(dir)
  }

  /** 把一串事件合并成一次刷新。 */
  private scheduleRefresh(): void {
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.refresh()
    }, this.debounceMs)
    this.debounceTimer.unref?.()
  }

  /** 通知订阅者。 */
  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // 订阅者自己的问题，不该让刷新失败。
      }
    }
  }
}

/** 从异常里取 errno 之类的机器码。 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}
