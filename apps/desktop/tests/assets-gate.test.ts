/**
 * 渲染层资源服务的边界行为：不属于它的路径必须**回 404 并关闭连接**。
 *
 * 此前未匹配路径直接 return，socket 一直挂到对端超时：浏览器看到的是"加载卡住"
 * 而不是明确的 404，排障时分不清是路径错了还是服务没起来。写方法同理。
 *
 * 顺带钉住 public/ 原样拷贝那一份的缓存口径：品牌资产（cat.png / favicon-*.png）就走
 * 这条路，它们没有内容 hash，因此必须是 no-cache，否则升级后标签页仍吃旧图标。
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { RENDERER_MOUNT, RendererAssets } from '../electron/renderer-assets.ts'

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tiers = JSON.parse(readFileSync(join(DESKTOP, 'assets/brand/tiers.json'), 'utf8')) as {
  brand: string
  favicon: string
}

const tmpDirs: string[] = []
const started: RendererAssets[] = []

async function startAssets(): Promise<RendererAssets> {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-assets-gate-'))
  tmpDirs.push(root)
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>ok</title>', 'utf8')
  writeFileSync(join(root, 'assets', 'index-B6_i5xWc.js'), 'export const a = 1\n', 'utf8')
  // public/ 原样拷贝的品牌资产：真实文件名、真实字节
  for (const name of [tiers.brand, tiers.favicon]) {
    copyFileSync(join(DESKTOP, 'renderer/public', name), join(root, name))
  }
  const assets = await RendererAssets.start(root, { port: 0 })
  started.push(assets)
  return assets
}

afterEach(async () => {
  while (started.length > 0) await started.pop()?.close()
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

describe('资源服务的未路由路径', () => {
  it('不属于自己的路径回 404（响应会结束，不是挂起）', async () => {
    const assets = await startAssets()
    for (const path of ['/', '/nope', '/index.html', '/app.js', '/favicon.ico']) {
      const res = await fetch(`${assets.url}${path}`)
      expect(res.status).toBe(404)
      // 关键：body 能读完，说明连接被正常收尾而不是悬着。
      expect(await res.text()).toContain('not found')
    }
  })

  it('非 GET/HEAD 方法回 405 并带 allow 头', async () => {
    const assets = await startAssets()
    const res = await fetch(`${assets.url}${RENDERER_MOUNT}`, { method: 'POST' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, HEAD')
  })

  it('自己的路由不受影响：挂载点与 /assets 都照常 200', async () => {
    const assets = await startAssets()
    expect((await fetch(`${assets.url}${RENDERER_MOUNT}`)).status).toBe(200)
    expect((await fetch(`${assets.url}/assets/index-B6_i5xWc.js`)).status).toBe(200)
  })

  it('public/ 里的品牌资产在挂载点上真的能取到，且走 no-cache', async () => {
    const assets = await startAssets()
    for (const name of [tiers.brand, tiers.favicon]) {
      const res = await fetch(`${assets.url}${RENDERER_MOUNT}/${name}`)
      expect(res.status, name).toBe(200)
      // public 原样拷贝的文件名里没有内容 hash：永久缓存会把升级后的图标卡在旧版
      expect(res.headers.get('cache-control'), name).toBe('no-cache')
      expect(res.headers.get('content-type'), name).toBe('image/png')
    }
  })

  it('文件被删后回 404（不抛未捕获异常）', async () => {
    const assets = await startAssets()
    rmSync(join(assets.root, 'assets', 'index-B6_i5xWc.js'))
    const res = await fetch(`${assets.url}/assets/index-B6_i5xWc.js`)
    expect(res.status).toBe(404)
  })
})
