/**
 * 内置插件：语音朗读。
 *
 * 插件挂上 `VoiceRegistry`（音色目录 + 云端合成 + 节流）并把自己的两条路由交给
 * RouteRegistry；关闭插件时两条路由与这个服务一起消失，渲染层的朗读按钮随即降级
 * 到系统语音。供应商凭据仍读组合根持有的同一份 `providers` 对象，不另存副本。
 * @module @ryharness/server/plugins/voice
 */

import { type Context, Service } from '@ryharness/cordis'
import {
  createVoiceRateLimiter,
  type SpeakRequest,
  type SpeakResult,
  synthesize,
  truncateForSynthesis,
  VOICE_ENGINES,
  VOICE_ERROR_CODES,
  VOICE_PROFILES,
  type VoiceEngineId,
  VoiceError,
  type VoiceProfile,
} from '@ryharness/voice'
import type { ProviderConfig, ProvidersConfigFile } from '../config.ts'
import { createVoiceHandlers, type VoiceAudio, type VoiceCatalogView, type VoiceSpeakInput } from '../routes/voice.ts'
import type { PluginEntry } from './host.ts'

export const VOICE_PLUGIN_ID = 'voice'

/** 云端引擎在 providers.json 里对应的路由 id（与内置条目同名）。 */
const SILICONFLOW_PROVIDER_ID = 'siliconflow'

/** cordis 服务名。 */
const SERVICE_NAME = 'voice'

declare module '@ryharness/cordis' {
  interface Context {
    /** 语音能力（挂载方式：`await ctx.plugin(VoiceRegistry, providers)`）。 */
    voice: VoiceRegistry
  }
}

/** 一条云端路线的凭据与端点。取不到就是"还没配"。 */
interface EngineCredential {
  apiKey: string
  baseUrl: string
}

/** 一个注册引擎的目录信息；`describe` 每次目录请求都会重新问一遍。 */
export interface VoiceEngineStatus {
  /** 下拉分组名（如「离线（Piper）」）。 */
  name: string
  available: boolean
  /** 使用方式/前置条件说明。 */
  note?: string
  /** 不可用时给用户的可操作原因（「离线语音包还没下载」）。 */
  reason?: string
}

/** 合成时从宿主拿到的能力。 */
export interface VoiceProviderDeps {
  /** 客户端断开 / 服务停机时中止；离线进程必须据此杀掉。 */
  signal?: AbortSignal
}

/**
 * 可注册的语音引擎。
 *
 * 接口刻意只要求三件事：引擎 id、当前音色、合成。`describe` 可选——不实现它时
 * 宿主按「已注册即可用」处理；需要异步安装/探测的引擎（Piper）实现它，才能把
 * 「还没下载」如实告诉目录，而不是等用户点了才失败。
 */
export interface VoiceProvider {
  engine: VoiceEngineId
  describe?(): VoiceEngineStatus
  profiles(): readonly VoiceProfile[]
  synthesize(request: SpeakRequest, deps: VoiceProviderDeps): Promise<SpeakResult>
}

/** 端点是不是 SiliconFlow（自建网关换了 id 时仍要认得出来）。 */
function isSiliconflowEndpoint(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname.toLowerCase().endsWith('siliconflow.cn')
  } catch {
    return false
  }
}

/**
 * 取出云端引擎可用的凭据与端点。
 *
 * 读法与 LLM 适配器一致：明文 key 优先，其次 `apiKeyEnv` 指向的环境变量（开发时
 * 用 .env 覆盖）。命中的顺序是"内置条目在前、其余指向 siliconflow 的路由在后"，
 * 这样用户把内置条目删了、自己加了一条同家端点的路由，语音照样能用。
 */
function engineCredential(providers: ProvidersConfigFile, providerId: string): EngineCredential | undefined {
  const entries = Object.entries(providers.providers)
  const sameVendor = (entry: [string, ProviderConfig]): boolean => {
    const [id, provider] = entry
    return id !== providerId && isSiliconflowEndpoint(provider.baseURL)
  }
  for (const entry of [
    ...entries.filter((candidate) => {
      return candidate[0] === providerId
    }),
    ...entries.filter(sameVendor),
  ]) {
    const [, config] = entry
    const apiKey = config.apiKey ?? (config.apiKeyEnv === undefined ? undefined : process.env[config.apiKeyEnv])
    if (apiKey === undefined || apiKey.length === 0) continue
    return { apiKey, baseUrl: config.baseURL.replace(/\/+$/, '') }
  }
  return undefined
}

/**
 * 语音能力服务：目录、凭据、节流与合成都在这里。
 *
 * 节流器与插件同生命周期（关掉再打开就换一份）：它不是业务状态，只是同一音色
 * 连点时的闸；插件卸载时把闸一起丢掉比跨生命周期保留一个旧窗口更符合直觉。
 */
