/**
 * `synthesize` 的请求组装与失败路径。
 *
 * 全部走注入的假 fetch：断言的是**发出去的形状**（URL / headers / body 字段）与
 * 失败时抛出的机器码，不触网、不需要真 key。
 */
import { describe, expect, it } from 'vitest'
import type { SpeakDeps } from '../src/index.ts'
import { MAX_SPEAK_TEXT_LENGTH, VOICE_ERROR_CODES, VoiceError } from '../src/index.ts'
import { SILICONFLOW_BASE_URL, synthesize, truncateForSynthesis } from '../src/synthesize.ts'

interface Captured {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

interface Stub {
  fetchImpl: typeof fetch
  calls: Captured[]
}

/** 一段真的 mp3 会有的头（ID3），用来断言字节流原样透传。 */
const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x21, 0xff, 0xfb])

function stubFetch(reply: { status?: number; contentType?: string; body?: Uint8Array; text?: string }): Stub {
  const calls: Captured[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    })
    const status = reply.status ?? 200
    const contentType = reply.contentType ?? 'audio/mpeg'
    const payload = reply.body ?? (status >= 400 ? new Uint8Array() : MP3_BYTES)
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
      arrayBuffer: async () =>
        payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer,
      text: async () => reply.text ?? '',
    } as Response
  }) as typeof fetch
  return { fetchImpl, calls }
}

function deps(fetchImpl: typeof fetch, extra: Partial<SpeakDeps> = {}): SpeakDeps {
  return { fetchImpl, apiKey: 'sk-test-key', baseUrl: 'https://gateway.test/v1', ...extra }
}

/** 取第 index 条元素；越界说明被测代码根本没走到那一步，当场抛出比断言 undefined 更快定位。 */
function at<T>(list: readonly T[], index: number): T {
  const item = list[index]
  if (item === undefined) throw new Error(`没有下标 ${index} 的元素`)
  return item
}

