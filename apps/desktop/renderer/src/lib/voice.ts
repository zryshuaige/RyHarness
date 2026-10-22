/**
 * 渲染层语音：音色目录、系统朗读、云端音频播放与分句。
 *
 * 两条引擎的边界只有这里知道：`system` 音色由本机 `speechSynthesis` 直接念（不经
 * 服务端、不花额度），云端音色走本机服务的 `POST /api/voice/speak` 拿音频字节。
 * 云端失败（没配 Key / 节流 / 网络 / 上游挂掉）一律自动降级到系统语音，并且只提示
 * 一次「已用系统语音朗读」——朗读是陪伴功能，不该用一个错误对话框把聊天打断。
 * @module lib/voice
 */

import { useEffect, useState } from 'react'
import { resolveApiBase } from '../api.ts'
import { authedFetch } from './authed-fetch.ts'
import { readSetting, writeSetting } from './storage.ts'
import { toast } from './toast.ts'

/** 与服务端 `VoiceEngineId` 同一组取值（渲染层不 import 内核包）。 */
export type VoiceEngineId = 'system' | 'siliconflow' | 'piper' | (string & {})

/** 一个语音引擎的对外信息。 */
export interface VoiceEngineInfo {
  id: VoiceEngineId
  name: string
  available: boolean
  note?: string
  /** 不可用时给用户的可操作原因（没配 Key / 还没下载）。 */
  reason?: string
}

/** 一条可选音色（GET /api/voice/catalog 的 profiles 元素）。 */
export interface VoiceProfile {
  id: string
  name: string
  engine: VoiceEngineId
  /** 上游端点的 voice 取值：系统音色是 SAPI 名，云端是 `模型:说话人`。 */
  voice: string
  gender?: string
  style?: string
  sampleText: string
  description: string
}

/** 音色目录。 */
export interface VoiceCatalog {
  engines: VoiceEngineInfo[]
  profiles: VoiceProfile[]
}

/** 离线语音包状态（与服务端 GET /api/voice/engines/piper/status 同形）。 */
export type VoiceInstallState = 'absent' | 'downloading' | 'ready' | 'error' | 'unsupported'

export interface VoiceInstallStatus {
  state: VoiceInstallState
  receivedBytes?: number
  totalBytes?: number
  error?: string
}

/** 云端合成失败时带出来的机器码（服务端 VOICE_ERROR_CODES 的子集）。 */
export class VoiceRequestError extends Error {
  readonly code: string | undefined
  readonly status: number

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'VoiceRequestError'
    this.status = status
    this.code = code
  }
}

// ---- 目录：同一会话只拉一次，失败可重试 ----

const catalogRequests = new Map<string, Promise<VoiceCatalog>>()

/** 清掉目录缓存（测试用；生产里一次会话只该拉一次）。 */
export function resetVoiceCatalogCache(): void {
  catalogRequests.clear()
}

function parseCatalog(value: unknown): VoiceCatalog {
  if (typeof value !== 'object' || value === null) throw new Error('音色目录格式不对')
  const record = value as Partial<VoiceCatalog>
  if (!Array.isArray(record.engines) || !Array.isArray(record.profiles)) {
    throw new Error('音色目录缺少 engines / profiles')
  }
  return { engines: record.engines, profiles: record.profiles }
}

/**
 * 取音色目录。
 *
 * 缓存的是 Promise 而不是结果：同一会话里多个组件同时挂载时也只发一个请求；
 * 请求失败就从缓存里删掉，下一次调用会真的重试（把一次断网永久钉死成「没有
 * 音色」是最难自查的失败）。
 */
export function fetchVoiceCatalog(base: string): Promise<VoiceCatalog> {
  const cached = catalogRequests.get(base)
  if (cached !== undefined) return cached
  const request = authedFetch(base, '/api/voice/catalog')
    .then(async (response) => {
      if (!response.ok) throw new Error(`音色目录没读出来（HTTP ${response.status}）`)
      return parseCatalog(await response.json())
    })
    .catch((error: unknown) => {
      catalogRequests.delete(base)
      throw error
    })
  catalogRequests.set(base, request)
  return request
}

/**
 * 强制重读音色目录。
 *
 * 安装离线语音包成功后必须走这条：目录缓存的是 Promise，不清掉的话引擎会永远
 * 停在「需要先下载」，用户只能重启应用才能看见新音色。
 */
