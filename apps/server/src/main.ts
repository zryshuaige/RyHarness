/**
 * 独立启动入口：`pnpm dev`（在 apps/server 目录）或 tsx apps/server/src/main.ts。
 * 优雅停机：SIGINT/SIGTERM → server.close()。
 *
 * ## 进程外入口
 *
 * 两个开关把服务端变成「外部程序可驱动的子进程」：
 * - `--rpc`：JSON-RPC（`@ryharness/api` 的 Remote 层）——给程序调；
 * - `--acp`：Agent Client Protocol——给编辑器用（把 RyHarness 当 agent）。
 *
 * 两种模式下 **stdout 只跑协议帧**，日志一律走 stderr（见 `rpc/stdio.ts`）。
 */
import { RyHarnessServer } from './app.ts'
import { envValue } from './env.ts'

const port = Number(envValue(process.env, 'PORT') ?? '32100')
const host = envValue(process.env, 'HOST') ?? '127.0.0.1'
const dataDir = envValue(process.env, 'DATA_DIR')
/** 进程外入口模式。 */
const rpcMode = process.argv.includes('--acp') ? 'acp' : process.argv.includes('--rpc') ? 'rpc' : undefined

const server = await RyHarnessServer.create({
  ...(Number.isFinite(port) ? { port } : {}),
  host,
  ...(dataDir === undefined ? {} : { dataDir }),
  ...(rpcMode === undefined ? {} : { rpcMode }),
})

// **日志走 stderr**：开了进程外入口时 stdout 是协议通道，日志写进去对端就解析炸了。
const log = (message: string): void => {
  process.stderr.write(`[ryharness] ${message}\n`)
}

// 进程外入口模式没有 HTTP 端口（协议走 stdio），这时没有地址可报。
if (server.url.length > 0) log(`server listening at ${server.url}`)
log(`data dir: ${server.dataDir}`)
if (rpcMode !== undefined) log(`进程外入口已开：${rpcMode}（stdio）`)
let shuttingDown = false
const shutdown = (): void => {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down…')
  server.close().then(
    () => {
      process.exit(0)
    },
    (error: unknown) => {
      process.stderr.write(`[ryharness] shutdown failed: ${String(error)}\n`)
      process.exit(1)
    },
  )
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
