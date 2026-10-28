/**
 * 用一条声线文件把一段话念出来，顺带报这一次花了多少 CPU 与内存。
 *
 * 这就是"以后每次调用脚本即可"那句话的落地：声线在文件里、参数在文件里、凭据在
 * 本机，念一句话不需要打开软件、不需要点界面。
 *
 *   pnpm voice:speak --text "你好，我是 Ryen"
 *   pnpm voice:speak --text "..." --voice ryen-cat --out out.mp3 --json
 *
 * 凭据从哪来（按顺序）：`MINIMAX_API_KEY` 环境变量 → 应用内的 `config/api-keys.json`。
 * 后者被系统密钥库加密过时，普通 Node 进程解不开——这时给一句人话，而不是把密文
 * 当 key 递出去。
 * @module scripts/voice/speak
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type MinimaxSpeakResult, synthesizeMinimax, VOICE_ERROR_CODES, VoiceError } from '@ryharness/voice'
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

/** 命令行参数。 */
interface Options {
  text: string
  voiceId: string
  out: string | undefined
  dataDir: string
  json: boolean
}

/** 解析命令行；不认识或缺参数时给 usage 并退出。 */
function parseArgs(argv: string[]): Options {
  const options: Options = {
    text: '',
    voiceId: DEFAULT_VOICE_ID,
    out: undefined,
    dataDir: resolveDataDir(),
    json: false,
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = (): string => {
      const value = argv[index + 1]
      if (value === undefined) {
        console.error(`[voice] ${arg} 后面缺一个值`)
        process.exit(2)
      }
      index++
      return value
    }
    if (arg === '--text') options.text = next()
    else if (arg === '--voice') options.voiceId = next()
    else if (arg === '--out') options.out = next()
    else if (arg === '--data-dir') options.dataDir = resolve(next())
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：tsx scripts/voice/speak.ts --text "要念的话" [--voice ryen-cat] [--out out.mp3] [--json]')
      process.exit(0)
    } else {
      console.error(`[voice] 不认识的参数：${arg}`)
      process.exit(2)
    }
  }
  if (options.text.trim().length === 0) {
    console.error('[voice] 要念的话不能为空（--text "..."）')
    process.exit(2)
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const file = loadVoiceFile(options.dataDir, options.voiceId)
if (file === undefined) {
  console.error(`[voice] 读不到声线文件 ${voiceFilePath(options.dataDir, options.voiceId)}：文件不存在，或字段不合格`)
  process.exit(2)
}
if (file.engine !== 'minimax') {
  console.error(`[voice] 这条声线跑在 ${file.engine} 上，本脚本只念 minimax 那条`)
  process.exit(2)
}

const apiKey = resolveApiKey(options.dataDir)
if (apiKey === undefined) {
  console.error(
    apiKeyIsSealed(options.dataDir)
      ? '[voice] 应用里那把 MiniMax key 被系统密钥库加密了，普通 Node 进程解不开。' +
          '两种办法：设 MINIMAX_API_KEY 环境变量，或直接在应用「设置 → 供应商」里换一把 key。'
      : '[voice] 没找到 MiniMax 的 API Key：设 MINIMAX_API_KEY 环境变量，或在应用「设置 → 供应商」里填上。',
  )
  process.exit(2)
}

const before = snapshotResources()
let result: MinimaxSpeakResult
try {
  result = await synthesizeMinimax(
    {
      text: options.text,
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
} catch (error) {
  if (error instanceof VoiceError) {
    console.error(`[voice] 合成失败（${error.code}）：${error.message}`)
    process.exit(1)
  }
  throw error
}
const after = snapshotResources()
const delta = resourceDelta(before, after)

const outPath = options.out ?? resolve(process.cwd(), 'out.mp3')
writeFileSync(outPath, result.audio)

const report = {
  voice: {
    id: file.id,
    name: file.name,
    engine: file.engine,
    upstream: file.voice,
    model: file.model ?? 'speech-2.6-hd',
    speed: file.speed ?? 1,
    pitch: file.pitch ?? 0,
    emotion: file.emotion ?? '（未指定）',
    file: voiceFilePath(options.dataDir, options.voiceId),
  },
  audio: {
    path: outPath,
    bytes: result.audio.byteLength,
    megabytes: megabytes(result.audio.byteLength),
    durationMs: result.durationMs ?? null,
  },
  cost: {
    wallMs: delta.wallMs,
    cpuMs: Math.round(delta.cpuMs),
    cpuPercentOfCore: delta.cpuPercentOfCore,
    rssMb: megabytes(after.rss),
    rssDeltaMb: megabytes(delta.rssDelta),
    heapUsedMb: megabytes(after.heapUsed),
  },
}

if (options.json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`[voice] ${file.name}（${file.voice}）念了 ${options.text.length} 个字`)
  console.log(`[voice] 音频：${outPath}（${report.audio.bytes} 字节，${report.audio.durationMs ?? '?'} ms）`)
  console.log(
    `[voice] 占用：墙钟 ${report.cost.wallMs} ms，CPU ${report.cost.cpuMs} ms（${report.cost.cpuPercentOfCore}% 单核），` +
      `常驻内存 ${report.cost.rssMb} MB（${report.cost.rssDeltaMb >= 0 ? '+' : ''}${report.cost.rssDeltaMb} MB），堆 ${report.cost.heapUsedMb} MB`,
  )
}

// 合成失败时的错误码在报告里也标一份，方便脚本化调用方分流。
if (result.audio.byteLength === 0) {
  console.error(`[voice] ${VOICE_ERROR_CODES.upstream}`)
  process.exit(1)
}
