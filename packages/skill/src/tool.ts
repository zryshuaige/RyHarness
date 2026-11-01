/**
 * 给模型用的 `skill` 工具：按名字把技能正文取回来。
 *
 * 这一族的核心就在**模型看到的是目录，不是全部正文**。工具说明里带一份短列表
 * （名字 + 一句话说明），模型觉得哪条对味，就按名字调工具把那一条的正文取回来。
 *
 * 为什么目录会一直在工具说明里：目录是拼在工具说明上的，而工具说明每轮请求
 * 都会重新读一遍（见 `packages/agent` 的循环）。所以目录一变，模型下一轮看到
 * 的就是新的那份，不用重建工具。
 * @module @ryharness/skill/tool
 */

import type { Tool } from '@ryharness/agent'
import { describeSkillFailure, SkillError } from './errors.ts'
import type { SkillRegistry } from './registry.ts'
import type { Skill, SkillSummary } from './types.ts'

/** 工具名。 */
export const SKILL_TOOL_NAME = 'skill'

/** 工具说明的固定部分（目录是另外拼上去的）。 */
const TOOL_DESCRIPTION = [
  '按名字取一个技能（可复用的工作法）的完整正文。',
  '先看下面这份目录判断该用哪一条，再按名字调用；目录里只有名字和说明，正文要真的取回来才算数。',
  '一次只取确实要用的那几条，取回来之后按它说的做。',
].join('\n')

/** 技能工具的配置。 */
export interface SkillToolOptions {
  /** 技能注册表：目录与正文都从它拿。 */
  readonly registry: SkillRegistry
}

/**
 * 把目录渲染成一段能贴进工具说明的文本。
 * @param summaries - 目录条目。
 * @returns 一段 markdown；没有技能时是一句话说明。
 */
export function renderSkillCatalog(summaries: readonly SkillSummary[]): string {
  if (summaries.length === 0) return '当前没有可用技能。'
  const lines = summaries.map((summary) => {
    return `- \`${summary.name}\`：${summary.description}`
  })
  return ['可用技能（这里只有名字和说明，正文要用 skill 工具按名字取）：', ...lines].join('\n')
}

/**
 * 把技能正文渲染成模型看到的形状。
 *
 * 套一层 `<skill_content>` 是为了让模型知道「这段是技能正文，不是用户说的话」。
 * @param skill - 技能。
 * @returns 一段 markdown。
 */
export function renderSkillContent(skill: Skill): string {
  return [
    `<skill_content name="${skill.name}">`,
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

/**
 * 造 `skill` 工具。
 *
 * 工具说明里的目录取自注册表的缓存快照，所以注册表要先 list 一次（插件启动时
 * 会做），目录变化后也要再 list 一次。
 * @param options - 工具配置。
 * @returns 可注册到工具表里的工具。
 */
export function createSkillTool(options: SkillToolOptions): Tool {
  return {
    name: SKILL_TOOL_NAME,
    get description(): string {
      return `${TOOL_DESCRIPTION}\n\n${renderSkillCatalog(options.registry.catalog)}`
    },
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '技能名（工具说明里列出的那个名字，一字不差）',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    execute: async (args: unknown) => {
      const name = readName(args)
      if (name === undefined) {
        return { content: 'Error: 缺少参数 name（技能名）', isError: true }
      }
      try {
        const skill = await options.registry.resolve(name)
        return { content: renderSkillContent(skill) }
      } catch (error) {
        const message = error instanceof SkillError ? error.message : describeSkillFailure(error)
        return { content: `Error: ${message}`, isError: true }
      }
    },
  }
}

/** 从工具参数里取出技能名；不是字符串就返回 undefined。 */
function readName(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || !('name' in args)) return undefined
  const name = args.name
  return typeof name === 'string' ? name : undefined
}
