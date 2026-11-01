/**
 * 技能（skill）这一层的公共类型。
 *
 * 核心主张只有一条：**技能是按需加载的**。目录里只放「名字 + 一句话说明」，
 * 正文要等模型点名要了才给。把十几个技能正文一股脑塞进系统提示，是上下文最快
 * 烂掉的方式——模型既读不完，也分不清哪条适用。
 *
 * 所以这里的类型是**两层的**：{@link SkillSummary} 是目录（没有 content 字段，
 * 类型上就保证它进不了系统提示），{@link Skill} 才是全文。
 * @module @ryharness/skill/types
 */

/**
 * 合法的技能名：字母数字开头，后面可以跟字母数字、连字符、下划线。
 *
 * 为什么卡这么死：技能名要当命令用（`/name`）、要当文件路径的一部分用
 * （`<root>/<name>/SKILL.md`）、还要进模型的工具参数。名字里出现空格、斜杠
 * 或者中文，后面每一步都要为它开特例，不如一开始就不让进。
 */
export const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u

/**
 * 目录里的一条技能（**不含正文**）。
 *
 * 「不含正文」是类型层面的保证，不是约定：{@link SkillSummary} 里根本没有
 * content 字段，所以谁也不可能把正文顺手塞进目录。
 */
export interface SkillSummary {
  /** 技能名（唯一标识，模型按它调用）。 */
  readonly name: string
  /** 展示名。缺省时与 name 相同。 */
  readonly title: string
  /** 一句话说明：这套工作法管什么事。 */
  readonly description: string
  /** 来源标签：这条技能是谁提供的（根目录标签或 provider 名）。 */
  readonly source: string
  /** 标签（可选），给界面做筛选用。 */
  readonly tags?: readonly string[]
}

/** 一个技能的全文：目录上的那几项，加上正文。 */
export interface Skill extends SkillSummary {
  /** 正文：这套工作法本身（markdown）。 */
  readonly content: string
}

/**
 * 技能来源：谁提供这份技能。
 *
 * 注册表只认这个契约，不关心技能是从磁盘、远程服务还是内存里来的——所以换
 * 来源不需要换注册表。
 */
export interface SkillProvider {
  /** provider 名（全局唯一，重复注册会报错）。 */
  readonly name: string
  /** 优先级：数字小的赢。缺省 100。 */
  readonly priority?: number
  /** 列出目录（**不含正文**）。 */
  list(): Promise<readonly SkillSummary[]>
  /** 按名字取全文；取不到返回 undefined。 */
  resolve(name: string): Promise<Skill | undefined>
  /** 目录变了时通知订阅者（可选，没有就不通知）。 */
  onChange?(listener: () => void): () => void
}

/**
 * 发现期的一条诊断：某个候选为什么没进目录。
 *
 * 为什么要留着它：被跳过的技能如果只是「悄悄不见了」，作者会以为是自己写错了
 * 名字。给出原因，他才知道是 frontmatter 少写了一个字段。
 */
export interface SkillDiagnostic {
  /** 出问题的文件或目录路径。 */
  readonly path: string
  /** 为什么被跳过（一句中文）。 */
  readonly reason: string
}

/** 一次名字冲突：同名技能里谁赢了、谁被盖住了。 */
export interface SkillConflict {
  /** 撞车的技能名。 */
  readonly name: string
  /** 赢的那一路（来源标签）。 */
  readonly winner: string
  /** 被盖住的那一路（来源标签）。 */
  readonly loser: string
}

/** 一次来源故障：某个 provider 的目录没取到。 */
export interface SkillProviderFailure {
  /** 出问题的 provider 名。 */
  readonly provider: string
  /** 原因（一句中文）。 */
  readonly reason: string
}
