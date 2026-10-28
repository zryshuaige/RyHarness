/**
 * 内置插件：MiniMax 语音 + 本地声线文件。
 *
 * 这一层是「声线文件」变成「软件里的一条音色」的地方：
 *
 * 1. 首次启动时把随装的默认声线文件写进 `<dataDir>/voice/voices/`（已存在的不覆盖——
 *    用户改过的声线是他自己的，不该被升级冲掉）；
 * 2. 读这个目录下的每一份 `*.json`，解析成目录条目，在 `/api/voice/catalog` 里露出来；
 * 3. 合成时按文件里的旋钮（语速 / 音高 / 音量 / 情绪）去调 MiniMax 的 `t2a_v2`。
 *
 * 凭据读的是**同一份** providers 配置（应用内填的 MiniMax key 与 LLM 走的是同一条
 * 路由），不另存副本：用户换 key 时语音与对话一起换，不会出现"对话能用、朗读不能"。
 *
 * 为什么文件放在数据目录而不是代码目录：安装版里代码目录是只读的 asar，而声线是要
 * 被用户改的东西（换说话人、调语速）。数据目录是「这台机器上的用户数据」，用户知道
 * 它在哪、删了会怎样。
 * @module @ryharness/server/plugins/voice-minimax
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@ryharness/cordis'
import {
  DEFAULT_VOICE_FILES,
  parseVoiceFile,
  registerVoiceProfile,
  synthesizeMinimax,
  VOICE_ERROR_CODES,
  VoiceError,
  type VoiceFile,
  type VoiceProfile,
} from '@ryharness/voice'
import type { ProviderConfig, ProvidersConfigFile } from '../config.ts'
import type { PluginEntry } from './host.ts'
import type { VoiceProvider } from './voice.ts'

export const VOICE_MINIMAX_PLUGIN_ID = 'voice-minimax'

/** 这个插件注册的引擎 id。 */
export const MINIMAX_ENGINE = 'minimax'

/** MiniMax 在 providers.json 里的路由 id（与内置条目同名）。 */
const MINIMAX_PROVIDER_ID = 'minimax'

/** 声线文件目录（相对数据目录）。 */
export const VOICE_FILES_DIR = join('voice', 'voices')

/** 凭据与端点。取不到就是"还没配"。 */
interface EngineCredential {
  apiKey: string
  baseUrl: string
}

/**
 * 端点是不是 MiniMax（自建网关换了 id 时仍要认得出来）。
 *
 * 与 SiliconFlow 那条同样的道理：按 hostname 认厂商，而不是只认路由 id——用户把这条
 * 路由改名或删了、自己加了一条同家端点的路由，语音照样该能用。
 */
function isMinimaxEndpoint(baseURL: string): boolean {
  try {
    const hostname = new URL(baseURL).hostname.toLowerCase()
    return hostname.endsWith('minimaxi.com') || hostname.endsWith('minimax.io')
  } catch {
    return false
  }
}

/**
 * 取出 MiniMax 的凭据与端点。
 *
 * 读的顺序与 LLM 适配器一致：明文 key 优先，其次 `apiKeyEnv` 指向的环境变量。命中的
 * 顺序是"内置条目在前、其余指向 MiniMax 的路由在后"。
 */
