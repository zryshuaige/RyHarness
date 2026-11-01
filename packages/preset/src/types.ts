/**
 * 助理能力预设：一份「这位助理能用什么」的命名说法。
 *
 * 上游（`agent-preset`）的口径是：**用普通的配置声明能力**，并管着**选择与版本**——
 * 宿主共用同一个 Agent 循环，但每位助理看到的是它**选中那一版**的工具、提示与技能。
 *
 * 我们照这个口径做：
 * - 预设 = `{ id, name, description, tools, prompt?, skills? }`；
 * - 选中预设 = 给这位助理**定一版**（revision），版本号单调递增；
 * - 换预设 = 再定一版；旧版保留（能回看「它刚才是什么样」）。
 * @module @ryharness/preset/types
 */

/** 一份能力预设。 */
export interface AgentPreset {
  /** 稳定 id。 */
  readonly id: string
  /** 给人看的名字。 */
  readonly name: string
  /** 一句话说明这份预设给这位助理什么能力。 */
  readonly description: string
  /** 这一版放开的工具名。 */
  readonly tools: readonly string[]
  /** 追加到系统提示的一段（可省）。 */
  readonly prompt?: string
  /** 这一版带的技能名（可省）。 */
  readonly skills?: readonly string[]
}

/** 某位助理选中的某一版。 */
export interface PresetRevision {
  /** 这位助理的 id。 */
  readonly agentId: string
  /** 版本号：每次改都 +1，从 1 起。 */
  readonly revision: number
  /** 选中的预设 id。 */
  readonly presetId: string
  /** 这一版的工具名。 */
  readonly tools: readonly string[]
  /** 这一版追加的提示。 */
  readonly prompt?: string
  /** 这一版带的技能。 */
  readonly skills?: readonly string[]
}

/** 预设相关失败的原因码。 */
export type PresetErrorCode = 'invalid-id' | 'duplicate-id' | 'not-found' | 'no-selection'

/** 预设相关失败：带机器码与一句人话。 */
export class PresetError extends Error {
  constructor(
    readonly code: PresetErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PresetError'
  }
}