export function refreshVoiceCatalog(base: string): Promise<VoiceCatalog> {
  catalogRequests.delete(base)
  return fetchVoiceCatalog(base)
}

/** 安装状态接口的路径；渲染层不关心具体端口。 */
const PIPER_STATUS_PATH = '/api/voice/engines/piper/status'
const PIPER_INSTALL_PATH = '/api/voice/engines/piper/install'

async function parseInstallStatus(response: Response): Promise<VoiceInstallStatus> {
  if (!response.ok) {
    throw new Error(`离线语音包状态读不出来（HTTP ${response.status}）`)
  }
  const payload = (await response.json()) as Partial<VoiceInstallStatus>
  const state = payload.state
  if (
    state !== 'absent' &&
    state !== 'downloading' &&
    state !== 'ready' &&
    state !== 'error' &&
    state !== 'unsupported'
  ) {
    throw new Error('离线语音包状态格式不对')
  }
  return {
    state,
    ...(typeof payload.receivedBytes === 'number' ? { receivedBytes: payload.receivedBytes } : {}),
    ...(typeof payload.totalBytes === 'number' ? { totalBytes: payload.totalBytes } : {}),
    ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
  }
}

/** 查一次离线语音包状态（安装卡轮询用）。 */
export async function fetchPiperInstallStatus(base: string): Promise<VoiceInstallStatus> {
  const response = await authedFetch(base, PIPER_STATUS_PATH)
  return await parseInstallStatus(response)
}

/** 启动下载；服务端幂等，重复点击只会拿到同一份进行中的状态。 */
export async function startPiperInstall(base: string): Promise<VoiceInstallStatus> {
  const response = await authedFetch(base, PIPER_INSTALL_PATH, { method: 'POST' })
  return await parseInstallStatus(response)
}

// ---- 自动朗读设置：与主题一样存在 localStorage ----

/** 「助理回复时自动朗读」的存储键（默认关）。 */
export const AUTO_SPEAK_STORAGE_KEY = 'ryharness-voice-autospeak'

export function loadAutoSpeak(): boolean {
  try {
    return readSetting(AUTO_SPEAK_STORAGE_KEY) === 'true'
  } catch {
    // 隐私模式下 localStorage 不可用：自动朗读按默认关处理。
    return false
  }
}

export function saveAutoSpeak(enabled: boolean): void {
  try {
    writeSetting(AUTO_SPEAK_STORAGE_KEY, String(enabled))
  } catch {
    // 持久化失败只影响下次启动的默认值，不阻断本次开关。
  }
}

// ---- 分句 ----

/** 一句话的硬上限：没有标点的长文按 80 字兜底切，避免等一整段才出声。 */
export const MAX_SENTENCE_LENGTH = 80

/** 句末标点。英文句点单独判定，避免拆开 3.14 这类小数。 */
const TERMINATORS = new Set(['。', '！', '？', '；', '!', '?', ';'])
const CLOSERS = new Set(['」', '』', '”', '’', '）', ')', '】', ']', '》', '〉'])
const BREAKS = new Set(['，', ',', '、', '：', ':', ' ', '\t'])

function isDotBoundary(text: string, index: number): boolean {
  const next = text[index + 1]
  return next === undefined || /\s/.test(next)
}

function isTerminator(text: string, index: number): boolean {
  const char = text[index]
  if (char === '.') return isDotBoundary(text, index)
  return char !== undefined && TERMINATORS.has(char)
}

/** 80 字兜底时优先在最近一个逗号/空格处断，读起来才不像被刀切。 */
function breakIndex(text: string): number {
  for (let index = MAX_SENTENCE_LENGTH - 1; index >= MAX_SENTENCE_LENGTH - 20; index--) {
    const char = text[index]
    if (char !== undefined && BREAKS.has(char)) return index + 1
  }
  return MAX_SENTENCE_LENGTH
}

/**
 * 流式分句：返回已完整的句子与还没说完的尾巴。
 *
 * 流式文本是一段一段到的，不能等 message-done 才切。尾巴原样返回，调用方在下一
 * 个 delta 上接着拼；消息结束时再用 {@link splitSentences} 把尾巴补播。
 */
