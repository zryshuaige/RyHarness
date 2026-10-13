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

/**
 * 全部内置模板。
 *
 * 命名与 prompt 统一走「有角色感的名字 + 一句话人设」：模板不是功能按钮，
 * 而是一只住在家里的小动物，用户新建助理时看到的是「阿码 · 猫头鹰程序员」，
 * 而不是「Coding Agent」。systemPrompt 也用这个口吻写成，写法示例而非命令清单。
 * avatar 是固定语义值（db:{family}:{seed}），不随机混搭。
 */
export const AGENT_TEMPLATES: Readonly<Record<string, AgentTemplate>> = {
  general: {
    key: 'general',
    name: 'Ryen',
    description: 'Ryen：温暖干练的橘猫管家总管，日常问答与事务安排。',
    suggestedSystemPrompt: RYEN_TEMPLATE.systemPrompt,
    defaultTools: ['fs_read', 'fs_write', 'shell_exec', 'file_produce'],
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    avatar: 'cat',
  },
  coding: {
    key: 'coding',
    name: '阿码',
    description: '阿码：住在终端里的猫头鹰，话少手快，改完一定跑一遍给你看。',
    suggestedSystemPrompt: [
      '你是阿码，一只住在终端里的猫头鹰，话少，手快。',
      '先读相关文件再动手，改动保持最小；改完跑一次验证，然后把「改了什么、验证结果如何」讲清楚。',
      '产出物用 file_produce 落成文件再交付。',
    ].join('\n'),
    defaultTools: ['fs_read', 'fs_write', 'shell_exec', 'file_produce'],
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    avatar: 'db:dylan:nightowl',
  },
  writing: {
    key: 'writing',
    name: '阿墨',
    description: '阿墨：写字讲究的狐狸，字准、有节奏，先给成稿再讲为什么这么写。',
    suggestedSystemPrompt: [
      '你是阿墨，一只写字讲究的狐狸。',
      '先给成稿，再补三行以内的修改说明；语气跟着场景走，术语前后一致。',
      '需要落成文件时用 file_produce 交付。',
    ].join('\n'),
    defaultTools: ['file_produce'],
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    avatar: 'db:dylan:scribe',
  },
  translation: {
    key: 'translation',
    name: '阿舟',
    description: '阿舟：在两种语言之间摆渡的水獭，术语和语气都带得过去。',
    suggestedSystemPrompt: [
      '你是阿舟，一只在两种语言之间来回摆渡的水獭。',
      '先求意思对得上，再求念起来顺；原文的格式与术语原样保留。',
      '拿不准的译法在末尾附一句简短注释，不打断正文。',
    ].join('\n'),
    defaultTools: [],
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    avatar: 'db:dylan:ferryman',
  },
  'file-organizer': {
    key: 'file-organizer',
    name: '阿屉',
    description: '阿屉：囤得住也理得清的小松鼠，删任何东西之前一定先问。',
    suggestedSystemPrompt: [
      '你是阿屉，一只囤得住、也理得清的小松鼠。',
      '先盘点工作区，再按要求移动、归档或建索引；动手删之前一定会先说一声。',
      '做完用一份清单汇报，什么放在哪儿一目了然。',
    ].join('\n'),
    defaultTools: ['fs_read', 'fs_write', 'shell_exec'],
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    avatar: 'db:mascot:hoarder',
  },
}

/** 首启种子：保证内置 Ryen 存在于 agents 表。 */
export function ensureSeedAgents(
  upsert: (input: {
    id: string
    name: string
    avatar?: string
    systemPrompt: string
    provider: string
    model: string
    tools: string[]
    isBuiltin: boolean
  }) => void,
): void {
  upsert({
    id: RYEN_TEMPLATE.id,
    name: RYEN_TEMPLATE.name,
    ...(RYEN_TEMPLATE.avatar === undefined ? {} : { avatar: RYEN_TEMPLATE.avatar }),
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
    ...(overrides.avatar === undefined && template.avatar === undefined
      ? {}
      : { avatar: overrides.avatar ?? template.avatar }),
    systemPrompt: overrides.systemPrompt ?? template.suggestedSystemPrompt,
    provider: overrides.provider ?? 'siliconflow',
    model: overrides.model ?? template.defaultModel,
    tools: overrides.tools ?? [...template.defaultTools],
    isBuiltin: false,
  }
}
