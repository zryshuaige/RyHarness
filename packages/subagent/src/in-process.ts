/**
 * 进程内子代理：拿 `@ryharness/agent` 的 AgentLoop 起一次**独立上下文**的运行。
 *
 * 「独立上下文」是这里唯一要紧的事：子代理不继承父对话的历史，只拿到任务描述。
 * 父对话里那些「刚才那个文件」「上次说的那个方案」对它一律不存在——它看得见的
 * 只有父代理写进 task 里的那几个字。代价是父代理得多写几个字，收益是子代理不会
 * 被一屏无关的历史带偏。
 *
 * 为什么复用 AgentLoop 而不是自己写一套：工具调度、并行回填、预算裁剪、取消边界
 * 这些坑都已经被踩过一遍了，再写一份就是两套语义慢慢分叉。
 * @module @ryharness/subagent/in-process
 */

import type { AgentDefinition } from '@ryharness/agent'
import { AgentLoop, isAbortedError } from '@ryharness/agent'
import type { ContentBlock, LlmRuntime } from '@ryharness/llm'
import { messageOf } from './format.ts'
import type { SubagentProvider, SubagentResult, SubagentRunInput } from './types.ts'

/**
 * 子代理的系统提示词（缺省值）。
 *
 * 头两句是硬约束，不是文风建议：它看不到父对话历史，也不能再往下派活。
 * 第三句说清「回复是父代理唯一能看到的输出」——没有这句，子代理会写一堆
 * 「我已经完成上述任务」这种对父代理毫无信息量的话。
 */
export const DEFAULT_SUBAGENT_SYSTEM_PROMPT = [
  '你是子代理。父代理把一段任务描述交给你，你看不到父对话的历史，只能看到这段描述——',
  '描述里没写的信息就按常识判断，不要反问，也不要假设自己知道上文。',
  '你也不能再把活派给别的子代理：这一层下面没有子代理了，事情自己做。',
  '把活干完，最后用一段中文回复说清结论：这段回复是父代理唯一能看到的输出，',
  '所以结论、关键数字、以及你实际做过什么动作，都要写在里面。',
].join('')

/** 进程内 provider 的构造参数。 */
export interface InProcessSubagentProviderOptions {
  /** LLM 运行时：子代理的模型调用走它。 */
  llm: LlmRuntime
  /** 子代理的系统提示词；缺省用 {@link DEFAULT_SUBAGENT_SYSTEM_PROMPT}。 */
  systemPrompt?: string
  /** 子代理的展示名（写进 agent 定义，模型侧看得见）。 */
  name?: string
}

/** 内容块里的纯文本（tool_call 的参数 JSON 不算回复文本）。 */
function textOf(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 建一个进程内子代理 provider。
 *
 * @param options - LLM 运行时与子代理的系统提示词。
 * @returns 满足 {@link SubagentProvider} 契约的 provider。
 */
export function createInProcessSubagentProvider(options: InProcessSubagentProviderOptions): SubagentProvider {
  return {
    id: 'in-process',
    async run(input: SubagentRunInput): Promise<SubagentResult> {
      const definition: AgentDefinition = {
        id: input.id,
        name: options.name ?? '子代理',
        systemPrompt: input.systemPrompt ?? options.systemPrompt ?? DEFAULT_SUBAGENT_SYSTEM_PROMPT,
        provider: input.route.provider,
        model: input.route.model,
        // 白名单只留服务裁剪过的那批：委派工具到不了这里，子代理起不了子代理。
        tools: [...input.toolNames],
      }
      const usedTools: string[] = []
      // 「最后一条 assistant 文本」取自每步组装好的 assistant 消息，而不是把各步
      // 的 delta 拼起来——拼起来会把中途那些「我先去看看」也算进结论里。
      let lastText = ''
      let steps = 0
      let failure: string | undefined

      const loop = new AgentLoop({
        definition,
        llm: options.llm,
        tools: input.tools,
        maxSteps: input.maxSteps,
        onAssistantMessage: (message) => {
          const text = textOf(message.content)
          if (text.trim().length > 0) lastText = text
        },
      })

      try {
        // 入口历史一个字都不给：run 的入参只有任务描述，子代理的上下文从零开始。
        for await (const event of loop.run({ text: input.task }, input.context, { signal: input.signal })) {
          if (event.type === 'tool-call-start') {
            if (!usedTools.includes(event.name)) usedTools.push(event.name)
          } else if (event.type === 'done') {
            steps = event.steps
          } else if (event.type === 'error') {
            failure = event.message
          }
          input.onProgress?.({ steps, tools: [...usedTools] })
        }
      } catch (error) {
        // 取消与失败分开说：父代理看到「已取消」知道是这轮结束了，看到「失败」知道
        // 要换条路走；混成一句英文错误，模型只会原样再试一次。
        if (isAbortedError(error)) {
          return {
            id: input.id,
            text: lastText,
            tools: usedTools,
            steps,
            status: 'failed',
            error: '子代理已取消：父对话结束或被中断。',
          }
        }
        return {
          id: input.id,
          text: lastText,
          tools: usedTools,
          steps,
          status: 'failed',
          error: `子代理失败：${messageOf(error)}`,
        }
      }

      if (failure !== undefined) {
        return {
          id: input.id,
          text: lastText,
          tools: usedTools,
          steps,
          status: 'failed',
          error: `子代理失败：${failure}`,
        }
      }
      return { id: input.id, text: lastText, tools: usedTools, steps, status: 'completed' }
    },
  }
}
