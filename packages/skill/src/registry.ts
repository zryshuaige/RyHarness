/**
 * 技能注册表：把多个来源的技能目录合成一份，并按名字取全文。
 *
 * 分工只有一条：**来源管「从哪儿来」，注册表管「合起来是什么样子」**。
 * 注册表不读技能正文，只校验名字、说明这些语义字段；正文要等 resolve 才去取。
 *
 * 同名怎么办（这条必须是明规则，不能靠运气）：
 * - 内嵌技能（{@link SkillRegistry.register} 进来的）优先级最高；
 * - 其余按 provider 的 `priority` 比，数字小的赢；
 * - priority 相同则**先注册的 provider 赢**（排序稳定，先来后到）。
 *
 * 输掉的那一路不会消失，它进 {@link SkillRegistry.conflicts}——界面上能看见
 * 「有个技能被盖住了」，作者不用猜。
 * @module @ryharness/skill/registry
 */

import { describeSkillFailure, SkillError } from './errors.ts'
import type { Skill, SkillConflict, SkillProvider, SkillProviderFailure, SkillSummary } from './types.ts'
import { SKILL_NAME_PATTERN } from './types.ts'

/** 内嵌技能的来源标签（上游把运行时注册的那一路叫 runtime）。 */
export const RUNTIME_SOURCE = 'runtime'

/** provider 没声明优先级时用的默认值。 */
const DEFAULT_PRIORITY = 100

/** 一个候选：目录上的那几项，加上「怎么把正文取回来」。 */
interface Candidate {
  readonly summary: SkillSummary
  readonly load: () => Promise<Skill | undefined>
}

/**
 * 技能注册表。
 *
 * 用法：先 `registerProvider(...)` 把来源挂上，再 `list()` 看目录、
 * `resolve(name)` 取正文。
 */
export class SkillRegistry {
  private readonly providers = new Map<string, SkillProvider>()
  private readonly embedded = new Map<string, Skill>()
  private readonly listeners = new Set<() => void>()
  private readonly providerUnsubscribes = new Map<string, () => void>()
  /** 最近一次合并时发生的冲突。 */
  private mergeConflicts: SkillConflict[] = []
  /** 注册内嵌技能时发生的冲突（不会被下一次合并冲掉）。 */
  private readonly embeddedConflicts: SkillConflict[] = []
  /** 最近一次合并时取不到目录的 provider。 */
  private providerFailures: SkillProviderFailure[] = []
  /** 最近一次 {@link list} 的目录快照（同步可读，给工具说明用）。 */
  private catalogSnapshot: readonly SkillSummary[] = []

