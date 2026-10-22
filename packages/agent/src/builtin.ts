/**
 * 内置 Agent 模板。Ryen 是系统自带的"猫管家总管"：中文、温暖、干练。
 * 用户通过 forkTemplate 从模板派生自己的 agent。
 * @module @ryharness/agent/builtin
 */

import { randomUUID } from 'node:crypto'
import type { AgentDefinition } from './types.ts'

/** 系统内置模板：猫管家总管家人设。 */
export const RYEN_TEMPLATE: AgentDefinition = {
  id: 'ryen',
  name: 'Ryen',
  avatar: 'cat',
  systemPrompt: [
    '你是 Ryen，这个家的猫管家总管。',
    '你以中文交流，语气温暖、干练，像一位值得信赖的管家：先倾听，再行动。',
    '你熟悉家里的每位成员，会主动把事情安排妥当；能用工具完成的事不推诿，',
    '需要确认的事会简短地说明理由再问。',
    '回答保持简洁，除非用户要求展开。',
  ].join('\n'),
  provider: 'siliconflow',
  model: 'deepseek-ai/DeepSeek-V4-Flash',
  // 默认工具**不含 shell_exec**：能在用户电脑上执行任意命令是最高一档能力，
  // 一条提示注入就能把它升级成任意代码执行，不该在用户还没意识到「这只小动物
  // 会敲我的电脑」时默认打开。与服务端模板目录（apps/server/src/seed.ts）保持
  // 一致；要用就在 agent 编辑里显式勾选，工具本身还有敏感路径闸兜底。
  // todo 是低风险的本机会话数据，默认开：用户说「帮我记一下」时助理必须能接住。
  tools: ['fs_read', 'fs_write', 'file_produce', 'todo'],
  isBuiltin: true,
}

/** 全部内置模板，按 id 索引。 */
export const BUILTIN_TEMPLATES: Readonly<Record<string, AgentDefinition>> = Object.freeze({
  [RYEN_TEMPLATE.id]: RYEN_TEMPLATE,
})

/**
 * 从模板 fork 一个用户 agent：分配新 id、清除内置标记，应用覆盖项。
 * @param template - 内置模板。
 * @param overrides - 用户自定义字段（name/avatar/systemPrompt/provider/model/temperature/tools）。
 * @returns 新的 AgentDefinition（isBuiltin: false，新 UUID id）。
 */
export function forkTemplate(
  template: AgentDefinition,
  overrides: Partial<Omit<AgentDefinition, 'id' | 'isBuiltin'>> = {},
): AgentDefinition {
  return {
    ...template,
    ...overrides,
    id: randomUUID(),
    isBuiltin: false,
  }
}
