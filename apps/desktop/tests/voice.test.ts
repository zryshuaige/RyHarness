// @vitest-environment jsdom
/**
 * 渲染层语音内核：分句、播放器队列/停止/降级、自动朗读设置。
 *
 * 播放器全部依赖注入：假 speech、假 Audio、假合成。这里量的是「一句话念完再念下一句」
 * 「停就真的停」「云端挂了自动用系统语音且只提示一次」这些产品行为，不是音频本身。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_SPEAK_STORAGE_KEY,
  type AudioLike,
  fetchPiperInstallStatus,
  loadAutoSpeak,
  localSystemVoiceNames,
  pickSystemVoice,
  refreshVoiceCatalog,
  resetVoiceCatalogCache,
  type SystemVoice,
  saveAutoSpeak,
  splitSentenceStream,
  splitSentences,
  startPiperInstall,
  type VoiceCatalog,
  VoicePlayer,
  type VoiceProfile,
} from '../renderer/src/lib/voice.ts'

const systemProfile: VoiceProfile = {
  id: 'system-huihui',
  name: '慧慧（系统女声）',
  engine: 'system',
  voice: 'Microsoft Huihui Desktop',
  sampleText: '你好。',
  description: '系统女声',
}

const cloudProfile: VoiceProfile = {
  id: 'sf-cosyvoice2-claire',
  name: '温柔女声',
  engine: 'siliconflow',
  voice: 'FunAudioLLM/CosyVoice2-0.5B:claire',
  sampleText: '你好。',
  description: '云端女声',
}

const piperProfile: VoiceProfile = {
  id: 'piper-huayan',
  name: '华言 · 离线女声',
  engine: 'piper',
  voice: 'zh_CN-huayan-medium',
  sampleText: '你好。',
  description: '离线女声',
}

const catalog: VoiceCatalog = {
  engines: [
    { id: 'system', name: '系统语音', available: true },
    { id: 'siliconflow', name: 'SiliconFlow', available: true },
    { id: 'piper', name: '离线（Piper）', available: true },
  ],
  profiles: [systemProfile, cloudProfile, piperProfile],
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function audioFixture(): {
  audio: AudioLike
  played: ReturnType<typeof vi.fn>
  paused: ReturnType<typeof vi.fn>
  end: () => void
} {
  const played = vi.fn(() => {
    return Promise.resolve()
  })
  const paused = vi.fn()
  const audio: AudioLike = { play: played, pause: paused, onended: null, onerror: null }
  return {
    audio,
    played,
    paused,
    end: () => {
      audio.onended?.()
    },
  }
}

interface PlayerFixture {
  player: VoicePlayer
  spoken: string[]
  notifyFallback: ReturnType<typeof vi.fn>
  notifyCatalogFallback: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  synthesizes: string[]
}

function playerFixture(
  options: {
    synthesize?: (input: { text: string; profileId: string; speed?: number }) => Promise<Blob>
    system?: SystemVoice
    audio?: AudioLike
    revoke?: (url: string) => void
    catalog?: () => Promise<VoiceCatalog>
  } = {},
): PlayerFixture {
  const spoken: string[] = []
  const synthesizes: string[] = []
  const notifyFallback = vi.fn()
  const notifyCatalogFallback = vi.fn()
  const cancel = vi.fn()
  const system: SystemVoice = options.system ?? {
    speak: (input) => {
      spoken.push(input.text)
      return Promise.resolve()
    },
    cancel,
  }
  const player = new VoicePlayer({
    catalog: options.catalog ?? (() => Promise.resolve(catalog)),
    synthesize:
      options.synthesize ??
      ((input) => {
        synthesizes.push(input.text)
        return Promise.resolve(new Blob(['audio']))
      }),
    system,
    createAudio: () => options.audio ?? audioFixture().audio,
    createObjectURL: () => 'blob:fixture',
    revokeObjectURL: options.revoke ?? (() => {}),
    notifyFallback,
    notifyCatalogFallback,
  })
  return { player, spoken, notifyFallback, notifyCatalogFallback, cancel, synthesizes }
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetVoiceCatalogCache()
})

describe('splitSentences', () => {
  it('按中文句末标点与换行切分，标点留在句子里', () => {
    expect(splitSentences('你好。今天过得怎么样？我很好！')).toEqual(['你好。', '今天过得怎么样？', '我很好！'])
    expect(splitSentences('第一行\n第二行；第三行')).toEqual(['第一行', '第二行；', '第三行'])
  })

  it('英文标点同样切分，句点只在小数之外断开', () => {
    expect(splitSentences('Hello world. Are you there? Yes!')).toEqual(['Hello world.', 'Are you there?', 'Yes!'])
    expect(splitSentences('圆周率约等于 3.14，不是整数。')).toEqual(['圆周率约等于 3.14，不是整数。'])
  })

  it('句末引号跟着上一句走，不甩到下一句开头', () => {
    expect(splitSentences('他说：“好。”然后走了。')).toEqual(['他说：“好。”', '然后走了。'])
  })

  it('没有标点的长句按 80 字兜底，优先在逗号处断', () => {
    expect(
      splitSentences('啊'.repeat(200)).map((sentence) => {
        return sentence.length
      }),
    ).toEqual([80, 80, 40])
    const long = `${'啊'.repeat(70)}，${'吧'.repeat(30)}`
    const split = splitSentences(long)
    expect(split[0]?.endsWith('，')).toBe(true)
    expect(split.every((sentence) => sentence.length <= 80)).toBe(true)
  })

  it('空串与纯空白返回空数组', () => {
    expect(splitSentences('')).toEqual([])
    expect(splitSentences(' \n\t ')).toEqual([])
  })

  it('流式分句把没说完的尾巴原样留着', () => {
    expect(splitSentenceStream('第一句。第二')).toEqual({ ready: ['第一句。'], rest: '第二' })
    expect(splitSentenceStream('还没说完')).toEqual({ ready: [], rest: '还没说完' })
    expect(splitSentenceStream('第一句。\n')).toEqual({ ready: ['第一句。'], rest: '' })
  })
})

describe('localSystemVoiceNames', () => {
  it('列出本机真实有的系统音色名', () => {
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [{ name: 'Microsoft Huihui Desktop - Chinese (Simplified)' }],
    })
    expect(localSystemVoiceNames()).toEqual(['Microsoft Huihui Desktop - Chinese (Simplified)'])
  })

  it('没有 Web Speech（精简运行时）时返回空数组，不抛错', () => {
    vi.stubGlobal('speechSynthesis', undefined)
    expect(localSystemVoiceNames()).toEqual([])
  })
})

describe('pickSystemVoice', () => {
  const voices = [
    { name: 'Microsoft David Desktop', lang: 'en-US' },
    { name: 'Microsoft Huihui Desktop', lang: 'zh-CN' },
  ]

  it('按目录里的 voice 名找；找不到退回中文音色，再退回系统默认', () => {
    expect(pickSystemVoice(voices, 'Microsoft Huihui Desktop')).toEqual(voices[1])
    expect(pickSystemVoice(voices, '不存在的音色')).toEqual(voices[1])
    expect(pickSystemVoice([voices[0] as { name: string; lang: string }])).toEqual(voices[0])
    expect(pickSystemVoice([])).toBeUndefined()
  })

  /**
   * 中文版 Windows 上音色名带语言后缀：精确匹配不上时，前缀匹配必须顶上。
   * 没有它，四个系统预设全都回退到"第一个中文音色"——听起来就是同一种声音。
   */
  it('音色名带语言后缀时按前缀认（不然四个预设听起来一样）', () => {
    const localized = [
      { name: 'Microsoft David Desktop - English (United States)', lang: 'en-US' },
      { name: 'Microsoft Huihui Desktop - Chinese (Simplified)', lang: 'zh-CN' },
      { name: 'Microsoft Yaoyao Desktop - Chinese (Simplified)', lang: 'zh-CN' },
      { name: 'Microsoft Kangkang Desktop - Chinese (Simplified)', lang: 'zh-CN' },
    ]
    expect(pickSystemVoice(localized, 'Microsoft Huihui Desktop')).toEqual(localized[1])
    expect(pickSystemVoice(localized, 'Microsoft Yaoyao Desktop')).toEqual(localized[2])
    expect(pickSystemVoice(localized, 'Microsoft Kangkang Desktop')).toEqual(localized[3])
    // 四条预设挑出四个不同的音色——这正是"选哪个都不一样"的判据
    const picked = ['Microsoft Huihui Desktop', 'Microsoft Yaoyao Desktop', 'Microsoft Kangkang Desktop'].map(
      (name) => {
        return pickSystemVoice(localized, name)
      },
    )
    expect(new Set(picked).size).toBe(3)
  })
})

