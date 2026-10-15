/**
 * 供应商配置：data/config/providers.json 读写。
 *
 * 首启时写入内置默认条目（SiliconFlow）；apiKey 一律走 apiKeyEnv
 * 引用，配置文件不存明文 key。用户自己加的供应商（POST /api/providers）
 * 写同一份文件，应用内 key 另存 config/api-keys.json（0600，桌面端用 Electron
 * safeStorage 交给系统密钥库加密，见 {@link configureSecretStore}）。
 * @module @ryagent/server/config
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { OpenAiAdapterConfig, OpenAiProviderConfig } from '@ryagent/llm-openai'

/**
 * 接入协议。当前适配器只有 OpenAI 兼容一路，`ollama` 是特例：本地服务不校验
 * 凭据，因此允许空 key（见 {@link KEYLESS_API_KEY_PLACEHOLDER}）。
 */
export type ProviderProtocol = 'openai' | 'ollama'

/** providers.json 里的一条路由：适配器配置 + 应用内元数据。 */
export interface ProviderConfig extends OpenAiProviderConfig {
  /** 接入协议（UI 徽标 + 是否免 key）。缺省 openai。 */
  protocol?: ProviderProtocol
  /** 用户手动添加的供应商（可删除）；内置条目不带这个标记。 */
  custom?: boolean
  /** 从哪个预设建起（UI 回溯图标/文档链接用）。 */
  presetId?: string
}

/** providers.json 的形状。 */
export interface ProvidersConfigFile {
  providers: Record<string, ProviderConfig>
  /**
   * 记忆向量模型的显式配置：走哪个 provider、用哪个 embedding 模型 id。
   * 缺省时跟随第一个已配 key 的供应商，且只有该供应商就是 SiliconFlow 时才
   * 套用它的默认向量模型——向量模型不通用，猜错会让整库检索静默塌陷。
   */
  embedding?: {
    providerId: string
    model: string
  }
}

/** 添加供应商向导的可选项（GET /api/provider-presets）。 */
export interface ProviderPreset {
  /** 预设 id；添加时也用作供应商 id（已被占用则退化成随机 id）。 */
  id: string
  displayName: string
  protocol: ProviderProtocol
  baseUrl: string
  /** 推荐模型 id 列表。 */
  models: string[]
  /** 官网/文档链接（UI 上「去官网申请 API Key」）。 */
  docsUrl?: string
}

/** 内置默认供应商的 baseURL：向量模型默认值只在它是当前供应商时才成立。 */
export const DEFAULT_PROVIDER_BASE_URL = 'https://api.siliconflow.cn/v1'

/** 内置默认供应商（SiliconFlow，key 经 SILICONFLOW_API_KEY 环境变量）。 */
export const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
  siliconflow: {
    baseURL: DEFAULT_PROVIDER_BASE_URL,
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    protocol: 'openai',
    displayName: 'SiliconFlow',
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek-V3', contextWindow: 64_000 },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek-R1', contextWindow: 64_000 },
      { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5-72B', contextWindow: 32_000 },
    ],
  },
}

/**
 * 供应商预设目录。
 *
 * 只给「协议 / baseURL / 推荐模型 / 文档链接」这些不随用户口味变的东西，具体
 * 模型与 key 由用户在向导里改。免 key 的 Ollama 也在列表里（本地模型是单机
 * 部署最常见的第二供应商）。
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'siliconflow',
    displayName: 'SiliconFlow',
    protocol: 'openai',
    baseUrl: DEFAULT_PROVIDER_BASE_URL,
    models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'],
    docsUrl: 'https://docs.siliconflow.cn/cn/userguide/quickstart',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    docsUrl: 'https://platform.deepseek.com',
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot 月之暗面',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-32k', 'moonshot-v1-128k'],
    docsUrl: 'https://platform.moonshot.cn',
  },
  {
    id: 'zhipu',
    displayName: '智谱 GLM',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4-plus'],
    docsUrl: 'https://open.bigmodel.cn/dev/api',
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    protocol: 'openai',
    baseUrl: 'https://api.minimaxi.com/v1',
    models: ['MiniMax-Text-01'],
    docsUrl: 'https://platform.minimaxi.com/document/Introduction',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-4', 'openai/gpt-4o-mini', 'google/gemini-2.5-flash'],
    docsUrl: 'https://openrouter.ai/docs',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini'],
    docsUrl: 'https://platform.openai.com/docs',
  },
  {
    id: 'ollama',
    displayName: 'Ollama（本地）',
    protocol: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5:7b', 'llama3.2:3b'],
    docsUrl: 'https://ollama.com/library',
  },
]

/** 按 id 查预设；未知返回 undefined。 */
export function providerPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => {
    return preset.id === id
  })
}

