/**
 * 语音 demo 的服务端：一个极小的 HTTP 服务，把声线文件、合成与资源占用凑到一起。
 *
 * 为什么单独写一个服务，而不是直接用软件自己的后端：这个 demo 要能在**没装应用**
 * 的机器上跑起来（`pnpm voice:demo` 就能出声），也要能把"这一次合成花了多少 CPU 与
 * 内存"原样端出来给网页看。软件自己的后端那条路要多穿一层插件与鉴权，对 demo 来说
 * 是白费力气。
 *
 *   pnpm voice:demo            # 默认 http://127.0.0.1:5178
 *   pnpm voice:demo --port 5180
 *
 * 路由：
 * - `GET /`            网页
 * - `GET /api/voices`  这一声线目录里有哪几条
 * - `GET /api/stats`   此刻的资源占用（网页每秒轮询一次）
 * - `POST /api/speak`  合成一段话，回音频与这一次占用了多少
 * @module scripts/voice/demo-server
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { synthesizeMinimax, type VoiceFile } from '@ryharness/voice'
import {
  apiKeyIsSealed,
  DEFAULT_VOICE_ID,
  loadVoiceFile,
  megabytes,
  resolveApiKey,
  resolveDataDir,
  resourceDelta,
  snapshotResources,
  voiceFilePath,
} from './runtime.ts'

/** 默认端口。 */
const DEFAULT_PORT = 5178

/** 这一页（相对脚本目录）。 */
const PAGE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'demo.html')

/** 最近一次合成的记录（网页要显示"上一次花了多少"）。 */
interface LastSynthesis {
  voiceId: string
  text: string
  wallMs: number
  cpuMs: number
  cpuPercentOfCore: number
  bytes: number
  durationMs: number | undefined
  rssMb: number
  at: number
}

let lastSynthesis: LastSynthesis | undefined

/** 解析命令行里的端口。 */
function parsePort(argv: string[]): number {
  const fromEnv = Number.parseInt(process.env.RYHARNESS_VOICE_DEMO_PORT ?? '', 10)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  const index = argv.indexOf('--port')
  if (index >= 0) {
    const value = Number.parseInt(argv[index + 1] ?? '', 10)
    if (Number.isInteger(value) && value > 0) return value
  }
  return DEFAULT_PORT
}

const port = parsePort(process.argv.slice(2))
const dataDir = resolveDataDir()

/** 读一条声线文件（读不到就写默认的那条）。 */
function readVoice(voiceId: string): VoiceFile | undefined {
  return loadVoiceFile(dataDir, voiceId)
}

/** 可用的音色清单。 */
function listVoices(): { id: string; name: string; file: string }[] {
  const voices: { id: string; name: string; file: string }[] = []
  for (const id of [DEFAULT_VOICE_ID]) {
    const file = readVoice(id)
    if (file === undefined) continue
    voices.push({ id: file.id, name: file.name, file: voiceFilePath(dataDir, id) })
  }
  return voices
}

/** 读请求体（JSON）。 */
async function readJsonBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 回 JSON。 */
function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

const server = createServer((req, res) => {
  void handle(req, res).catch((error: unknown) => {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  })
})

