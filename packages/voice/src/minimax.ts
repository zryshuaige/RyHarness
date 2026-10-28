/**
 * MiniMax 语音合成：一次 `POST <base>/t2a_v2`。
 *
 * 为什么单独一个文件而不是塞进 `synthesize.ts`：那个函数是 SiliconFlow 的
 * OpenAI 兼容端点（`POST /audio/speech`，回 mp3 字节流），MiniMax 这边是
 * `POST /t2a_v2`，回 JSON，音频以**十六进制**塞在 `data.audio` 里。两边的请求体、
 * 响应形状、失败语义都不同，硬塞进一个函数只会得到一坨 if。
 *
 * 一条必须记住的坑：**HTTP 200 不等于成功**。MiniMax 的业务码在
 * `base_resp.status_code` 里，鉴权失败（1004）、余额不足（1008）、参数不对（2013）
 * 全都是 200 + 一个非零业务码。只看 HTTP 状态码，这些会一路走到前端变成"合成成功"
 * 的空音频。
 * @module @ryharness/voice/minimax
 */

import {
  DEFAULT_SPEAK_TIMEOUT_MS,
  MAX_SPEAK_TEXT_LENGTH,
  type SpeakResult,
  VOICE_ERROR_CODES,
  VoiceError,
} from './types.ts'

/** MiniMax 国内站的端点根（OpenAI 风格那套 `/v1` 前缀在它这里是巧合，路径并不通用）。 */
export const MINIMAX_TTS_BASE_URL = 'https://api.minimaxi.com/v1'

/** 默认合成模型。 */
export const MINIMAX_TTS_MODEL = 'speech-2.6-hd'

/** 一次合成请求（形状贴着声线文件，见 `voice-file.ts`）。 */
export interface MinimaxSpeakRequest {
  text: string
  /** 上游 `voice_id`：系统音色名、克隆音色 id、还是设计出来的音色 id。 */
  voice: string
  model?: string
  speed?: number
  pitch?: number
  vol?: number
  emotion?: string
  /** 语种增强；`Chinese` 对中文最稳，不给就让上游自己猜。 */
  language?: string
}

/** 合成所需的一切外部依赖（与 `synthesize.ts` 同一套注入方式：测试不触网）。 */
export interface MinimaxDeps {
  fetchImpl: typeof fetch
  /** 上游凭据；空串按"没配凭据"处理。 */
  apiKey: string
  /** 端点根（不带尾部斜杠）。省略 = MiniMax 国内站。 */
  baseUrl?: string
  /** 请求超时毫秒；0 = 不设超时。 */
  timeoutMs?: number
  /** 调用方给的中止信号（客户端断开时用）。 */
  signal?: AbortSignal
}

/** 合成结果：音频字节 + 上游报回来的时长（毫秒，界面用来显示"这段有多长"）。 */
export interface MinimaxSpeakResult extends SpeakResult {
  /** 上游 `extra_info.audio_length`，毫秒。 */
  durationMs?: number
}

/**
 * MiniMax 的业务码 → 我们的错误分类。
 *
 * 分类的依据是**调用方该做什么**：改配置（没 key / 余额不足）、改请求（参数不对）、
 * 等一等（限流），还是这事儿就是上游坏了。归错类比不归类更糟——前端是按 code
 * 分支的。
 */
const UPSTREAM_FAILURES: Readonly<Record<number, { code: string; reason: string }>> = {
  1002: { code: VOICE_ERROR_CODES.rateLimited, reason: '语音服务限流了，稍后再试' },
  1004: { code: VOICE_ERROR_CODES.noCredential, reason: 'MiniMax 的 API Key 不对' },
  1008: { code: VOICE_ERROR_CODES.upstream, reason: 'MiniMax 账户余额不足' },
  1039: { code: VOICE_ERROR_CODES.rateLimited, reason: '语音服务限流了，稍后再试' },
  2013: { code: VOICE_ERROR_CODES.badRequest, reason: '语音请求的参数不对' },
  2049: { code: VOICE_ERROR_CODES.noCredential, reason: 'MiniMax 的 API Key 无效' },
  2061: { code: VOICE_ERROR_CODES.upstream, reason: '当前套餐不支持这个能力' },
}

/**
 * 十六进制 → 字节。
 *
 * 自己写而不用 `Buffer.from(hex, 'hex')`：内核不假设自己只跑在 Node 里（渲染层也
 * 会 import 这个包），而 Buffer 的十六进制解析在遇到非法字符时是**静默截断**——
 * 半截音频比报错难查得多。
 */