/**
 * 免 key 协议的占位凭据：适配器构造时要求每条路由恰好有一个凭据来源（空串会被
 * 判为不可用），而 Ollama 这类本地服务根本不校验 Authorization 头，于是用一个
 * 显眼的占位串把校验应付过去。
 */
export const KEYLESS_API_KEY_PLACEHOLDER = 'ollama-local-no-key'

/** 缺 key 的供应商预留的环境变量名：真去用的时候在本地以「缺凭据」失败，
 *  而不是拿假 token 发出请求换回一个看不懂的 401。 */
export function reservedApiKeyEnv(routeId: string): string {
  return `RYAGENT_API_KEY_${routeId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

/** 配置文件的权限：providers.json 同样只给本人读写（与 api-keys.json 一致）。 */
const CONFIG_FILE_MODE = 0o600

/** 原子写入（先写 .tmp 再 rename），尽力 chmod 到 0600。 */
function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: CONFIG_FILE_MODE })
  renameSync(tmp, path)
  try {
    chmodSync(path, CONFIG_FILE_MODE)
  } catch {
    // Windows 上 chmod 语义有限，失败不阻塞启动。
  }
}

/** providers.json 的路径（dataDir/config/providers.json）。 */
export function providersConfigPath(dataDir: string): string {
  return join(dataDir, 'config', 'providers.json')
}

/** 应用内凭据文件的路径（dataDir/config/api-keys.json）。 */
function apiKeysPath(dataDir: string): string {
  return join(dataDir, 'config', 'api-keys.json')
}

/** 凭据文件 v2 的标记字段。 */
const API_KEYS_SCHEMA = 'ryagent/api-keys@2'

/**
 * 凭据加密器：把 key 变成落盘的那一串，以及原样读回来。
 *
 * 桌面端是 Electron safeStorage（密钥由系统密钥库/DPAPI 持有，文件本身即使被
 * 拷走也解不开）；独立开发进程、CI 与测试没有 Electron，退回明文 + 0600 并打
 * 一声日志——这是明确的降级路径，不是静默失败。
 */
export interface SecretCodec {
  /** 落盘格式标记，也用于判断一份旧文件能不能直接读。 */
  readonly id: 'safeStorage' | 'plaintext'
  seal(plain: string): string
  open(sealed: string): string
}

/** Electron safeStorage 的最小形态（便于注入替身）。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(sealed: Buffer): string
}

/** 明文 + 0600 的降级实现：字段原样透传。 */
const PLAINTEXT_CODEC: SecretCodec = {
  id: 'plaintext',
  seal: (plain) => {
    return plain
  },
  open: (sealed) => {
    return sealed
  },
}

function safeStorageCodec(storage: SafeStorageLike): SecretCodec {
  return {
    id: 'safeStorage',
    seal: (plain) => {
      return storage.encryptString(plain).toString('base64')
    },
    open: (sealed) => {
      return storage.decryptString(Buffer.from(sealed, 'base64'))
    },
  }
}

/**
 * 探测 Electron safeStorage。
 *
 * 在 Electron 主进程里 `require('electron')` 拿到的是运行时模块；在普通 Node
 * 下它解析到 npm 包本身（一个路径字符串，没有 safeStorage），因此探测失败会
 * 自然降级，不需要判断自己是不是 Electron。
 */
function detectSafeStorage(): SafeStorageLike | undefined {
  try {
    const electron = createRequire(import.meta.url)('electron') as { safeStorage?: SafeStorageLike }
    const storage = electron.safeStorage
    if (storage === undefined || typeof storage.isEncryptionAvailable !== 'function') return undefined
    // app 还没 ready 时部分平台读密钥库会抛；不可用就明文，不阻塞启动。
    return storage.isEncryptionAvailable() ? storage : undefined
  } catch {
    return undefined
  }
}

/** 自动装配：有系统密钥库就用它，没有就明文降级。 */
function detectCodec(): SecretCodec {
  const storage = detectSafeStorage()
  return storage === undefined ? PLAINTEXT_CODEC : safeStorageCodec(storage)
}

let activeSecretCodec: SecretCodec | undefined

/** 当前凭据存储用的加密方式（'safeStorage' | 'plaintext'）：设置页与日志都要如实显示。 */
export function secretStoreCipher(): SecretCodec['id'] {
  return currentCodec().id
}

/**
 * 显式指定凭据加密器；传 undefined 恢复自动探测。
 *
 * 主进程在 app ready 后调一次（把 safeStorage 显式钉住，省掉隐式探测的时序
 * 假设）；测试注入可预测的替身。必须是**任何读写凭据之前**调用。
 */
export function configureSecretStore(codec: SecretCodec | undefined): void {
  activeSecretCodec = codec
}

function currentCodec(): SecretCodec {
  activeSecretCodec ??= detectCodec()
  return activeSecretCodec
}

/** v2 信封的形状守卫。 */
function isEnvelope(record: Record<string, unknown>): boolean {
  return record.$schema === API_KEYS_SCHEMA && typeof record.keys === 'object' && record.keys !== null
}

/**
 * v2 信封里逐条自带的密文（同一份文件里两种 cipher 并存时用）。
 *
 * 条目写成裸字符串表示"与文件级 cipher 相同"，写成对象表示自己带 cipher。信封的
 * `$schema` 仍是 @2——对象形态是字符串形态的超集，旧读法把不认识的值跳过即可，
 * 换版本号反而会让只认 @2 的读法把整份文件当成 v1 明文，那比混写糟糕得多。
 */
interface SealedEntry {
  cipher: SecretCodec['id']
  value: string
}

function isSealedEntry(value: unknown): value is SealedEntry {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (record.cipher === 'safeStorage' || record.cipher === 'plaintext') && typeof record.value === 'string'
}

/** 一次读取的结果：解得开的与解不开的分开装，写回时各归各位。 */
interface StoredKeys {
  /** 当前环境解得开的 key（明文，只在进程内用）。 */
  keys: Record<string, string>
  /**
   * 解不开、但仍属于用户的密文条目。
   *
   * 换机器、换系统账户、密钥库暂时不可用时密文救不回来——可"这一轮解不开"不等于
   * "这个 key 没了"。把它们原样带回写盘，用户下一次保存别的 key 才不会顺手抹掉
   * 上一版加密时配好的凭据：那才是真正的静默丢失。
   */
  sealed: Record<string, SealedEntry>
}

function tryOpen(codec: SecretCodec, sealed: string): string | undefined {
  try {
    return codec.open(sealed)
  } catch {
    return undefined
  }
}

/** 同一路径只提醒一次：设置页每存一次 key 都会走到读/写路径，日志不必刷屏。 */
const warnedPaths = new Set<string>()

function warnOnce(key: string, message: () => string): void {
  if (warnedPaths.has(key)) return
  warnedPaths.add(key)
  console.warn(message())
}

/**
 * 读凭据：v1 明文与 v2 信封都吃，坏文件按"没有凭据"起（不阻塞启动）。
 * 解不开的条目单独带出并提示重填——换系统账户后 safeStorage 解不出来是常态，
 * 那时把整份文件静默当成空，等于告诉用户"你没配过 key"。
 */
function readApiKeyFile(dataDir: string): StoredKeys {
  const stored: StoredKeys = { keys: {}, sealed: {} }
  const path = apiKeysPath(dataDir)
  if (!existsSync(path)) return stored
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return stored
  }
  if (typeof parsed !== 'object' || parsed === null) return stored
  const record = parsed as Record<string, unknown>
  const envelope = isEnvelope(record)
  const payload = (envelope ? record.keys : record) as Record<string, unknown>
  const fileCipher: SecretCodec['id'] = record.cipher === 'safeStorage' ? 'safeStorage' : 'plaintext'
  const codec = currentCodec()
  // 降级路径在读的时候就要说清楚：否则用户要等到哪天翻到这份文件，才知道自己
  // 的 key 是明文躺在盘上。
  if (codec.id === 'plaintext') {
    warnOnce(`${path}#read`, () => {
      return `@ryagent/server: 没有可用的系统密钥库（Electron safeStorage），${path} 里的 API key 只能以明文保存（0600，仅开发环境可用）`
    })
  }
  const unreadable: string[] = []
  for (const [providerId, entry] of Object.entries(payload)) {
    const sealed = isSealedEntry(entry) ? entry : { cipher: fileCipher, value: entry }
    if (typeof sealed.value !== 'string' || sealed.value.length === 0) continue
    // v1 文件与 cipher=plaintext 的信封都直接就是明文，不走当前的 codec：
    // 那份密文是写它的那台机器的密钥，加密方式一变就再也解不开了。
    if (sealed.cipher !== 'safeStorage') {
      stored.keys[providerId] = sealed.value
      continue
    }
    // 当前环境根本没有系统密钥库：解不开就是解不开，绝不能把密文当 key 递出去
    // （那会变成"带着一段 base64 去请求供应商"，报出来的错完全指不到病根）——
    // 但密文本身要原样留着，等回到能解密的环境。
    const plain = codec.id === 'safeStorage' ? tryOpen(codec, sealed.value) : undefined
    if (plain === undefined) {
      stored.sealed[providerId] = { cipher: 'safeStorage', value: sealed.value }
      unreadable.push(providerId)
      continue
    }
    stored.keys[providerId] = plain
  }
  if (unreadable.length > 0) {
    console.warn(
      `@ryagent/server: ${path} 里 ${unreadable.length} 个已存 API key（${unreadable.join('、')}）当前解不开：` +
        '本机没有可用的系统密钥库，或换过系统账户。请在设置里重新填写；' +
        '在能解开之前它们原样留在盘上，不会被其它 key 的保存覆盖掉。',
    )
  }
  return stored
}

