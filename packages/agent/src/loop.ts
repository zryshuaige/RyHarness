/**
 * 精简 agent 消息循环。
 *
 * 每步：组装请求（systemPrompt + 历史 + 工具白名单）→ ctx.llm.stream() →
 * 边收 chunk 边发事件、边用 BlockAssembler 组装 → 若产出 tool_call 则逐个
 * 调度执行、把 tool 结果追加进历史、进入下一步；否则以 finish 终止。
 * 达到 maxSteps 仍有未决工具调用时以 error 事件终止（防死循环）。
 *
 * 与上游 dsh-agent-loop 的关系：只保留"循环 + 工具调度"内核，不带
 * session 发布、sandbox 执行器与审批生态（M0 决策：agent 循环自写精简版）。
 * @module @ryagent/agent/loop
 */

import {
  BlockAssembler,
  createToolResultMessage,
  createUserMessage,
  errorChain,
  isHarnessError,
} from '@ryagent/llm'
import type {
  AssistantMessage,
  FinishReason,
  GenerateOptions,
  LlmRuntime,
  Message,
  ToolCallId,
  ToolSchema,
  ToolCallBlock,
} from '@ryagent/llm'
import type { AgentDefinition, AgentLoopEvent, Tool, ToolContext } from './types.ts'

/** AgentLoop 构造参数。 */
export interface AgentLoopOptions {
  definition: AgentDefinition
  /** 挂载好的 LLM 运行时（cordis ctx.llm 或等价物）。 */
  llm: LlmRuntime
  /** 可用工具全集；循环按 definition.tools 白名单过滤。 */
  tools: readonly Tool[]
  /** 最大步数（模型调用次数），默认 16。 */
  maxSteps?: number
  /** 起始历史（从持久层恢复的消息），循环会复制后追加。 */
  history?: readonly Message[]
  /** 每步组装出完整 assistant 消息时回调（群聊调度器据此持久化/解析 @提及）。 */
  onAssistantMessage?: (message: AssistantMessage) => void
}

const DEFAULT_MAX_STEPS = 16

/** 把任意 thrown value 归一为事件用的 { message, code }。 */
function failureOf(error: unknown): { message: string; code: string } {
  return {
    message: errorChain(error),
    code: isHarnessError(error) ? error.code : 'UNKNOWN',
  }
}

/** 精简 agent 消息循环。一个实例可反复 run；每次 run 从初始 history 派生。 */
export class AgentLoop {
  private readonly allowedTools: Map<string, Tool>

  constructor(private readonly options: AgentLoopOptions) {
    const wanted = new Set(options.definition.tools)
    this.allowedTools = new Map(options.tools.filter((tool) => { return wanted.has(tool.name) })
      .map((tool) => { return [tool.name, tool] }))
  }

  /**
   * 跑一轮用户输入。
   * @param input - 用户文本。
   * @param context - 工具执行上下文（工作区根目录等）。
   * @returns 事件异步流：text-delta / tool-call-start / tool-result / done / error。
   */
  async *run(input: { text: string }, context: ToolContext): AsyncGenerator<AgentLoopEvent> {
    const { definition, llm } = this.options
    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS
    const history: Message[] = [...(this.options.history ?? [])]
    history.push(createUserMessage({ content: [{ type: 'text', text: input.text }], source: { kind: 'user' } }))

    const toolSchemas: ToolSchema[] = [...this.allowedTools.values()]
      .map((tool) => { return { name: tool.name, description: tool.description, parameters: tool.parameters } })

    let steps = 0
    while (steps < maxSteps) {
      steps++
      const request: GenerateOptions = {
        provider: definition.provider,
        model: definition.model,
        system: definition.systemPrompt,
        messages: history,
        ...toolSchemas.length === 0 ? {} : { tools: toolSchemas },
        ...definition.temperature === undefined ? {} : { temperature: definition.temperature },
      }

      const assembler = new BlockAssembler()
      try {
        for await (const chunk of llm.stream(request)) {
          assembler.push(chunk)
          if (chunk.type === 'text-delta') {
            yield { type: 'text-delta', text: chunk.text }
          } else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
            yield {
              type: 'tool-call-start',
              callId: chunk.block.id,
              name: chunk.block.name,
              arguments: chunk.block.arguments,
            }
          }
        }
      } catch (error) {
        const failure = failureOf(error)
        yield { type: 'error', message: failure.message, code: failure.code }
        return
      }

      const message = assembler.message({ provider: definition.provider, model: definition.model })
      this.options.onAssistantMessage?.(message)
      history.push(message)
      const calls = message.content.filter((block): block is ToolCallBlock => { return block.type === 'tool-call' })
      const finish: FinishReason = assembler.finish

      if (calls.length === 0) {
        // 纯文本（或错误/中止）终止：max-tokens 截断已由 BlockAssembler 处理。
        yield { type: 'done', finish, steps }
        return
      }
      if (finish.kind !== 'tool-calls' && finish.kind !== 'stop') {
        // 流以错误/中止收尾却带着未执行的调用：不上调度，直接终止。
        yield { type: 'done', finish, steps }
        return
      }

      for (const call of calls) {
        const result = await this.executeCall(call, context)
        yield {
          type: 'tool-result',
          callId: call.id,
          name: call.name,
          isError: result.isError === true,
          result,
        }
        history.push(createToolResultMessage({
          callId: call.id as ToolCallId,
          content: [{ type: 'text', text: result.content }],
          isError: result.isError === true,
        }))
      }
    }

    yield {
      type: 'error',
      message: `agent loop exceeded maxSteps=${maxSteps} with pending tool calls`,
      code: 'MAX_STEPS',
    }
  }

  /** 执行一个 tool_call：未知工具与参数解析失败都转化为错误结果而非抛异常。 */
  private async executeCall(call: ToolCallBlock, context: ToolContext) {
    const tool = this.allowedTools.get(call.name)
    if (tool === undefined) {
      return { content: `unknown tool "${call.name}"`, isError: true }
    }
    let args: unknown
    try {
      args = JSON.parse(call.arguments)
    } catch {
      return { content: `invalid tool arguments JSON: ${call.arguments}`, isError: true }
    }
    try {
      return await tool.execute(args, context)
    } catch (error) {
      return { content: `tool "${call.name}" failed: ${errorChain(error)}`, isError: true }
    }
  }
}
