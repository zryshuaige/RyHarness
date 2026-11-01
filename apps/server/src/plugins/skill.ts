/**
 * 内置插件：技能目录与 `skill` 工具。
 *
 * 技能是**可复用的工作法**（怎么审一份稿子、怎么写周报）。助理先看到一份短目录
 * （名字 + 一句话说明），觉得哪条对味，就调 `skill` 工具把那条的正文取回来。
 *
 * 技能从哪儿来：项目里的 `<workspaceRoot>/.skills/`、用户目录的
 * `<dataDir>/skills/`、以及配置里给的自定义目录。目录变了会被盯上，改完不用
 * 重启就能被发现。
 *
 * 本插件只做「发现 + 取用」，不提供技能内容——内容是用户或别的插件写进去的。
 * @module @ryharness/server/plugins/skill
 */

import type { Context } from '@ryharness/cordis'
import {
  createSkillTool,
  defaultSkillRoots,
  FileSystemSkillProvider,
  SKILL_TOOL_NAME,
  SkillRegistry,
} from '@ryharness/skill'
import type { PluginEntry } from './host.ts'

export const SKILL_PLUGIN_ID = 'skill'

/** 技能插件的依赖。 */
export interface SkillPluginOptions {
  /** 工作区根目录：项目技能目录是 `<workspaceRoot>/.skills/`。 */
  readonly workspaceRoot?: string
  /** 数据目录：用户技能目录是 `<dataDir>/skills/`。 */
  readonly dataDir?: string
  /** 自定义技能目录（排在项目目录之后、用户目录之前）。 */
  readonly customDirs?: readonly string[]
  /**
   * 已经建好的注册表。
   *
   * 给了就用它，插件不再自己建目录来源——这样别的插件往同一个注册表里挂技能也
   * 是一份目录。
   */
  readonly registry?: SkillRegistry
}

/**
 * 技能插件入口：把 `skill` 工具注册进工具表。
 *
 * 工具说明里带的是**目录**，不是全部正文——这是这一族的关键：十几个技能正文
 * 一起进上下文既贵又读不完，模型点名要哪条再取哪条。
 */
export function skillPlugin(options: SkillPluginOptions): PluginEntry {
  return {
    id: SKILL_PLUGIN_ID,
    name: '技能',
    description: '让助理按需加载可复用的工作法：它先看技能目录，点名才去取正文。',
    group: 'feature',
    capabilities: {
      tools: [SKILL_TOOL_NAME],
    },
    impact: '关闭后助理不能再加载技能正文；已经取过的正文留在对话历史里，技能文件本身不会被改动。',
    inject: ['tools'],
    apply: async (ctx: Context) => {
      const registry = options.registry ?? new SkillRegistry()
      let provider: FileSystemSkillProvider | undefined
      if (options.registry === undefined) {
        provider = new FileSystemSkillProvider({
          roots: defaultSkillRoots({
            workspaceRoot: options.workspaceRoot,
            dataDir: options.dataDir,
            customDirs: options.customDirs,
          }),
        })
        registry.registerProvider(provider)
      }
      // 先扫一遍目录：工具说明里的目录要一开始就准，不然模型第一轮看到的是空的。
      await registry.list()
      ctx.tools.register(createSkillTool({ registry }))
      provider?.startWatching()
      // 目录变了就把新的目录刷进注册表快照，工具说明下一轮自然跟着变。
      const off = registry.onChange(() => {
        void registry.list()
      })
      ctx.effect(() => {
        return () => {
          off()
          provider?.stopWatching()
        }
      }, 'skill.provider')
    },
  }
}