function engineCredential(providers: ProvidersConfigFile): EngineCredential | undefined {
  const entries = Object.entries(providers.providers)
  const sameVendor = (entry: [string, ProviderConfig]): boolean => {
    const [id, provider] = entry
    return id !== MINIMAX_PROVIDER_ID && isMinimaxEndpoint(provider.baseURL)
  }
  for (const entry of [
    ...entries.filter((candidate) => {
      return candidate[0] === MINIMAX_PROVIDER_ID
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
 * 把随装的默认声线写进数据目录（已存在的不动）。
 *
 * 只在**缺文件**时写：声线文件是用户改过的东西，升级应用时把它盖回去，等于把用户
 * 调好的语速悄悄扔了。
 */
export function seedVoiceFiles(dir: string, defaults: readonly VoiceFile[] = DEFAULT_VOICE_FILES): string[] {
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  for (const file of defaults) {
    const path = join(dir, `${file.id}.json`)
    if (existsSync(path)) continue
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    written.push(path)
  }
  return written
}

/**
 * 读目录下的声线文件。
 *
 * 坏文件**跳过**而不是让整次启动失败：一份手写坏了的 JSON 不该让整个软件开不了机。
 * 但也不静默——控制台要说一声是哪个文件、为什么不能用。
 */
export function loadVoiceFiles(dir: string): VoiceFile[] {
  if (!existsSync(dir)) return []
  const files: VoiceFile[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      console.warn(`@ryharness/server: 声线文件 ${path} 不是合法 JSON，已跳过：${(error as Error).message}`)
      continue
    }
    const file = parseVoiceFile(parsed)
    if (file === undefined) {
      console.warn(`@ryharness/server: 声线文件 ${path} 字段不合格，已跳过（id/engine/voice/sampleText 等必填）`)
      continue
    }
    files.push(file)
  }
  return files
}

/** 插件选项（测试可注入假目录；生产只传 dataDir 与 providers）。 */
export interface MinimaxVoicePluginOptions {
  dataDir: string
  providers: ProvidersConfigFile
  /** 覆盖声线文件目录（测试用）。 */
  voicesDir?: string
  /** 覆盖 fetch（测试用）。 */
  fetchImpl?: typeof fetch
}

/** 造 provider 需要的那些东西。 */
export interface MinimaxProviderOptions {
  /** 已读出来的声线文件。 */
  files: readonly VoiceFile[]
  /** 声线文件目录（只用来在界面上告诉用户"改哪个文件"）。 */
  dir: string
  providers: ProvidersConfigFile
  fetchImpl?: typeof fetch
}

/**
 * 造 MiniMax 这个引擎的 provider。
 *
 * 单独拆出来是为了能直接测它（不必起整个服务）：凭据从哪来、旋钮怎么传给上游、
 * 没配 key 时说哪句话——这三条都是"用户看得见"的处置。
 * @param options - 声线文件、目录、供应商配置与可注入的 fetch。
 */
export function createMinimaxProvider(options: MinimaxProviderOptions): VoiceProvider {
  const byId = new Map(
    options.files.map((file) => {
      return [file.id, file] as const
    }),
  )
  const profiles: VoiceProfile[] = options.files.map((file) => {
    return {
      id: file.id,
      name: file.name,
      engine: file.engine,
      voice: file.voice,
      sampleText: file.sampleText,
      description: file.description,
    }
  })
  return {
    engine: MINIMAX_ENGINE,
    describe() {
      const credential = engineCredential(options.providers)
      if (credential === undefined) {
        return {
          name: 'MiniMax 语音',
          available: false,
          note: '按声线文件念，语速与音高都在文件里',
          reason: '还没配置 MiniMax 的 API Key，先去「设置 → 供应商」里填上',
        }
      }
      return {
        name: 'MiniMax 语音',
        available: true,
        note: `声线文件在 ${options.dir}，改完存盘、重启应用就生效`,
      }
    },
    profiles() {
      return profiles
    },
    async synthesize(request, deps) {
      const file = byId.get(request.profileId)
      if (file === undefined) {
        throw new VoiceError(`声线文件里没有「${request.profileId}」`, VOICE_ERROR_CODES.unknownProfile)
      }
      const credential = engineCredential(options.providers)
      if (credential === undefined) {
        throw new VoiceError('还没配置 MiniMax 的 API Key，先去「设置 → 供应商」里填上', VOICE_ERROR_CODES.noCredential)
      }
      const result = await synthesizeMinimax(
        {
          text: request.text,
          voice: file.voice,
          ...(file.model === undefined ? {} : { model: file.model }),
          // 说话时临时拖的语速覆盖文件里的默认值；没拖就用文件里的。
          speed: request.speed ?? file.speed,
          ...(file.pitch === undefined ? {} : { pitch: file.pitch }),
          ...(file.vol === undefined ? {} : { vol: file.vol }),
          ...(file.emotion === undefined ? {} : { emotion: file.emotion }),
          language: 'Chinese',
        },
        {
          fetchImpl: options.fetchImpl ?? fetch,
          apiKey: credential.apiKey,
          baseUrl: credential.baseUrl,
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        },
      )
      return { audio: result.audio, mime: result.mime, format: result.format }
    },
  }
}

/**
 * 插件入口。
 *
 * provider 注销与目录条目的注册都挂在自己的 fiber 上：插件关掉时，目录里不再出现
 * minimax 这一组音色，人格里指向它们的那位助理显示成「已下架的旧音色」（id 还在，
 * 插件回来又能用），而不是留下一条点下去就报错的死引用。
 * @param options - 数据目录、供应商配置与可注入依赖。
 */
export function voiceMinimaxPlugin(options: MinimaxVoicePluginOptions): PluginEntry {
  return {
    id: VOICE_MINIMAX_PLUGIN_ID,
    name: 'MiniMax 语音',
    description: '按声线文件念：Ryen 的猫猫音等，改文件里的语速音高即可换一种念法。',
    group: 'voice',
    // 不声明 capabilities：这个插件提供的是**音色**（voice provider），既没有工具
    // 也没有路由。写一个空的 routes 数组只会在插件页上留一个空胶囊——那看着像
    // 「声明了但没生效」，其实是压根没什么可声明。
    impact: '关闭后这些声线不可用，系统语音与其它云端音色不受影响。',
    inject: ['voice'],
    apply: (ctx: Context) => {
      const dir = options.voicesDir ?? join(options.dataDir, VOICE_FILES_DIR)
      seedVoiceFiles(dir)
      const files = loadVoiceFiles(dir)
      const provider = createMinimaxProvider({
        files,
        dir,
        providers: options.providers,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      })

      ctx.effect(() => {
        const disposeProvider = ctx.voice.registerProvider(provider)
        // 目录条目也要进内核的注册表：人格保存时 `normalizeVoiceId` 只放行目录里有的
        // id，不注册的话，用户挑了这条音色、存下来却变成"不朗读"。
        const disposers = provider.profiles().map((profile) => {
          return registerVoiceProfile(profile)
        })
        return () => {
          disposeProvider()
          for (const dispose of disposers) dispose()
        }
      }, 'voice-minimax.provider')
    },
  }
}
