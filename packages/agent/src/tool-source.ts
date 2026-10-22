/**
 * 工具来源的两种形态归一：数组（测试/独立用法）与按名注册表（cordis 服务）。
 *
 * 白名单存的是名字，解析却必须发生在**每一轮**而不是构造协调器那一刻：插件热重挂
 * 之后，同名工具的实例可能已经换了一个，缓存下来的数组会让模型继续调用旧实例。
 * @module @ryharness/agent/tool-source
 */

import type { Tool, ToolSource } from './types.ts'

function isToolArray(source: ToolSource): source is readonly Tool[] {
  return Array.isArray(source)
}

/**
 * 把白名单解析成可调用工具表。
 *
 * 不在白名单里的工具不会出现在结果里（模型连声明都看不到），注册表里查不到的
 * 名字直接跳过——用户删了插件、agent 定义里还留着旧工具名时，对话应当照常可用。
 * @param source - 数组或按名注册表。
 * @param wanted - agent 定义里的工具名白名单。
 */
export function resolveAllowedTools(source: ToolSource, wanted: readonly string[]): Map<string, Tool> {
  const allowed = new Map<string, Tool>()
  if (isToolArray(source)) {
    const names = new Set(wanted)
    for (const tool of source) {
      if (names.has(tool.name)) allowed.set(tool.name, tool)
    }
    return allowed
  }
  for (const name of wanted) {
    const tool = source.get(name)
    if (tool !== undefined) allowed.set(name, tool)
  }
  return allowed
}

/**
 * 工具来源摊平成数组。
 *
 * 群调度要在共享工具集之后追加交接工具，而注册表是只读视图——摊平出来的副本
 * 只承载这一次构造，不会把交接工具写回注册表。
 * @param source - 数组或按名注册表。
 */
export function listTools(source: ToolSource): readonly Tool[] {
  return isToolArray(source) ? source : source.list()
}
