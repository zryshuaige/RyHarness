/**
 * 云端语音合成：一次 OpenAI 兼容的 `POST <base>/audio/speech`。
 *
 * 纯函数式——fetch、凭据、音色都从 `deps` 注入，所以测试不需要真 key、不触网。
 * @module @ryharness/voice/synthesize
 */

import { speakerModel, voiceProfile } from './catalog.ts'
import {
  DEFAULT_SPEAK_TIMEOUT_MS,
  MAX_SPEAK_SPEED,
  MAX_SPEAK_TEXT_LENGTH,
  MIN_SPEAK_SPEED,
  type SpeakRequest,
  type SpeakResult,
  VOICE_ERROR_CODES,
  VoiceError,
  type VoiceProfile,
} from './types.ts'

/** SiliconFlow 官方端点根（OpenAI 兼容的 `/v1`）。自建网关可经 deps.baseUrl 覆盖。 */
export const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1'

/** 合成所需的一切外部依赖。 */
export interface SpeakDeps {
  /** 注入的 fetch（生产传全局的，测试传假实现）。 */
  fetchImpl: typeof fetch
  /** 上游凭据；空串按"没配凭据"处理，而不是发一个注定 401 的请求。 */
  apiKey: string
  /** 端点根（不带尾部斜杠）。省略 = SiliconFlow 官方地址。 */
  baseUrl?: string
  /** 直接指定音色，省去按 id 查目录（测试与自定义音色用）。 */
  profile?: VoiceProfile
  /** 请求超时毫秒；0 = 不设超时。 */
  timeoutMs?: number
}

/** 按长度上界截断，并如实告诉调用方截了（UI 要能说明"只念了前半段"）。 */
export function truncateForSynthesis(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_SPEAK_TEXT_LENGTH) return { text, truncated: false }
  return { text: text.slice(0, MAX_SPEAK_TEXT_LENGTH), truncated: true }
}

/** 语速夹到端点支持的区间；非数字按 1（端点默认值）处理。 */
function clampSpeed(speed: number | undefined): number {
  if (speed === undefined || !Number.isFinite(speed)) return 1
  return Math.min(MAX_SPEAK_SPEED, Math.max(MIN_SPEAK_SPEED, speed))
}

/** 上游错误正文里的 `{code, message}`；不是这个形状就返回 undefined。 */
function upstreamDetail(payload: unknown): { code?: string; message?: string } {
  if (typeof payload !== 'object' || payload === null) return {}
  const record = payload as Record<string, unknown>
  const code = typeof record.code === 'string' || typeof record.code === 'number' ? String(record.code) : undefined
  const message = typeof record.message === 'string' ? record.message : undefined
  return { ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) }
}

/** 内容类型 → 输出格式。只认 wav，其余（mp3/opus/pcm）一律当 mp3 之外的字节流不可假设。 */
function responseFormat(contentType: string): SpeakResult['format'] {
  return contentType.includes('wav') ? 'wav' : 'mp3'
}

/**
 * 合成一段话。
 *
 * 失败一律抛 {@link VoiceError}（`code` 取 `VOICE_ERROR_CODES`）——不返回"空音频 +
 * 错误标志"那种形状：空数组进了 `<audio>` 只会静默不响，而调用方要的是能区分的
 * 失败原因（没配 key / 本机音色 / 被节流 / 上游挂了）。
 */
export async function synthesize(request: SpeakRequest, deps: SpeakDeps): Promise<SpeakResult> {
  const text = request.text.trim()
  if (text.length === 0) {
    throw new VoiceError('要朗读的文本不能为空', VOICE_ERROR_CODES.badRequest)
  }
  const profile = deps.profile ?? voiceProfile(request.profileId)
  if (profile === undefined) {
    throw new VoiceError(`目录里没有音色「${request.profileId}」`, VOICE_ERROR_CODES.unknownProfile)
  }
  if (profile.engine === 'system') {
    throw new VoiceError(
      `音色「${profile.name}」是系统语音，由渲染层直接朗读，不经过服务端合成`,
      VOICE_ERROR_CODES.engineLocal,
    )
  }
  if (deps.apiKey.length === 0) {
    throw new VoiceError('还没配置 API Key，先去设置里填', VOICE_ERROR_CODES.noCredential)
  }
  const model = speakerModel(profile.voice)
  if (model === undefined) {
    throw new VoiceError(`音色「${profile.name}」的 voice 不是「模型:说话人」形式`, VOICE_ERROR_CODES.unknownProfile)
  }

  const endpoint = `${(deps.baseUrl ?? SILICONFLOW_BASE_URL).replace(/\/+$/, '')}/audio/speech`
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SPEAK_TIMEOUT_MS
  let response: Response
  try {
    response = await deps.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deps.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        // voice 必须带模型前缀：裸 speaker 名会被端点判 Invalid voice（实测）。
        voice: profile.voice,
        input: truncateForSynthesis(text).text,
        response_format: 'mp3',
        speed: clampSpeed(request.speed),
      }),
      ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    })
  } catch (cause) {
    throw new VoiceError('连不上语音服务，请检查网络', VOICE_ERROR_CODES.upstream, { cause })
  }

  if (!response.ok) {
    const body = await response.text().catch(() => {
      return ''
    })
    const detail = upstreamDetail(safeJson(body))
    const reason = detail.message ?? body.slice(0, 200)
    throw new VoiceError(
      `语音服务返回 HTTP ${response.status}${reason === '' ? '' : `：${reason}`}`,
      VOICE_ERROR_CODES.upstream,
      {
        upstreamStatus: response.status,
        ...(detail.code === undefined ? {} : { upstreamCode: detail.code }),
      },
    )
  }

  const audio = new Uint8Array(await response.arrayBuffer())
  if (audio.byteLength === 0) {
    throw new VoiceError('语音服务返回了空音频', VOICE_ERROR_CODES.upstream, { upstreamStatus: response.status })
  }
  const format = responseFormat(response.headers.get('content-type') ?? '')
  return { audio, mime: format === 'wav' ? 'audio/wav' : 'audio/mpeg', format }
}

/** 错误正文可能不是 JSON；解析失败就交回 undefined，由调用方回退到原文。 */
function safeJson(text: string): unknown {
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