function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length === 0 || hex.length % 2 !== 0) return undefined
  if (!/^[0-9a-f]+$/i.test(hex)) return undefined
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/** 从上游 JSON 里挑出我们认识的几个字段。 */
function pick(raw: unknown): {
  audio: string
  statusCode: number
  statusMessage: string
  durationMs?: number
} {
  const record = (typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >
  const data = (
    typeof record.data === 'object' && record.data !== null ? (record.data as Record<string, unknown>) : {}
  ) as Record<string, unknown>
  const base = (
    typeof record.base_resp === 'object' && record.base_resp !== null
      ? (record.base_resp as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>
  const extra = (
    typeof record.extra_info === 'object' && record.extra_info !== null
      ? (record.extra_info as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>
  const statusCode = typeof base.status_code === 'number' ? base.status_code : 0
  const statusMessage = typeof base.status_msg === 'string' ? base.status_msg : ''
  const audio = typeof data.audio === 'string' ? data.audio : ''
  const length = extra.audio_length
  const durationMs = typeof length === 'number' && Number.isFinite(length) ? length : undefined
  return { audio, statusCode, statusMessage, ...(durationMs === undefined ? {} : { durationMs }) }
}

/**
 * 合成一段话。
 *
 * 失败一律抛 {@link VoiceError}（`code` 取 `VOICE_ERROR_CODES`）——与内核里另一条
 * 合成路径同一个约定：不返回"空音频 + 错误标志"，那种形状进了 `<audio>` 只会静默
 * 不响。
 */
export async function synthesizeMinimax(request: MinimaxSpeakRequest, deps: MinimaxDeps): Promise<MinimaxSpeakResult> {
  const text = request.text.trim()
  if (text.length === 0) {
    throw new VoiceError('要朗读的文本不能为空', VOICE_ERROR_CODES.badRequest)
  }
  if (deps.apiKey.length === 0) {
    throw new VoiceError('还没配置 MiniMax 的 API Key，先去设置里填', VOICE_ERROR_CODES.noCredential)
  }
  const voice = request.voice.trim()
  if (voice.length === 0) {
    throw new VoiceError('声线文件里没写上游的 voice', VOICE_ERROR_CODES.badRequest)
  }

  const endpoint = `${(deps.baseUrl ?? MINIMAX_TTS_BASE_URL).replace(/\/+$/, '')}/t2a_v2`
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SPEAK_TIMEOUT_MS
  const voiceSetting: Record<string, unknown> = { voice_id: voice }
  if (request.speed !== undefined) voiceSetting.speed = request.speed
  if (request.pitch !== undefined) voiceSetting.pitch = request.pitch
  if (request.vol !== undefined) voiceSetting.vol = request.vol
  if (request.emotion !== undefined) voiceSetting.emotion = request.emotion

  let response: Response
  try {
    // 客户端断开与超时两个信号都要在：前者让"用户已经切走了"能立刻停，后者兜住
    // 上游卡住不返回。
    const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
    const signal =
      deps.signal === undefined
        ? timeout
        : timeout === undefined
          ? deps.signal
          : AbortSignal.any([deps.signal, timeout])
    response = await deps.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deps.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model ?? MINIMAX_TTS_MODEL,
        text: text.slice(0, MAX_SPEAK_TEXT_LENGTH),
        ...(request.language === undefined ? {} : { language_boost: request.language }),
        voice_setting: voiceSetting,
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (cause) {
    throw new VoiceError('连不上语音服务，请检查网络', VOICE_ERROR_CODES.upstream, { cause })
  }

  if (!response.ok) {
    const body = await response.text().catch(() => {
      return ''
    })
    throw new VoiceError(
      `语音服务返回 HTTP ${response.status}${body.length === 0 ? '' : `：${body.slice(0, 200)}`}`,
      VOICE_ERROR_CODES.upstream,
      {
        upstreamStatus: response.status,
      },
    )
  }

  const raw = await response.json().catch(() => {
    return undefined
  })
  const { audio, statusCode, statusMessage, durationMs } = pick(raw)
  if (statusCode !== 0) {
    const known = UPSTREAM_FAILURES[statusCode]
    throw new VoiceError(
      known === undefined
        ? `语音服务拒绝了这次合成：${statusMessage.length === 0 ? `业务码 ${statusCode}` : statusMessage}`
        : known.reason,
      known?.code ?? VOICE_ERROR_CODES.upstream,
      { upstreamCode: String(statusCode), upstreamStatus: response.status },
    )
  }

  // `data.audio` 正常是十六进制；万一上游改成了「给个链接」，那是另一回事，
  // 当成失败比把一段 URL 当音频塞给 <audio> 强。
  if (audio.length === 0) {
    throw new VoiceError('语音服务返回了空音频', VOICE_ERROR_CODES.upstream, { upstreamStatus: response.status })
  }
  if (audio.startsWith('http://') || audio.startsWith('https://')) {
    throw new VoiceError('语音服务返回了链接而不是音频', VOICE_ERROR_CODES.upstream, {
      upstreamStatus: response.status,
    })
  }
  const bytes = hexToBytes(audio)
  if (bytes === undefined) {
    throw new VoiceError('语音服务返回的音频不是可解码的十六进制', VOICE_ERROR_CODES.upstream, {
      upstreamStatus: response.status,
    })
  }

  return {
    audio: bytes,
    mime: 'audio/mpeg',
    format: 'mp3',
    ...(durationMs === undefined ? {} : { durationMs }),
  }
}
