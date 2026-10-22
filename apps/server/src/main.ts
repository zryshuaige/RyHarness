/**
 * 独立启动入口：`pnpm dev`（在 apps/server 目录）或 tsx apps/server/src/main.ts。
 * 优雅停机：SIGINT/SIGTERM → server.close()。
 */
import { RyHarnessServer } from './app.ts'
import { envValue } from './env.ts'

const port = Number(envValue(process.env, 'PORT') ?? '32100')
const host = envValue(process.env, 'HOST') ?? '127.0.0.1'
const dataDir = envValue(process.env, 'DATA_DIR')

const server = await RyHarnessServer.create({
  ...(Number.isFinite(port) ? { port } : {}),
  host,
  ...(dataDir === undefined ? {} : { dataDir }),
})

console.log(`[ryharness] server listening at ${server.url}`)
console.log(`[ryharness] data dir: ${server.dataDir}`)

let shuttingDown = false
const shutdown = (): void => {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\n[ryharness] shutting down…')
  server.close().then(
    () => {
      process.exit(0)
    },
    (error: unknown) => {
      console.error('[ryharness] shutdown failed:', error)
      process.exit(1)
    },
  )
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