/**
 * 写凭据：整体加密成 v2 信封（顺带把 v1 明文文件升级掉）。
 *
 * `stored.sealed` 里解不开的条目原样带走：降级路径最危险的不是"这轮用不了"，
 * 而是因为这轮用不了就把用户配好的凭据从盘上抹掉。
 */
function writeApiKeyEntries(dataDir: string, stored: StoredKeys): void {
  const codec = currentCodec()
  const path = apiKeysPath(dataDir)
  const entries = new Map<string, SealedEntry>()
  for (const [providerId, entry] of Object.entries(stored.sealed)) {
    // 只有同一个 cipher 才谈得上"重新封装"：明文 codec 去 open 一段密文只会把它
    // 原样当明文存回去，那比留着密文危险得多。
    const plain = entry.cipher === codec.id ? tryOpen(codec, entry.value) : undefined
    entries.set(providerId, plain === undefined ? entry : { cipher: codec.id, value: codec.seal(plain) })
  }
  for (const [providerId, plain] of Object.entries(stored.keys)) {
    entries.set(providerId, { cipher: codec.id, value: codec.seal(plain) })
  }
  const carried = [...entries.values()].filter((entry) => {
    return entry.cipher !== codec.id
  })
  if (codec.id === 'plaintext') {
    warnOnce(`${path}#write`, () => {
      return (
        `@ryagent/server: safeStorage 不可用，API key 以明文写入 ${path}（0600，仅开发环境）` +
        (carried.length > 0 ? `；另有 ${carried.length} 个密钥库密文条目原样保留` : '')
      )
    })
  }
  const keys: Record<string, string | SealedEntry> = {}
  for (const [providerId, entry] of entries) {
    keys[providerId] = entry.cipher === codec.id ? entry.value : entry
  }
  writePrivateJson(path, { $schema: API_KEYS_SCHEMA, cipher: codec.id, keys })
}

