/**
 * 工具结果的落库形态：正文、失败标记、以及"标记不进模型上下文"。
 *
 * 历史回放要能看见"当时它读了什么、错在哪"，前提是那两样东西真的在库里——实时事件
 * 带 isError，落库时丢掉它，回看就只剩一行"已读文件"。另一半同样重要：失败标记是给
 * 渲染层的，不该随历史回填给模型（它对模型没有新增信息，还白占输入预算）。
 */

import type { Tool } from '@ryharness/agent'
import { brandString } from '@ryharness/brand'
import type { GenerateOptions, LlmRuntime, StreamChunk, ToolCallId } from '@ryharness/llm'
import { SessionCoordinator, SessionStore, TOOL_ERROR_BLOCK_TYPE } from '@ryharness/session'
import { describe, expect, it } from 'vitest'

const AGENT = {
  id: 'a1',
  name: 'Ryen',
  systemPrompt: '你是测试 agent。',
  provider: 'mock',
  model: 'mock-model',
  tools: ['flaky'],
}

type Step = 'tool' | 'final'

/** 两步脚本：先要一次工具调用，再收尾成一句话。 */
function scriptedLlm(steps: Step[]): { llm: LlmRuntime; requests: GenerateOptions[] } {
  const requests: GenerateOptions[] = []
  let index = 0
  const llm = {
    stream(options: GenerateOptions) {
      requests.push({ ...options, messages: [...options.messages] })
      const step = steps[index++] ?? 'final'
      const callId = brandString<ToolCallId>('call-1')
      const chunks: StreamChunk[] =
        step === 'tool'
          ? [
              {
                type: 'block-end',
                index: 0,
                block: { type: 'tool-call', id: callId, name: 'flaky', arguments: '{"path":"a.ts"}' },
              },
              { type: 'finish', reason: { kind: 'tool-calls' } },
            ]
          : [
              { type: 'text-delta', index: 0, text: '看完了' },
              { type: 'block-end', index: 0, block: { type: 'text', text: '看完了' } },
              { type: 'finish', reason: { kind: 'stop' } },
            ]
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield* chunks
      })()
    },
  } as unknown as LlmRuntime
  return { llm, requests }
}

/** 返回失败的工具（模拟"文件读不到"这一类现场）。 */
function failingTool(): Tool {
  return {
    name: 'flaky',
    description: '读文件',
    parameters: { type: 'object' },
    async execute() {
      throw new Error('ENOENT: no such file or directory')
    },
  }
}

async function runTurn(isError: boolean): Promise<{
  store: SessionStore
  conversationId: string
  requests: GenerateOptions[]
}> {
  const store = new SessionStore(':memory:')
  store.upsertAgent(AGENT)
  const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
  const { llm, requests } = scriptedLlm(['tool', 'final'])
  const tool: Tool = failingTool()
  if (!isError) {
    tool.execute = async () => {
      return { content: 'export const a = 1' }
    }
  }
  const coordinator = new SessionCoordinator({ store, llm, tools: [tool] })
  for await (const _ of coordinator.chatDirect(conversation.id, 'a1', '看下 a.ts', { workspaceRoot: process.cwd() })) {
    /* drain */
  }
  return { store, conversationId: conversation.id, requests }
}

describe('工具结果的落库形态', () => {
  it('失败的工具结果带失败标记块，正文原样留着', async () => {
    const { store, conversationId } = await runTurn(true)
    const toolRows = store.listMessages(conversationId).filter((row) => {
      return row.toolCallId !== undefined
    })
    expect(toolRows).toHaveLength(1)
    const blocks = toolRows[0]?.contentBlocks as { type: string; text?: string }[]
    expect(
      blocks.map((block) => {
        return block.type
      }),
    ).toContain(TOOL_ERROR_BLOCK_TYPE)
    // 正文（错误原文）是回放时展开能看到的东西，不能因为加了标记就丢。
    expect(messageTextOf(toolRows[0]?.contentBlocks as { type: string; text?: string }[])).toContain('ENOENT')
    store.close()
  })

  it('成功的工具结果不写失败标记块', async () => {
    const { store, conversationId } = await runTurn(false)
    const toolRows = store.listMessages(conversationId).filter((row) => {
      return row.toolCallId !== undefined
    })
    expect(toolRows).toHaveLength(1)
    expect(messageTextOf(toolRows[0]?.contentBlocks as { type: string; text?: string }[])).toContain(
      'export const a = 1',
    )
    expect(
      ((toolRows[0]?.contentBlocks ?? []) as { type: string }[]).some((block) => {
        return block.type === TOOL_ERROR_BLOCK_TYPE
      }),
    ).toBe(false)
    store.close()
  })

  it('失败标记不回填给模型：重建历史里只有正文块', async () => {
    const { store, conversationId } = await runTurn(true)
    // 第二轮请求的历史就是重建出来的消息：标记块必须在 modelBlocks 里被剔掉，
    // 否则它会作为未知块被塞进供应商请求（要么被拒，要么白占输入预算）。
    const { llm, requests } = scriptedLlm(['final'])
    const coordinator = new SessionCoordinator({ store, llm, tools: [] })
    for await (const _ of coordinator.chatDirect(conversationId, 'a1', '继续', { workspaceRoot: process.cwd() })) {
      /* drain */
    }
    const history = requests[0]?.messages ?? []
    const replayed = history.flatMap((message) => {
      return message.content.map((block) => {
        return block.type
      })
    })
    expect(replayed).not.toContain(TOOL_ERROR_BLOCK_TYPE)
    expect(
      history.some((message) => {
        return message.role === 'tool'
      }),
    ).toBe(true)
    store.close()
  })
})

function messageTextOf(blocks: { type: string; text?: string }[]): string {
  return blocks
    .filter((block) => {
      return block.type === 'text'
    })
    .map((block) => {
      return block.text ?? ''
    })
    .join('\n')
}
