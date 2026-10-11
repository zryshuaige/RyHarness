/**
 * 精简 agent 运行时类型：Agent 定义、工具抽象、循环事件。
 * @module @ryagent/agent/types
 */

import type { FinishReason, ToolCallId } from '@ryagent/llm'

/** Agent 定义：一段可持久化的 agent 身份 + 能力白名单。 */
export interface AgentDefinition {
  /** 稳定 id（builtin 为固定字符串；fork 生成 UUID）。 */
  id: string
  name: string
  /** 头像（emoji 或 URL），展示用。 */
  avatar?: string
  /** 系统提示词，注入每次请求的系统槽。 */
  systemPrompt: string
  /** 已注册的 LLM provider 路由（ctx.llm 的 route id）。 */
  provider: string
  model: string
  temperature?: number
  /** 可调用的工具名白名单；为空数组表示纯对话。 */
  tools: string[]
  /** 系统内置模板为 true；用户 fork 的为 false。 */
  isBuiltin?: boolean
}

/** 一次工具执行的上下文。 */
export interface ToolContext {
  /** 工作区根目录：fs 类工具必须限制在其内。 */
  workspaceRoot: string
  /** 调用方取消信号。 */
  signal?: AbortSignal
}

/** "发文件"产物卡片：file_produce 类工具返回，UI 据此渲染文件消息。 */
export interface ProduceCard {
  /** 工作区内的绝对路径。 */
  path: string
  name: string
  size: number
  mime: string
}

/** 工具执行结果。 */
export interface ToolResult {
  /** 文本内容，作为 tool 消息进入模型历史。 */
  content: string
  isError?: boolean
  /** 产物卡片（可选）。 */
  produce?: ProduceCard
}

/** 工具抽象：name/description/parameters 映射到 @ryagent/llm 的 ToolSchema。 */
export interface Tool {
  name: string
  description: string
  /** JSON Schema（对象）。 */
  parameters: Record<string, unknown>
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>
}

/** AgentLoop 产出的事件流，供 UI 订阅。 */
export type AgentLoopEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-start'; callId: ToolCallId; name: string; arguments: string }
  | { type: 'tool-result'; callId: ToolCallId; name: string; isError: boolean; result: ToolResult }
  | { type: 'done'; finish: FinishReason; steps: number }
  | { type: 'error'; message: string; code: string }
