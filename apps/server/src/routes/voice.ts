/**
 * 语音路由的纯 handler 工厂：音色目录与云端合成。
 *
 * 路由不再由本模块往 Router 上挂——挂载权归 `voice` 插件的 RouteRegistry，
 * 插件卸载时两条路由随之消失。这里只做 HTTP 层的入参校验、状态码映射与字节流
 * 写出；凭据查找、节流与合成在插件的 `VoiceRegistry` 里。
 * @module @ryharness/server/routes/voice
 */

import { VOICE_ERROR_CODES, VoiceError, type VoiceProfile } from '@ryharness/voice'
import { type Handler, json } from '../router.ts'

/** 目录里一个引擎的对外视图。 */
export interface VoiceEngineView {
  id: string
  name: string
  available: boolean
  note?: string
  /** `available:false` 时给用户的可操作原因（没配 Key、还没下载…）。 */
  reason?: string
}

/** 离线语音包的安装状态（GET /api/voice/engines/:id/status）。 */
export interface VoiceInstallStatus {
  state: 'absent' | 'downloading' | 'ready' | 'error' | 'unsupported'
  /** 已下载字节（跨全部文件累计）。 */
  receivedBytes?: number
  /** 预计总字节（下载源没报 Content-Length 时按已知下限估）。 */
  totalBytes?: number
  /** 失败 / 不支持的原因；成功与进行中缺省。 */
  error?: string
}

/** 安装卡依赖的最小能力：启动与查询都返回当前状态。 */
export interface VoiceInstallService {
  startInstall(): VoiceInstallStatus
  installStatus(): VoiceInstallStatus
}

/** GET /api/voice/catalog 的响应体。 */
export interface VoiceCatalogView {
  engines: VoiceEngineView[]
  profiles: readonly VoiceProfile[]
}

/** POST /api/voice/speak 的入参（校验后）。 */
export interface VoiceSpeakInput {
  text: string
  profileId: string
  speed?: number
}

/** 一次成功合成的结果；路由只负责把它写成 audio 字节流。 */
export interface VoiceAudio {
  audio: Uint8Array
  mime: string
  profileId: string
  truncated: boolean
}

/** handler 工厂依赖的最小语音能力（插件里的 VoiceRegistry 实现它）。 */
export interface VoiceService {
  catalog(): VoiceCatalogView
  /**
   * @param options.signal - 客户端断开时中止合成（spawn 的进程必须能被杀掉）。
   */
  speak(input: VoiceSpeakInput, options?: { signal?: AbortSignal }): Promise<VoiceAudio>
}

/** 白名单校验：只认 text / profileId / speed 三个字段，其余键一律丢弃。 */
function parseSpeakInput(body: unknown): VoiceSpeakInput {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const text = typeof record.text === 'string' ? record.text : ''
  const profileId = typeof record.profileId === 'string' ? record.profileId.trim() : ''
  if (profileId.length === 0) {
    throw new VoiceError('profileId 是必填的', VOICE_ERROR_CODES.badRequest)
  }
  const speed = typeof record.speed === 'number' ? record.speed : undefined
  return { text, profileId, ...(speed === undefined ? {} : { speed }) }
}

/**
 * 语音失败 → HTTP 状态。
 *
 * 凭据缺失与入参不合法都是 4xx：调用方改配置或改请求就行，重试没有意义。上游故障
 * 归 502（不是 500——服务端自己没坏），节流归 429 且带 Retry-After。
 */
const VOICE_STATUS: Record<string, number> = {
  [VOICE_ERROR_CODES.badRequest]: 400,
  [VOICE_ERROR_CODES.unknownProfile]: 400,
  [VOICE_ERROR_CODES.engineLocal]: 400,
  [VOICE_ERROR_CODES.noCredential]: 400,
  [VOICE_ERROR_CODES.rateLimited]: 429,
  [VOICE_ERROR_CODES.upstream]: 502,
  // 引擎没注册 = 这个能力此刻不存在（插件关了/引擎未装），不是请求写错了；
  // 503 让调用方知道「等它回来可以重试」，而不是去改 profileId。
  [VOICE_ERROR_CODES.engineUnavailable]: 503,
  [VOICE_ERROR_CODES.piperFailed]: 502,
}