export function splitSentenceStream(text: string): { ready: string[]; rest: string } {
  const ready: string[] = []
  let current = ''
  const flush = (): void => {
    const sentence = current.trim()
    if (sentence.length > 0) ready.push(sentence)
    current = ''
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === undefined) break
    if (char === '\n') {
      flush()
      continue
    }
    current += char
    if (isTerminator(text, index)) {
      // 句末的引号/右括号跟句子走：`他说“好。”` 不该把后引号甩到下一句。
      while (index + 1 < text.length) {
        const next = text[index + 1]
        if (next === undefined || (!TERMINATORS.has(next) && next !== '.' && !CLOSERS.has(next))) break
        current += next
        index += 1
      }
      flush()
      continue
    }
    if (current.length >= MAX_SENTENCE_LENGTH) {
      const cut = breakIndex(current)
      const head = current.slice(0, cut).trim()
      if (head.length > 0) ready.push(head)
      current = current.slice(cut)
    }
  }
  return { ready, rest: current }
}

/**
 * 把一段完整文本切成朗读句。
 *
 * 纯函数：中文标点（。！？；）、英文标点（.!?;）、换行与 80 字兜底都覆盖。
 * 空串与纯空白返回空数组（调用方据此不入队）。
 */
export function splitSentences(text: string): string[] {
  const { ready, rest } = splitSentenceStream(text)
  const tail = rest.trim()
  if (tail.length > 0) ready.push(tail)
  return ready
}

// ---- 系统语音适配器 ----

/** 本机音色（只用到挑音色需要的两个字段，测试可以给普通对象）。 */
export interface SystemVoiceLike {
  name: string
  lang: string
}

/**
 * 按名字找本机音色；找不到就回退到第一个中文音色，再退到系统默认。
 *
 * 目录里的 `voice` 是 Windows SAPI 名（如 `Microsoft Huihui Desktop`），而不同
 * 系统装的语言包不一样——硬认名字会让没装慧慧的机器整个念不出来。
 *
 * **为什么还要前缀匹配**：中文版 Windows 上 `getVoices()` 返回的名字带语言
 * 后缀（`Microsoft Huihui Desktop - Chinese (Simplified)`），只有精确匹配的话
 * 四个预设全都匹配不上，一起回退到"第一个中文音色"——于是**选哪个预设听起来
 * 都是同一种声音**。前缀匹配把这条回退路径堵上。
 */
export function pickSystemVoice<T extends SystemVoiceLike>(voices: readonly T[], wantedName?: string): T | undefined {
  if (wantedName !== undefined) {
    const exact = voices.find((voice) => {
      return voice.name === wantedName
    })
    if (exact !== undefined) return exact
    const prefixed = voices.find((voice) => {
      return voice.name.startsWith(wantedName)
    })
    if (prefixed !== undefined) return prefixed
  }
  return (
    voices.find((voice) => {
      return /^zh/i.test(voice.lang)
    }) ?? voices[0]
  )
}

/**
 * 本机真实有的系统音色名。
 *
 * 返回空数组有两种含义，得靠"读到了没有"区分：还没加载完（`undefined` 之外的情
 * 形由调用方用 state 表达）与**本机根本没装中文语音包**。所以这里返回数组，调用
 * 方另外记一份"读到没有"。
 */
export function localSystemVoiceNames(): string[] {
  if (typeof window === 'undefined') return []
  const synth = window.speechSynthesis
  if (synth === undefined) return []
  return synth.getVoices().map((voice) => {
    return voice.name
  })
}

/** 系统朗读的最小接口：取消由播放器统一管。 */
export interface SystemVoice {
  speak(input: { text: string; voiceName?: string; lang: string; rate: number }): Promise<void>
  cancel(): void
}

/** 用 Web Speech API 实现的本机朗读。 */
function browserSystemVoice(): SystemVoice {
  const synthesis = (): SpeechSynthesis | undefined => {
    return typeof window === 'undefined' ? undefined : window.speechSynthesis
  }
  return {
    speak(input) {
      const synth = synthesis()
      // 没有 Web Speech（极少数精简运行时）：静默返回，让队列继续往下走。
      if (synth === undefined) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const utterance = new SpeechSynthesisUtterance(input.text)
        utterance.lang = input.lang
        utterance.rate = input.rate
        const finish = (): void => {
          resolve()
        }
        utterance.onend = finish
        utterance.onerror = finish
        const speakNow = (): void => {
          const voice = pickSystemVoice(synth.getVoices(), input.voiceName)
          if (voice !== undefined) utterance.voice = voice
          synth.speak(utterance)
        }
        // 冷启动时 `getVoices()` 可能还是空的（音色列表是异步加载的，`voiceschanged`
        // 之前拿不到）。那时候直接念就是系统默认音色——于是「选哪个预设都一样」。
        // 等它加载完再念；万一永远不加载，1.5 秒后照念（不能卡住整个队列）。
        if (synth.getVoices().length > 0) {
          speakNow()
          return
        }
        let done = false
        const onReady = (): void => {
          if (done) return
          done = true
          synth.removeEventListener('voiceschanged', onReady)
          speakNow()
        }
        synth.addEventListener('voiceschanged', onReady)
        setTimeout(onReady, 1500)
      })
    },
    cancel() {
      synthesis()?.cancel()
    },
  }
}

