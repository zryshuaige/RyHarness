/**
 * 进程外链路的自检端点：`GET /api/rpc/selfcheck`。
 *
 * 这一族盯的是「SDK 到底能不能连上这个服务端」。
 *
 * **为什么以前没人跑过它**：端点建好之后没有测试，于是「服务端起自己的 --rpc
 * 子进程」那条路——源码下 node 跑不了 .ts、打包后路径不存在、子进程还要抢
 * 32100 端口——三处都失败，而这个端点在真实产品里**必然**返回失败。建好但没
 * 跑过的东西就是这样：坏了也没人知道。
 *
 * 现在自检走**进程内的内存管道**：请求真的走 JSON-RPC 帧、真的过网关、真的按
 * 人写的方法签名注解校验参数——但不需要子进程、不依赖 tsx、不依赖构建产物。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

/** 起一个服务端。 */
async function startServer(): Promise<RyHarnessServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ryharness-selfcheck-'))
  tmpDirs.push(dataDir)
  return RyHarnessServer.create({ port: 0, dataDir, memory: null, evolution: null })
}

describe('进程外链路的自检', () => {
  it('SDK 能连上这个服务端，拿到类型图', async () => {
    const server = await startServer()
    try {
      const response = await fetch(`${server.url}/api/rpc/selfcheck`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { ok: boolean; serviceCount: number; error?: string }
      expect(body.ok).toBe(true)
      // 类型图里至少有一个服务（RyHarness 自己那个）。
      expect(body.serviceCount).toBeGreaterThan(0)
      expect(body.error).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it('这个端点不占 HTTP 端口：进程外入口模式（--rpc）只走 stdio', async () => {
    // 端口被占时 listen 失败是没有 error 监听的**未捕获异常**，进程直接消失。
    // 自检那条路以前就踩在这上面：子进程要抢 32100，而主服务正占着它。
    const server = await RyHarnessServer.create({
      port: 0,
      dataDir: (() => {
        const dir = mkdtempSync(join(tmpdir(), 'ryharness-rpcmode-'))
        tmpDirs.push(dir)
        return dir
      })(),
      memory: null,
      evolution: null,
      rpcMode: 'rpc',
    })
    try {
      // 没监听端口，所以拿不到地址——但也不能因为拿不到就抛异常。
      expect(server.url).toBe('')
    } finally {
      await server.close()
    }
  })
})
