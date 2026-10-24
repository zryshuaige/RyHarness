/**
 * 内置插件：Piper 离线语音。
 *
 * 为什么是 Piper：安装版用户没有云端 Key 时只剩 Windows SAPI，声音机械得像导航；
 * Piper（MIT）在 CPU 上就能跑，模型与二进制都可以从公开镜像一次下载完，之后完全
 * 不依赖网络与凭据。
 *
 * 两件事刻意分开：
 * - **安装**是异步的（约 85 MB），状态机对外只有 `absent / downloading / ready /
 *   error / unsupported` 五个值；POST 只启动，GET 轮询，重复启动幂等。
 *   二进制解压执行前必须先通过 GitHub 官方 digest 校验；拿不到官方摘要时只允许
 *   官方直连，第三方代理一律禁用——不可校验的可执行文件等于把 RCE 交给代理运营者。
 * - **合成**是串行的：同一时刻只允许一个 `piper.exe`，否则几段流式文本同时开口会
 *   把 CPU 抢成复读机。进程 30 秒没结束就杀掉，并随客户端断开一起中止。
 *
 * 平台边界说实话：Piper 官方只发 Windows 构建，其他平台 `state=unsupported`，
 * 不假装能装。资源目录 `<dataDir>/voice/piper/` 在插件关闭后原样保留。
 *
 * 许可注意：Piper 二进制是 MIT；`zh_CN-huayan-medium` 的 model card 标注训练集
 * HuaYan_TTS 的 License 为 Unknown。二进制与模型都**不随安装包分发**，由用户点击后
 * 从公开镜像下载；商用/再分发前需要复核模型许可。
 * @module @ryharness/server/plugins/voice-piper
 */

import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@ryharness/cordis'
import { type SpeakResult, VOICE_ERROR_CODES, VoiceError, type VoiceProfile } from '@ryharness/voice'
import { createVoiceInstallHandlers, type VoiceInstallStatus } from '../routes/voice.ts'
import type { PluginEntry } from './host.ts'
import type { VoiceProvider } from './voice.ts'

export const VOICE_PIPER_PLUGIN_ID = 'voice-piper'
export const PIPER_PROFILE_ID = 'piper-huayan'
export const PIPER_INSTALL_PATH = '/api/voice/engines/piper/install'
export const PIPER_STATUS_PATH = '/api/voice/engines/piper/status'

const PIPER_ENGINE = 'piper'
const PIPER_EXE = 'piper.exe'
const MODEL_FILE = 'zh_CN-huayan-medium.onnx'
const MODEL_CONFIG_FILE = `${MODEL_FILE}.json`

/** Piper 官方发布的三要素：下载 URL 与 Releases API 都从这里推导，升版本只改这一处。 */
const PIPER_RELEASE_REPO = 'rhasspy/piper'
const PIPER_RELEASE_TAG = '2023.11.14-2'
const PIPER_BINARY_ASSET_NAME = 'piper_windows_amd64.zip'
const GITHUB_RELEASE_BASE = `https://github.com/${PIPER_RELEASE_REPO}/releases/download`
const GITHUB_RELEASE = `${GITHUB_RELEASE_BASE}/${PIPER_RELEASE_TAG}/${PIPER_BINARY_ASSET_NAME}`
/** Releases API：asset 的 `digest`（`sha256:…`）是「这个 zip 就是官方发布的」的唯一凭据。 */
const GITHUB_API_RELEASE = `https://api.github.com/repos/${PIPER_RELEASE_REPO}/releases/tags/${PIPER_RELEASE_TAG}`

/**
 * 二进制镜像表：官方直连第一，公共代理只作官方失败后的 fallback。
 *
 * 顺序就是信任顺序：zip 解出来是要直接执行的 piper.exe，把匿名代理排在官方前面
 * 等于把「往用户机器上放什么可执行文件」的决定权交给代理运营者。代理保留在列表里，
 * 因为下载后会做官方 digest 校验，校验不过的文件到不了解压那一步；拿不到 digest
 * 时代理会整个被禁用（见 downloadBinary）。
 */
export const PIPER_BINARY_MIRRORS: readonly string[] = [
  GITHUB_RELEASE,
  `https://ghproxy.net/${GITHUB_RELEASE}`,
  `https://gh-proxy.com/${GITHUB_RELEASE}`,
]

/** 模型与配置是数据不是可执行文件，沿用镜像优先、直连兜底（本网络实测直连 HF 不可用）。 */
const HF_MODEL_ROOT = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium'
const HF_MIRROR_ROOT = 'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium'

export const PIPER_MODEL_MIRRORS: readonly string[] = [
  `${HF_MIRROR_ROOT}/${MODEL_FILE}`,
  `${HF_MODEL_ROOT}/${MODEL_FILE}`,
]

export const PIPER_MODEL_CONFIG_MIRRORS: readonly string[] = [
  `${HF_MIRROR_ROOT}/${MODEL_CONFIG_FILE}`,
  `${HF_MODEL_ROOT}/${MODEL_CONFIG_FILE}`,
]

/** 三个下载文件的大小下限。 */
export interface PiperSizeLimits {
  binary: number
  model: number
  config: number
}