// ---- 音频元素适配器 ----

/** `<audio>` 的最小接口（测试注入假实现，不依赖 jsdom 的媒体栈）。 */
export interface AudioLike {
  play(): Promise<void> | void
  pause(): void
  onended: (() => void) | null
  onerror: (() => void) | null
}

function browserAudio(src: string): AudioLike {
  const audio = new Audio(src)
  const handlers: { ended: (() => void) | null; error: (() => void) | null } = { ended: null, error: null }
  audio.addEventListener('ended', () => {
    handlers.ended?.()
  })
  audio.addEventListener('error', () => {
    handlers.error?.()
  })
  return {
    play: () => {
      return audio.play()
    },
    pause: () => {
      audio.pause()
    },
    get onended() {
      return handlers.ended
    },
    set onended(handler) {
      handlers.ended = handler
    },
    get onerror() {
      return handlers.error
    },
    set onerror(handler) {
      handlers.error = handler
    },
  }
}

// ---- 播放器 ----

/** 一次朗读请求；`key` 让界面知道「正在播的是哪条气泡」。 */
export interface SpeakInput {
  text: string
  profileId: string
  speed?: number
  key?: string
}

/** 播放器对外的播放状态（UI 据此显示「播放中」）。 */
export interface VoicePlaybackState {
  status: 'idle' | 'speaking'
  /** 当前正在播的内容标识（气泡的 message key 或试听标记）。 */
  key?: string
}

/** 播放器依赖（全部可注入，单测不需要真音频/真语音）。 */
export interface VoicePlayerDeps {
  catalog(): Promise<VoiceCatalog>
  synthesize(input: { text: string; profileId: string; speed?: number }): Promise<Blob>
  system: SystemVoice
  createAudio(src: string): AudioLike
  createObjectURL(blob: Blob): string
  revokeObjectURL(url: string): void
  /** 云端失败降级时的提示（播放器保证只调用一次）。 */
  notifyFallback(): void
  /**
   * 音色目录本身读不到时的提示（插件关闭 / 服务未起）；同样只调用一次。
   * 缺省时静默降级，测试与精简嵌入不必为一次提示实现回调。
   */
  notifyCatalogFallback?(): void
}

interface QueueItem {
  text: string
  profileId: string
  speed?: number
  key?: string
  resolve(): void
}

type PlayResult = 'played' | 'failed' | 'aborted'

/**
 * 朗读播放器：单例、串行队列、可停止、云端失败自动降级系统语音。
 *
 * 队列串行是为了「流式即读」：一句话合成完立刻播，下一句在上一句念完后接上，
 * 不会几段音频同时开口。切会话/组件卸载时调用 {@link stop}，队列清空、当前音频
 * 暂停并释放 objectURL。
 */
export class VoicePlayer {
  private readonly deps: VoicePlayerDeps
  private readonly queue: QueueItem[] = []
  private readonly listeners = new Set<(state: VoicePlaybackState) => void>()
  private state: VoicePlaybackState = { status: 'idle' }
  private pumping = false
  /** 每次 stop 自增：await 回来的旧任务据此判断自己已经作废。 */
  private runId = 0
  /** 中止当前正在播的那一段（音频或系统朗读）。 */
  private activeAbort: (() => void) | undefined
  private fallbackNotified = false
  private catalogFallbackNotified = false

  constructor(deps: VoicePlayerDeps) {
    this.deps = deps
  }

  getState(): VoicePlaybackState {
    return this.state
  }

  isSpeaking(): boolean {
    return this.state.status === 'speaking'
  }