/** 真正的处理逻辑。 */
async function handle(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const url = req.url ?? '/'
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    const html = readFileSync(PAGE_PATH, 'utf8')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
    return
  }
  if (req.method === 'GET' && url === '/api/voices') {
    sendJson(res, 200, { voices: listVoices(), dataDir })
    return
  }
  if (req.method === 'GET' && url === '/api/stats') {
    const snapshot = snapshotResources()
    sendJson(res, 200, {
      now: snapshot,
      rssMb: megabytes(snapshot.rss),
      heapUsedMb: megabytes(snapshot.heapUsed),
      cpuMs: Math.round(snapshot.cpuUserMs),
      uptimeMs: snapshot.uptimeMs,
      last: lastSynthesis ?? null,
    })
    return
  }
  if (req.method === 'POST' && url === '/api/speak') {
    const body = await readJsonBody(req)
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const voiceId = typeof body.voiceId === 'string' && body.voiceId.length > 0 ? body.voiceId : DEFAULT_VOICE_ID
    if (text.length === 0) {
      sendJson(res, 400, { error: '要念的文本不能为空' })
      return
    }
    const file = readVoice(voiceId)
    if (file === undefined) {
      sendJson(res, 404, { error: `没有这条声线：${voiceId}` })
      return
    }
    const apiKey = resolveApiKey(dataDir)
    if (apiKey === undefined) {
      sendJson(res, 400, {
        error: apiKeyIsSealed(dataDir)
          ? '应用里那把 MiniMax key 被系统密钥库加密了，普通 Node 进程解不开：设 MINIMAX_API_KEY 环境变量再启动 demo。'
          : '没找到 MiniMax 的 API Key：设 MINIMAX_API_KEY 环境变量，或在应用「设置 → 供应商」里填上。',
      })
      return
    }

    const before = snapshotResources()
    const started = Date.now()
    try {
      const result = await synthesizeMinimax(
        {
          text,
          voice: file.voice,
          ...(file.model === undefined ? {} : { model: file.model }),
          ...(file.speed === undefined ? {} : { speed: file.speed }),
          ...(file.pitch === undefined ? {} : { pitch: file.pitch }),
          ...(file.vol === undefined ? {} : { vol: file.vol }),
          ...(file.emotion === undefined ? {} : { emotion: file.emotion }),
          language: 'Chinese',
        },
        { fetchImpl: fetch, apiKey },
      )
      const after = snapshotResources()
      const delta = resourceDelta(before, after)
      lastSynthesis = {
        voiceId: file.id,
        text,
        wallMs: Date.now() - started,
        cpuMs: Math.round(delta.cpuMs),
        cpuPercentOfCore: delta.cpuPercentOfCore,
        bytes: result.audio.byteLength,
        durationMs: result.durationMs ?? 0,
        rssMb: megabytes(after.rss),
        at: Date.now(),
      }
      sendJson(res, 200, {
        ok: true,
        mime: result.mime,
        audioBase64: Buffer.from(result.audio).toString('base64'),
        voice: { id: file.id, name: file.name, upstream: file.voice, speed: file.speed ?? 1, pitch: file.pitch ?? 0 },
        audio: {
          bytes: result.audio.byteLength,
          durationMs: result.durationMs ?? 0,
        },
        cost: {
          wallMs: lastSynthesis.wallMs,
          cpuMs: lastSynthesis.cpuMs,
          cpuPercentOfCore: lastSynthesis.cpuPercentOfCore,
          rssMb: megabytes(after.rss),
          rssDeltaMb: megabytes(delta.rssDelta),
          heapUsedMb: megabytes(after.heapUsed),
        },
        now: after,
      })
    } catch (error) {
      sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  sendJson(res, 404, { error: '没有这条路由' })
}

server.listen(port, '127.0.0.1', () => {
  const voices = listVoices()
  console.log(`[voice:demo] http://127.0.0.1:${port}`)
  console.log(`[voice:demo] 数据目录：${dataDir}`)
  for (const voice of voices) console.log(`[voice:demo] 声线：${voice.name}（${voice.id}）→ ${voice.file}`)
  if (voices.length === 0) console.log('[voice:demo] 没读到声线文件，页面里点一下"念出来"会自动写入默认那条')
  console.log(
    `[voice:demo] 凭据：${resolveApiKey(dataDir) === undefined ? '没找到（MINIMAX_API_KEY 或应用内凭据）' : '已就绪'}`,
  )
})

/** 端口被占时说清楚是谁占的，别让"起不来"变成一句谜语。 */
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[voice:demo] 端口 ${port} 已被占用，换一个：pnpm voice:demo --port ${port + 1}`)
    process.exit(1)
  }
  throw error
})
