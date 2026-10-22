// @vitest-environment node

/**
 * 渲染层静态资源服务：端口策略与条件请求。
 *
 * 两条都对着同一件事——「跨启动 origin 稳定」与「升级后一定拿到新产物」：
 * 端口每次都变等于每次冷启动把 Chromium 的 HTTP 与 V8 缓存清零；而把
 * index.html 也当不可变资源缓存住，则会让用户永远停在旧版本上。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type AddressInfo, createServer as createNetServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RENDERER_MOUNT, RendererAssets, type RendererAssetsOptions } from '../electron/renderer-assets.ts'

/** 造一份 vite 形状的 dist：入口 + assets/ 下带 hash 的分片 + public 原样拷贝的文件。 */
const fixtureDirs: string[] = []

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-assets-'))
  fixtureDirs.push(dir)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>RyHarness</title>')
  writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
  writeFileSync(join(dir, 'assets/index-B6_i5xWc.js'), 'export const a = 1\n')
  writeFileSync(join(dir, 'assets/index-Bbc7Hzqy.css'), '.a{color:red}\n')
  return dir
}

const opened: RendererAssets[] = []
const blockers: Server[] = []

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map((assets) => {
      return assets.close()
    }),
  )
  await Promise.all(
    blockers.splice(0).map((blocker) => {
      return new Promise<void>((resolvePromise) => {
        blocker.close(() => {
          resolvePromise()
        })
      })
    }),
  )
  while (fixtureDirs.length > 0) {
    rmSync(fixtureDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
  }
})

async function startAssets(dir: string, options?: RendererAssetsOptions): Promise<RendererAssets> {
  const assets = await RendererAssets.start(dir, options)
  opened.push(assets)
  return assets
}

/** 占住一个回环端口不放，用来把「期望端口被占」这条路径逼出来。 */
async function occupyPort(): Promise<number> {
  const blocker = createNetServer()
  blockers.push(blocker)
  await new Promise<void>((resolvePromise) => {
    blocker.listen(0, '127.0.0.1', () => {
      resolvePromise()
    })
  })
  return (blocker.address() as AddressInfo).port
}

/** 借一个刚释放的回环端口（起完即关，本机测试里不会有人抢）。 */
async function freePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolvePromise) => {
    probe.listen(0, '127.0.0.1', () => {
      resolvePromise()
    })
  })
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolvePromise) => {
    probe.close(() => {
      resolvePromise()
    })
  })
  return port
}

describe('渲染层资源服务端口', () => {
  it('固定端口优先：origin 跨启动不变，HTTP 与 V8 缓存才留得住', async () => {
    const port = await freePort()
    const assets = await startAssets(fixture(), { port })
    expect(assets.port).toBe(port)
    expect(assets.fellBack).toBe(false)
    expect(assets.url).toBe(`http://127.0.0.1:${port}`)
    // 真的伺服起来了：固定端口不是「声称」而是「绑上了」。
    expect((await fetch(`${assets.url}${RENDERER_MOUNT}`)).status).toBe(200)
  })

  it('期望端口被占用时回退随机，如实标记（origin 变了，但窗口照样起得来）', async () => {
    const taken = await occupyPort()
    const assets = await startAssets(fixture(), { port: taken })
    expect(assets.fellBack).toBe(true)
    expect(assets.port).not.toBe(taken)
    expect(assets.port).toBeGreaterThan(0)
    expect((await fetch(`${assets.url}${RENDERER_MOUNT}`)).status).toBe(200)
  })

  it('不给端口就是随机端口（多开与测试场景，行为与从前一致）', async () => {
    const assets = await startAssets(fixture())
    expect(assets.port).toBeGreaterThan(0)
    expect(assets.fellBack).toBe(false)
  })
})

describe('渲染层资源服务的缓存策略', () => {
  it('index.html 一律 no-cache 且始终 200（升级后必须拿新的）', async () => {
    const assets = await startAssets(fixture())
    const first = await fetch(`${assets.url}${RENDERER_MOUNT}`)
    expect(first.status).toBe(200)
    expect(first.headers.get('cache-control')).toBe('no-cache')
    expect(first.headers.get('etag')).toBeNull()
    expect(await first.text()).toContain('RyHarness')

    // 就算客户端拿着校验器来要 304，入口 HTML 也不给——它才是版本的新旧开关。
    const second = await fetch(`${assets.url}${RENDERER_MOUNT}`, { headers: { 'if-none-match': '*' } })
    expect(second.status).toBe(200)
    expect(second.headers.get('cache-control')).toBe('no-cache')
    expect(await second.text()).toContain('RyHarness')
  })

  it('带 hash 的产物 immutable + 强 ETag；If-None-Match 命中就回 304 不传 body', async () => {
    const assets = await startAssets(fixture())
    const url = `${assets.url}/assets/index-B6_i5xWc.js`

    const first = await fetch(url)
    expect(first.status).toBe(200)
    expect(first.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(first.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    const etag = first.headers.get('etag')
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/)
    expect(await first.text()).toContain('export const a = 1')

    const hit = await fetch(url, { headers: { 'if-none-match': etag as string } })
    expect(hit.status).toBe(304)
    expect(hit.headers.get('etag')).toBe(etag)
    expect(hit.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await hit.text()).toBe('')

    // 同一份产物换个访问路径（/app 前缀）拿到的是同一个 ETag，缓存不会裂成两份。
    const mounted = await fetch(`${assets.url}${RENDERER_MOUNT}/assets/index-B6_i5xWc.js`)
    expect(mounted.headers.get('etag')).toBe(etag)

    // 弱校验器与多标签列表按 GET 的弱比较规则命中。
    expect((await fetch(url, { headers: { 'if-none-match': `W/${etag}` } })).status).toBe(304)
    expect((await fetch(url, { headers: { 'if-none-match': `"0000000000000000", ${etag}` } })).status).toBe(304)

    const miss = await fetch(url, { headers: { 'if-none-match': '"0000000000000000"' } })
    expect(miss.status).toBe(200)
    expect(await miss.text()).toContain('export const a = 1')
  })

  it('内容寻址的 CSS 同样 immutable（不是只有 JS 走长缓存）', async () => {
    const assets = await startAssets(fixture())
    const res = await fetch(`${assets.url}/assets/index-Bbc7Hzqy.css`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(res.headers.get('etag')).not.toBeNull()
  })

  it('public 原样拷贝的无 hash 文件走 no-cache 且不发 ETag（不会被 immutable 卡在旧版）', async () => {
    const assets = await startAssets(fixture())
    const res = await fetch(`${assets.url}${RENDERER_MOUNT}/favicon.svg`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('etag')).toBeNull()
  })

  it('HEAD 与 404/403 保持原样（条件请求不能改坏既有路由）', async () => {
    const assets = await startAssets(fixture())
    const head = await fetch(`${assets.url}/assets/index-B6_i5xWc.js`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('etag')).not.toBeNull()

    expect((await fetch(`${assets.url}/assets/nope-B6_i5xWc.js`)).status).toBe(404)
    // ..%2f 过了 URL 规范化才还原成 ../，正好走到解出根目录外的那条 403 分支。
    expect((await fetch(`${assets.url}${RENDERER_MOUNT}/..%2f..%2fsecret.txt`)).status).toBe(403)
  })
})
