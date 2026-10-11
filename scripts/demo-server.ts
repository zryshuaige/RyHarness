/**
 * M4a 手动验证脚本：以真实配置（providers.json）启动本地后端，
 * 打几个只读端点后优雅停机。真实 SiliconFlow 对话路径需
 * SILICONFLOW_API_KEY，由 M1 的 smoke 脚本覆盖。
 *
 *   pnpm demo:server
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyAgentServer } from '@ryagent/server'

const dataDir = mkdtempSync(join(tmpdir(), 'ryagent-demo-server-'))

try {
  const server = await RyAgentServer.create({ port: 0, dataDir })
  console.log(`[demo] server at ${server.url} (data: ${dataDir})`)

  const templates = await (await fetch(`${server.url}/api/agent-templates`)).json() as { templates: { key: string; name: string }[] }
  console.log(`[demo] templates: ${templates.templates.map((t) => { return t.name }).join(' / ')}`)

  const providers = await (await fetch(`${server.url}/api/providers`)).json() as { providers: { id: string; models: { id: string }[] }[] }
  for (const provider of providers.providers) {
    console.log(`[demo] provider ${provider.id}: ${provider.models.map((m) => { return m.id }).join(', ')}`)
  }

  const agents = await (await fetch(`${server.url}/api/agents`)).json() as { agents: { id: string; name: string; isBuiltin: boolean }[] }
  console.log(`[demo] seeded agents: ${agents.agents.map((a) => { return `${a.name}${a.isBuiltin ? '(builtin)' : ''}` }).join(', ')}`)

  const conversations = await (await fetch(`${server.url}/api/conversations`)).json() as { conversations: unknown[] }
  console.log(`[demo] conversations: ${conversations.conversations.length}`)

  console.log('[demo] 只读端点全部正常；真实对话需 SILICONFLOW_API_KEY（见 pnpm smoke:siliconflow）。')
  await server.close()
  console.log('[demo] 优雅停机完成。')
} finally {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
}
