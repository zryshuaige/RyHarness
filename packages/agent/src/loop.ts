/**
 * 精简 agent 消息循环。
 *
 * 每步：组装请求（systemPrompt + 历史 + 工具白名单）→ ctx.llm.stream() →
 * 边收 chunk 边发事件、边用 BlockAssembler 组装 → 若产出 tool_call 则并行
 * 调度执行（结果按 call 顺序回填）、把 tool 结果追加进历史、进入下一步；
 * 否则以 finish 终止。达到 maxSteps 仍有未决工具调用时以 error 事件终止
 * （防死循环）。
 *
 * 并发取舍：记忆 recall 与进化 compile 互不依赖，并行发起（首 token 延迟取
 * 二者较大值而非之和）；同一条 assistant 消息里的多个工具调用并行执行，
 * 但事件与 tool 消息一律按模型给出的 call 顺序提交，保证历史确定。传入
 * `signal` 后，循环在每个边界检查取消，不再发起新的模型调用、不再执行后续
 * 工具：已推给前端的半截回复先以 done 收尾并落库（否则刷新即消失），随后
 * 以 {@link AbortedError} 结束。
 *
 * 与上游 dsh-agent-loop 的关系：只保留"循环 + 工具调度"内核，不带
 * session 发布、sandbox 执行器与审批生态（M0 决策：agent 循环自写精简版）。
 * @module @ryagent/agent/loop
 */

import type {
  AssistantMessage,
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmRuntime,
  Message,
  TokenUsage,
  ToolCallBlock,
  ToolCallId,
  ToolSchema,
} from '@ryagent/llm'
import {
  BlockAssembler,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  errorChain,
  isHarnessError,
} from '@ryagent/llm'
import { ABORTED_CODE, abortedErrorOf, throwIfAborted } from './aborted.ts'
import type { AgentDefinition, AgentLoopEvent, Tool, ToolContext, ToolResult } from './types.ts'

/** AgentLoop 构造参数。 */
export interface AgentLoopOptions {
  definition: AgentDefinition
  /** 挂载好的 LLM 运行时（cordis ctx.llm 或等价物）。 */
  llm: LlmRuntime
  /** 可用工具全集；循环按 definition.tools 白名单过滤。 */
  tools: readonly Tool[]
  /** 最大步数（模型调用次数），默认 16。 */
  maxSteps?: number
  /** 起始历史（从持久层恢复的消息），循环会按预算裁剪后复制追加。 */
  history?: readonly Message[]
  /**
   * 起始历史的字符预算（token 的字符数近似），默认 30k；超预算从最旧开始
   * 丢弃。传 `Infinity` 关闭裁剪。本轮内新产生的消息不参与裁剪——中途丢
   * 历史会打断 tool_call/tool_result 的配对。
   */
  historyBudgetChars?: number
  /**
   * 每步组装出完整 assistant 消息时回调（群聊调度器据此持久化/解析 @提及）。
   * `usage` 是产出该消息的那次模型调用的用量（供应商未回报时为 undefined）：
   * 调用方在同一步把它落到该条消息上，成本才按消息可查。
   */
  onAssistantMessage?: (message: AssistantMessage, usage?: TokenUsage) => void
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
  /**
   * 编译该 agent 的进化上下文。`inputText` 是本轮用户输入：教训注入靠它做
   * 相关性筛选，不传就只剩 playbook 条目（教训相关性形同虚设）。
   */
  compile(
    agentId: string,
    inputText: string,
  ): Promise<{ text: string; playbookEntryIds: string[]; reflectionIds: string[] } | undefined>
  enqueueTurn(agentId: string, agentName: string, conversationId: string, turn: EvolutionTurnData): void
}

const DEFAULT_MAX_STEPS = 16

/** 起始历史的字符预算默认值（token 的字符数近似，对齐群聊侧的 30k）。 */
export const DEFAULT_HISTORY_BUDGET_CHARS = 30_000

/** 把任意 thrown value 归一为事件用的 { message, code }。 */
function failureOf(error: unknown): { message: string; code: string } {
  return {
    message: errorChain(error),
    code: isHarnessError(error) ? error.code : 'UNKNOWN',
  }
}

/** 内容块里的纯文本（tool_call 的参数 JSON 不计入回复文本）。 */
function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => {
      return block.type === 'text'
    })
    .map((block) => {
      return block.type === 'text' ? block.text : ''
    })
    .join('\n')
}