  /** 订阅状态变化；返回退订函数。 */
  onStateChange(listener: (state: VoicePlaybackState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 入队一段文本；返回的 Promise 在**这一段**播完（或停止）时 resolve。
   *
   * 空文本直接 resolve，不占队列——流式分句常常切出空串，让它进队列只会制造一次
   * 无意义的「播放中」闪烁。
   */
  speak(input: SpeakInput): Promise<void> {
    const text = input.text.trim()
    if (text.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.queue.push({
        text,
        profileId: input.profileId,
        ...(input.speed === undefined ? {} : { speed: input.speed }),
        ...(input.key === undefined ? {} : { key: input.key }),
        resolve,
      })
      if (this.state.status !== 'speaking') {
        this.setState({ status: 'speaking', ...(input.key === undefined ? {} : { key: input.key }) })
      }
      void this.pump()
    })
  }

  /** 停止当前朗读并清空队列（切会话 / 组件卸载 / 点停止）。 */
  stop(): void {
    this.runId += 1
    const pending = this.queue.splice(0)
    for (const item of pending) item.resolve()
    const abort = this.activeAbort
    this.activeAbort = undefined
    if (abort !== undefined) abort()
    else this.deps.system.cancel()
    this.setState({ status: 'idle' })
  }

  /**
   * 串行消费队列。
   *
   * `pumping` 防止两次 speak 各起一条消费链；stop 之后新入队的项由 finally 里的
   * 再启动接住（旧的消费链正在 abort 的 await 上，不能让它把新队列漏掉）。
   */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0]
        if (item === undefined) break
        const run = this.runId
        const { profile, wantsCloud } = await this.resolveProfile(item.profileId)
        if (run !== this.runId || this.queue[0] !== item) {
          item.resolve()
          continue
        }
        this.setState({
          status: 'speaking',
          ...(item.key === undefined ? {} : { key: item.key }),
        })
        if (profile !== undefined && profile.engine !== 'system') {
          // 所有服务端引擎（云端与离线）走同一条合成路径；失败一律降级系统语音。
          const result = await this.playCloud(item, run)
          if (result === 'failed' && run === this.runId) {
            this.notifyFallbackOnce()
            await this.speakSystem(item, undefined)
          }
        } else {
          // 目录都读不到时已经提示过一次「已用系统语音」；这里不再叠一条云端不可用。
          if (wantsCloud && profile === undefined && !this.catalogFallbackNotified) this.notifyFallbackOnce()
          // 系统朗读失败没有更好的退路：如实收口，继续下一句。
          await this.speakSystem(item, profile)
        }
        if (run !== this.runId || this.queue[0] !== item) {
          item.resolve()
          continue
        }
        this.queue.shift()
        item.resolve()
      }
    } finally {
      this.pumping = false
      if (this.queue.length === 0) this.setState({ status: 'idle' })
      else void this.pump()
    }
  }

  /** 解析音色；目录里没有时回落到第一条系统音色，并告诉调用方它是不是云端 id。 */
  private async resolveProfile(profileId: string): Promise<{ profile?: VoiceProfile; wantsCloud: boolean }> {
    const wantsCloud = profileId !== 'none' && !profileId.startsWith('system-')
    try {
      const catalog = await this.deps.catalog()
      const profile = catalog.profiles.find((candidate) => {
        return candidate.id === profileId
      })
      if (profile !== undefined) return { profile, wantsCloud: false }
      const system = catalog.profiles.find((candidate) => {
        return candidate.engine === 'system'
      })
      return system === undefined ? { wantsCloud } : { profile: system, wantsCloud }
    } catch {
      // 目录都读不到（插件被关掉 / 服务未起）时只能按「本机默认音色」念：
      // 朗读优先于解释失败，但要有一次轻提示，否则用户不知道云端音色为什么没响。
      this.notifyCatalogFallbackOnce()
      return { wantsCloud }
    }
  }

  /** 目录失败与云端失败分开计数：这是完全不同的两件事，但各自只提示一次。 */
  private notifyCatalogFallbackOnce(): void {
    if (this.catalogFallbackNotified) return
    this.catalogFallbackNotified = true
    this.deps.notifyCatalogFallback?.()
  }

  private async playCloud(item: QueueItem, run: number): Promise<PlayResult> {
    let blob: Blob
    try {
      blob = await this.deps.synthesize({
        text: item.text,
        profileId: item.profileId,
        ...(item.speed === undefined ? {} : { speed: item.speed }),
      })
    } catch {
      return run === this.runId ? 'failed' : 'aborted'
    }
    if (run !== this.runId) return 'aborted'
    const url = this.deps.createObjectURL(blob)
    const audio = this.deps.createAudio(url)
    return new Promise<PlayResult>((resolve) => {
      let settled = false
      const finish = (result: PlayResult): void => {
        if (settled) return
        settled = true
        audio.onended = null
        audio.onerror = null
        try {
          audio.pause()
        } catch {
          // 已经结束/已释放的音频元素暂停失败没有影响。
        }
        this.deps.revokeObjectURL(url)
        if (this.activeAbort === abort) this.activeAbort = undefined
        resolve(result)
      }
      const abort = (): void => {
        finish('aborted')
      }
      this.activeAbort = abort
      audio.onended = () => {
        finish('played')
      }
      audio.onerror = () => {
        finish('failed')
      }
      try {
        const started = audio.play()
        if (started instanceof Promise) {
          void started.catch(() => {
            finish('failed')
          })
        }
      } catch {
        finish('failed')
      }
    })
  }

  private speakSystem(item: QueueItem, profile: VoiceProfile | undefined): Promise<PlayResult> {
    return new Promise<PlayResult>((resolve) => {
      let settled = false
      const finish = (result: PlayResult): void => {
        if (settled) return
        settled = true
        if (this.activeAbort === abort) this.activeAbort = undefined
        resolve(result)
      }
      const abort = (): void => {
        this.deps.system.cancel()
        finish('aborted')
      }
      this.activeAbort = abort
      this.deps.system
        .speak({
          text: item.text,
          ...(profile === undefined ? {} : { voiceName: profile.voice }),
          lang: 'zh-CN',
          rate: item.speed ?? 1,
        })
        .then(() => {
          finish('played')
        })
        .catch(() => {
          finish('failed')
        })
    })
  }

  /** 云端失败的提示只出现一次：同一场会话里重复弹等于每次朗读都报一次错。 */
  private notifyFallbackOnce(): void {
    if (this.fallbackNotified) return
    this.fallbackNotified = true
    this.deps.notifyFallback()
  }

  private setState(next: VoicePlaybackState): void {
    if (this.state.status === next.status && this.state.key === next.key) return
    this.state = next
    for (const listener of this.listeners) listener(next)
  }
}

