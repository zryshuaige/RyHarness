/**
 * 语音域的请求契约：**形状的唯一真源**。
 *
 * 三个字段全部可缺省：`profileId` 缺失回的是带 VOICE_BAD_REQUEST 机器码的
 * VoiceError（测试逐字断言这个码），所以「必填」留在 handler；`text` 非字符串
 * 会被 handler 当空串收下再被「空文本」校验挡下，`speed` 非数字直接丢弃——
 * 这些宽容语义不进 schema。
 * @module @ryharness/server/contract/voice
 */

import z from '@ryharness/schemastery'

/** POST /api/voice/speak 的入参形状（语义校验后才是 VoiceSpeakInput）。 */
export interface SpeakBodyInput {
  text?: string
  profileId?: string
  speed?: number
}

export const SpeakBody: z<SpeakBodyInput> = z.object({
  text: z.string(),
  profileId: z.string(),
  speed: z.number(),
})
