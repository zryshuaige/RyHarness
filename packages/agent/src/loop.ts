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

import type {
  AssistantMessage,
  FinishReason,
  GenerateOptions,
  LlmRuntime,
  Message,
  ToolCallBlock,
  ToolCallId,
  ToolSchema,
} from '@ryagent/llm'
import { BlockAssembler, createToolResultMessage, createUserMessage, errorChain, isHarnessError } from '@ryagent/llm'
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
  /**
   * 长期记忆钩子（可选）：组装 prompt 前 recall 注入；每轮结束异步
   * enqueueExtraction（绝不阻塞回复）。记忆故障不得影响对话。
   */
  memory?: AgentMemoryHooks
  /**
   * 自我进化钩子（可选）：组装前 compile 注入 [经验手册]/[上次教训]；
   * 每轮结束异步 enqueueTurn（Reflector 计数 + Reflexion + Curator delta）。
   */
  evolution?: AgentEvolutionHooks
}

/** 记忆系统对运行时的最小接口（由 @ryagent/memory 的 MemoryService 实现）。 */
export interface AgentMemoryHooks {
  recall(agentId: string, inputText: string): Promise<string | undefined>
  enqueueExtraction(agentId: string, agentName: string, conversationId: string, turnText: string): void
}

/** 一轮轨迹数据（进化管线的输入，由 @ryagent/evolve 消费）。 */
export interface EvolutionTurnData {
  userText: string
  assistantText: string
  toolResults: { name: string; isError: boolean }[]
  /** LLM 流是否以错误收尾。 */
  llmError: boolean
  /** 本轮注入的 playbook 条目 / 教训（归因计数用）。 */
  injectedPlaybookEntryIds: string[]
  injectedReflectionIds: string[]
}

/** 自我进化对运行时的最小接口（由 @ryagent/evolve 的 EvolveService 实现）。 */
export interface AgentEvolutionHooks {
  compile(agentId: string): Promise<{ text: string; playbookEntryIds: string[]; reflectionIds: string[] } | undefined>
  enqueueTurn(agentId: string, agentName: string, conversationId: string, turn: EvolutionTurnData): void
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
    this.allowedTools = new Map(
      options.tools
        .filter((tool) => {
          return wanted.has(tool.name)
        })
        .map((tool) => {
          return [tool.name, tool]
        }),
    )
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

    const toolSchemas: ToolSchema[] = [...this.allowedTools.values()].map((tool) => {
      return { name: tool.name, description: tool.description, parameters: tool.parameters }
    })

    // 长期记忆召回（组装前注入；故障静默降级为无人设增强）。
    let memoryBlock: string | undefined
    if (this.options.memory !== undefined) {
      try {
        memoryBlock = await this.options.memory.recall(definition.id, input.text)
      } catch {
        memoryBlock = undefined
      }
    }
    // 自我进化编译（playbook + 上次教训）；故障静默降级。
    let evolutionBlock: string | undefined
    let injectedPlaybookEntryIds: string[] = []
    let injectedReflectionIds: string[] = []
    if (this.options.evolution !== undefined) {
      try {
        const compiled = await this.options.evolution.compile(definition.id)
        evolutionBlock = compiled?.text
        injectedPlaybookEntryIds = compiled?.playbookEntryIds ?? []
        injectedReflectionIds = compiled?.reflectionIds ?? []
      } catch {
        evolutionBlock = undefined
      }
    }
    const systemPrompt = [definition.systemPrompt, memoryBlock, evolutionBlock]
      .filter((part): part is string => {
        return part !== undefined
      })
      .join('\n\n')

    let steps = 0
    let assistantText = ''
    let llmError = false
    const toolResults: { name: string; isError: boolean }[] = []
    try {
      while (steps < maxSteps) {
        steps++
        const request: GenerateOptions = {
          provider: definition.provider,
          model: definition.model,
          system: systemPrompt,
          messages: history,
          ...(toolSchemas.length === 0 ? {} : { tools: toolSchemas }),
          ...(definition.temperature === undefined ? {} : { temperature: definition.temperature }),
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
          llmError = true
          const failure = failureOf(error)
          yield { type: 'error', message: failure.message, code: failure.code }
          return
        }

        const message = assembler.message({ provider: definition.provider, model: definition.model })
        this.options.onAssistantMessage?.(message)
        history.push(message)
        assistantText += message.content
          .filter((block) => {
            return block.type === 'text'
          })
          .map((block) => {
            return block.type === 'text' ? block.text : ''
          })
          .join('\n')
        const calls = message.content.filter((block): block is ToolCallBlock => {
          return block.type === 'tool-call'
        })
        const finish: FinishReason = assembler.finish

        // 终态 error/aborted 不是正常收尾：传播为 error 事件，让协调器落
        // system 错误消息、服务器推 error 事件，而不是把半截回复当完整回复。
        if (finish.kind === 'error' || finish.kind === 'aborted') {
          llmError = true
          yield { type: 'error', message: finish.failure.message, code: finish.failure.code }
          return
        }

        if (calls.length === 0) {
          yield { type: 'done', finish, steps }
          return
        }
        if (finish.kind !== 'tool-calls' && finish.kind !== 'stop') {
          yield { type: 'done', finish, steps }
          return
        }

        for (const call of calls) {
          const result = await this.executeCall(call, context)
          toolResults.push({ name: call.name, isError: result.isError === true })
          yield {
            type: 'tool-result',
            callId: call.id,
            name: call.name,
            isError: result.isError === true,
            result,
          }
          history.push(
            createToolResultMessage({
              callId: call.id as ToolCallId,
              content: [{ type: 'text', text: result.content }],
              isError: result.isError === true,
            }),
          )
        }
      }

      yield {
        type: 'error',
        message: `agent loop exceeded maxSteps=${maxSteps} with pending tool calls`,
        code: 'MAX_STEPS',
      }
    } finally {
      // 自我进化：每轮轨迹入队（Reflector/Reflexion/Curator，异步）。
      // 无 assistant 文本但发生错误/工具调用的轮次也要入队（反思需要失败信号）。
      if (
        this.options.evolution !== undefined &&
        (assistantText.trim().length > 0 || llmError || toolResults.length > 0)
      ) {
        try {
          this.options.evolution.enqueueTurn(definition.id, definition.name, '', {
            userText: input.text,
            assistantText: assistantText.trim(),
            toolResults,
            llmError,
            injectedPlaybookEntryIds,
            injectedReflectionIds,
          })
        } catch {
          // 进化入队故障不影响对话。
        }
      }
      // 长期记忆抽取（异步管线，绝不阻塞回复）；至少要有 assistant 内容才入队。
      if (this.options.memory !== undefined && assistantText.trim().length > 0) {
        try {
          this.options.memory.enqueueExtraction(
            definition.id,
            definition.name,
            '',
            `用户：${input.text}
${definition.name}：${assistantText.trim()}`,
          )
        } catch {
          // 记忆入队故障不影响对话。
        }
      }
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
