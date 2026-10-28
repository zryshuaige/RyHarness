/**
 * MiniMax 合成客户端：请求形状、十六进制解码、业务码归类。
 *
 * 这里量的是「上游回什么，我们把它变成什么」——尤其是业务码：MiniMax 的鉴权失败
 * （1004）、余额不足（1008）、参数不对（2013）全是 HTTP 200 + 非零业务码，只看
 * HTTP 状态码的话，它们会一路走到前端变成"合成成功"的空音频。
 */

import { describe, expect, it, vi } from 'vitest'
import { MINIMAX_TTS_BASE_URL, synthesizeMinimax, VOICE_ERROR_CODES, VoiceError } from '../src/index.ts'

/** 上游正常回包的样子：十六进制音频 + 业务码 0。 */
function okBody(hex = '494433', extra: Record<string, unknown> = {}): unknown {
  return {
    data: { audio: hex, status: 2 },
    extra_info: { audio_length: 1234, usage_characters: 12 },
    base_resp: { status_code: 0, status_msg: 'success' },
    ...extra,
  }
}

/** 一个只回固定 JSON 的假 fetch。 */
function fakeFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

/** 跑一次合成，失败时把 VoiceError 交回调用方断言。 */
async function run(request: Parameters<typeof synthesizeMinimax>[0], body: unknown, status = 200): Promise<unknown> {
  return await synthesizeMinimax(request, { fetchImpl: fakeFetch(body, status), apiKey: 'test-key' })
}

const BASE_REQUEST = { text: '你好，我是 Ryen。', voice: 'Chinese (Mandarin)_Crisp_Girl' }

describe('MiniMax 合成', () => {
  it('十六进制音频解码成字节，并带上上游报的时长', async () => {
    const result = await run(BASE_REQUEST, okBody('494433'))
    expect(result).toBeDefined()
    const value = result as { audio: Uint8Array; mime: string; format: string; durationMs?: number }
    expect(Array.from(value.audio)).toEqual([0x49, 0x44, 0x33])
    expect(value.mime).toBe('audio/mpeg')
    expect(value.format).toBe('mp3')
    expect(value.durationMs).toBe(1234)
  })

  it('请求打的是 t2a_v2，声音参数进 voice_setting', async () => {
    const fetchImpl = fakeFetch(okBody())
    await synthesizeMinimax(
      { ...BASE_REQUEST, model: 'speech-2.6-hd', speed: 1.05, pitch: 2, vol: 1, emotion: 'happy', language: 'Chinese' },
      { fetchImpl, apiKey: 'test-key' },
    )
    const call = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(call?.[0]).toBe(`${MINIMAX_TTS_BASE_URL}/t2a_v2`)
    const init = call?.[1] as RequestInit
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key')
    const body = JSON.parse(init.body as string) as {
      model: string
      text: string
      language_boost?: string
      voice_setting: Record<string, unknown>
    }
    expect(body.model).toBe('speech-2.6-hd')
    expect(body.text).toBe('你好，我是 Ryen。')
    expect(body.language_boost).toBe('Chinese')
    expect(body.voice_setting.voice_id).toBe('Chinese (Mandarin)_Crisp_Girl')
    expect(body.voice_setting.speed).toBe(1.05)
    expect(body.voice_setting.pitch).toBe(2)
    expect(body.voice_setting.emotion).toBe('happy')
  })

  it('文本为空、没配 key、没写 voice：入参问题当场说清，不发注定失败的请求', async () => {
    const fetchImpl = fakeFetch(okBody())
    await expect(
      synthesizeMinimax({ text: '  ', voice: 'x' }, { fetchImpl, apiKey: 'test-key' }),
    ).rejects.toMatchObject({ code: VOICE_ERROR_CODES.badRequest })
    await expect(synthesizeMinimax(BASE_REQUEST, { fetchImpl, apiKey: '' })).rejects.toMatchObject({
      code: VOICE_ERROR_CODES.noCredential,
    })
    await expect(
      synthesizeMinimax({ text: '话', voice: '  ' }, { fetchImpl, apiKey: 'test-key' }),
    ).rejects.toMatchObject({ code: VOICE_ERROR_CODES.badRequest })
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0)
  })

  it('业务码归类：鉴权失败、余额不足、参数不对、限流各有各的处置', async () => {
    const cases: { code: number; expect: string }[] = [
      { code: 1004, expect: VOICE_ERROR_CODES.noCredential },
      { code: 2049, expect: VOICE_ERROR_CODES.noCredential },
      { code: 1008, expect: VOICE_ERROR_CODES.upstream },
      { code: 2013, expect: VOICE_ERROR_CODES.badRequest },
      { code: 1002, expect: VOICE_ERROR_CODES.rateLimited },
      { code: 1039, expect: VOICE_ERROR_CODES.rateLimited },
      { code: 2061, expect: VOICE_ERROR_CODES.upstream },
      { code: 1234, expect: VOICE_ERROR_CODES.upstream },
    ]
    for (const item of cases) {
      const body = { data: { audio: '' }, base_resp: { status_code: item.code, status_msg: '失败' } }
      const error = await run(BASE_REQUEST, body).catch((reason: unknown) => {
        return reason
      })
      expect(error).toBeInstanceOf(VoiceError)
      expect((error as VoiceError).code).toBe(item.expect)
      expect((error as VoiceError).upstreamCode).toBe(String(item.code))
    }
  })

  it('HTTP 200 但音频是空的、不是十六进制、或者干脆是个链接：都算失败', async () => {
    const empty = await run(BASE_REQUEST, okBody('')).catch((reason: unknown) => {
      return reason
    })
    expect(empty).toBeInstanceOf(VoiceError)

    const notHex = await run(BASE_REQUEST, okBody('zzzz')).catch((reason: unknown) => {
      return reason
    })
    expect(notHex).toBeInstanceOf(VoiceError)

    const link = await run(BASE_REQUEST, okBody('https://example.invalid/a.mp3')).catch((reason: unknown) => {
      return reason
    })
    expect(link).toBeInstanceOf(VoiceError)
  })

  it('连不上上游时给的是网络类失败，不是空音频', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const error = await synthesizeMinimax(BASE_REQUEST, { fetchImpl, apiKey: 'test-key' }).catch((reason: unknown) => {
      return reason
    })
    expect(error).toBeInstanceOf(VoiceError)
    expect((error as VoiceError).code).toBe(VOICE_ERROR_CODES.upstream)
  })
})