/** 把抛出的东西翻成 `{error, code}` 响应；非语音错误才是真的 500。 */
function sendVoiceFailure(res: Parameters<typeof json>[0], error: unknown): void {
  if (!(error instanceof VoiceError)) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error), code: 'INTERNAL' })
    return
  }
  const status = VOICE_STATUS[error.code] ?? 502
  json(res, status, {
    error: error.message,
    code: error.code,
    // 上游自己的状态码与业务码一起带出去：语音服务报的 Invalid voice / 限流，
    // 光看"502"谁也查不出是哪一头的问题。
    ...(error.upstreamStatus === undefined ? {} : { upstreamStatus: error.upstreamStatus }),
    ...(error.upstreamCode === undefined ? {} : { upstreamCode: error.upstreamCode }),
  })
}

/**
 * 造出两条路由的 handler。
 *
 * 目录失败（插件被卸载后 404）由插件层决定是否还有路由；这里只处理语音业务错误。
 * @param voice - 语音能力实现（`VoiceRegistry`）。
 */
export function createVoiceHandlers(voice: VoiceService): { catalog: Handler; speak: Handler } {
  /**
   * GET /api/voice/catalog：有哪些引擎、各自能不能用、有哪些音色。
   *
   * `available` 如实反映当前配置：系统音色恒 true（不依赖任何配置），云端看用户
   * 有没有给这条路线填上可用凭据。界面据此决定"显示但置灰"还是"根本不列"——把一条
   * 用不了的音色摆成可选，用户点了才失败，那才是真的骗人。
   */
  const catalog: Handler = async (_req, res) => {
    json(res, 200, voice.catalog())
  }

  /**
   * POST /api/voice/speak：把一句话合成为音频字节流。
   *
   * 回的是 `audio/mpeg` 本身而不是 JSON 包一层 base64：渲染层拿到就能喂给
   * `<audio>`，省掉一次 base64 编解码。`X-Voice-Profile` 回显这次用的是哪条音色
   * （截断发生时同时给 `X-Voice-Truncated`，让界面能说明"只念了前半段"）。
   */
  const speak: Handler = async (req, res) => {
    try {
      const input = parseSpeakInput(await req.body())
      // 客户端中途断开（切会话、关窗）时把 signal 传到底：离线合成是真进程，
      // 不杀就会在后台把一个 30 秒的 piper.exe 跑完。
      const controller = new AbortController()
      const abort = (): void => {
        if (!res.writableEnded) controller.abort()
      }
      req.raw.once('aborted', abort)
      res.once('close', abort)
      let result: VoiceAudio
      try {
        result = await voice.speak(input, { signal: controller.signal })
      } finally {
        req.raw.off('aborted', abort)
        res.off('close', abort)
      }
      res.writeHead(200, {
        'content-type': result.mime,
        'content-length': result.audio.byteLength,
        'x-voice-profile': result.profileId,
        ...(result.truncated ? { 'x-voice-truncated': 'true' } : {}),
      })
      res.end(Buffer.from(result.audio))
    } catch (error) {
      sendVoiceFailure(res, error)
    }
  }

  return { catalog, speak }
}

/**
 * 离线语音包的安装/状态两条路由。
 *
 * POST 只负责**启动**（下载是异步的），所以立即回 202 + 当前状态；重复点击拿到的是
 * 同一份进行中的状态，而不是再起一遍下载。GET 恒 200，失败原因放在 `error` 里——
 * 「轮询失败状态」本身不是 HTTP 失败，前端要靠它渲染重试按钮。
 * @param service - 某个引擎的安装器（Piper 插件传入）。
 */
export function createVoiceInstallHandlers(service: VoiceInstallService): { install: Handler; status: Handler } {
  const install: Handler = async (_req, res) => {
    const snapshot = service.startInstall()
    json(res, snapshot.state === 'downloading' ? 202 : 200, snapshot)
  }
  const status: Handler = async (_req, res) => {
    json(res, 200, service.installStatus())
  }
  return { install, status }
}