async function failure(promise: Promise<unknown>): Promise<VoiceError> {
  let thrown: unknown
  try {
    await promise
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(VoiceError)
  return thrown as VoiceError
}

describe('合成请求的组装', () => {
  it('打向 <base>/audio/speech，带 Bearer 凭据；body 的 model 与 voice 前缀一致', async () => {
    const { fetchImpl, calls } = stubFetch({})
    const result = await synthesize(
      { text: '你好，我是 Ryen。', profileId: 'sf-cosyvoice2-anna', speed: 1.25 },
      deps(fetchImpl),
    )
    expect(calls).toHaveLength(1)
    expect(at(calls, 0).url).toBe('https://gateway.test/v1/audio/speech')
    expect(at(calls, 0).headers.authorization).toBe('Bearer sk-test-key')
    expect(at(calls, 0).headers['content-type']).toBe('application/json')
    // 端点只认带模型前缀的 voice：这里断言 model 与 voice 的前半段字面一致，
    // 两处各写一份而不校验的话，改目录时迟早会对不上。
    expect(at(calls, 0).body.model).toBe('FunAudioLLM/CosyVoice2-0.5B')
    expect(at(calls, 0).body.voice).toBe('FunAudioLLM/CosyVoice2-0.5B:anna')
    expect(at(calls, 0).body.input).toBe('你好，我是 Ryen。')
    expect(at(calls, 0).body.response_format).toBe('mp3')
    expect(at(calls, 0).body.speed).toBe(1.25)
    expect(result.audio).toEqual(MP3_BYTES)
    expect(result.mime).toBe('audio/mpeg')
    expect(result.format).toBe('mp3')
  })

  it('省略 baseUrl 时打 SiliconFlow 官方端点；尾部斜杠归一', async () => {
    const official = stubFetch({})
    await synthesize({ text: '你好', profileId: 'sf-moss-alex' }, deps(official.fetchImpl, { baseUrl: undefined }))
    expect(at(official.calls, 0).url).toBe(`${SILICONFLOW_BASE_URL}/audio/speech`)
    const sloppy = stubFetch({})
    await synthesize(
      { text: '你好', profileId: 'sf-moss-alex' },
      deps(sloppy.fetchImpl, { baseUrl: 'https://gateway.test/v1/' }),
    )
    expect(at(sloppy.calls, 0).url).toBe('https://gateway.test/v1/audio/speech')
  })

  it('语速夹到端点区间；缺省与非数字按 1 发', async () => {
    const cases: readonly [{ speed?: number }, number][] = [
      [{}, 1],
      [{ speed: 0.1 }, 0.25],
      [{ speed: 99 }, 4],
      [{ speed: Number.NaN }, 1],
    ]
    for (const [request, expected] of cases) {
      const { fetchImpl, calls } = stubFetch({})
      await synthesize({ text: '你好', profileId: 'sf-cosyvoice2-anna', ...request }, deps(fetchImpl))
      expect(at(calls, 0).body.speed).toBe(expected)
    }
  })

  it('wav 响应回 wav 的 mime 与 format（别把 wav 当 mp3 发给渲染层）', async () => {
    const { fetchImpl } = stubFetch({ contentType: 'audio/wav' })
    const result = await synthesize({ text: '你好', profileId: 'sf-cosyvoice2-anna' }, deps(fetchImpl))
    expect(result.format).toBe('wav')
    expect(result.mime).toBe('audio/wav')
  })
})

describe('失败路径', () => {
  it('文本为空（或全空白）：入参错，不发请求', async () => {
    const { fetchImpl, calls } = stubFetch({})
    for (const text of ['', '   ', '\n\t']) {
      const error = await failure(synthesize({ text, profileId: 'sf-cosyvoice2-anna' }, deps(fetchImpl)))
      expect(error.code).toBe(VOICE_ERROR_CODES.badRequest)
    }
    expect(calls).toHaveLength(0)
  })

  it('未知 profileId：VOICE_PROFILE_NOT_FOUND，不发请求', async () => {
    const { fetchImpl, calls } = stubFetch({})
    const error = await failure(synthesize({ text: '你好', profileId: 'no-such' }, deps(fetchImpl)))
    expect(error.code).toBe(VOICE_ERROR_CODES.unknownProfile)
    expect(calls).toHaveLength(0)
  })

  it('系统音色：VOICE_ENGINE_LOCAL（前端据此降级到 speechSynthesis），不发请求', async () => {
    const { fetchImpl, calls } = stubFetch({})
    const error = await failure(synthesize({ text: '你好', profileId: 'system-huihui' }, deps(fetchImpl)))
    expect(error.code).toBe(VOICE_ERROR_CODES.engineLocal)
    expect(error.message).toContain('渲染层')
    expect(calls).toHaveLength(0)
  })

  it('空凭据：VOICE_NO_CREDENTIAL——不拿一个注定 401 的请求去换一个看不懂的错误', async () => {
    const { fetchImpl, calls } = stubFetch({})
    const error = await failure(
      synthesize({ text: '你好', profileId: 'sf-cosyvoice2-anna' }, deps(fetchImpl, { apiKey: '' })),
    )
    expect(error.code).toBe(VOICE_ERROR_CODES.noCredential)
    expect(calls).toHaveLength(0)
  })

  it('超长文本不报错：截断到上限后照常合成（超长是产品上的取舍，不是失败）', async () => {
    const { fetchImpl, calls } = stubFetch({})
    const long = '啊'.repeat(MAX_SPEAK_TEXT_LENGTH + 500)
    const result = await synthesize({ text: long, profileId: 'sf-cosyvoice2-anna' }, deps(fetchImpl))
    expect(String(at(calls, 0).body.input)).toHaveLength(MAX_SPEAK_TEXT_LENGTH)
    expect(result.audio).toEqual(MP3_BYTES)
  })

  it('截断助手：超长时砍到上限并置 truncated，未超长原样返回', () => {
    const long = '啊'.repeat(MAX_SPEAK_TEXT_LENGTH + 500)
    const cut = truncateForSynthesis(long)
    expect(cut.truncated).toBe(true)
    expect(cut.text).toHaveLength(MAX_SPEAK_TEXT_LENGTH)
    const short = truncateForSynthesis('短句')
    expect(short).toEqual({ text: '短句', truncated: false })
  })

  it('合成时超长正文也被砍到上限（内核自己守这条，不依赖调用方先截）', async () => {
    const { fetchImpl, calls } = stubFetch({})
    await synthesize(
      { text: '啊'.repeat(MAX_SPEAK_TEXT_LENGTH + 500), profileId: 'sf-cosyvoice2-anna' },
      deps(fetchImpl),
    )
    expect(String(at(calls, 0).body.input)).toHaveLength(MAX_SPEAK_TEXT_LENGTH)
  })

  it('上游非 2xx：VOICE_UPSTREAM，并透传上游的状态码与业务码', async () => {
    const { fetchImpl } = stubFetch({
      status: 400,
      text: JSON.stringify({ code: 20047, message: 'Invalid voice.' }),
    })
    const error = await failure(synthesize({ text: '你好', profileId: 'sf-cosyvoice2-anna' }, deps(fetchImpl)))
    expect(error.code).toBe(VOICE_ERROR_CODES.upstream)
    expect(error.upstreamStatus).toBe(400)
    expect(error.upstreamCode).toBe('20047')
    expect(error.message).toContain('Invalid voice.')
  })

  it('上游回的不是 JSON：不猜业务码，但状态码与原文仍在', async () => {
    const { fetchImpl } = stubFetch({ status: 503, text: '<html>gateway down</html>' })
    const error = await failure(synthesize({ text: '你好', profileId: 'sf-cosyvoice2-anna' }, deps(fetchImpl)))
    expect(error.code).toBe(VOICE_ERROR_CODES.upstream)
    expect(error.upstreamStatus).toBe(503)
    expect(error.upstreamCode).toBeUndefined()
    expect(error.message).toContain('503')
  })

  it('网络层抛错也归到 VOICE_UPSTREAM（带上原始 cause，不吞）', async () => {
    const fetchImpl = (async () => {
      throw new Error('socket hang up')
    }) as typeof fetch
    const error = await failure(synthesize({ text: '你好', profileId: 'sf-cosyvoice2-anna' }, deps(fetchImpl)))
    expect(error.code).toBe(VOICE_ERROR_CODES.upstream)
    expect((error.cause as Error).message).toBe('socket hang up')
  })

  it('上游返回 0 字节：VOICE_UPSTREAM——空音频进 <audio> 只会静默不响', async () => {
    const { fetchImpl } = stubFetch({ body: new Uint8Array() })
    const error = await failure(synthesize({ text: '你好', profileId: 'sf-cosyvoice2-anna' }, deps(fetchImpl)))
    expect(error.code).toBe(VOICE_ERROR_CODES.upstream)
    expect(error.message).toContain('空音频')
  })

  it('voice 不是「模型:说话人」形式的 profile：不猜模型名，直接判为未知音色', async () => {
    const { fetchImpl, calls } = stubFetch({})
    const error = await failure(
      synthesize(
        { text: '你好', profileId: 'broken' },
        deps(fetchImpl, {
          profile: {
            id: 'broken',
            name: '坏音色',
            engine: 'siliconflow',
            voice: 'anna',
            sampleText: 'x',
            description: 'x',
          },
        }),
      ),
    )
    expect(error.code).toBe(VOICE_ERROR_CODES.unknownProfile)
    expect(calls).toHaveLength(0)
  })

  it('注入的 profile 直接生效（自定义音色不必进目录）', async () => {
    const { fetchImpl, calls } = stubFetch({})
    await synthesize(
      { text: '你好', profileId: 'ignored' },
      deps(fetchImpl, {
        profile: {
          id: 'custom',
          name: '自定义',
          engine: 'siliconflow',
          voice: 'MyOrg/Clone-TTS:vip-speaker',
          sampleText: 'x',
          description: 'x',
        },
      }),
    )
    // profileId 被 deps.profile 盖掉，voice 与 model 都按注入的那条来。
    expect(at(calls, 0).body.model).toBe('MyOrg/Clone-TTS')
    expect(at(calls, 0).body.voice).toBe('MyOrg/Clone-TTS:vip-speaker')
  })
})
