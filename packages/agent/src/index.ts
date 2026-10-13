/**
 * RyAgent 精简 agent 运行时。
 *
 * 三个部分组成：AgentDefinition（可持久化的身份+能力定义）、内置模板
 * （Ryen 猫管家总管 + forkTemplate 派生）、AgentLoop（消息+工具循环，
 * 构造注入 LlmRuntime，不依赖 cordis 插件化）。
 * @module @ryagent/agent
 */

export { BUILTIN_TEMPLATES, forkTemplate, RYEN_TEMPLATE } from './builtin.ts'
export type { AgentEvolutionHooks, AgentLoopOptions, AgentMemoryHooks, EvolutionTurnData } from './loop.ts'
export { AgentLoop } from './loop.ts'
export type {
  AgentDefinition,
  AgentLoopEvent,
  ProduceCard,
  Tool,
  ToolContext,
  ToolResult,
} from './types.ts'
