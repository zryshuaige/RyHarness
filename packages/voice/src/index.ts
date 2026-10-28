/**
 * RyHarness 语音合成内核：音色目录 + 云端合成 + 节流。
 *
 * 服务端（`apps/server` 的 `/api/voice/*`）是唯一的调用方；本机音色（`system`
 * 引擎）不经这里——渲染层用 `speechSynthesis` 自己念，服务端对那种音色回
 * `VOICE_ENGINE_LOCAL` 让它降级。
 * @module @ryharness/voice
 */

export type { VoiceEngineInfo } from './catalog.ts'
export {
  allVoiceProfiles,
  declareVoiceId,
  isKnownVoiceId,
  registerVoiceProfile,
  speakerModel,
  VOICE_ENGINES,
  VOICE_PROFILES,
  voiceProfile,
  voiceProfilesForEngine,
} from './catalog.ts'
export type { MinimaxDeps, MinimaxSpeakRequest, MinimaxSpeakResult } from './minimax.ts'
export { MINIMAX_TTS_BASE_URL, MINIMAX_TTS_MODEL, synthesizeMinimax } from './minimax.ts'
export type { RateLimitOptions, RateLimitVerdict, VoiceRateLimiter } from './rate-limit.ts'
export { createVoiceRateLimiter, DEFAULT_MAX_CONCURRENT, DEFAULT_MIN_INTERVAL_MS } from './rate-limit.ts'
export type { SpeakDeps } from './synthesize.ts'
export { SILICONFLOW_BASE_URL, synthesize, truncateForSynthesis } from './synthesize.ts'
export type {
  SpeakRequest,
  SpeakResult,
  VoiceEngineId,
  VoiceErrorOptions,
  VoiceProfile,
} from './types.ts'
export {
  DEFAULT_SPEAK_TIMEOUT_MS,
  MAX_SPEAK_SPEED,
  MAX_SPEAK_TEXT_LENGTH,
  MIN_SPEAK_SPEED,
  VOICE_ERROR_CODES,
  VoiceError,
} from './types.ts'
export type { VoiceFile } from './voice-file.ts'
export { DEFAULT_VOICE_FILES, parseVoiceFile, RYEN_CAT_VOICE, voiceFileToProfile } from './voice-file.ts'
