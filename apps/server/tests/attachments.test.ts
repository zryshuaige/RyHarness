/**
 * 附件上传（POST /api/conversations/:id/files）与产物下载（GET /api/files/:name）。
 *
 * 走真实 HTTP + 真实落盘：上传的字节必须**逐字节**回到磁盘上（base64 过一趟
 * JSON 再解回来，最容易在这里悄悄少几个字节），且文件名消毒与体积上限要真的
 * 挡住写入，而不只是回一个 4xx。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@ryagent/cordis'
import type { GenerateOptions, StreamChunk } from '@ryagent/llm'
import { LlmAdapter } from '@ryagent/llm'
import { RyAgentServer } from '@ryagent/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []
const running: RyAgentServer[] = []

function tempDataDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ryagent-attach-${prefix}-`))
  tmpDirs.push(dir)
  return dir
}

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

async function startServer(): Promise<{ server: RyAgentServer; dataDir: string; artifactsDir: string }> {
  const dataDir = tempDataDir('server')
  const server = await RyAgentServer.create({
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
  return { server, dataDir, artifactsDir: join(dataDir, 'workspace', '.ryagent-artifacts') }
}

async function newConversation(server: RyAgentServer): Promise<string> {
  const response = await fetch(`${server.url}/api/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'direct', agentId: 'ryen' }),
  })
  const body = (await response.json()) as { conversation: { id: string } }
  return body.conversation.id
}

async function upload(
  server: RyAgentServer,
  conversationId: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.url}/api/conversations/${conversationId}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** 任意长度的二进制（覆盖 base64 里 +/ 与末尾填充的所有情况）。 */
function binaryBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 37 + 11) % 256
  return bytes
}

