/**
 * 精简 agent 运行时类型：Agent 定义、工具抽象、循环事件。
 * @module @ryharness/agent/types
 */

import type { FinishReason, ToolCallId } from '@ryharness/llm'

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
  /**
   * 思考强度档位（`low` / `medium` / `high` / `off`）。
   *
   * 只有模型自己声明支持时才生效——运行时会对不支持的档位抛
   * `UNSUPPORTED_REASONING_EFFORT`（见 LlmRuntime.resolveCall），而不是静默忽略。
   * 所以 UI 必须按 {@link LlmResolvedModelInfo.reasoning} 出选项，不能给所有模型
   * 都挂一个选择器。留空 = 用模型默认，不发任何字段。
   */
  reasoningEffort?: string
  /** 可调用的工具名白名单；为空数组表示纯对话。 */
  tools: string[]
  /** 系统内置模板为 true；用户 fork 的为 false。 */
  isBuiltin?: boolean
}

/** 一次工具执行的上下文。 */
export interface ToolContext {
  /** 工作区根目录：fs 类工具必须限制在其内。 */
  workspaceRoot: string
  /** 当前轮所属会话：待办这类按会话落数据的工具靠它分组。 */
  conversationId?: string
  /** 正在执行的 agent id：群里多个成员共用一份上下文时，工具靠它认领归属。 */
  agentId?: string
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

/**
 * 同一条 assistant 消息里的多个工具调用如何执行。
 * - `'parallel'`（默认）：整批并发执行，结果按模型给出的 call 顺序回填。
 * - `'sequential'`：整批退回串行，供有副作用/互斥的工具使用。
 */
export type ToolExecutionMode = 'sequential' | 'parallel'

/** 工具抽象：name/description/parameters 映射到 @ryharness/llm 的 ToolSchema。 */
export interface Tool {
  name: string
  description: string
  /** JSON Schema（对象）。 */
  parameters: Record<string, unknown>
  /** 覆盖本轮默认执行模式；缺省即并发。 */
  executionMode?: ToolExecutionMode
  /**
   * 执行前需要用户逐条批准（shell 这类「模型可驱动任意宿主行为」的工具）。
   * 循环在配额记账之后、真正执行之前询问审批方；拒绝转化为**错误结果**回给
   * 模型（与配额越限同一条路径），不炸轮次。审批方缺省时视为放行——审批是
   * 装配层的安全闸，不是内核的前置条件。
   */
  requiresApproval?: boolean
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>
}

/**
 * 按名解析工具的最小契约：生产装配传 cordis 的 ToolRegistry，测试仍可直接给数组。
 *
 * 只要 `get` 就够了——白名单本身是名字列表，按名字现查才能让插件的热挂载/卸载
 * 在下一轮立刻生效；`list` 服务于群调度追加交接工具那类「先摊平再合并」的用法。
 */
export interface ToolLookup {
  get(name: string): Tool | undefined
  list(): readonly Tool[]
}

/** 工具来源：数组（测试/独立用法）或按名注册表（生产装配）。 */
export type ToolSource = readonly Tool[] | ToolLookup

/** AgentLoop 产出的事件流，供 UI 订阅。 */
export type AgentLoopEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-start'; callId: ToolCallId; name: string; arguments: string }
  | { type: 'tool-result'; callId: ToolCallId; name: string; isError: boolean; result: ToolResult }
  | { type: 'done'; finish: FinishReason; steps: number }
  | { type: 'error'; message: string; code: string }
