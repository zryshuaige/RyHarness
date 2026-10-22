/**
 * 语音合成的类型、错误码与常量。
 *
 * 放在最前面是因为 catalog 与 synthesize 都要它，而它自己不依赖任何模块。
 * @module @ryharness/voice/types
 */

import { HarnessError } from '@ryharness/llm'

/**
 * 语音引擎。
 *
 * - `system`：Windows 自带的系统语音，**不经服务端**——渲染层用 Web Speech API 的
 *   `speechSynthesis` 直接念。对它调服务端合成必须明确失败（见 {@link VoiceEngineId}
 *   在 `POST /api/voice/speak` 里的约定），否则前端会拿到一个永远等不到声音的请求。
 * - `siliconflow`：OpenAI 兼容的云端 TTS（`POST <base>/audio/speech`）。
 * - `piper`：本机 Piper 离线合成（插件注册的 provider）。
 *
 * 末尾的 `(string & {})` 让**注册进来的引擎**不必改内核类型：宿主允许插件自带引擎 id，
 * 但字面量仍保留补全。渲染层与会话说到底只把它当不透明字符串。
 */
export type VoiceEngineId = 'system' | 'siliconflow' | 'piper' | (string & {})

/**
 * 一个可选音色。
 *
 * `voice` 承载的是**上游端点要的取值**，两种引擎各是一套：
 * - `siliconflow`：完整的 `模型:说话人` 串（如 `FunAudioLLM/CosyVoice2-0.5B:anna`）。
 *   端点只认这种带模型前缀的写法，写裸 `anna` 会被判 `Invalid voice`（实测）。
 * - `system`：Windows SAPI 的音色名（如 `Microsoft Huihui Desktop`），由渲染层交给
 *   `speechSynthesis` 挑选，服务端不解释它。
 */
export interface VoiceProfile {
  id: string
  /** 界面显示名。 */
  name: string
  engine: VoiceEngineId
  /** 上游端点的 voice 取值（见 {@link VoiceProfile} 上的说明）。 */
  voice: string
  /** 性别（目录里有的才是实测/官方给出的，没有就留空而不是猜）。 */
  gender?: string
  /** 风格（沉稳 / 欢快 / 温柔…）。 */
  style?: string
  /** 试听用的固定句子。 */
  sampleText: string
  /** 一句话说明这条音色跑在什么上、适合什么场景。 */
  description: string
}

/** 一次合成请求。 */
export interface SpeakRequest {
  text: string
  profileId: string
  /** 语速；缺省 1，越界由内核夹到 {@link MIN_SPEAK_SPEED}–{@link MAX_SPEAK_SPEED}。 */
  speed?: number
}

/** 一次合成的结果：音频字节本身 + 够渲染层直接喂给 `<audio>` 的类型信息。 */
export interface SpeakResult {
  audio: Uint8Array
  mime: string
  format: 'mp3' | 'wav'
}

/**
 * 语音合成的机器码。前端按 `code` 分支，不解析 `message` 文本。
 *
 * 与服务端 `HttpRequestError` 的默认码区分开：这几条描述的是"语音这条路特有的
 * 处置"，其中 {@link VOICE_ERROR_CODES.engineLocal} 尤其重要——它是渲染层该
 * 从服务端合成降级到本机 `speechSynthesis` 的唯一依据。
 */
export const VOICE_ERROR_CODES = {
  /** profileId 查无此音色（含引擎不支持该音色）。 */
  unknownProfile: 'VOICE_PROFILE_NOT_FOUND',
  /** 入参不合法：文本为空、speed 不是数字… */
  badRequest: 'VOICE_BAD_REQUEST',
  /** 引擎在本机（system）：服务端合成不了，前端降级到 speechSynthesis。 */
  engineLocal: 'VOICE_ENGINE_LOCAL',
  /** 这条云端路线还没有可用凭据（去设置里填 API Key）。 */
  noCredential: 'VOICE_NO_CREDENTIAL',
  /** 被本机节流挡下（同一音色太密，或全局并发已满）。 */
  rateLimited: 'VOICE_RATE_LIMITED',
  /** 上游服务本身失败（网络、HTTP 错误码、空音频）。 */
  upstream: 'VOICE_UPSTREAM',
  /** 音色属于某个引擎，但此刻没有引擎提供方（插件被关闭 / 尚未装载）。 */
  engineUnavailable: 'VOICE_ENGINE_UNAVAILABLE',
  /** Piper 进程失败：非零退出、超时、无法启动或输出不是 WAV。 */
  piperFailed: 'VOICE_PIPER_FAILED',
} as const

/**
 * 单次合成允许的文本长度上限（字符）。
 *
 * 按输入的 UTF-8 字节数计费的上游（SiliconFlow 就是）没有长度上限时会把一段长文
 * 拆成很长的音频，而一次朗读的合理长度就是几句话；这里给一个硬上界，超出的部分
 * 截断（见 `truncateForSynthesis`），而不是把用户的排障时间耗在一次几分钟的合成上。
 */
export const MAX_SPEAK_TEXT_LENGTH = 2000

/** 语速下界（与上游端点声明的取值范围一致）。 */
export const MIN_SPEAK_SPEED = 0.25

/** 语速上界。 */
export const MAX_SPEAK_SPEED = 4

/** 合成超时（毫秒）。2000 字的长文在慢线路上也要合成得完，超时由调用方按需调。 */
export const DEFAULT_SPEAK_TIMEOUT_MS = 30_000

/** VoiceError 的附加信息：上游自己的状态码与业务码（透传给前端排查用）。 */
export interface VoiceErrorOptions extends ErrorOptions {
  /** 上游返回的 HTTP 状态码。 */
  upstreamStatus?: number
  /** 上游返回的业务码（如 SiliconFlow 的 `20047 Invalid voice`）。 */
  upstreamCode?: string
}

/**
 * 语音合成的失败。走 {@link HarnessError} 是为了与内核既有的错误分类同一套
 * taxonomy：服务端 `describeFailure` 认得它，工具结果与回放也能保住这个失败类。
 * `code` 取 {@link VOICE_ERROR_CODES} 之一。
 */
export class VoiceError extends HarnessError {
  readonly upstreamStatus: number | undefined
  readonly upstreamCode: string | undefined

  constructor(message: string, code: string, options: VoiceErrorOptions = {}) {
    super(message, code, options)
    this.upstreamStatus = options.upstreamStatus
    this.upstreamCode = options.upstreamCode
  }
}
