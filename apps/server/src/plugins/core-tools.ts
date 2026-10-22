/**
 * 内置插件：基础工具（读/写文件、执行命令、交付产物）。
 *
 * 工具在这里注册而不是由组合根写死数组：注册表是运行时事实，插件卸载时四个
 * 工具随 effect 一起消失；agent 定义里的白名单仍决定每个 agent 能看见哪些。
 * @module @ryharness/server/plugins/core-tools
 */

import { fileProduce, fsRead, fsWrite, shellExec } from '@ryharness/tools'
import type { PluginEntry } from './host.ts'

export const CORE_TOOLS_PLUGIN_ID = 'core-tools'

export const coreToolsPlugin: PluginEntry = {
  id: CORE_TOOLS_PLUGIN_ID,
  name: '内置工具',
  description: '读写工作区文件、执行命令、把结果落成文件卡片；每个 agent 仍按自己的白名单取用。',
  group: 'core',
  capabilities: { tools: ['fs_read', 'fs_write', 'shell_exec', 'file_produce'] },
  impact: '关闭后助理无法读写工作区文件或执行命令，依赖工具的任务会全部失败。',
  core: true,
  inject: ['tools'],
  apply: (ctx) => {
    for (const tool of [fsRead, fsWrite, shellExec, fileProduce]) ctx.tools.register(tool)
  },
}
