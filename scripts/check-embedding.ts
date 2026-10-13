/**
 * 实测 SiliconFlow embedding：维度、耗时、可用性。
 * 读取 RyAgent/.env 的 SILICONFLOW_API_KEY；无 key 时提示跳过。
 *
 *   pnpm tsx scripts/check-embedding.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function loadDotEnv(): Record<string, string> {
  try {
    const text = readFileSync(join(import.meta.dirname, '..', '.env'), 'utf8')
    const vars: Record<string, string> = {}
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (match !== null && match[1] !== undefined && (match[2] ?? '').length > 0) {
        vars[match[1]] = (match[2] ?? '').replace(/^["']|["']$/g, '')
      }
    }
    return vars
  } catch {
    return {}
  }
}

const env = { ...loadDotEnv(), ...(process.env as Record<string, string>) }
const apiKey = env.SILICONFLOW_API_KEY
if (apiKey === undefined || apiKey.length === 0) {
  console.log('[check-embedding] 未找到 SILICONFLOW_API_KEY，跳过（降级路径：纯 FTS5）。')
  process.exit(0)
}

const MODELS = ['Qwen/Qwen3-Embedding-0.6B', 'Qwen/Qwen3-Embedding-4B']
for (const model of MODELS) {
  const started = Date.now()
  const response = await fetch('https://api.siliconflow.cn/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: ['用户养了一只橘猫，名叫布丁', '今天天气不错'] }),
  })
  const elapsed = Date.now() - started
  const body = (await response.json()) as { data?: { embedding: number[] }[]; error?: { message?: string } }
  if (response.ok && body.data !== undefined) {
    console.log(
      `[check-embedding] ${model}: dim=${body.data[0]!.embedding.length}, 批量=${body.data.length}, ${elapsed}ms ✓`,
    )
  } else {
    console.log(`[check-embedding] ${model}: 失败 ${body.error?.message ?? response.status}`)
  }
}
