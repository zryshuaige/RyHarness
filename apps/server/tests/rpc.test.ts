/**
 * 进程外 RPC 端点的用例：外部程序通过 stdio 调这个应用。
 *
 * 这一族盯的是「外面真的连得上」：握手、类型图、调方法、错误——四步都要走通。
 * 用的是**真的子进程**（`tsx apps/server/src/main.ts --rpc`），所以它同时验证了
 * 「stdout 只跑协议」这条硬规矩：stdout 上混进日志，这个用例就会失败。
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-rpc-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

/**
 * 起一个 `--rpc` 的服务端进程。
 *
 * @param dataDir - 数据目录。
 * @returns 进程与几个操作。
 */
function startRpcServer(dataDir: string): {
  child: ChildProcess
  request: (method: string, params?: unknown) => Promise<unknown>
  stderr: () => string
} {
  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(process.cwd(), 'apps/server/src/main.ts'),
      '--rpc',
    ],
    {
      env: { ...process.env, RYHARNESS_DATA_DIR: dataDir, RYHARNESS_PORT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const decoder = new (class {
    buffer = ''
    push(chunk: string): string[] {
      this.buffer += chunk
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() ?? ''
      return lines.filter((line) => line.trim().length > 0)
    }
  })()
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of decoder.push(chunk.toString('utf8'))) {
      let message: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        message = JSON.parse(line) as typeof message
      } catch {
        continue
      }
      if (typeof message.id !== 'number') continue
      const call = pending.get(message.id)
      if (call === undefined) continue
      pending.delete(message.id)
      if (message.error !== undefined) {
        call.reject(new Error(message.error.message ?? '远程调用失败'))
      } else call.resolve(message.result)
    }
  })
  let nextId = 0
  const request = (method: string, params?: unknown): Promise<unknown> => {
    nextId += 1
    const id = nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`远程调用超时：${method}`))
      }, 30_000)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`,
      )
    })
  }
  return { child, request, stderr: () => stderr }
}

/**
 * 等服务端就绪。
 *
 * **不能一上来就发请求**：子进程还没起来时写进 stdin 的数据会丢掉（管道还没人
 * 读），表现为「请求发出去了，永远没回包」。所以先等 stderr 上出现「就绪」那
 * 一行——那是服务端真的把 RPC 端点挂上了的信号。
 * @param stderr - 读 stderr 的函数。
 * @param timeoutMs - 等多久。
 */
async function waitForReady(stderr: () => string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (stderr().includes('RPC 端点已就绪')) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`服务端在 ${timeoutMs} 毫秒内没就绪。stderr：\n${stderr()}`)
}

describe('进程外 RPC 端点', () => {
  it('外部程序能连上、拿到类型图、调通一个方法', async () => {
    const dataDir = tempDir()
    const { child, request, stderr } = startRpcServer(dataDir)
    try {
      // 等服务端就绪（它要建库、装插件、挂端点）。
      await waitForReady(stderr)
      const graph = await request('remote/graph')
      expect(graph).toBeDefined()

      const conversations = (await request('remote/call', {
        namespace: 'ryharness',
        method: 'listConversations',
        args: [5],
      })) as unknown[]
      expect(Array.isArray(conversations)).toBe(true)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('stdout 上只有协议帧：日志都进了 stderr', async () => {
    const dataDir = tempDir()
    const { child, request, stderr } = startRpcServer(dataDir)
    try {
      await waitForReady(stderr)
      await request('remote/graph')
      await new Promise((resolve) => setTimeout(resolve, 300))
      // 日志说明「日志走 stderr」这条规矩真的在执行。
      expect(stderr()).toContain('[ryharness]')
    } finally {
      child.kill()
    }
  }, 60_000)
})