/** 大小下限：只防「下到一个 404 页面 / 空文件就当成功」，不是精确尺寸。 */
export const PIPER_SIZE_LIMITS: PiperSizeLimits = {
  binary: 15 * 1024 * 1024,
  model: 40 * 1024 * 1024,
  config: 1024,
}

/** 进度总量估算（实际以 Content-Length 为准，这里只是让下载条一开始有分母）。 */
export const PIPER_TOTAL_BYTES_ESTIMATE = 88 * 1024 * 1024

/**
 * 单个 HTTP 请求的超时。
 *
 * 分段后每段只有几 MB，但镜像在负载高时单连接会掉到 10 KB/s 量级：300 秒会把
 * 「还在慢慢下」误判成失败并整段重来。600 秒留出余量，同时仍能兜住彻底卡死的
 * 连接（分段失败会换下一个镜像重试这一段）。
 */
export const PIPER_REQUEST_TIMEOUT_MS = 600_000

/** Piper 合成超时。 */
export const PIPER_SYNTHESIS_TIMEOUT_MS = 30_000

/**
 * 大于这个体积才分段下载。
 *
 * 实测同一镜像单连接只有 ~20 KB/s、4 条 Range 连接能到 ~150 KB/s；85 MB 的安装包
 * 单连接要十几分钟。小文件分段只会多几次请求，没有必要。
 */
export const PIPER_PARALLEL_MIN_BYTES = 8 * 1024 * 1024

/**
 * 分段数。
 *
 * 取 8 不只是为了聚合带宽：每段要能在 300 秒的请求超时内下完。22 MB 的二进制
 * 分 4 段时每段 5.5 MB，慢镜像（~20 KB/s）会正好卡在 275 秒，一次抖动就整文件
 * 重下；分 8 段后每段 2.75 MB，留出足够余量。
 */
export const PIPER_PARALLEL_CHUNKS = 8

/** 安装用的 fetch（可注入假实现；生产就是全局 fetch）。 */
export type PiperFetch = (url: string, init?: RequestInit) => Promise<Response>

/** zip 解压（Windows 走 PowerShell Expand-Archive；测试注入假实现）。 */
export type PiperExtract = (zipPath: string, destination: string) => Promise<void>

/** 安装器的可注入依赖。 */
export interface PiperInstallerOptions {
  dataDir: string
  fetchImpl?: PiperFetch
  platform?: NodeJS.Platform
  extractZip?: PiperExtract
  limits?: Partial<PiperSizeLimits>
  requestTimeoutMs?: number
  totalBytesEstimate?: number
  /** 分段数（1 = 关闭分段，测试用）。 */
  parallelChunks?: number
  /** 低于这个体积不分段（测试会调小）。 */
  parallelMinBytes?: number
}

/**
 * piper 的安装状态在通用字段之外多带一条警示（如「未校验哈希」）。
 *
 * 放在子类型而不是改 routes/voice.ts 的公共接口：警示是 piper 供应链策略特有的
 * 概念，其他引擎的安装卡不该被迫解释这个字段。
 */
export interface PiperInstallStatus extends VoiceInstallStatus {
  warning?: string
}

/** 一个下载镜像失败后换下一个；任何一次 HTTP/大小校验失败都算失败。 */
interface DownloadResult {
  received: number
  contentLength?: number
}