export class VoiceRegistry extends Service {
  private readonly limiter = createVoiceRateLimiter()
  /** 注册顺序即目录顺序（Map 保序）。 */
  private readonly engines = new Map<string, VoiceProvider>()
  /**
   * 曾经在目录里出现过的音色。
   *
   * 只用于**报错归因**：插件刚被关掉、前端还拿着旧目录点了一下，这时该说
   * 「引擎没注册」而不是「查无此音色」——后者会把用户引向改 profileId。
   */
  private readonly knownProfiles = new Map<string, VoiceProfile>()

  constructor(
    ctx: Context,
    private readonly providers: ProvidersConfigFile,
  ) {
    super(ctx, SERVICE_NAME)
  }

  /**
   * 注册一个引擎提供方，返回精确注销函数（重复调用幂等）。
   *
   * 不让注册本身持有生命周期：调用方（voice-piper 插件）把返回的 disposer 放进
   * 自己的 `ctx.effect`，于是「插件关掉」与「provider 消失」是同一个动作。
   * 同 id 重复注册直接报错：静默覆盖会让先装的那个插件永远收不到合成请求。
   * @param provider - 引擎实现。
   * @returns 注销这一次注册的函数。
   */
  registerProvider(provider: VoiceProvider): () => void {
    if (this.engines.has(provider.engine)) {
      throw new Error(`@ryharness/server: voice engine "${provider.engine}" is already registered`)
    }
    this.engines.set(provider.engine, provider)
    this.remember(provider.profiles())
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.engines.get(provider.engine) === provider) this.engines.delete(provider.engine)
    }
  }

  /** 当前注册的引擎 id（测试与排障用；目录的顺序以 catalog 为准）。 */
  registeredEngines(): readonly string[] {
    return [...this.engines.keys()]
  }

  /** 目录：系统音色恒可用，云端看凭据，注册引擎看它自己的 describe。 */
  catalog(): VoiceCatalogView {
    const cloudReady = engineCredential(this.providers, SILICONFLOW_PROVIDER_ID) !== undefined
    const engines = VOICE_ENGINES.map((engine) => {
      const available = engine.id === 'system' || cloudReady
      return {
        id: engine.id,
        name: engine.name,
        available,
        ...(engine.note === undefined ? {} : { note: engine.note }),
        ...(available || engine.id === 'system' ? {} : { reason: '还没配置 SiliconFlow 的 API Key' }),
      }
    })
    const providerProfiles: VoiceProfile[] = []
    for (const provider of this.engines.values()) {
      const status = this.describeEngine(provider)
      engines.push({
        id: provider.engine,
        name: status.name,
        available: status.available,
        ...(status.note === undefined ? {} : { note: status.note }),
        ...(status.reason === undefined ? {} : { reason: status.reason }),
      })
      providerProfiles.push(...provider.profiles())
    }
    this.remember(providerProfiles)
    return { engines, profiles: [...VOICE_PROFILES, ...providerProfiles] }
  }

  /**
   * 合成一句话。
   *
   * 凭据先于节流查：没配 key 时无论点多少次都只会被节流挡下，用户看到的是一个
   * 永远不变的"太频繁"，而真正该他去做的事是去设置里填 Key。
   */
  async speak(input: VoiceSpeakInput, options: { signal?: AbortSignal } = {}): Promise<VoiceAudio> {
    const profile = this.findProfile(input.profileId)
    if (profile === undefined) {
      throw new VoiceError(`目录里没有音色「${input.profileId}」`, VOICE_ERROR_CODES.unknownProfile)
    }
    if (profile.engine === 'system') {
      throw new VoiceError(
        `音色「${profile.name}」是系统语音，请在应用里直接朗读，不经过服务端`,
        VOICE_ERROR_CODES.engineLocal,
      )
    }
    if (input.text.trim().length === 0) {
      throw new VoiceError('要朗读的文本不能为空', VOICE_ERROR_CODES.badRequest)
    }
    if (profile.engine === 'siliconflow') {
      return await this.speakCloud(input, profile)
    }
    return await this.speakProvider(input, profile, options.signal)
  }

  /** 内置云端：凭据检查仍然先于节流（与拆分前逐字一致）。 */
  private async speakCloud(input: VoiceSpeakInput, profile: VoiceProfile): Promise<VoiceAudio> {
    const credential = engineCredential(this.providers, SILICONFLOW_PROVIDER_ID)
    if (credential === undefined) {
      throw new VoiceError(
        '还没配置 SiliconFlow 的 API Key，先去「设置 → 供应商」里填上',
        VOICE_ERROR_CODES.noCredential,
      )
    }
    this.acquire(profile)
    try {
      const prepared = truncateForSynthesis(input.text)
      const result = await synthesize(
        { text: prepared.text, profileId: profile.id, ...(input.speed === undefined ? {} : { speed: input.speed }) },
        {
          fetchImpl: fetch,
          apiKey: credential.apiKey,
          baseUrl: credential.baseUrl,
          profile,
        },
      )
      return {
        audio: result.audio,
        mime: result.mime,
        profileId: profile.id,
        truncated: prepared.truncated,
      }
    } finally {
      // 成功与失败都要还槽：漏一次就把全局并发上限吃掉了，且再也还不回来。
      this.limiter.release()
    }
  }

  /**
   * 注册引擎：按 profile.engine 路由到 provider。
   *
   * 先查可用性再占节流槽：没下载的离线包无论点多少次都不该把并发额度占掉。
   * provider 抛非 VoiceError 时包成 VOICE_UPSTREAM——HTTP 层只认这一种错误形状，
   * 否则第三方插件的一个普通 Error 会变成 500「INTERNAL」，看不出是语音这条路。
   */
  private async speakProvider(
    input: VoiceSpeakInput,
    profile: VoiceProfile,
    signal: AbortSignal | undefined,
  ): Promise<VoiceAudio> {
    const provider = this.engines.get(profile.engine)
    if (provider === undefined) {
      throw new VoiceError(
        `音色「${profile.name}」所属的引擎「${profile.engine}」没有注册（插件可能已关闭）`,
        VOICE_ERROR_CODES.engineUnavailable,
      )
    }
    const status = this.describeEngine(provider)
    if (!status.available) {
      throw new VoiceError(
        status.reason ?? `音色「${profile.name}」所属的引擎「${profile.engine}」当前不可用`,
        VOICE_ERROR_CODES.engineUnavailable,
      )
    }
    this.acquire(profile)
    try {
      const prepared = truncateForSynthesis(input.text)
      const result = await provider.synthesize(
        { text: prepared.text, profileId: profile.id, ...(input.speed === undefined ? {} : { speed: input.speed }) },
        { ...(signal === undefined ? {} : { signal }) },
      )
      if (result.audio.byteLength === 0) {
        throw new VoiceError(`引擎「${profile.engine}」返回了空音频`, VOICE_ERROR_CODES.upstream)
      }
      return { audio: result.audio, mime: result.mime, profileId: profile.id, truncated: prepared.truncated }
    } catch (error) {
      if (error instanceof VoiceError) throw error
      throw new VoiceError(`引擎「${profile.engine}」合成失败：${messageOf(error)}`, VOICE_ERROR_CODES.upstream, {
        cause: error,
      })
    } finally {
      this.limiter.release()
    }
  }

  /** 占一个节流槽；挡下时抛与拆分前同一组文案。 */
  private acquire(profile: VoiceProfile): void {
    const verdict = this.limiter.acquire(profile.id)
    if (verdict.ok) return
    throw new VoiceError(
      verdict.reason === 'busy' ? '同时合成的请求太多，稍后再试' : '同一个音色刚念过，稍等一下再试',
      VOICE_ERROR_CODES.rateLimited,
    )
  }

  /** 当前目录里的音色；退一步认「曾经出现过」的，用来把引擎缺失报准。 */
  private findProfile(id: string): VoiceProfile | undefined {
    const fromBuiltin = VOICE_PROFILES.find((profile) => {
      return profile.id === id
    })
    if (fromBuiltin !== undefined) return fromBuiltin
    for (const provider of this.engines.values()) {
      const profiles = provider.profiles()
      this.remember(profiles)
      const match = profiles.find((profile) => {
        return profile.id === id
      })
      if (match !== undefined) return match
    }
    return this.knownProfiles.get(id)
  }

  /** provider 没声明 describe 时按「已注册、可用」处理。 */
  private describeEngine(provider: VoiceProvider): VoiceEngineStatus {
    return provider.describe?.() ?? { name: provider.engine, available: true }
  }

  private remember(profiles: readonly VoiceProfile[]): void {
    for (const profile of profiles) this.knownProfiles.set(profile.id, profile)
  }
}

