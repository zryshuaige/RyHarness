/**
 * 预设注册表与版本管理。
 *
 * 两条规矩：
 * - **名字唯一**：两个预设抢同一个 id，用户选到哪个就说不清了。
 * - **版本单调递增**：改一次就是新的一版，旧版留着——「它刚才是什么样」要能回看，
 *   出问题时才查得动。
 * @module @ryharness/preset/registry
 */

import { type AgentPreset, PresetError, type PresetRevision } from './types.ts'

/** 预设 id 的形状。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/u

/** 预设注册表：登记预设、管每位助理选中的版本。 */
export class PresetRegistry {
  private readonly presets = new Map<string, AgentPreset>()
  /** 助理 id → 它的各版本（按版本号排）。 */
  private readonly revisions = new Map<string, PresetRevision[]>()

  /**
   * 登记一份预设。
   * @param preset - 预设。
   */
  register(preset: AgentPreset): void {
    if (!ID_PATTERN.test(preset.id)) {
      throw new PresetError('invalid-id', `预设 id 不合法：${preset.id}`)
    }
    if (this.presets.has(preset.id)) {
      throw new PresetError('duplicate-id', `预设 "${preset.id}" 已经登记过了`)
    }
    this.presets.set(preset.id, preset)
  }

  /** 已登记的预设（按 id 排）。 */
  list(): AgentPreset[] {
    return [...this.presets.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  /** 按 id 取一份预设。 */
  get(id: string): AgentPreset | undefined {
    return this.presets.get(id)
  }

  /**
   * 给某位助理选定一份预设，产生**新的一版**。
   * @param agentId - 助理 id。
   * @param presetId - 预设 id。
   * @returns 新的一版。
   */
  select(agentId: string, presetId: string): PresetRevision {
    const preset = this.presets.get(presetId)
    if (preset === undefined) {
      throw new PresetError('not-found', `没有这个预设：${presetId}`)
    }
    const history = this.revisions.get(agentId) ?? []
    const revision: PresetRevision = {
      agentId,
      revision: (history.at(-1)?.revision ?? 0) + 1,
      presetId,
      tools: [...preset.tools],
      ...(preset.prompt === undefined ? {} : { prompt: preset.prompt }),
      ...(preset.skills === undefined ? {} : { skills: [...preset.skills] }),
    }
    history.push(revision)
    this.revisions.set(agentId, history)
    return revision
  }

  /**
   * 这位助理当前选中的那一版。
   * @param agentId - 助理 id。
   * @returns 当前版本；没选过是 undefined。
   */
  current(agentId: string): PresetRevision | undefined {
    const history = this.revisions.get(agentId)
    return history?.at(-1)
  }

  /**
   * 这位助理的各版本（按版本号排）。
   * @param agentId - 助理 id。
   * @returns 版本列表。
   */
  revisionsOf(agentId: string): PresetRevision[] {
    return [...(this.revisions.get(agentId) ?? [])]
  }

  /**
   * 取某个历史版本。
   * @param agentId - 助理 id。
   * @param revision - 版本号。
   * @returns 那一版；没有是 undefined。
   */
  revision(agentId: string, revision: number): PresetRevision | undefined {
    return this.revisions.get(agentId)?.find((entry) => entry.revision === revision)
  }

  /**
   * 这位助理此刻生效的能力集合（工具名 + 提示 + 技能）。
   *
   * 没选过预设就说「没选」——不能默默给一份空的能力，那等于把助理的本事悄悄清零。
   * @param agentId - 助理 id。
   * @returns 生效的能力。
   */
  effective(agentId: string): { tools: readonly string[]; prompt?: string; skills?: readonly string[] } {
    const current = this.current(agentId)
    if (current === undefined) {
      throw new PresetError('no-selection', `这位助理还没有选能力预设`)
    }
    return {
      tools: current.tools,
      ...(current.prompt === undefined ? {} : { prompt: current.prompt }),
      ...(current.skills === undefined ? {} : { skills: current.skills }),
    }
  }
}