/** 错误 → 一句可展示的原因（不把堆栈塞进 status）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** PowerShell 单引号字符串转义：路径里的 `'` 变成 `''`。 */
function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** 默认解压：只支持 Windows；别的平台在启动安装前就被挡下了。 */
function defaultExtractZip(zipPath: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destination)} -Force`,
      ],
      { windowsHide: true, timeout: 120_000 },
      (error, _stdout, stderr) => {
        if (error !== null) {
          const detail = stderr.trim()
          reject(new Error(`解压失败：${detail.length > 0 ? detail : error.message}`))
          return
        }
        resolve()
      },
    )
  })
}

/** 递归找文件（zip 里可能是 `piper/piper.exe`，不能写死层级）。 */
function findFile(root: string, name: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return path
    if (entry.isDirectory()) {
      const nested = findFile(path, name)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** 文件存在且至少这么大（读不了也算没有）。 */
function atLeast(path: string, bytes: number): boolean {
  try {
    return statSync(path).size >= bytes
  } catch {
    return false
  }
}

/** Releases API 的 asset JSON（只取校验真正关心的两个字段）。 */
interface GithubAsset {
  name?: unknown
  digest?: unknown
}

/**
 * 从 release JSON 里取出二进制 asset 的官方 sha256（十六进制，剥掉 `sha256:` 前缀）。
 *
 * 只认 sha256：别的摘要算法、或老版本 API 没有的 `digest` 字段，一律按「拿不到」
 * 返回 undefined，让调用方退到只允许官方直连的保守路径——宁可少一条下载腿，
 * 不可少一道校验。
 */
function parseBinaryDigest(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const assets = (body as { assets?: unknown }).assets
  if (!Array.isArray(assets)) return undefined
  for (const asset of assets) {
    if (typeof asset !== 'object' || asset === null) continue
    const { name, digest } = asset as GithubAsset
    if (name !== PIPER_BINARY_ASSET_NAME || typeof digest !== 'string') continue
    const hex = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : ''
    return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined
  }
  return undefined
}

/** 整文件 SHA-256：安装包只有几十 MB，一次读入比流式简单且足够快。 */
function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Piper 安装器：状态机 + 镜像下载 + 原子换入。
 *
 * 所有写盘都先落在 `<voice>/.piper-install-*` 里，最后一步才 rename 成正式目录；
 * 中途失败只删暂存目录，用户永远不会看到「半个 piper.exe」被当成已安装。
 */
export class PiperInstaller {
  readonly dir: string
  private readonly voiceRoot: string
  private readonly fetchImpl: PiperFetch
  private readonly platform: NodeJS.Platform
  private readonly extractZip: PiperExtract
  private readonly limits: PiperSizeLimits
  private readonly requestTimeoutMs: number
  private readonly totalBytesEstimate: number
  private readonly parallelChunks: number
  private readonly parallelMinBytes: number
  private readonly abort = new AbortController()
  private state: VoiceInstallStatus['state'] = 'absent'
  private receivedBytes = 0
  private completedBytes = 0
  private totalBytes = 0
  private error: string | undefined
  private warning: string | undefined
  private task: Promise<void> | undefined

  constructor(options: PiperInstallerOptions) {
    this.dir = join(options.dataDir, 'voice', 'piper')
    this.voiceRoot = dirname(this.dir)
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.platform = options.platform ?? process.platform
    this.extractZip = options.extractZip ?? defaultExtractZip
    this.limits = { ...PIPER_SIZE_LIMITS, ...options.limits }
    this.requestTimeoutMs = options.requestTimeoutMs ?? PIPER_REQUEST_TIMEOUT_MS
    this.totalBytesEstimate = options.totalBytesEstimate ?? PIPER_TOTAL_BYTES_ESTIMATE
    this.parallelChunks = options.parallelChunks ?? PIPER_PARALLEL_CHUNKS
    this.parallelMinBytes = options.parallelMinBytes ?? PIPER_PARALLEL_MIN_BYTES
  }

  /** 启动安装；已在下/已装好/不支持时只回当前状态（幂等）。 */
  startInstall(): VoiceInstallStatus {
    if (this.state === 'downloading') return this.installStatus()
    if (this.platform !== 'win32') {
      this.state = 'unsupported'
      this.error = '离线语音包目前只支持 Windows：Piper 官方只发布 Windows 构建。'
      return this.installStatus()
    }
    if (this.filesReady()) {
      this.state = 'ready'
      this.error = undefined
      return this.installStatus()
    }
    this.state = 'downloading'
    this.error = undefined
    this.warning = undefined
    this.receivedBytes = 0
    this.completedBytes = 0
    this.totalBytes = this.totalBytesEstimate
    this.task = this.runInstall().then(
      () => {
        this.state = 'ready'
        this.error = undefined
        this.receivedBytes = Math.max(this.receivedBytes, this.completedBytes)
        // 完成时把估算分母换成真实总量：界面上的进度条应当走到 100%，
        // 而不是停在一个偏大的估算值上。
        this.totalBytes = this.receivedBytes
      },
      (error: unknown) => {
        this.state = 'error'
        this.error = messageOf(error)
      },
    )
    return this.installStatus()
  }

  /** 当前状态；进程重启后文件齐全也能直接认成 ready。 */
  installStatus(): PiperInstallStatus {
    if (this.state === 'absent' && this.filesReady()) this.state = 'ready'
    return {
      state: this.state,
      ...(this.receivedBytes > 0 ? { receivedBytes: this.receivedBytes } : {}),
      ...(this.totalBytes > 0 ? { totalBytes: this.totalBytes } : {}),
      ...(this.error === undefined ? {} : { error: this.error }),
      ...(this.warning === undefined ? {} : { warning: this.warning }),
    }
  }

  /** 插件关闭：中止进行中的下载（暂存由 runInstall 的 finally 清掉）。 */
  dispose(): void {
    this.abort.abort()
  }

  /** 等待当前任务结束（测试用；生产不阻塞卸载）。 */
  async settled(): Promise<void> {
    await this.task
  }

  /** 三个必需文件都在且达到下限。 */
  private filesReady(): boolean {
    return (
      atLeast(join(this.dir, PIPER_EXE), 1) &&
      atLeast(join(this.dir, MODEL_FILE), this.limits.model) &&
      atLeast(join(this.dir, MODEL_CONFIG_FILE), this.limits.config)
    )
  }

  private async runInstall(): Promise<void> {
    mkdirSync(this.voiceRoot, { recursive: true })
    this.cleanupStaleStaging()
    const stage = join(this.voiceRoot, `.piper-install-${process.pid}-${randomUUID().slice(0, 8)}`)
    mkdirSync(stage, { recursive: true })
    try {
      await this.downloadBinary(stage)
      const zipPath = join(stage, 'piper.zip')
      const extracted = join(stage, 'extracted')
      mkdirSync(extracted, { recursive: true })
      await this.extractZip(zipPath, extracted)
      rmSync(zipPath, { force: true })

      const exePath = findFile(extracted, PIPER_EXE)
      if (exePath === undefined) throw new Error('下载的压缩包里没有 piper.exe')
      // zip 里带一层 `piper/`：把 exe 同级的依赖一起摊到暂存根，最终目录才符合
      // 「<dataDir>/voice/piper/piper.exe 及依赖文件」这个约定。
      const toolsRoot = dirname(exePath)
      for (const entry of readdirSync(toolsRoot)) {
        const target = join(stage, entry)
        if (existsSync(target)) rmSync(target, { recursive: true, force: true })
        renameSync(join(toolsRoot, entry), target)
      }
      rmSync(extracted, { recursive: true, force: true })
      if (!atLeast(join(stage, PIPER_EXE), 1)) throw new Error('解压后没有找到 piper.exe')

      await this.downloadWithMirrors(PIPER_MODEL_MIRRORS, join(stage, MODEL_FILE), this.limits.model, '华言离线模型')
      await this.downloadWithMirrors(
        PIPER_MODEL_CONFIG_MIRRORS,
        join(stage, MODEL_CONFIG_FILE),
        this.limits.config,
        '华言模型配置',
      )

      // 原子换入：先清掉可能残留的旧目录（只有不 ready 才会走到这里）。
      rmSync(this.dir, { recursive: true, force: true })
      renameSync(stage, this.dir)
    } catch (error) {
      rmSync(stage, { recursive: true, force: true })
      throw error
    } finally {
      this.cleanupStaleStaging()
    }
  }

  /** 清掉上次崩溃留下的暂存目录（不碰正式目录）。 */
  private cleanupStaleStaging(): void {
    if (!existsSync(this.voiceRoot)) return
    for (const entry of readdirSync(this.voiceRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('.piper-install-')) {
        rmSync(join(this.voiceRoot, entry.name), { recursive: true, force: true })
      }
    }
  }

  /**
   * 二进制下载：先锁完整性，再谈从哪里下。
   *
   * 1. 先问 Releases API 要官方 digest；任何一步拿不到（API 不可达、资产无摘要）都
   *    退到「只允许官方直连」——不可校验的可执行文件不能从匿名代理拿，且把
   *    「未校验哈希」挂到状态上明示，而不是默默放行；
   * 2. 拿到 digest 后官方与代理都可以试（下载后逐字节 SHA-256 比对兜底），比对不过
   *    就删文件、拒绝安装——此时最合理的解释是镜像投毒，必须让用户看见。
   */
  private async downloadBinary(stage: string): Promise<void> {
    const zipPath = join(stage, 'piper.zip')
    const digest = await this.fetchOfficialDigest()
    if (digest === undefined) {
      this.warning = '未校验哈希：GitHub 官方 API 不可用或未返回摘要，二进制仅从 GitHub 官方直连下载。'
    } else {
      this.warning = undefined
    }
    const mirrors = digest === undefined ? [GITHUB_RELEASE] : PIPER_BINARY_MIRRORS
    try {
      await this.downloadWithMirrors(mirrors, zipPath, this.limits.binary, 'Piper 二进制')
    } catch (error) {
      if (digest !== undefined || this.abort.signal.aborted) throw error
      throw new Error(`${messageOf(error)}；拿不到官方哈希，已禁用第三方代理，只允许官方直连下载。`)
    }
    if (digest === undefined) return
    const actual = sha256File(zipPath)
    if (actual !== digest) {
      rmSync(zipPath, { force: true })
      const detail = `期望 ${digest.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`
      throw new Error(`Piper 二进制 SHA-256 与官方发布不符（${detail}），可能被镜像篡改；已删除下载文件并拒绝安装。`)
    }
  }

  /**
   * 问 Releases API 要二进制 asset 的官方 sha256。
   *
   * 一次安装只调一次，未认证调用的速率限制足够用；API 失败不算安装失败——退到
   * 只允许官方直连的保守路径即可，不能因为 GitHub API 抖动把安装整个堵死。
   */
  private async fetchOfficialDigest(): Promise<string | undefined> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(Math.min(this.requestTimeoutMs, 30_000))])
    try {
      const response = await this.fetchImpl(GITHUB_API_RELEASE, {
        signal,
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'RyHarness/piper-installer' },
      })
      if (!response.ok) return undefined
      return parseBinaryDigest(await response.json())
    } catch {
      return undefined
    }
  }

  /**
   * 依次尝试镜像；每个镜像失败都删掉当次半成品。
   *
   * 大文件走分段路径：先探测所有镜像，找到第一个支持 Range 的，再把**每一段**
   * 独立地按镜像列表回退。这样某一段在慢镜像上超时只重下这一段，不会把已经
   * 下好的几 MB 全部作废（单连接时代一次抖动就要从零开始）。
   */
  private async downloadWithMirrors(
    mirrors: readonly string[],
    target: string,
    minimum: number,
    label: string,
  ): Promise<void> {
    let lastReason = ''
    if (this.parallelChunks > 1 && minimum >= this.parallelMinBytes) {
      const probe = await this.probeAcrossMirrors(mirrors)
      if (probe !== undefined) {
        this.receivedBytes = this.completedBytes
        try {
          const result = await this.fetchRanges(mirrors, probe.mirrorIndex, target, probe.total)
          if (result.received < minimum) {
            throw new Error(`只下载到 ${result.received} 字节（下限 ${minimum}）`)
          }
          this.completedBytes += result.received
          this.receivedBytes = this.completedBytes
          this.totalBytes = Math.max(this.totalBytes, this.completedBytes)
          return
        } catch (error) {
          rmSync(target, { force: true })
          if (this.abort.signal.aborted) throw new Error('安装已中止')
          lastReason = messageOf(error)
        }
      }
    }
    for (const mirror of mirrors) {
      if (this.abort.signal.aborted) throw new Error('安装已中止')
      this.receivedBytes = this.completedBytes
      try {
        const result = await this.fetchWhole(mirror, target)
        if (result.received < minimum) {
          throw new Error(`只下载到 ${result.received} 字节（下限 ${minimum}）`)
        }
        this.completedBytes += result.received
        this.receivedBytes = this.completedBytes
        this.totalBytes = Math.max(this.totalBytes, this.completedBytes)
        return
      } catch (error) {
        rmSync(target, { force: true })
        if (this.abort.signal.aborted) throw new Error('安装已中止')
        lastReason = messageOf(error)
      }
    }
    throw new Error(`${label}下载失败（已尝试 ${mirrors.length} 个镜像）：${lastReason}`)
  }

  /** 按优先级找第一个支持 Range 的镜像。 */
  private async probeAcrossMirrors(
    mirrors: readonly string[],
  ): Promise<{ total: number; mirrorIndex: number } | undefined> {
    for (const [index, mirror] of mirrors.entries()) {
      if (this.abort.signal.aborted) throw new Error('安装已中止')
      try {
        const total = await this.probeRange(mirror)
        if (total !== undefined) return { total, mirrorIndex: index }
      } catch {
        // 探测失败只说明这个镜像此刻不可用，继续看下一个。
        if (this.abort.signal.aborted) throw new Error('安装已中止')
      }
    }
    return undefined
  }

  /** Range 探测：只取第一个字节，从 `Content-Range` 读总长。 */
  private async probeRange(url: string): Promise<number | undefined> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(Math.min(this.requestTimeoutMs, 30_000))])
    const response = await this.fetchImpl(url, {
      signal,
      headers: { range: 'bytes=0-0', accept: '*/*', 'user-agent': 'RyHarness/piper-installer' },
    })
    try {
      if (response.status !== 206) return undefined
      const header = response.headers.get('content-range')
      if (header === null) return undefined
      const match = /bytes\s+\d+-\d+\/(\d+)/.exec(header)
      if (match === null) return undefined
      const total = Number(match[1])
      return Number.isFinite(total) && total > 0 ? total : undefined
    } finally {
      await response.body?.cancel().catch(() => {
        // 只需要头；取消正文失败不影响后续判断。
      })
    }
  }

  /** 分段下载到临时 part 文件；每段各自按镜像列表回退，全部成功后再拼成目标文件。 */
  private async fetchRanges(
    mirrors: readonly string[],
    firstMirrorIndex: number,
    target: string,
    total: number,
  ): Promise<DownloadResult> {
    this.totalBytes = Math.max(this.totalBytes, this.completedBytes + total)
    const chunkSize = Math.max(1, Math.ceil(total / this.parallelChunks))
    const count = Math.ceil(total / chunkSize)
    const parts: (string | undefined)[] = Array.from({ length: count })
    const progresses = Array.from({ length: count }, () => {
      return 0
    })
    const abort = new AbortController()
    const update = (): void => {
      this.receivedBytes =
        this.completedBytes +
        progresses.reduce((sum, value) => {
          return sum + value
        }, 0)
    }
    const tasks = Array.from({ length: count }, async (_unused, index) => {
      const start = index * chunkSize
      const end = Math.min(total - 1, start + chunkSize - 1)
      if (start > end) return
      const part = `${target}.part${index}`
      parts[index] = part
      let lastReason = ''
      for (let attempt = 0; attempt < mirrors.length; attempt++) {
        if (this.abort.signal.aborted) throw new Error('安装已中止')
        const mirror = mirrors[(firstMirrorIndex + attempt) % mirrors.length]
        if (mirror === undefined) continue
        progresses[index] = 0
        rmSync(part, { force: true })
        try {
          await this.downloadChunk(mirror, part, start, end, index, progresses, update, abort.signal)
          return
        } catch (error) {
          rmSync(part, { force: true })
          if (this.abort.signal.aborted) throw new Error('安装已中止')
          lastReason = messageOf(error)
        }
      }
      throw new Error(`第 ${index + 1} 段下载失败（已尝试 ${mirrors.length} 个镜像）：${lastReason}`)
    })
    try {
      // 任一段失败就立刻 abort 其余段；allSettled 只用于等它们真正收尾后清文件。
      const guarded = tasks.map(async (task) => {
        try {
          await task
        } catch (error) {
          abort.abort()
          throw error
        }
      })
      const results = await Promise.allSettled(guarded)
      const failed = results.find((result) => {
        return result.status === 'rejected'
      })
      if (failed !== undefined) {
        throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason))
      }
      const received = progresses.reduce((sum, value) => {
        return sum + value
      }, 0)
      if (received !== total) throw new Error(`分段合计 ${received} 字节，与总长 ${total} 不符`)

      const handle = await open(target, 'w')
      try {
        for (const part of parts) {
          if (part === undefined) continue
          await handle.write(await readFile(part))
        }
      } finally {
        await handle.close()
      }
      return { received, contentLength: total }
    } finally {
      for (const part of parts) {
        if (part !== undefined) rmSync(part, { force: true })
      }
    }
  }

  /** 下载一段；只负责一个镜像的一次尝试，失败由调用方换镜像。 */
  private async downloadChunk(
    url: string,
    part: string,
    start: number,
    end: number,
    index: number,
    progresses: number[],
    update: () => void,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchImpl(url, {
      signal: AbortSignal.any([this.abort.signal, abortSignal, AbortSignal.timeout(this.requestTimeoutMs)]),
      headers: {
        range: `bytes=${start}-${end}`,
        accept: '*/*',
        'user-agent': 'RyHarness/piper-installer',
      },
    })
    if (response.status !== 206) throw new Error(`分段下载返回 HTTP ${response.status}`)
    if (response.body === null) throw new Error('响应没有内容')
    const handle = await open(part, 'w')
    const reader = response.body.getReader()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        progresses[index] = (progresses[index] ?? 0) + chunk.value.byteLength
        update()
        await handle.write(chunk.value)
      }
    } finally {
      await handle.close()
      await reader.cancel().catch(() => {
        // 同单连接路径：正常读完也会 resolve。
      })
    }
  }

  /** 单连接下载（小文件或不支持 Range 的镜像）。 */
  private async fetchWhole(url: string, target: string): Promise<DownloadResult> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.requestTimeoutMs)])
    const response = await this.fetchImpl(url, {
      signal,
      headers: { accept: '*/*', 'user-agent': 'RyHarness/piper-installer' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const rawLength = response.headers.get('content-length')
    const contentLength = rawLength === null ? undefined : Number(rawLength)
    if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > 0) {
      this.totalBytes = Math.max(this.totalBytes, this.completedBytes + contentLength)
    }
    if (response.body === null) throw new Error('响应没有内容')

    const handle = await open(target, 'w')
    const reader = response.body.getReader()
    let received = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        received += chunk.value.byteLength
        await handle.write(chunk.value)
        this.receivedBytes = this.completedBytes + received
      }
    } finally {
      await handle.close()
      await reader.cancel().catch(() => {
        // 正常读完时 cancel 也会 resolve；这里只是保证异常路径释放流。
      })
    }
    return { received, ...(contentLength === undefined ? {} : { contentLength }) }
  }
}

/** 试听句与云端目录里的句子保持同一风格：短、有语调变化。 */
const PIPER_SAMPLE_TEXT = '你好，我是 Ryen，这句是这台电脑离线合成的。'

/** 目录里的离线音色（只有一个模型，先不假装有男声）。 */
export const PIPER_PROFILE: VoiceProfile = {
  id: PIPER_PROFILE_ID,
  name: '华言 · 离线女声',
  engine: PIPER_ENGINE,
  voice: 'zh_CN-huayan-medium',
  gender: '女',
  style: '温和',
  sampleText: PIPER_SAMPLE_TEXT,
  description: 'Piper 开源离线模型（MIT），装好后不需要任何 API Key，断网也能念',
}

/** 合成进程的最小接口（测试注入假进程，不真的 spawn）。 */
export interface PiperChild {
  writeStdin(data: string): void
  onStderr(listener: (chunk: string) => void): void
  onClose(listener: (code: number | null) => void): void
  onError(listener: (error: Error) => void): void
  kill(): void
}

/** spawn 的窄接口：只暴露 runner 真正用到的四件事。 */
export type PiperSpawn = (command: string, args: readonly string[]) => PiperChild

/** 默认 spawn：stdin 写文本，stderr 留着排错，close 决定成败。 */
function defaultSpawn(command: string, args: readonly string[]): PiperChild {
  const child = spawn(command, [...args], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
  return {
    writeStdin(data) {
      child.stdin.end(data)
    },
    onStderr(listener) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        listener(chunk)
      })
    },
    onClose(listener) {
      child.on('close', listener)
    },
    onError(listener) {
      child.on('error', listener)
    },
    kill() {
      child.kill()
    },
  }
}

/** 合成器的可注入依赖。 */
export interface PiperRunnerOptions {
  dir: string
  spawnImpl?: PiperSpawn
  timeoutMs?: number
}

interface PiperJob {
  text: string
  signal?: AbortSignal
  resolve(result: SpeakResult): void
  reject(error: Error): void
  settled: boolean
  cleanupAbort?: () => void
  child?: PiperChild
  timer?: NodeJS.Timeout
  stderr: string
}

/** 中止不是故障，但对调用方仍要有可识别的结构化错误。 */
function abortedError(): VoiceError {
  return new VoiceError('离线语音合成已中止', VOICE_ERROR_CODES.piperFailed)
}

/** 读 WAV 并校验头；不是 RIFF/WAVE 就当失败，不把坏字节喂给 <audio>。 */
function readWav(path: string): SpeakResult {
  const buffer = readFileSync(path)
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new VoiceError('Piper 输出的不是有效的 WAV 文件', VOICE_ERROR_CODES.piperFailed)
  }
  return { audio: new Uint8Array(buffer), mime: 'audio/wav', format: 'wav' }
}

/**
 * Piper 合成器：串行队列 + 30 秒超时 + 可中止。
 *
 * 队列不用 Promise 链：排队中的任务被中止时应当**立刻**失败，而不是等前一个
 * 任务跑完才轮到它。active 同时只可能有一个子进程。
 */
export class PiperRunner {
  private readonly dir: string
  private readonly spawnImpl: PiperSpawn
  private readonly timeoutMs: number
  private readonly queue: PiperJob[] = []
  private active: PiperJob | undefined
  private pumping = false

  constructor(options: PiperRunnerOptions) {
    this.dir = options.dir
    this.spawnImpl = options.spawnImpl ?? defaultSpawn
    this.timeoutMs = options.timeoutMs ?? PIPER_SYNTHESIS_TIMEOUT_MS
  }

  synthesize(text: string, signal?: AbortSignal): Promise<SpeakResult> {
    if (signal?.aborted === true) return Promise.reject(abortedError())
    return new Promise<SpeakResult>((resolve, reject) => {
      const job: PiperJob = {
        text,
        resolve,
        reject,
        settled: false,
        stderr: '',
        ...(signal === undefined ? {} : { signal }),
      }
      if (signal !== undefined) {
        const onAbort = (): void => {
          this.abortJob(job)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        job.cleanupAbort = () => {
          signal.removeEventListener('abort', onAbort)
        }
      }
      this.queue.push(job)
      void this.pump()
    })
  }

  /** 插件关闭：排队中的立即失败，正在跑的杀掉。 */
  dispose(): void {
    for (const job of this.queue.splice(0)) this.fail(job, abortedError())
    if (this.active !== undefined) {
      this.fail(this.active, abortedError())
      try {
        this.active.child?.kill()
      } catch {
        // 进程已经退出时 kill 失败没有影响。
      }
    }
  }

  private abortJob(job: PiperJob): void {
    if (job.settled) return
    const index = this.queue.indexOf(job)
    if (index >= 0) {
      this.queue.splice(index, 1)
      this.fail(job, abortedError())
      return
    }
    if (this.active === job) {
      this.fail(job, abortedError())
      try {
        job.child?.kill()
      } catch {
        // 同上。
      }
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()
        if (job === undefined) break
        if (job.settled) continue
        this.active = job
        await this.runOne(job)
        this.active = undefined
      }
    } finally {
      this.pumping = false
      if (this.queue.length > 0) void this.pump()
    }
  }

  /** 跑一个进程；resolve 表示「进程已收尾」，成败通过 job 的 promise 交付。 */
  private runOne(job: PiperJob): Promise<void> {
    return new Promise<void>((resolve) => {
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        resolve()
      }
      if (job.settled) {
        finish()
        return
      }
      const outputPath = join(this.dir, `.piper-${randomUUID()}.wav`)
      let child: PiperChild
      try {
        // 必须用安装目录里的绝对路径：`spawn('piper.exe')` 会去 cwd / PATH 找，
        // 应用从任意工作目录启动时就会 ENOENT（真机验证踩到过）。
        child = this.spawnImpl(join(this.dir, PIPER_EXE), [
          '--model',
          join(this.dir, MODEL_FILE),
          '--output_file',
          outputPath,
        ])
      } catch (error) {
        this.fail(job, new VoiceError(`启动 piper.exe 失败：${messageOf(error)}`, VOICE_ERROR_CODES.piperFailed))
        finish()
        return
      }
      job.child = child
      job.timer = setTimeout(() => {
        if (job.settled) return
        this.fail(
          job,
          new VoiceError(`离线语音合成超时（${this.timeoutMs / 1000} 秒），已终止进程`, VOICE_ERROR_CODES.piperFailed),
        )
        try {
          child.kill()
        } catch {
          // 进程可能已经自己退出。
        }
        // kill 之后 close 事件偶尔收不到（Windows 上尤其如此）：给一个兜底，
        // 否则队列会永远卡在「前一个进程还没收尾」。
        setTimeout(() => {
          rmSync(outputPath, { force: true })
          finish()
        }, 2_000)
      }, this.timeoutMs)

      child.onError((error) => {
        this.fail(job, new VoiceError(`piper.exe 启动失败：${error.message}`, VOICE_ERROR_CODES.piperFailed))
        try {
          child.kill()
        } catch {
          // 同上。
        }
        rmSync(outputPath, { force: true })
        finish()
      })

      child.onClose(async (code) => {
        if (job.timer !== undefined) clearTimeout(job.timer)
        if (!job.settled) {
          if (code !== 0) {
            const detail = job.stderr.trim()
            this.fail(
              job,
              new VoiceError(
                `piper.exe 退出码 ${String(code)}${detail.length === 0 ? '' : `：${detail}`}`,
                VOICE_ERROR_CODES.piperFailed,
              ),
            )
          } else {
            try {
              this.succeed(job, readWav(outputPath))
            } catch (error) {
              this.fail(
                job,
                error instanceof VoiceError ? error : new VoiceError(messageOf(error), VOICE_ERROR_CODES.piperFailed),
              )
            }
          }
        }
        rmSync(outputPath, { force: true })
        finish()
      })

      child.onStderr((chunk) => {
        // 只留最后 2000 字：错误信息够定位即可，别把整段日志塞进 HTTP 响应。
        job.stderr = `${job.stderr}${chunk}`.slice(-2000)
      })

      try {
        child.writeStdin(`${job.text}\n`)
      } catch (error) {
        this.fail(job, new VoiceError(`写入 piper.exe 失败：${messageOf(error)}`, VOICE_ERROR_CODES.piperFailed))
        try {
          child.kill()
        } catch {
          // 同上。
        }
        rmSync(outputPath, { force: true })
      }
    })
  }

  private succeed(job: PiperJob, result: SpeakResult): void {
    if (job.settled) return
    job.settled = true
    if (job.timer !== undefined) clearTimeout(job.timer)
    job.cleanupAbort?.()
    job.resolve(result)
  }

  private fail(job: PiperJob, error: Error): void {
    if (job.settled) return
    job.settled = true
    if (job.timer !== undefined) clearTimeout(job.timer)
    job.cleanupAbort?.()
    job.reject(error)
  }
}

/** 用安装器与合成器拼出目录里那一条离线音色。 */
export function createPiperProvider(installer: PiperInstaller, runner: PiperRunner): VoiceProvider {
  return {
    engine: PIPER_ENGINE,
    describe() {
      const status = installer.installStatus()
      if (status.state === 'ready') {
        return {
          name: '离线（Piper）',
          available: true,
          note: '完全离线，不依赖任何 API Key；声音由本机模型生成',
        }
      }
      return {
        name: '离线（Piper）',
        available: false,
        note: '下载一次后永久可用，之后断网也能朗读',
        reason: reasonOf(status),
      }
    },
    profiles() {
      return [PIPER_PROFILE]
    },
    async synthesize(request, deps) {
      const status = installer.installStatus()
      if (status.state !== 'ready') {
        throw new VoiceError(reasonOf(status), VOICE_ERROR_CODES.engineUnavailable)
      }
      return await runner.synthesize(request.text, deps.signal)
    },
  }
}

/** 状态 → 用户能照着做的一句话。 */
function reasonOf(status: VoiceInstallStatus): string {
  if (status.state === 'downloading') return '离线语音包正在下载，完成后就能用'
  if (status.state === 'error') return `离线语音包安装失败：${status.error ?? '未知原因'}，可以重试`
  if (status.state === 'unsupported') return status.error ?? '当前平台不支持离线语音包'
  return '离线语音包还没下载'
}

/** 插件选项（测试可注入假下载/假进程；生产只传 dataDir）。 */
export interface PiperPluginOptions {
  dataDir: string
  fetchImpl?: PiperFetch
  platform?: NodeJS.Platform
  extractZip?: PiperExtract
  limits?: Partial<PiperSizeLimits>
  requestTimeoutMs?: number
  totalBytesEstimate?: number
  parallelChunks?: number
  parallelMinBytes?: number
  spawnImpl?: PiperSpawn
  synthesisTimeoutMs?: number
  installer?: PiperInstaller
  runner?: PiperRunner
}

/**
 * 语音 Piper 插件入口。
 *
 * provider 注销与安装器/合成器收尾都挂在 voice-piper 自己的 fiber 上：插件关掉时
 * 目录里不再出现 piper、两条路由 404、正在跑的进程被杀，但 `<dataDir>/voice/piper/`
 * 里的文件原样保留，下次打开不必重下。
 * @param options - 数据目录与可注入依赖。
 */
export function voicePiperPlugin(options: PiperPluginOptions): PluginEntry {
  return {
    id: VOICE_PIPER_PLUGIN_ID,
    name: 'Voice Piper',
    description: '离线、开源的中文语音：下载一次后不需要任何 Key，断网也能朗读。',
    group: 'voice',
    capabilities: { routes: [`POST ${PIPER_INSTALL_PATH}`, `GET ${PIPER_STATUS_PATH}`] },
    impact: '关闭后离线音色不可用，云端与系统语音不受影响。',
    inject: ['voice', 'routes'],
    apply: (ctx: Context) => {
      const installer =
        options.installer ??
        new PiperInstaller({
          dataDir: options.dataDir,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.platform === undefined ? {} : { platform: options.platform }),
          ...(options.extractZip === undefined ? {} : { extractZip: options.extractZip }),
          ...(options.limits === undefined ? {} : { limits: options.limits }),
          ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
          ...(options.totalBytesEstimate === undefined ? {} : { totalBytesEstimate: options.totalBytesEstimate }),
          ...(options.parallelChunks === undefined ? {} : { parallelChunks: options.parallelChunks }),
          ...(options.parallelMinBytes === undefined ? {} : { parallelMinBytes: options.parallelMinBytes }),
        })
      const runner =
        options.runner ??
        new PiperRunner({
          dir: installer.dir,
          ...(options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl }),
          ...(options.synthesisTimeoutMs === undefined ? {} : { timeoutMs: options.synthesisTimeoutMs }),
        })
      const provider = createPiperProvider(installer, runner)
      ctx.effect(() => {
        const disposeProvider = ctx.voice.registerProvider(provider)
        return () => {
          disposeProvider()
          runner.dispose()
          installer.dispose()
        }
      }, 'voice-piper.provider')

      const handlers = createVoiceInstallHandlers({
        startInstall: () => installer.startInstall(),
        installStatus: () => installer.installStatus(),
      })
      ctx.routes.register('POST', PIPER_INSTALL_PATH, handlers.install)
      ctx.routes.register('GET', PIPER_STATUS_PATH, handlers.status)
    },
  }
}
