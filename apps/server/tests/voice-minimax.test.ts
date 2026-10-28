/**
 * MiniMax 语音与声线文件：种子、读盘、目录注册与合成参数。
 *
 * 上游用假 fetch：这里量的是"声线文件怎么变成目录里的一条音色、怎么变成上游请求"，
 * 不是网络。真实合成在 `pnpm voice:speak` 与 demo 里跑。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProvidersConfigFile } from '@ryharness/server'
import { createMinimaxProvider, loadVoiceFiles, seedVoiceFiles, VOICE_FILES_DIR } from '@ryharness/server'
import { isKnownVoiceId, registerVoiceProfile, VOICE_ERROR_CODES } from '@ryharness/voice'
import { afterEach, describe, expect, it, vi } from 'vitest'

const tmpDirs: string[] = []

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-voice-minimax-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

/** 有一把 key 的供应商配置。 */
function providersWithKey(): ProvidersConfigFile {
  return {
    providers: {
      minimax: { baseURL: 'https://api.minimaxi.com/v1', apiKey: 'test-key', models: [] },
    },
  }
}

/** 上游正常回包。 */
function okResponse(hex = '494433'): Response {
  return new Response(
    JSON.stringify({
      data: { audio: hex, status: 2 },
      extra_info: { audio_length: 1234 },
      base_resp: { status_code: 0, status_msg: 'success' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('声线文件的种子与读盘', () => {
  it('首次启动把默认声线写进数据目录', () => {
    const dir = join(dataDir(), VOICE_FILES_DIR)
    const written = seedVoiceFiles(dir)
    expect(written.length).toBeGreaterThan(0)
    expect(existsSync(join(dir, 'ryen-cat.json'))).toBe(true)
    const parsed = JSON.parse(readFileSync(join(dir, 'ryen-cat.json'), 'utf8')) as { engine: string; voice: string }
    expect(parsed.engine).toBe('minimax')
    expect(parsed.voice.length).toBeGreaterThan(0)
  })

  it('用户改过的声线不会被升级盖回去', () => {
    const dir = join(dataDir(), VOICE_FILES_DIR)
    seedVoiceFiles(dir)
    const path = join(dir, 'ryen-cat.json')
    const edited = { ...(JSON.parse(readFileSync(path, 'utf8')) as object), speed: 0.8, pitch: -3 }
    writeFileSync(path, JSON.stringify(edited), 'utf8')
    const written = seedVoiceFiles(dir)
    expect(written.length).toBe(0)
    const after = JSON.parse(readFileSync(path, 'utf8')) as { speed: number }
    expect(after.speed).toBe(0.8)
  })

  it('坏文件被跳过而不是让整次启动失败（一份手写坏了的 JSON 不该让软件开不了机）', () => {
    const dir = join(dataDir(), VOICE_FILES_DIR)
    seedVoiceFiles(dir)
    writeFileSync(join(dir, 'broken.json'), '{ 这不是 JSON', 'utf8')
    writeFileSync(join(dir, 'incomplete.json'), JSON.stringify({ id: 'x' }), 'utf8')
    const files = loadVoiceFiles(dir)
    expect(
      files.map((file) => {
        return file.id
      }),
    ).toEqual(['ryen-cat'])
  })

  it('目录里没有文件时读出空数组（不抛错）', () => {
    expect(loadVoiceFiles(join(dataDir(), '不存在'))).toEqual([])
  })
})

describe('MiniMax provider', () => {
  it('声线文件里的那一条出现在目录里（界面与试听都靠它）', () => {
    const dir = join(dataDir(), VOICE_FILES_DIR)
    seedVoiceFiles(dir)
    const files = loadVoiceFiles(dir)
    const provider = createMinimaxProvider({ files, dir, providers: providersWithKey() })
    const profiles = provider.profiles()
    expect(profiles.length).toBe(1)
    expect(profiles[0]?.id).toBe('ryen-cat')
    expect(profiles[0]?.engine).toBe('minimax')
    expect(profiles[0]?.sampleText.length).toBeGreaterThan(0)
  })

  it('没配 key 时说清楚要做什么，而不是等用户点了才失败', () => {
    const dir = join(dataDir(), VOICE_FILES_DIR)
    const files = loadVoiceFiles(dir)
    const provider = createMinimaxProvider({ files, dir, providers: { providers: {} } })
    const status = provider.describe?.()
    expect(status?.available).toBe(false)
    expect(status?.reason).toContain('API Key')
  })

  it('合成时把文件里的旋钮带给上游；临时拖的语速覆盖文件里的默认值', async () => {
    const dir = join(dataDir(), VOICE_FILES_DIR)
    seedVoiceFiles(dir)
    const files = loadVoiceFiles(dir)
    const fetchImpl = vi.fn(async () => {
      return okResponse()
    }) as unknown as typeof fetch
    const provider = createMinimaxProvider({ files, dir, providers: providersWithKey(), fetchImpl })

    const result = await provider.synthesize({ text: '你好，我是 Ryen。', profileId: 'ryen-cat' }, {})
    expect(Array.from(result.audio)).toEqual([0x49, 0x44, 0x33])
    expect(result.mime).toBe('audio/mpeg')

    const call = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    const body = JSON.parse(String(call?.[1].body)) as {
      voice_setting: { voice_id: string; speed: number; pitch: number; emotion: string }
    }
    expect(body.voice_setting.voice_id).toBe('Chinese (Mandarin)_Crisp_Girl')
    expect(body.voice_setting.speed).toBe(1.05)
    expect(body.voice_setting.pitch).toBe(2)
    expect(body.voice_setting.emotion).toBe('happy')

    await provider.synthesize({ text: '慢一点。', profileId: 'ryen-cat', speed: 0.7 }, {})
    const second = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[1]
    const secondBody = JSON.parse(String(second?.[1].body)) as { voice_setting: { speed: number } }
    expect(secondBody.voice_setting.speed).toBe(0.7)
  })

  it('声线文件里没有这条音色 / 没配 key：两种失败各有各的机器码', async () => {
    const dir = join(dataDir(), VOICE_FILES_DIR)
    seedVoiceFiles(dir)
    const files = loadVoiceFiles(dir)
    const provider = createMinimaxProvider({ files, dir, providers: providersWithKey() })
    await expect(provider.synthesize({ text: '话', profileId: 'no-such-voice' }, {})).rejects.toMatchObject({
      code: VOICE_ERROR_CODES.unknownProfile,
    })

    // 声线文件在、就是没配 key：这时候该说的是"去设置里填 key"，不是"没这条声线"。
    const withoutKey = createMinimaxProvider({ files, dir, providers: { providers: {} } })
    await expect(withoutKey.synthesize({ text: '话', profileId: 'ryen-cat' }, {})).rejects.toMatchObject({
      code: VOICE_ERROR_CODES.noCredential,
    })
  })
})

describe('音色 id 的合法性', () => {
  it('注册过的声线 id 是合法音色 id（人格保存时不会被洗成「不朗读」）', () => {
    expect(isKnownVoiceId('ryen-cat')).toBe(true)
    const dispose = registerVoiceProfile({
      id: 'tmp-voice',
      name: '临时音色',
      engine: 'minimax',
      voice: 'x',
      sampleText: '话',
      description: '说明',
    })
    expect(isKnownVoiceId('tmp-voice')).toBe(true)
    dispose()
  })
})