describe('VoicePlayer', () => {
  it('连续调用按序播放：前一句念完才轮到下一句，状态带当前 key', async () => {
    const { player, spoken } = playerFixture()
    const states: string[] = []
    player.onStateChange((state) => {
      states.push(`${state.status}:${state.key ?? ''}`)
    })
    expect(player.isSpeaking()).toBe(false)
    const first = player.speak({ text: '第一句。', profileId: systemProfile.id, key: 'a' })
    const second = player.speak({ text: '第二句。', profileId: systemProfile.id, key: 'b' })
    expect(player.isSpeaking()).toBe(true)
    await Promise.all([first, second])
    expect(spoken).toEqual(['第一句。', '第二句。'])
    expect(player.isSpeaking()).toBe(false)
    expect(states).toEqual(['speaking:a', 'speaking:b', 'idle:'])
  })

  it('stop 清空队列并中止当前系统朗读', async () => {
    const pending = deferred()
    const cancel = vi.fn()
    const spoken: string[] = []
    const { player } = playerFixture({
      system: {
        speak: (input) => {
          spoken.push(input.text)
          return pending.promise
        },
        cancel,
      },
    })
    const first = player.speak({ text: '第一句。', profileId: systemProfile.id, key: 'a' })
    const second = player.speak({ text: '第二句。', profileId: systemProfile.id, key: 'b' })
    // 第一句已经开口、第二句还在队列里：停掉之后谁都不该再念。
    await vi.waitFor(() => {
      expect(spoken).toEqual(['第一句。'])
    })
    player.stop()
    pending.resolve()
    await Promise.all([first, second])
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(spoken).toEqual(['第一句。'])
    expect(player.isSpeaking()).toBe(false)
  })

  it('停止云端播放会暂停音频并释放 objectURL', async () => {
    const gate = deferred()
    const paused = vi.fn()
    const revoke = vi.fn()
    const played = vi.fn(() => {
      return gate.promise
    })
    const audio: AudioLike = { play: played, pause: paused, onended: null, onerror: null }
    const { player } = playerFixture({ audio, revoke })
    const done = player.speak({ text: '云端一句。', profileId: cloudProfile.id, key: 'cloud' })
    // 等合成返回、音频真的开始播再停：停在合成途中测不到 pause/revoke。
    await vi.waitFor(() => {
      expect(played).toHaveBeenCalled()
    })
    player.stop()
    await done
    expect(paused).toHaveBeenCalled()
    expect(revoke).toHaveBeenCalledWith('blob:fixture')
    expect(player.isSpeaking()).toBe(false)
  })

  it('云端失败自动降级系统语音，同一场会话只提示一次', async () => {
    const { player, spoken, notifyFallback } = playerFixture({
      synthesize: () => {
        return Promise.reject(new Error('VOICE_NO_CREDENTIAL'))
      },
    })
    await player.speak({ text: '第一句。', profileId: cloudProfile.id })
    await player.speak({ text: '第二句。', profileId: cloudProfile.id })
    expect(spoken).toEqual(['第一句。', '第二句。'])
    expect(notifyFallback).toHaveBeenCalledTimes(1)
  })

  it('音色目录都读不到（插件关闭）时仍用系统语音念，只轻提示一次', async () => {
    const { player, spoken, synthesizes, notifyCatalogFallback, notifyFallback } = playerFixture({
      catalog: () => {
        return Promise.reject(new Error('音色目录没读出来（HTTP 404）'))
      },
    })
    // 系统音色与云端音色各念一句：目录失败后不应再发合成请求，也不该叠两条提示。
    await player.speak({ text: '第一句。', profileId: systemProfile.id })
    await player.speak({ text: '第二句。', profileId: cloudProfile.id })
    expect(spoken).toEqual(['第一句。', '第二句。'])
    expect(synthesizes).toEqual([])
    expect(notifyCatalogFallback).toHaveBeenCalledTimes(1)
    expect(notifyFallback).not.toHaveBeenCalled()
  })

  it('系统音色不调用云端合成', async () => {
    const { player, synthesizes, spoken } = playerFixture()
    await player.speak({ text: '系统念。', profileId: systemProfile.id })
    expect(synthesizes).toEqual([])
    expect(spoken).toEqual(['系统念。'])
  })

  it('离线音色与云端走同一条服务端合成路径（不是系统语音）', async () => {
    const audio: AudioLike = {
      play: () => {
        setTimeout(() => {
          audio.onended?.()
        }, 0)
        return Promise.resolve()
      },
      pause: () => {},
      onended: null,
      onerror: null,
    }
    const { player, synthesizes, spoken } = playerFixture({ audio })
    await player.speak({ text: '离线念。', profileId: piperProfile.id })
    expect(synthesizes).toEqual(['离线念。'])
    expect(spoken).toEqual([])
  })
})