/** 异常 → 一句可展示的原因。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 语音插件入口。
 *
 * `apply` 先挂 VoiceRegistry，再注册两条路由；两者都归插件 fiber，卸载时 cordis
 * 逆序执行清理（路由先撤、服务随后注销），不会留下指向已消失服务的 handler。
 * @param providers - 组合根持有的供应商配置（语音与 LLM 共用同一份）。
 */
export function voicePlugin(providers: ProvidersConfigFile): PluginEntry {
  return {
    id: VOICE_PLUGIN_ID,
    name: '语音朗读',
    description: '把设置里的云端音色接到朗读按钮；关闭后朗读只剩本机系统语音。',
    group: 'voice',
    capabilities: { routes: ['GET /api/voice/catalog', 'POST /api/voice/speak'] },
    impact: '关闭后朗读只剩本机系统语音，云端音色目录与合成接口下线。',
    inject: ['routes'],
    apply: (ctx) => {
      // 直接构造而不是再挂一层子插件：handler 需要的就是这个实例，绕一圈经
      // ctx.voice 取反而要求外层插件声明一个「apply 开始时还不存在」的依赖。
      // Service 构造时把自身 provide 到当前 fiber，插件卸载即注销。
      const voice = new VoiceRegistry(ctx, providers)
      const handlers = createVoiceHandlers(voice)
      ctx.routes.register('GET', '/api/voice/catalog', handlers.catalog)
      ctx.routes.register('POST', '/api/voice/speak', handlers.speak)
    },
  }
}