/** 读取 providers.json；不存在则写入默认配置后返回。 */
export function loadProvidersConfig(path: string): ProvidersConfigFile {
  if (!existsSync(path)) {
    const initial: ProvidersConfigFile = { providers: DEFAULT_PROVIDERS }
    writePrivateJson(path, initial)
    return initial
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as ProvidersConfigFile).providers !== 'object' ||
    (parsed as ProvidersConfigFile).providers === null
  ) {
    throw new Error(`@ryagent/server: invalid providers config at ${path}`)
  }
  return parsed as ProvidersConfigFile
}

/**
 * 应用内配置的 API key 存储：config/api-keys.json（0600）。
 *
 * providers.json 坚持只存 apiKeyEnv 引用、不落明文；但桌面应用要让用户首启就能
 * 粘贴 key 用起来，所以 key 单独放一个 0600 的文件，且**只**在进程内合并进适配器
 * 配置，不回显给前端。
 *
 * 文件有两代格式，读写都兼容：
 * - v1（历史）：扁平 `{ "<providerId>": "<明文 key>" }`；
 * - v2（当前）：`{ "$schema": "ryagent/api-keys@2", "cipher": …, "keys": { … } }`，
 *   `keys` 里放密文。cipher 记的是**写这一版时**用的加密方式——换机器、换系统
 *   账户后解不开时只丢那一版，并提示用户重填，而不是把整份凭据当成不存在。
 * 写任何一次都顺手把 v1 升成 v2。
 *
 * 「解不开」只影响本轮的可用性，不影响用户已经配好的东西：解不开的密文会原样
 * 带回下一次写入（条目自带 cipher），既不会被别的 key 覆盖掉，也能在回到能解密
 * 的环境后直接读回来。
 */