describe('自动朗读设置', () => {
  it('默认关，写入 localStorage 后可读回', () => {
    expect(loadAutoSpeak()).toBe(false)
    saveAutoSpeak(true)
    expect(localStorage.getItem(AUTO_SPEAK_STORAGE_KEY)).toBe('true')
    expect(loadAutoSpeak()).toBe(true)
    saveAutoSpeak(false)
    expect(loadAutoSpeak()).toBe(false)
  })
})

describe('离线语音包接口', () => {
  it('解析 downloading 状态（含进度），错误状态原样带回 error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: 'downloading', receivedBytes: 10, totalBytes: 100 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: 'error', error: '下载失败' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchPiperInstallStatus('http://api.test')).toEqual({
      state: 'downloading',
      receivedBytes: 10,
      totalBytes: 100,
    })
    expect(await fetchPiperInstallStatus('http://api.test')).toEqual({ state: 'error', error: '下载失败' })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/voice/engines/piper/status')
  })

  it('startPiperInstall 走 POST；坏状态码抛错而不是猜一个状态', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: 'downloading' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: 'weird' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    expect(await startPiperInstall('http://api.test')).toEqual({ state: 'downloading' })
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
    await expect(startPiperInstall('http://api.test')).rejects.toThrow('HTTP 404')
    await expect(fetchPiperInstallStatus('http://api.test')).rejects.toThrow('格式不对')
  })

  it('refreshVoiceCatalog 清掉缓存：安装完成后同一次会话也能看见新引擎', async () => {
    const first: VoiceCatalog = {
      engines: [{ id: 'piper', name: '离线（Piper）', available: false, reason: '离线语音包还没下载' }],
      profiles: [],
    }
    const second: VoiceCatalog = {
      engines: [{ id: 'piper', name: '离线（Piper）', available: true }],
      profiles: [],
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(first), { status: 200, headers: { 'content-type': 'application/json' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(second), { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    vi.stubGlobal('fetch', fetchMock)
    expect((await refreshVoiceCatalog('http://api.test')).engines[0]?.available).toBe(false)
    expect((await refreshVoiceCatalog('http://api.test')).engines[0]?.available).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
