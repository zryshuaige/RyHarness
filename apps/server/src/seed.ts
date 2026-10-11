/**
 * 内置 Agent 模板目录（产品层；区别于 @ryagent/agent 的运行时内置 Ryen）。
 * POST /api/agents 可用 templateKey 从模板实例化。
 * @module @ryagent/server/seed
 */

import { randomUUID } from 'node:crypto'
import type { AgentDefinition } from '@ryagent/agent'
import { RYEN_TEMPLATE } from '@ryagent/agent'

/** 一个可实例化的 agent 模板。 */
export interface AgentTemplate {
  key: string
  name: string
  description: string
  suggestedSystemPrompt: string
  defaultTools: string[]
  defaultModel: string
  avatar?: string
}

/** 全部内置模板。 */
export const AGENT_TEMPLATES: Readonly<Record<string, AgentTemplate>> = {
  general: {
    key: 'general',
    name: '通用助理',
    description: 'Ryen：温暖干练的猫管家总管，日常问答与事务安排。',
    suggestedSystemPrompt: RYEN_TEMPLATE.systemPrompt,
    defaultTools: ['fs_read', 'fs_write', 'shell_exec', 'file_produce'],
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    avatar: RYEN_TEMPLATE.avatar,
  },
  coding: {
    key: 'coding',
    name: 'Coding Agent',
    description: '读写代码、跑命令、产出文件，适合开发任务。',
    suggestedSystemPrompt: [
      '你是 Coding Agent，一名可靠的工程师。',
      '先读相关文件再改；改动保持最小；跑命令验证；产出用 file_produce 落成文件。',
      '回复简洁，说明做了什么与验证结果。',
    ].join('\n'),
    defaultTools: ['fs_read', 'fs_write', 'shell_exec', 'file_produce'],
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    avatar: '💻',
  },
  writing: {
    key: 'writing',
    name: '写作',
    description: '撰写与润色中文文稿、邮件、文案。',
    suggestedSystemPrompt: '你是中文写作助手，文字准确、有节奏、符合场景语气；先给成稿，再附简要修改说明。',
    defaultTools: ['file_produce'],
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    avatar: '✍️',
  },
  translation: {
    key: 'translation',
    name: '翻译',
    description: '中英互译，保持术语与语气一致。',
    suggestedSystemPrompt: '你是翻译，中英互译信达雅；保留原文格式与术语；拿不准的译法附简短注释。',
    defaultTools: [],
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    avatar: '🌐',
  },
  'file-organizer': {
    key: 'file-organizer',
    name: '文件整理',
    description: '在工作区内整理、重排、归档文件。',
    suggestedSystemPrompt: '你是文件整理员：先盘点工作区文件，再按用户要求移动/归档/生成索引；任何删除前必须说明；结果用清单汇报。',
    defaultTools: ['fs_read', 'fs_write', 'shell_exec'],
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    avatar: '🗂️',
  },
}

/** 首启种子：保证内置 Ryen 存在于 agents 表。 */
export function ensureSeedAgents(upsert: (input: {
  id: string
  name: string
  avatar?: string
  systemPrompt: string
  provider: string
  model: string
  tools: string[]
  isBuiltin: boolean
}) => void): void {
  upsert({
    id: RYEN_TEMPLATE.id,
    name: RYEN_TEMPLATE.name,
    ...RYEN_TEMPLATE.avatar === undefined ? {} : { avatar: RYEN_TEMPLATE.avatar },
    systemPrompt: RYEN_TEMPLATE.systemPrompt,
    provider: RYEN_TEMPLATE.provider,
    model: RYEN_TEMPLATE.model as string,
    tools: [...RYEN_TEMPLATE.tools],
    isBuiltin: true,
  })
}

/**
 * 从模板实例化一个用户 agent 定义。
 * @param templateKey - {@link AGENT_TEMPLATES} 的键。
 * @param overrides - 用户自定义字段（name/systemPrompt/tools/model/provider）。
 * @returns 新的 AgentDefinition（新 UUID，isBuiltin: false）。
 */
export function instantiateTemplate(
  templateKey: string,
  overrides: Partial<Omit<AgentDefinition, 'id' | 'isBuiltin'>> = {},
): AgentDefinition {
  const template = AGENT_TEMPLATES[templateKey]
  if (template === undefined) throw new Error(`unknown agent template "${templateKey}"`)
  return {
    id: randomUUID(),
    name: overrides.name ?? template.name,
    ...overrides.avatar === undefined && template.avatar === undefined
      ? {}
      : { avatar: overrides.avatar ?? template.avatar },
    systemPrompt: overrides.systemPrompt ?? template.suggestedSystemPrompt,
    provider: overrides.provider ?? 'siliconflow',
    model: overrides.model ?? template.defaultModel,
    tools: overrides.tools ?? [...template.defaultTools],
    isBuiltin: false,
  }
}