export function loadApiKeys(dataDir: string): Record<string, string> {
  return readApiKeyFile(dataDir).keys
}

/** 原子写入某个供应商的 key；返回是否写入成功（供应商未知时 false）。空串=删除。 */
export function saveApiKey(dataDir: string, providerId: string, key: string): boolean {
  const config = loadProvidersConfig(providersConfigPath(dataDir))
  if (config.providers[providerId] === undefined) return false
  const stored = readApiKeyFile(dataDir)
  if (key.length === 0) delete stored.keys[providerId]
  else stored.keys[providerId] = key
  // 用户显式改了这一条：旧密文（含当前解不开的那份）随之作废。
  delete stored.sealed[providerId]
  writeApiKeyEntries(dataDir, stored)
  return true
}

/**
 * 删掉某个供应商的 key，不要求它还在 providers.json 里。
 * 删供应商时用它：先删 key 再删路由才不会半路失败留下孤儿 key。
 * 当前环境解不开的密文也照删——"删不掉"不该由这一层来替用户决定。
 */
export function deleteApiKey(dataDir: string, providerId: string): void {
  const stored = readApiKeyFile(dataDir)
  if (stored.keys[providerId] === undefined && stored.sealed[providerId] === undefined) return
  delete stored.keys[providerId]
  delete stored.sealed[providerId]
  writeApiKeyEntries(dataDir, stored)
}

/**
 * 落盘整份供应商配置（POST /api/providers 的写入口）。
 *
 * 写之前先剥掉进程内合并进来的明文 key：调用方手上的是"适配器用的配置"（已经
 * 并过 api-keys.json），直接序列化就等于把明文 key 抄进那份承诺不存明文的文件。
 *
 * providers.json 同样按 0600 写：它没有明文 key，但它是本机能连到哪些外部服务
 * 的清单，与 api-keys.json 属于同一份信任边界。
 */
export function writeProvidersConfig(dataDir: string, config: ProvidersConfigFile): void {
  const providers: Record<string, ProviderConfig> = {}
  for (const [id, provider] of Object.entries(config.providers)) {
    if (provider.apiKey === undefined) {
      providers[id] = provider
      continue
    }
    const { apiKey: _merged, ...rest } = provider
    providers[id] = rest
  }
  writePrivateJson(providersConfigPath(dataDir), { ...config, providers })
}

/**
 * 把本地存储的 key 合并进供应商配置（apiKeyEnv 优先级更高：显式环境变量
 * 仍然覆盖应用内设置，方便开发时用 .env 覆盖）。
 */