describe('附件上传', () => {
  it('落盘字节与上传内容逐字节一致，回执 {name,size,mime} 与产物卡片同构', async () => {
    const { server, artifactsDir } = await startServer()
    const conversationId = await newConversation(server)
    const bytes = binaryBytes(5_000)

    const { status, body } = await upload(server, conversationId, {
      name: 'note.md',
      mime: 'text/markdown',
      data: Buffer.from(bytes).toString('base64'),
    })

    expect(status).toBe(200)
    expect(body).toEqual({ name: 'note.md', size: 5_000, mime: 'text/markdown' })
    const onDisk = readFileSync(join(artifactsDir, 'note.md'))
    expect(Buffer.compare(onDisk, Buffer.from(bytes))).toBe(0)
    expect(onDisk.byteLength).toBe(5_000)
  })

  it('上传后能直接用回执里的 name 从 GET /api/files/:name 下载回来', async () => {
    const { server } = await startServer()
    const conversationId = await newConversation(server)
    const { body } = await upload(server, conversationId, {
      name: 'hello.txt',
      mime: 'text/plain',
      data: Buffer.from('你好，世界', 'utf8').toString('base64'),
    })

    const response = await fetch(`${server.url}/api/files/${String(body.name)}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(await response.text()).toBe('你好，世界')
  })

  it('未给 mime 时按扩展名推断；mime 不是 type/subtype 也退回推断值', async () => {
    const { server, artifactsDir } = await startServer()
    const conversationId = await newConversation(server)

    const inferred = await upload(server, conversationId, {
      name: 'a.csv',
      data: Buffer.from('a,b\n1,2\n').toString('base64'),
    })
    expect(inferred.body.mime).toBe('text/csv')

    const bogus = await upload(server, conversationId, {
      name: 'b.csv',
      mime: 'not a mime <script>',
      data: Buffer.from('a,b\n').toString('base64'),
    })
    expect(bogus.body.mime).toBe('text/csv')
    expect(existsSync(join(artifactsDir, 'b.csv'))).toBe(true)
  })

  it('同名上传不覆盖已有文件：第二个落成 -2 后缀，旧的字节保持原样', async () => {
    const { server, artifactsDir } = await startServer()
    const conversationId = await newConversation(server)
    const first = await upload(server, conversationId, {
      name: 'report.txt',
      data: Buffer.from('first', 'utf8').toString('base64'),
    })
    const second = await upload(server, conversationId, {
      name: 'report.txt',
      data: Buffer.from('second', 'utf8').toString('base64'),
    })
    const third = await upload(server, conversationId, {
      name: 'report.txt',
      data: Buffer.from('third', 'utf8').toString('base64'),
    })

    expect(first.body.name).toBe('report.txt')
    expect(second.body.name).toBe('report-2.txt')
    expect(third.body.name).toBe('report-3.txt')
    expect(readFileSync(join(artifactsDir, 'report.txt'), 'utf8')).toBe('first')
    expect(readFileSync(join(artifactsDir, 'report-2.txt'), 'utf8')).toBe('second')
  })

  it('文件名只放行叶子名：路径穿越与控制字符一律 400，且什么都没落盘', async () => {
    const { server, artifactsDir } = await startServer()
    const conversationId = await newConversation(server)
    const data = Buffer.from('x', 'utf8').toString('base64')

    for (const name of [
      '../escape.txt',
      'sub/dir.txt',
      '..\\escape.txt',
      'C:\\Windows\\escape.txt',
      '..',
      '.',
      'bad\u0000name.txt',
      'bad\u001fname.txt',
    ]) {
      const { status, body } = await upload(server, conversationId, { name, data })
      expect(status, `name=${JSON.stringify(name)}`).toBe(400)
      expect(typeof body.error).toBe('string')
    }
    expect(existsSync(join(server.workspaceRoot, 'escape.txt'))).toBe(false)
    expect(existsSync(artifactsDir)).toBe(false)
  })

  it('base64 载荷非法（截断、非字符集、非规范尾部）一律 400', async () => {
    const { server, artifactsDir } = await startServer()
    const conversationId = await newConversation(server)

    for (const data of ['QQ', 'not base64!!', 'QR==', 'QUJD=REY']) {
      const { status } = await upload(server, conversationId, { name: 'x.txt', data })
      expect(status, `data=${data}`).toBe(400)
    }
    expect(existsSync(artifactsDir)).toBe(false)
  })

  it('data: URL 前缀与换行都能解出来（同一份字节不因编码写法不同而变）', async () => {
    const { server, artifactsDir } = await startServer()
    const conversationId = await newConversation(server)
    const bytes = binaryBytes(3_000)
    const base64 = Buffer.from(bytes).toString('base64')

    const withPrefix = await upload(server, conversationId, {
      name: 'data-url.bin',
      data: `data:application/octet-stream;base64,${base64}`,
    })
    const wrapped = await upload(server, conversationId, {
      name: 'wrapped.bin',
      data: `${base64.slice(0, 80)}\n${base64.slice(80)}`,
    })

    expect(withPrefix.status).toBe(200)
    expect(wrapped.status).toBe(200)
    expect(Buffer.compare(readFileSync(join(artifactsDir, 'data-url.bin')), Buffer.from(bytes))).toBe(0)
    expect(Buffer.compare(readFileSync(join(artifactsDir, 'wrapped.bin')), Buffer.from(bytes))).toBe(0)
  })

  it('超过 20MB 的附件回 413，且不在磁盘上留残骸', async () => {
    const { server, artifactsDir } = await startServer()
    const conversationId = await newConversation(server)
    // base64 长度先触发上限：21MB 的内容足够越过 20MB 的闸，用不着真解一遍。
    const oversize = Buffer.alloc(21 * 1024 * 1024, 7).toString('base64')

    const { status, body } = await upload(server, conversationId, { name: 'big.bin', data: oversize })

    expect(status).toBe(413)
    expect(String(body.error)).toContain('20 MB')
    expect(existsSync(join(artifactsDir, 'big.bin'))).toBe(false)
  })

  it('缺 name / data 回 400；会话不存在回 404', async () => {
    const { server } = await startServer()
    const conversationId = await newConversation(server)
    const data = Buffer.from('x').toString('base64')

    expect((await upload(server, conversationId, { data })).status).toBe(400)
    expect((await upload(server, conversationId, { name: 'a.txt' })).status).toBe(400)
    expect((await upload(server, 'no-such-conversation', { name: 'a.txt', data })).status).toBe(404)
  })
})
