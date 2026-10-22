/**
 * SiliconFlow 冒烟脚本（tsx 运行）。
 *
 *   pnpm smoke:siliconflow
 *
 * 组装 cordis Context → 挂载 LlmRuntime + OpenAI 兼容适配器（siliconflow
 * 路由）→ 跑两个场景：
 *   (a) 流式对话，逐字打印 text-delta；
 *   (b) 一轮 tool calling（echo 工具），验证模型发起 tool_call 且参数 JSON
 *       组装完整。
 *
 * API key 读取顺序：环境变量 SILICONFLOW_API_KEY → RyHarness/.env（gitignored）。
 * 缺失时打印提示并以退出码 0 跳过（不是失败）。模型可用 SILICONFLOW_MODEL
 * 覆盖，默认 deepseek-ai/DeepSeek-V4-Pro。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@ryharness/cordis'
import type { StreamChunk, ToolCallBlock } from '@ryharness/llm'
import LlmRuntime, { createUserMessage } from '@ryharness/llm'
import { apply } from '@ryharness/llm-openai'

// .env 交给 Node 标准库解析（引擎要求 ^22.19||>=24），不再各写一份正则。
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '.env'))
} catch {
  // 没有 .env 就只用环境变量。
}
const env = process.env as Record<string, string>
const apiKey = env.SILICONFLOW_API_KEY
if (apiKey === undefined || apiKey.length === 0) {
  console.log('[smoke] 未找到 SILICONFLOW_API_KEY（环境变量或 RyHarness/.env），跳过 SiliconFlow 冒烟。')
  console.log('[smoke] 设置后重试：pnpm smoke:siliconflow')
  process.exit(0)
}

const model = env.SILICONFLOW_MODEL ?? 'deepseek-ai/DeepSeek-V4-Pro'
const provider = 'siliconflow'

const ctx = new Context()
await ctx.plugin(LlmRuntime)
apply(ctx, {
  providers: {
    [provider]: {
      baseURL: 'https://api.siliconflow.cn/v1',
      apiKey,
      displayName: 'SiliconFlow',
      models: [{ id: model, contextWindow: 64_000 }],
    },
  },
})

try {
  // ---- 场景 (a)：流式对话 ----
  console.log(`[smoke] (a) 流式对话：${provider} / ${model}`)
  const stream = ctx.llm.stream({
    provider,
    model,
    messages: [
      createUserMessage({ content: [{ type: 'text', text: '用一句中文介绍你自己。' }], source: { kind: 'user' } }),
    ],
  })
  let text = ''
  let usage: Extract<StreamChunk, { type: 'usage' }>['usage'] | undefined
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      process.stdout.write(chunk.text)
      text += chunk.text
    } else if (chunk.type === 'usage') {
      usage = chunk.usage
    } else if (chunk.type === 'finish') {
      console.log(`\n[smoke] finish: ${chunk.reason.kind}`)
    }
  }
  if (text.length === 0) throw new Error('场景 (a) 未收到任何文本')
  console.log(
    `[smoke] (a) 通过：收到 ${text.length} 字符文本` +
      (usage === undefined
        ? ''
        : `，usage input=${usage.inputTokens} output=${usage.outputTokens} total=${usage.totalTokens}`),
  )

  // ---- 场景 (b)：一轮 tool calling ----
  console.log('[smoke] (b) tool calling：声明 echo 工具，要求模型调用它')
  const toolStream = ctx.llm.stream({
    provider,
    model,
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: '请调用 echo 工具，参数 text 设为 "smoke-ok"。不要输出其他内容。' }],
        source: { kind: 'user' },
      }),
    ],
    tools: [
      {
        name: 'echo',
        description: '回显输入文本',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: '要回显的文本' } },
          required: ['text'],
        },
      },
    ],
  })
  const toolCalls: ToolCallBlock[] = []
  let toolFinish: Extract<StreamChunk, { type: 'finish' }>['reason'] | undefined
  for await (const chunk of toolStream) {
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') toolCalls.push(chunk.block)
    if (chunk.type === 'finish') toolFinish = chunk.reason
  }
  const call = toolCalls[0]
  if (call === undefined) throw new Error(`场景 (b) 模型未发起 tool_call（finish=${toolFinish?.kind}）`)
  const args = JSON.parse(call.arguments) as { text?: string }
  if (typeof args.text !== 'string' || args.text.length === 0) {
    throw new Error(`场景 (b) tool_call 参数 JSON 不完整：${call.arguments}`)
  }
  console.log(`[smoke] (b) 通过：tool_call name=${call.name} id=${call.id} args=${call.arguments}`)
  console.log('[smoke] 全部场景通过。')
} catch (error) {
  console.error('[smoke] 失败:', error)
  process.exitCode = 1
}