export function mergeApiKeys(config: ProvidersConfigFile, keys: Record<string, string>): ProvidersConfigFile {
  if (Object.keys(keys).length === 0) return config
  const providers = { ...config.providers }
  for (const [providerId, key] of Object.entries(keys)) {
    const provider = providers[providerId]
    // 只在"没有明文 key"时并入：手改配置残留的空串不算已配，否则用户在设置里
    // 存好的 key 会被它无声挡掉。
    if (provider === undefined || carriesApiKey(provider)) continue
    providers[providerId] = { ...provider, apiKey: key }
  }
  // embedding 是独立于 providers 的轴：只换路由时不能把它一起丢掉（换掉之后
  // 记忆的向量模型会静默回落成"跟随第一个供应商"）。
  return { ...config, providers }
}

/** 配置里是否直接带了非空明文 key。 */
function carriesApiKey(provider: OpenAiProviderConfig): boolean {
  return typeof provider.apiKey === 'string' && provider.apiKey.length > 0
}

/** 某条路由是否已经配了可用的凭据（明文 key 或指向已设置的环境变量）。 */
function hasUsableCredential(provider: OpenAiProviderConfig, env: (name: string) => string | undefined): boolean {
  if (carriesApiKey(provider)) return true
  if (provider.apiKeyEnv === undefined) return false
  const value = env(provider.apiKeyEnv)
  return value !== undefined && value.length > 0
}

/**
 * 由配置文件构造适配器配置。
 *
 * 适配器构造时会校验每条路由「恰好一个凭据来源」，而缺凭据的供应商是常态
 * （本地 Ollama 根本不需要 key；用户加了 DeepSeek 但还没粘贴 key）。这里把
 * 两种缺凭据补成能让适配器起来的形状：
 * - 免 key 协议：占位串（本地服务不校验 Authorization 头）；
 * - 其余：指向一个预留的环境变量名，请求时以「缺凭据」在本地失败，而不是拿
 *   假 token 发出请求换回一个看不懂的 401。用户若真的设了那个环境变量，它照样
 *   生效（开发时的逃生口）。
 */
export function toAdapterConfig(config: ProvidersConfigFile): OpenAiAdapterConfig {
  const providers: Record<string, OpenAiProviderConfig> = {}
  for (const [routeId, provider] of Object.entries(config.providers)) {
    if (hasUsableCredential(provider, (name) => process.env[name])) {
      providers[routeId] = provider
      continue
    }
    // 先把两个凭据字段都摘干净再补一个：适配器校验的是"恰好一个"，手改过的
    // providers.json 里残留的空 apiKey 会和补上的 apiKeyEnv 撞成两个而炸掉整个
    // 适配器构造。
    const { apiKey: _key, apiKeyEnv: _env, ...rest } = provider
    providers[routeId] =
      provider.protocol === 'ollama'
        ? { ...rest, apiKey: KEYLESS_API_KEY_PLACEHOLDER }
        : { ...rest, apiKeyEnv: reservedApiKeyEnv(routeId) }
  }
  return { providers }
}

/** 某个供应商的凭据是否已配置（apiKey 直接给出，或 apiKeyEnv 指向的环境变量存在）；只看存在性，不泄露值。 */
export function providerKeyConfigured(
  provider: OpenAiProviderConfig,
  env: (name: string) => string | undefined = (name) => {
    return process.env[name]
  },
): boolean {
  return hasUsableCredential(provider, env)
}

/**
 * 解析记忆/进化管线要用的 LLM 连接：取第一个凭据已配置的供应商，
 * 模型取该供应商的第一个。这样用户在 providers.json 里换成别家服务商后，
 * 记忆与进化也跟着走，而不是写死 SiliconFlow。
 */
export function resolveSidecarLlm(
  providers: ProvidersConfigFile,
): { providerId: string; apiKey: string; baseURL: string; model: string } | undefined {
  for (const [providerId, provider] of Object.entries(providers.providers)) {
    const apiKey = provider.apiKey ?? (provider.apiKeyEnv === undefined ? undefined : process.env[provider.apiKeyEnv])
    if (apiKey === undefined || apiKey.length === 0) continue
    const model = provider.models[0]?.id
    if (model === undefined) continue
    return { providerId, apiKey, baseURL: provider.baseURL, model }
  }
  return undefined
}
