/**
 * 独立启动入口：`pnpm dev`（在 apps/server 目录）或 tsx apps/server/src/main.ts。
 * 优雅停机：SIGINT/SIGTERM → server.close()。
 */
import { RyAgentServer } from './app.ts'

const port = Number(process.env.RYAGENT_PORT ?? '32100')
const host = process.env.RYAGENT_HOST ?? '127.0.0.1'
const dataDir = process.env.RYAGENT_DATA_DIR

const server = await RyAgentServer.create({
  ...Number.isFinite(port) ? { port } : {},
  host,
  ...dataDir === undefined ? {} : { dataDir },
})

console.log(`[ryagent] server listening at ${server.url}`)
console.log(`[ryagent] data dir: ${server.dataDir}`)

const shutdown = (): void => {
  console.log('\n[ryagent] shutting down…')
  server.close().then(() => {
    process.exit(0)
  }, (error: unknown) => {
    console.error('[ryagent] shutdown failed:', error)
    process.exit(1)
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