// ---- 云端合成（走本机服务，Key 不落渲染层） ----

async function requestSpeech(base: string, input: { text: string; profileId: string; speed?: number }): Promise<Blob> {
  const response = await authedFetch(base, '/api/voice/speak', {
    method: 'POST',
    body: JSON.stringify({
      text: input.text,
      profileId: input.profileId,
      ...(input.speed === undefined ? {} : { speed: input.speed }),
    }),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => {
      return {}
    })) as { error?: string; code?: string }
    throw new VoiceRequestError(
      payload.error ?? `语音合成失败（HTTP ${response.status}）`,
      response.status,
      payload.code,
    )
  }
  return response.blob()
}

function defaultDeps(base: string): VoicePlayerDeps {
  return {
    catalog: () => {
      return fetchVoiceCatalog(base)
    },
    synthesize: (input) => {
      return requestSpeech(base, input)
    },
    system: browserSystemVoice(),
    createAudio: (src) => {
      return browserAudio(src)
    },
    createObjectURL: (blob) => {
      return URL.createObjectURL(blob)
    },
    revokeObjectURL: (url) => {
      URL.revokeObjectURL(url)
    },
    notifyFallback: () => {
      toast.info('云端语音不可用，已用系统语音朗读')
    },
    notifyCatalogFallback: () => {
      toast.info('音色目录暂不可用，已用系统语音朗读')
    },
  }
}

const players = new Map<string, VoicePlayer>()

/** 同一个 API 地址只用一个播放器（队列与状态才是全局的）。 */
export function voicePlayerFor(base: string = resolveApiBase()): VoicePlayer {
  const existing = players.get(base)
  if (existing !== undefined) return existing
  const player = new VoicePlayer(defaultDeps(base))
  players.set(base, player)
  return player
}

/** 订阅播放状态（React hook）。 */
export function useVoicePlayback(player: VoicePlayer | undefined): VoicePlaybackState {
  const [state, setState] = useState<VoicePlaybackState>(() => {
    return player?.getState() ?? { status: 'idle' }
  })
  useEffect(() => {
    if (player === undefined) {
      setState({ status: 'idle' })
      return
    }
    setState(player.getState())
    return player.onStateChange(setState)
  }, [player])
  return state
}
