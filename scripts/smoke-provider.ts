/**
 * 真实供应商冒烟脚本（tsx 运行）。
 *
 *   pnpm smoke:provider
 *
 * 组装 cordis Context → 挂载 LlmRuntime + OpenAI 兼容适配器 → 跑两个场景：
 *   (a) 流式对话，逐字打印 text-delta；
 *   (b) 一轮 tool calling（echo 工具），验证模型发起 tool_call 且参数 JSON
 *       组装完整。
 *
 * ## 为什么从"只测 SiliconFlow"改成"测任意一家"
 *
 * 上一版把供应商写死在脚本里，于是每换一个模型厂商都得改一遍脚本才能验。
 * 而本仓的模型目录是**逐家按官方文档核实**的（model id、思考参数方言、上下文
 * 窗口），这些声明会过期——MiniMax 那一档就因为官方把 `M3.1-Flash-Preview` 转正成
 * `MiniMax-M3.1-Flash`，旧 id 直接 404。目录里的每一条都该有一条**真跑过**的路。
 *
 * 配置从环境变量读（key 不进仓库）：
 * - `RYHARNESS_SMOKE_PROVIDER` 供应商名，默认 `siliconflow`；
 * - `RYHARNESS_SMOKE_MODEL`     模型 id，默认按供应商取；
 * - `RYHARNESS_SMOKE_API_KEY`   凭据（也兼容 `SILICONFLOW_API_KEY`）；
 * - `RYHARNESS_SMOKE_BASE_URL`  端点，默认取该供应商的预设；
 * - `RYHARNESS_SMOKE_EFFORT`    思考档位（low/medium/high/xhigh/max），不给就不发。
 *
 * 端点与模型默认值都取自 `apps/server/src/config.ts` 的**预设表**——也就是界面上
 * "从预设建一家"用的那份。脚本跟界面读同一份事实，就不会出现"脚本里能跑、界面上
 * 建出来却跑不了"。
 */
import { join } from 'node:path'
import { Context } from '@ryharness/cordis'
import type { StreamChunk, ToolCallBlock } from '@ryharness/llm'
import LlmRuntime, { ReasoningEffortId as brandReasoningEffortId, createUserMessage } from '@ryharness/llm'
import { apply } from '@ryharness/llm-openai'
import { PROVIDER_PRESETS } from '../apps/server/src/config.ts'

// .env 交给 Node 标准库解析（引擎要求 ^22.19||>=24），不再各写一份正则。
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '.env'))
} catch {
  // 没有 .env 就只用环境变量。
}
const env = process.env as Record<string, string>

const provider = env.RYHARNESS_SMOKE_PROVIDER ?? 'siliconflow'
const preset = PROVIDER_PRESETS.find((candidate) => {
  return candidate.id === provider
})
const apiKey = env.RYHARNESS_SMOKE_API_KEY ?? env[`${provider.toUpperCase()}_API_KEY`] ?? env.SILICONFLOW_API_KEY
if (apiKey === undefined || apiKey.length === 0) {
  console.log(`[smoke] 未找到 ${provider} 的凭据，跳过。`)
  console.log('[smoke] 设置 RYHARNESS_SMOKE_API_KEY（或该供应商的 <NAME>_API_KEY）后重试。')
  process.exit(0)
}

const model = env.RYHARNESS_SMOKE_MODEL ?? preset?.defaultModel ?? preset?.models[0]
if (model === undefined) {
  console.log(`[smoke] 供应商 ${provider} 没有可用模型（预设里也没有），跳过。`)
  process.exit(0)
}
const baseURL = env.RYHARNESS_SMOKE_BASE_URL ?? preset?.baseUrl
if (baseURL === undefined) {
  console.log(`[smoke] 供应商 ${provider} 没有预设端点，请用 RYHARNESS_SMOKE_BASE_URL 指定。`)
  process.exit(0)
}
/** 思考档位：只在预设声明支持时才发（发错方言 = 整轮 400）。 */
const effort = env.RYHARNESS_SMOKE_EFFORT
const reasoningControl = preset?.reasoningControl
/** 档位 id 是品牌类型：只能由它自己的构造函数造，不能拿裸字符串冒充。 */
const effortId = effort === undefined ? undefined : brandReasoningEffortId(effort)

const ctx = new Context()
await ctx.plugin(LlmRuntime)
apply(ctx, {
  providers: {
    [provider]: {
      baseURL,
      apiKey,
      displayName: preset?.displayName ?? provider,
      models: [{ id: model, contextWindow: 64_000 }],
      ...(reasoningControl === undefined ? {} : { reasoningControl }),
    },
  },
})

try {
  // ---- 场景 (a)：流式对话 ----
  console.log(`[smoke] (a) 流式对话：${provider} / ${model}${effort === undefined ? '' : ` / effort=${effort}`}`)
  const stream = ctx.llm.stream({
    provider,
    model,
    messages: [
      createUserMessage({ content: [{ type: 'text', text: '用一句中文介绍你自己。' }], source: { kind: 'user' } }),
    ],
    ...(effortId === undefined ? {} : { reasoningEffort: effortId }),
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
    ...(effortId === undefined ? {} : { reasoningEffort: effortId }),
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
