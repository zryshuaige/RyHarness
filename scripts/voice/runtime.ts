/**
 * 语音脚本与 demo 共用的那几件事：找数据目录、读声线文件、找凭据、采样资源占用。
 *
 * 为什么单独一个模块：`speak.ts`（命令行）与 `demo-server.ts`（网页 demo）要做的是
 * 同一件事的两面——同一个声线文件、同一把钥匙、同一种占用口径。口径分两处写，
 * 迟早出现"脚本说 40 MB、网页说 60 MB"，而看数字的人会以为其中有一个在撒谎。
 *
 * 声线文件与凭据都只落在本机（数据目录 / 环境变量），不进仓库。
 * @module scripts/voice/runtime
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_VOICE_FILES, parseVoiceFile, type VoiceFile } from '@ryharness/voice'

/** 声线文件目录（相对数据目录，与服务端插件一致）。 */
export const VOICE_FILES_SUBDIR = join('voice', 'voices')

/** 默认的音色 id（Ryen 的猫猫音）。 */
export const DEFAULT_VOICE_ID = 'ryen-cat'

/**
 * 数据目录。
 *
 * 顺序与应用一致：环境变量 `RYHARNESS_DATA_DIR` → `%APPDATA%/RyHarness/ryharness-data`。
 * 桌面端读的是 `app.getPath('userData')`，那在 Windows 上就是 `%APPDATA%/RyHarness`。
 */
export function resolveDataDir(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit
  const fromEnv = process.env.RYHARNESS_DATA_DIR
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'RyHarness', 'ryharness-data')
}

/**
 * 读一条声线文件；读不到就把随装默认的那条写进去再读。
 *
 * "读不到就写默认"是刻意的：脚本要在**应用从没启动过**的机器上也能跑出声音，
 * 而用户第一次改声线时改的正是这份文件——它已经在那儿了。
 * @param dataDir - 数据目录。
 * @param voiceId - 音色 id。
 * @returns 声线文件；找不到也解析不了时给 undefined。
 */
export function loadVoiceFile(dataDir: string, voiceId: string = DEFAULT_VOICE_ID): VoiceFile | undefined {
  const dir = join(dataDir, VOICE_FILES_SUBDIR)
  const path = join(dir, `${voiceId}.json`)
  if (!existsSync(path)) {
    const fallback = DEFAULT_VOICE_FILES.find((file) => {
      return file.id === voiceId
    })
    if (fallback === undefined) return undefined
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, `${JSON.stringify(fallback, null, 2)}\n`, 'utf8')
  }
  try {
    return parseVoiceFile(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

/** 声线文件放在哪（给用户看的路径）。 */
export function voiceFilePath(dataDir: string, voiceId: string = DEFAULT_VOICE_ID): string {
  return join(dataDir, VOICE_FILES_SUBDIR, `${voiceId}.json`)
}

/**
 * 找 MiniMax 的 API Key。
 *
 * 顺序：环境变量 → 应用内那份凭据文件（`config/api-keys.json`）。
 *
 * 凭据文件里被系统密钥库加密过的条目（Electron safeStorage）在普通 Node 进程里
 * **解不开**——那不是 bug，是设计：解密要用系统密钥库。这种情况下给一句人话，
 * 而不是把一段 base64 当 key 递出去（那会报"鉴权失败"，指不到病根）。
 * @param dataDir - 数据目录。
 * @returns key；找不到时给 undefined。
 */
export function resolveApiKey(dataDir: string): string | undefined {
  const fromEnv = process.env.MINIMAX_API_KEY
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim()
  const path = join(dataDir, 'config', 'api-keys.json')
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      keys?: Record<string, unknown>
    }
    const entry = parsed.keys?.minimax
    if (typeof entry === 'string' && entry.length > 0) return entry
    // 条目自带 cipher 时说明它是密文；明文路径不猜。
    return undefined
  } catch {
    return undefined
  }
}

/** 凭据是不是被系统密钥库加密过（解不开时给用户一句能照做的说明）。 */
export function apiKeyIsSealed(dataDir: string): boolean {
  const path = join(dataDir, 'config', 'api-keys.json')
  if (!existsSync(path)) return false
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      cipher?: string
      keys?: Record<string, unknown>
    }
    const entry = parsed.keys?.minimax
    if (typeof entry === 'string') return false
    if (typeof entry === 'object' && entry !== null) {
      const cipher = (entry as { cipher?: unknown }).cipher
      return cipher === 'safeStorage'
    }
    return parsed.cipher === 'safeStorage'
  } catch {
    return false
  }
}

/** 一次资源占用采样。 */
export interface ResourceSnapshot {
  /** 常驻内存（字节）。 */
  rss: number
  /** V8 堆已用（字节）。 */
  heapUsed: number
  /** V8 堆总量（字节）。 */
  heapTotal: number
  /** 堆外内存（字节）。 */
  external: number
  /** 进程累计 CPU 时间：用户态（毫秒）。 */
  cpuUserMs: number
  /** 进程累计 CPU 时间：内核态（毫秒）。 */
  cpuSystemMs: number
  /** 进程已运行（毫秒）。 */
  uptimeMs: number
  /** 进程号。 */
  pid: number
  /** Node 版本。 */
  node: string
  /** 采样时刻（毫秒时间戳）。 */
  at: number
}

/**
 * 采一次资源占用。
 *
 * CPU 用 `process.cpuUsage()` 的**累计值**：它包含进程启动以来所有线程的时间，
 * 两次采样相减就是这两件事之间真正烧掉的 CPU——比"采样时那一瞬间的百分比"可靠
 * 得多（后者的分母根本没法定）。
 */
export function snapshotResources(): ResourceSnapshot {
  const memory = process.memoryUsage()
  const cpu = process.cpuUsage()
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    external: memory.external,
    cpuUserMs: (cpu.user + cpu.system) / 1000,
    cpuSystemMs: cpu.system / 1000,
    uptimeMs: Math.round(process.uptime() * 1000),
    pid: process.pid,
    node: process.version,
    at: Date.now(),
  }
}

/** 两次采样之间的差值（合成这一次花了多少 CPU 与时间）。 */
export interface ResourceDelta {
  /** 这段墙钟时间（毫秒）。 */
  wallMs: number
  /** 这段里烧掉的 CPU 时间（毫秒；可能大于 wallMs，因为多线程）。 */
  cpuMs: number
  /** 这段里常驻内存的变化（字节；正数是涨了）。 */
  rssDelta: number
  /** 这段里堆的变化（字节）。 */
  heapDelta: number
  /** 折算成"占满一个核"的百分比（100 = 一个核跑满）。 */
  cpuPercentOfCore: number
}

/** 两次采样相减。 */
export function resourceDelta(before: ResourceSnapshot, after: ResourceSnapshot): ResourceDelta {
  const wallMs = Math.max(1, after.at - before.at)
  const cpuMs = Math.max(0, after.cpuUserMs - before.cpuUserMs)
  return {
    wallMs,
    cpuMs,
    rssDelta: after.rss - before.rss,
    heapDelta: after.heapUsed - before.heapUsed,
    cpuPercentOfCore: Math.round((cpuMs / wallMs) * 1000) / 10,
  }
}

/** 字节 → MB（保留一位小数，给界面与日志用）。 */
export function megabytes(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10
}
