/**
 * 产物预览的文件端点：GET /api/files/:name/info（元数据 + 绝对路径）与
 * GET /api/files/:name/raw（原始字节，供内嵌预览渲染器直接消费）。
 *
 * 两条路由都比既有的下载路由多走一道 `resolveTarget`——工作区里一个指向外部的
 * 文件符号链接，词法的叶子名校验完全看不出来。这里把「看不见的那一半边界」钉住。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@ryharness/cordis'
import type { GenerateOptions, StreamChunk } from '@ryharness/llm'
import { LlmAdapter } from '@ryharness/llm'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []
const running: RyHarnessServer[] = []

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close()
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

class QuietAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'Quiet' }
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

async function startServer(): Promise<{ base: string; artifactsDir: string; workspaceRoot: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ryharness-preview-'))
  tmpDirs.push(dataDir)
  const server = await RyHarnessServer.create({
    port: 0,
    dataDir,
    memory: null,
    evolution: null,
    consolidationIntervalMs: 0,
    mountLlm: (ctx: Context) => {
      ctx.llm.registerAdapter(['mock'], new QuietAdapter())
    },
  })
  running.push(server)
  const workspaceRoot = join(dataDir, 'workspace')
  const artifactsDir = join(workspaceRoot, '.ryharness-artifacts')
  mkdirSync(artifactsDir, { recursive: true })
  return { base: server.url, artifactsDir, workspaceRoot }
}

describe('产物预览端点', () => {
  it('info 回绝对路径与字节数，raw 回同样的字节并按扩展名给 MIME', async () => {
    const { base, artifactsDir } = await startServer()
    writeFileSync(join(artifactsDir, 'report.md'), '# 周报', 'utf8')

    const info = await fetch(`${base}/api/files/report.md/info`)
    expect(info.status).toBe(200)
    expect(await info.json()).toEqual({
      name: 'report.md',
      path: join(artifactsDir, 'report.md'),
      size: 8,
      mime: 'text/markdown',
    })

    const raw = await fetch(`${base}/api/files/report.md/raw`)
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-type')).toContain('text/markdown')
    expect(raw.headers.get('content-disposition')).toContain('inline')
    expect(await raw.text()).toBe('# 周报')
  })

  it('?download=1 走附件语义（内嵌预览不能替用户决定下载）', async () => {
    const { base, artifactsDir } = await startServer()
    writeFileSync(join(artifactsDir, 'a.txt'), 'hello', 'utf8')

    const response = await fetch(`${base}/api/files/a.txt/raw?download=1`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain('attachment')
    expect(response.headers.get('content-disposition')).toContain(encodeURIComponent('a.txt'))
  })

  it('名字不是叶子名一律 400', async () => {
    const { base } = await startServer()
    // `%2E%2E` 会被 URL 解析器在到达路由之前就归一成一段 `..` 并弹掉，
    // 因此它落到别的路由上；穿越防线仍是叶子名校验，这里只钉它挡得住的那两种写法。
    for (const path of ['..%2Fryharness.db', 'a%2Fb.txt', '..%5Cwindows']) {
      const info = await fetch(`${base}/api/files/${path}/info`)
      const raw = await fetch(`${base}/api/files/${path}/raw`)
      expect(info.status, path).toBe(400)
      expect(raw.status, path).toBe(400)
    }
  })

  it('文件不存在是 404，不是 200 空体', async () => {
    const { base } = await startServer()
    expect((await fetch(`${base}/api/files/nope.txt/info`)).status).toBe(404)
    expect((await fetch(`${base}/api/files/nope.txt/raw`)).status).toBe(404)
  })

  it('指向工作区外的符号链接被真实路径闸挡住（叶子名校验看不出来的那种）', async () => {
    const { base, artifactsDir } = await startServer()
    const outsideDir = mkdtempSync(join(tmpdir(), 'ryharness-preview-outside-'))
    tmpDirs.push(outsideDir)
    const secret = join(outsideDir, 'secret.txt')
    writeFileSync(secret, '不该被读到', 'utf8')
    symlinkSync(secret, join(artifactsDir, 'leak.txt'))

    // 三条产物路由必须给同一个答案：下载那条此前只做叶子名校验，软链照样把
    // 工作区外的文件原样吐出去。
    for (const suffix of ['', 'info', 'raw']) {
      const response = await fetch(`${base}/api/files/leak.txt${suffix === '' ? '' : `/${suffix}`}`)
      expect(response.status, suffix).toBe(403)
      expect(await response.text()).not.toContain('不该被读到')
    }
  })

  it('超出预览上限直接 413：内嵌预览要把整份读进渲染层内存', async () => {
    const { base, artifactsDir } = await startServer()
    writeFileSync(join(artifactsDir, 'big.bin'), Buffer.alloc(32 * 1024 * 1024 + 1))

    expect((await fetch(`${base}/api/files/big.bin/info`)).status).toBe(200)
    const raw = await fetch(`${base}/api/files/big.bin/raw`)
    expect(raw.status).toBe(413)
    expect((await raw.json()).code).toBe('PAYLOAD_TOO_LARGE')
  })
})