/** 一轮运行的调用方选项。 */
export interface AgentRunOptions {
  /**
   * 调用方取消信号。取消后循环不再发起新的模型调用、不再执行后续工具，
   * 并以 {@link AbortedError} 结束；缺省时沿用 ToolContext.signal。
   */
  signal?: AbortSignal
}

/** 估算一条消息的字符权重（4 字符 ≈ 1 token 的粗略口径）。 */
function messageWeight(message: Message): number {
  let total = 16
  for (const block of message.content) {
    if (block.type === 'text' || block.type === 'reasoning') total += block.text.length
    else if (block.type === 'tool-call') total += block.arguments.length + block.name.length
    else total += 64 // 图片/文件句柄的近似体积
  }
  return total + 4
}

/**
 * 按字符预算从最旧开始裁剪起始历史（思路与群聊的 buildGroupContext 对齐）。
 * @param history - 待裁剪的历史消息。
 * @param budgetChars - 字符预算；非有限值（`Infinity`）表示不裁剪。
 * @returns 预算内的历史窗口；始终至少保留最新一条，且窗口首条不会是孤立的
 *   tool 结果（其 tool_call 已被裁掉，供应商会拒绝这种序列）。
 */
export function trimHistoryToBudget(history: readonly Message[], budgetChars: number): Message[] {
  if (!Number.isFinite(budgetChars)) return [...history]
  const weights = history.map(messageWeight)
  let total = weights.reduce((sum, weight) => {
    return sum + weight
  }, 0)
  let start = 0
  while (total > budgetChars && start < history.length - 1) {
    total -= weights[start] as number
    start++
  }
  while (start < history.length - 1 && (history[start] as Message).role === 'tool') start++
  return history.slice(start)
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
   * @param options - 调用方取消信号（缺省沿用 context.signal）。
   * @returns 事件异步流：text-delta / tool-call-start / tool-result / done / error。
   * @throws AbortedError - 调用方取消。
   */
  async *run(input: { text: string }, context: ToolContext, options?: AgentRunOptions): AsyncGenerator<AgentLoopEvent> {
    const { definition, llm } = this.options
    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS
    const signal = options?.signal ?? context.signal
    const toolContext: ToolContext = signal === context.signal ? context : { ...context, signal }
    throwIfAborted(signal)

    const history: Message[] = trimHistoryToBudget(
      this.options.history ?? [],
      this.options.historyBudgetChars ?? DEFAULT_HISTORY_BUDGET_CHARS,
    )
    history.push(createUserMessage({ content: [{ type: 'text', text: input.text }], source: { kind: 'user' } }))

    const toolSchemas: ToolSchema[] = [...this.allowedTools.values()].map((tool) => {
      return { name: tool.name, description: tool.description, parameters: tool.parameters }
    })

    // 记忆召回与进化编译互不依赖，并行发起：首 token 延迟取二者较大值而非之和
    // （各自最坏 ~800ms embedding / playbook 编译）。两者都静默降级。
    const [memoryBlock, compiled] = await Promise.all([
      this.recallMemory(definition.id, input.text),
      this.compileEvolution(definition.id, input.text),
    ])
    throwIfAborted(signal)
    const evolutionBlock = compiled.text
    const injectedPlaybookEntryIds = compiled.playbookEntryIds
    const injectedReflectionIds = compiled.reflectionIds
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
        throwIfAborted(signal)
        const request: GenerateOptions = {
          provider: definition.provider,
          model: definition.model,
          system: systemPrompt,
          messages: history,
          ...(toolSchemas.length === 0 ? {} : { tools: toolSchemas }),
          ...(definition.temperature === undefined ? {} : { temperature: definition.temperature }),
          ...(signal === undefined ? {} : { signal }),
        }

        const assembler = new BlockAssembler()
        let failure: { message: string; code: string } | undefined
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
          // 取消不按失败处理：留给下面的统一中断收尾（先固化半截回复）。
          if (signal?.aborted !== true) failure = failureOf(error)
        }

        const finish: FinishReason = assembler.finish
        if (signal?.aborted === true || failure !== undefined || finish.kind === 'error' || finish.kind === 'aborted') {
          const partial = this.commitInterrupted(assembler, definition)
          assistantText += partial.text
          if (signal?.aborted === true) {
            // 半截回复已经推给前端：先以 done 收尾（协调器落库、服务器推
            // message-done），再抛 AbortedError。否则这段内容刷新后就消失。
            if (partial.blocks.length > 0) yield { type: 'done', finish, steps }
            throw abortedErrorOf(signal)
          }
          llmError = true
          const terminal = finish.kind === 'error' || finish.kind === 'aborted' ? finish.failure : undefined
          yield {
            type: 'error',
            message: terminal?.message ?? failure?.message ?? 'llm stream failed',
            code: terminal?.code ?? failure?.code ?? 'UNKNOWN',
          }
          return
        }

        const message = assembler.message({ provider: definition.provider, model: definition.model })
        this.options.onAssistantMessage?.(message, assembler.usage)
        history.push(message)
        assistantText += textOf(message.content)
        const calls = message.content.filter((block): block is ToolCallBlock => {
          return block.type === 'tool-call'
        })

        if (calls.length === 0) {
          yield { type: 'done', finish, steps }
          return
        }
        if (finish.kind !== 'tool-calls' && finish.kind !== 'stop') {
          yield { type: 'done', finish, steps }
          return
        }

        // 同一批工具调用并发执行（默认策略，对齐上游的 toolExecution:
        // "parallel"）；任一工具声明 sequential 时整批退回串行，避免有副作用
        // 的工具互相踩踏。结果按 call 顺序回填，事件与历史顺序不随完成
        // 先后变化，历史保持确定。
        throwIfAborted(signal)
        const results = await this.executeCalls(calls, toolContext)
        throwIfAborted(signal)
        for (const [index, call] of calls.entries()) {
          const result = results[index] as ToolResult
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

  /**
   * 执行一批 tool_call。默认并发；批次里任一工具声明 `executionMode:
   * 'sequential'` 时整批串行（工具的副作用可能互相排斥）。
   * @returns 与 calls 同序的结果数组。
   */
  private async executeCalls(calls: readonly ToolCallBlock[], context: ToolContext): Promise<ToolResult[]> {
    const sequential = calls.some((call) => {
      return this.allowedTools.get(call.name)?.executionMode === 'sequential'
    })
    if (sequential || calls.length === 1) {
      const results: ToolResult[] = []
      for (const call of calls) {
        results.push(await this.executeCall(call, context))
      }
      return results
    }
    return await Promise.all(calls.map((call) => this.executeCall(call, context)))
  }

  /** 长期记忆召回（故障静默降级为无人设增强）。 */
  private async recallMemory(agentId: string, inputText: string): Promise<string | undefined> {
    if (this.options.memory === undefined) return undefined
    try {
      return await this.options.memory.recall(agentId, inputText)
    } catch {
      return undefined
    }
  }

  /**
   * 固化被中断的一步（取消 / 流异常 / 终态 error）：只保留已经收到的文本与
   * 思考块——未执行的 tool_call 落库后，下一轮重建历史会缺少配对的 tool
   * 结果消息，供应商会直接拒绝整个请求。
   * @returns 固化的内容块与其中的文本；空数组表示没有可保留的内容。
   */
  private commitInterrupted(
    assembler: BlockAssembler,
    definition: AgentDefinition,
  ): { blocks: ContentBlock[]; text: string } {
    const blocks = assembler.interruptedBlocks()
    if (blocks.length === 0) return { blocks, text: '' }
    this.options.onAssistantMessage?.(
      createAssistantMessage({
        content: blocks,
        source: { provider: definition.provider, model: definition.model },
      }),
      assembler.usage,
    )
    return { blocks, text: textOf(blocks) }
  }

  /** 自我进化编译（playbook + 相关教训；故障静默降级）。 */
  private async compileEvolution(
    agentId: string,
    inputText: string,
  ): Promise<{
    text?: string
    playbookEntryIds: string[]
    reflectionIds: string[]
  }> {
    if (this.options.evolution === undefined) {
      return { playbookEntryIds: [], reflectionIds: [] }
    }
    try {
      const compiled = await this.options.evolution.compile(agentId, inputText)
      return {
        ...(compiled?.text === undefined ? {} : { text: compiled.text }),
        playbookEntryIds: compiled?.playbookEntryIds ?? [],
        reflectionIds: compiled?.reflectionIds ?? [],
      }
    } catch {
      return { playbookEntryIds: [], reflectionIds: [] }
    }
  }

  /** 执行一个 tool_call：未知工具与参数解析失败都转化为错误结果而非抛异常。 */
  private async executeCall(call: ToolCallBlock, context: ToolContext): Promise<ToolResult> {
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