  /**
   * 挂一个技能来源。
   *
   * provider 名必须唯一：两个同名来源会让「这条技能从哪儿来」说不清，所以直接
   * 报错，不做静默替换。
   * @param provider - 来源实现。
   * @returns 注销函数（重复调用是幂等的）。
   */
  registerProvider(provider: SkillProvider): () => void {
    const name = provider.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new SkillError('invalid-name', 'provider 必须有名字')
    }
    if (this.providers.has(name)) {
      throw new SkillError('duplicate-name', `provider "${name}" 已经注册过了`)
    }
    this.providers.set(name, provider)
    const unsubscribe = provider.onChange?.(() => {
      this.notify()
    })
    if (unsubscribe !== undefined) this.providerUnsubscribes.set(name, unsubscribe)
    this.notify()
    return () => {
      // 只在还挂着的时候拆：重复注销是安全的，拆错了别人的 provider 不是。
      if (!this.providers.has(name)) return
      this.providers.delete(name)
      const off = this.providerUnsubscribes.get(name)
      if (off !== undefined) {
        off()
        this.providerUnsubscribes.delete(name)
      }
      this.notify()
    }
  }

  /**
   * 注册一条内嵌技能（直接给正文的那种）。
   *
   * 同名时**先登记的赢**：后来那条不覆盖，只记进 {@link conflicts}。
   * @param skill - 技能内容。
   */
  register(skill: Skill): void {
    if (typeof skill.name !== 'string' || !SKILL_NAME_PATTERN.test(skill.name)) {
      throw new SkillError('invalid-name', `技能名字不合法："${String(skill.name)}"`)
    }
    if (typeof skill.description !== 'string' || skill.description.length === 0) {
      throw new SkillError('invalid-skill', `技能 "${skill.name}" 缺说明`)
    }
    if (this.embedded.has(skill.name)) {
      this.embeddedConflicts.push({
        name: skill.name,
        winner: RUNTIME_SOURCE,
        loser: skill.source,
      })
      return
    }
    this.embedded.set(skill.name, { ...skill, source: RUNTIME_SOURCE })
    this.notify()
  }

  /**
   * 合并后的目录（**不含正文**），按名字排好。
   *
   * 这一条是整个包的中心：模型看到的是这份短列表，正文要它点名才给。
   * @returns 目录条目。
   */
  async list(): Promise<readonly SkillSummary[]> {
    const candidates = await this.collect()
    this.catalogSnapshot = [...candidates.values()]
      .map((candidate) => candidate.summary)
      .sort((a, b) => a.name.localeCompare(b.name))
    return this.catalogSnapshot
  }

  /**
   * 最近一次 {@link list} 的目录快照（同步可读）。
   *
   * 给「工具说明里要带目录」这种**不能 await** 的场合用：先 list 一次填上，
   * 之后目录变了再 list 一次刷新。
   */
  get catalog(): readonly SkillSummary[] {
    return this.catalogSnapshot
  }

  /**
   * 按名字取技能全文。
   *
   * 找不到是要报错的，不是返回空：那两种情况给模型的答复完全不同（「你写错名字了」
   * 与「这个技能现在没有」），混成一句会让它反复重试同一个名字。
   * @param name - 技能名。
   * @returns 技能全文。
   */
  async resolve(name: string): Promise<Skill> {
    if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
      throw new SkillError('invalid-name', `技能名字不合法："${String(name)}"`)
    }
    const candidates = await this.collect()
    const winner = candidates.get(name)
    if (winner === undefined) {
      throw new SkillError('not-found', `没有这个技能："${name}"`)
    }
    const skill = await winner.load()
    if (skill === undefined) {
      throw new SkillError('not-found', `技能正文取不到："${name}"`)
    }
    // 名字对不上说明磁盘上的东西在「发现」与「加载」之间变了：这一份不是他要的。
    if (skill.name !== name) {
      throw new SkillError('invalid-skill', `技能内容与名字对不上："${name}"`)
    }
    return skill
  }

  /**
   * 订阅「目录变了」。
   *
   * 来源自己发现变化时调它，订阅者据此刷新界面或提示词里的目录。
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
   * 名字冲突记录：同名技能里谁赢了、谁被盖住了。
   *
   * 覆盖两种：provider 之间撞名，以及内嵌技能与 provider 撞名。
   * @returns 冲突列表（没有冲突时是空数组）。
   */
  conflicts(): readonly SkillConflict[] {
    return [...this.mergeConflicts, ...this.embeddedConflicts]
  }

  /**
   * 取不到目录的 provider。
   *
   * 一个来源坏了不该拖垮整份目录，所以坏的那个被跳过，这里记一笔。
   * @returns 故障列表（没有故障时是空数组）。
   */
  failures(): readonly SkillProviderFailure[] {
    return this.providerFailures
  }

  /** 收集各来源的候选，按优先级合并。 */
  private async collect(): Promise<Map<string, Candidate>> {
    const candidates = new Map<string, Candidate>()
    const conflicts: SkillConflict[] = []
    const failures: SkillProviderFailure[] = []

    // 内嵌技能优先级最高：它是程序明确塞进来的，不该被磁盘上的同名文件盖住。
    for (const [name, skill] of this.embedded) {
      candidates.set(name, { summary: toSummary(skill), load: async () => skill })
    }

    for (const provider of this.sortedProviders()) {
      let summaries: readonly SkillSummary[]
      try {
        summaries = await provider.list()
      } catch (error) {
        failures.push({ provider: provider.name, reason: describeSkillFailure(error) })
        continue
      }
      for (const summary of summaries) {
        const existing = candidates.get(summary.name)
        if (existing !== undefined) {
          conflicts.push({
            name: summary.name,
            winner: existing.summary.source,
            loser: summary.source,
          })
          continue
        }
        candidates.set(summary.name, {
          summary,
          load: async () => provider.resolve(summary.name),
        })
      }
    }

    this.mergeConflicts = conflicts
    this.providerFailures = failures
    return candidates
  }

  /** provider 按优先级排好；优先级相同按注册先后（排序是稳定的）。 */
  private sortedProviders(): SkillProvider[] {
    return [...this.providers.values()].sort((a, b) => {
      return (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY)
    })
  }

  /** 通知订阅者；一个订阅者出错不该带倒 others。 */
  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // 订阅者自己的问题，不该让目录刷新失败。
      }
    }
  }
}

/** 技能 → 目录条目（去掉正文）。 */
function toSummary(skill: Skill): SkillSummary {
  return {
    name: skill.name,
    title: skill.title,
    description: skill.description,
    source: skill.source,
    tags: skill.tags,
  }
}
