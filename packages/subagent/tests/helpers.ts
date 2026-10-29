/**
 * 子代理用例共用的替身：假的 LLM 适配器、假的工具、跑父代理循环的脚手架。
 *
 * 单独放一个文件是因为两份用例要共用同一套替身：复制一遍既长又会在重复代码门禁
 * 上被记一笔。
 */

import type { AgentDefinition, AgentLoopEvent, Tool } from '@ryharness/agent'
import { AgentLoop } from '@ryharness/agent'
import { brandString } from '@ryharness/brand'
import { Context } from '@ryharness/cordis'
import type { GenerateOptions, LlmProviderInfo, StreamChunk, ToolCallId } from '@ryharness/llm'
import { LlmAdapter, LlmRuntime } from '@ryharness/llm'

/** 子代理的系统提示在测试里换一个可辨认的标记：父代理与子代理的请求要分得开。 */
export const CHILD_SYSTEM = '你是子代理（测试）。'

/** 父代理的系统提示标记。 */
export const PARENT_SYSTEM = '你是父代理（测试）。'

/** 按请求挑脚本的假适配器。 */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: (options: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Mock' }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 记录时把消息数组抄一份：循环会往同一个数组里继续追加，不抄的话事后读到的是
    // 跑完之后的最终历史，而不是这一请求当时带的那几条。
    this.requests.push({ ...options, messages: [...options.messages] })
    const self = this
    return (async function* (): AsyncGenerator<StreamChunk> {
      const chunks = await self.script(options)
      yield* chunks
    })()
  }
}

/** 一段纯文本回复。 */
export function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 一次工具调用。 */
export function toolCallChunks(name: string, args: unknown): StreamChunk[] {
  const id = brandString<ToolCallId>(`call-${name}`)
  const argsText = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argsText } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** 请求里的全部文本（用户消息、工具结果里的文字都算）。 */
export function requestText(options: GenerateOptions): string {
  const parts: string[] = []
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** 这个请求是不是发给子代理的。 */
export function isChildRequest(options: GenerateOptions): boolean {
  return (options.system ?? '').includes(CHILD_SYSTEM)
}

/** 父代理定义。 */
export const PARENT: AgentDefinition = {
  id: 'parent',
  name: '父代理',
  systemPrompt: PARENT_SYSTEM,
  provider: 'mock',
  model: 'mock-model',
  tools: ['subagent', 'subagent_list'],
}

/** 子代理可用的普通工具：子代理得有自己的活干。 */
export const echoTool: Tool = {
  name: 'echo',
  description: '回显 text 参数',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async execute(args) {
    const record = args as Record<string, unknown>
    const text = record.text
    if (typeof text !== 'string') return { content: 'missing text', isError: true }
    return { content: `echo: ${text}` }
  },
}

/** 建一个真的 LlmRuntime（假适配器挂上去）。 */
export async function makeRuntime(adapter: LlmAdapter): Promise<LlmRuntime> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx.llm
}

/** 跑一轮父代理的循环，收集事件。 */
export async function runParent(
  llm: LlmRuntime,
  tools: readonly Tool[],
  text: string,
  conversationId = 'c1',
): Promise<AgentLoopEvent[]> {
  const loop = new AgentLoop({ definition: PARENT, llm, tools })
  const events: AgentLoopEvent[] = []
  for await (const event of loop.run({ text }, { workspaceRoot: process.cwd(), conversationId })) {
    events.push(event)
  }
  return events
}

/** 工具结果里的正文。 */
export function toolResultTexts(events: readonly AgentLoopEvent[]): string[] {
  const out: string[] = []
  for (const event of events) {
    if (event.type === 'tool-result') out.push(event.result.content)
  }
  return out
}

/** 最后一条 assistant 文本。 */
export function lastAssistantText(events: readonly AgentLoopEvent[]): string {
  let text = ''
  for (const event of events) {
    if (event.type === 'text-delta') text += event.text
  }
  return text
}

/** 等一个条件成立：子代理起跑是异步的，断言得等它真的开始。 */
export async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
  }
  throw new Error('等待条件超时')
}
