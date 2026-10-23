/**
 * 供应商配置：data/config/providers.json 读写。
 *
 * 首启时写入内置默认条目（SiliconFlow）；apiKey 一律走 apiKeyEnv
 * 引用，配置文件不存明文 key。用户自己加的供应商（POST /api/providers）
 * 写同一份文件，应用内 key 另存 config/api-keys.json（0600，桌面端用 Electron
 * safeStorage 交给系统密钥库加密，见 {@link configureSecretStore}）。
 * @module @ryharness/server/config
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { OpenAiAdapterConfig, OpenAiProviderConfig } from '@ryharness/llm-openai'

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

/**
 * providers.json 里一个模型条目的写入形状（POST / PATCH /api/providers 的 models）。
 *
 * contextWindow 是用户照厂商文档补录的上下文长度，它一路走到 OpenAI 适配器的
 * resolveModel()，再由内核按它算输入预算（@ryharness/agent 的 resolveRequestBudget）。
 * 所以它必须与界面上显的那个数字是同一份值：界面上写着 A、内核按 B 算，比干脆
 * 不给这个入口更糟——用户正是拿它判断"这条长会话会不会爆窗口"。
 */
export interface ProviderModelInput {
  /** Model id sent as `model` on the wire. */
  id: string
  /** 用户补录的上下文长度；不填 = 端点没报、界面显示「上下文未知」。 */
  contextWindow?: number
}

/**
 * 补录上下文长度的下限（token）。
 *
 * 再小就装不下系统提示 + 工具声明 + 一次回复，内核会把输入预算算成 0（每轮几乎
 * 什么都没发给模型），而界面上那个数字仍然"看着合法"。
 */
export const MIN_CONTEXT_WINDOW_TOKENS = 1_024

/**
 * 补录上下文长度的上限（token）。
 *
 * 4M 已经高过当前在售模型的窗口，再大只可能是把 128000 敲成了 12800000。这类数字
 * 会让内核按一个不存在的窗口留历史，最后由供应商 400 来告诉用户——那时他已经
 * 白攒了几十轮上下文。
 */
export const MAX_CONTEXT_WINDOW_TOKENS = 4_000_000

/**
 * 校验一个补录的上下文长度：合法回整数，不合法回 undefined。
 *
 * 只认正整数：核心里面所有 token 口径都按整数算，带小数的窗口没有意义，而
 * 1.5 这种写法多半是"1.5 万"之类口误被当成 token 数敲了进来。
 */
export function parseContextWindowTokens(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  if (value < MIN_CONTEXT_WINDOW_TOKENS || value > MAX_CONTEXT_WINDOW_TOKENS) return undefined
  return value
}

/**
 * 按客户端声明的模型列表重建一条路由的模型条目。
 *
 * 顺序听客户端的（那份列表就是它的编辑面），name / description 沿用旧条目：界面上
 * 没有它们的编辑入口，因为改个长度把显示名弄没了是纯损失。
 *
 * 声明里不带 contextWindow = 用户把框清空了，旧值必须跟着走：否则界面回到「未知」、
 * 内核里还留着上一次的窗口预算，那又是一处界面与内核不一致（见 {@link ProviderModelInput}）。
 */
export function applyDeclaredModels(
  previous: readonly OpenAiProviderConfig['models'][number][],
  declared: readonly ProviderModelInput[],
): OpenAiProviderConfig['models'] {
  const known = new Map(
    previous.map((model) => {
      return [model.id, model]
    }),
  )
  return declared.map((model) => {
    const { contextWindow: _cleared, ...carried } = known.get(model.id) ?? { id: model.id }
    return {
      ...carried,
      id: model.id,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    }
  })
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
  /**
   * 「给新用户用的那一档」：助理改绑到这家时默认用它，而不是列表第一条。
   *
   * 为什么不能盲取第一条：每家列表的第一档不一定是新用户能用的——
   * Moonshot 的 kimi-k3 需先充值解锁（赠送的代金券不适用，用赠送额度建的 key
   * 调它直接 404 / 无权限）；智谱的 glm-5.3 思考程度默认 max（每轮都慢一截）；
   * OpenRouter 头两档是旗舰价（$4/$20 与 $10/$50 每百万）。改绑是服务端静默做的，
   * 用户看不见这一层，于是「跟着走」就等于「跟着最贵或用不了的那档走」。
   */
  defaultModel?: string
  /** 官网/文档链接（UI 上「去官网申请 API Key」）。 */
  docsUrl?: string
  /**
   * 这家怎么表达思考强度，落库到 provider 路由上（见 OpenAiProviderConfig）。
   *
   * 缺省即 `none`：不给用户一个选了会被端点静默忽略的选择器，比没有更糟。认不认
   * `reasoning_effort` 是按官方文档逐家核过的（2026-10），不是按「OpenAI 兼容
   * 大概都支持」猜的——猜错就是整轮 400。
   */
  reasoningControl?: 'effort' | 'thinking-adaptive' | 'none'
}

/** 内置默认供应商的 baseURL：向量模型默认值只在它是当前供应商时才成立。 */
export const DEFAULT_PROVIDER_BASE_URL = 'https://api.siliconflow.cn/v1'

/**
 * SiliconFlow 推荐模型目录（2026-10 核对官方 API 文档的 model 枚举 + 更新公告）。
 *
 * 收录条件是「文档枚举里有、且历次更新公告没下线/迁移走」：文档枚举会滞后（已下线的
 * GLM-4.7、GLM-4.6 还挂在上面），而下线只写在公告里，两个条件缺一个就会把一个点不动
 * 的条目写进用户的下拉框——那种条目在界面上和活的模型长得一模一样，只有点了才知道。
 *
 * contextWindow 一律取**保守值**：写大了内核会按一个不存在的窗口留历史，最后由供应商
 * 400 告诉用户，而他已经白攒了几十轮上下文（见 {@link ProviderModelInput}）。凡官方只
 * 说「1M / 256K」而平台侧未公开确切窗口的，按整数向下取整（1M → 1_000_000、256K →
 * 262_144）；口径互相打架的取其中较小的一个。
 */
const SILICONFLOW_MODELS: OpenAiProviderConfig['models'] = [
  // DeepSeek V4 是当前一代（1M 上下文）。Flash 排在 Pro 前面不是随手排的：
  // resolveSidecarLlm 取「第一个已配凭据供应商的第一个模型」给记忆/进化管线当副驾，
  // 目录顺序就是那个选择。Flash 同代、更快更便宜，默认挡在前面对谁都更划算；
  // Pro 留在这里给愿意为旗舰推理多花钱的人手动挑。
  { id: 'deepseek-ai/DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_000_000 },
  { id: 'deepseek-ai/DeepSeek-V4-Pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000 },
  // V3.2 是上一代旗舰（官方 160K，保守取 128K），便宜，是长会话的性价比档。
  { id: 'deepseek-ai/DeepSeek-V3.2', name: 'DeepSeek-V3.2', contextWindow: 128_000 },
  // R1 是纯推理经典款；平台侧已把推理模型整体升到 128K。
  { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek-R1', contextWindow: 128_000 },
  // 智谱：GLM-5 已迁移到 5.1，这里只留 5.1 与便宜的 4.5-Air。
  { id: 'zai-org/GLM-5.1', name: 'GLM-5.1', contextWindow: 192_000 },
  { id: 'zai-org/GLM-4.5-Air', name: 'GLM-4.5-Air', contextWindow: 128_000 },
  // 通义：旗舰 / 主力 / 最新小 MoE / 代码 / 便宜档 / 最小档。
  { id: 'Qwen/Qwen3.5-397B-A17B', name: 'Qwen3.5-397B', contextWindow: 262_144 },
  { id: 'Qwen/Qwen3.5-122B-A10B', name: 'Qwen3.5-122B', contextWindow: 262_144 },
  { id: 'Qwen/Qwen3.6-35B-A3B', name: 'Qwen3.6-35B-A3B', contextWindow: 262_144 },
  { id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', name: 'Qwen3-Coder-480B', contextWindow: 262_144 },
  { id: 'Qwen/Qwen3-32B', name: 'Qwen3-32B', contextWindow: 32_768 },
  { id: 'Qwen/Qwen3-8B', name: 'Qwen3-8B', contextWindow: 32_768 },
  { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5-72B', contextWindow: 32_768 },
  // 长上下文与 Agent 场景的另一条线：Kimi 走 256K 长文档，MiniMax 主打 Agent 工具调用。
  { id: 'moonshotai/Kimi-K2.6', name: 'Kimi-K2.6', contextWindow: 262_144 },
  // MiniMax：官方 2026-10-13 公告，M2.5 / M2.7 全系 11-18 下线且按量用户**无自动
  // 路由**，只留 M2.5 会让老用户点下去直接报错。M3 是当前唯一「按量可调 + 1M」的档。
  { id: 'MiniMaxAI/MiniMax-M3', name: 'MiniMax-M3', contextWindow: 1_000_000 },
  // 开源推理的老牌大模型，给不接 DeepSeek/Qwen 体系的人一条路。
  { id: 'openai/gpt-oss-120b', name: 'gpt-oss-120b', contextWindow: 131_072 },
]

/** 内置默认供应商（SiliconFlow，key 经 SILICONFLOW_API_KEY 环境变量）。 */
export const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
  siliconflow: {
    baseURL: DEFAULT_PROVIDER_BASE_URL,
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    protocol: 'openai',
    displayName: 'SiliconFlow',
    models: SILICONFLOW_MODELS,
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
    // 与内置路由取同一份常量：两份手写的推荐列表迟早各说各话，而用户在向导里看到的
    // 就是它。
    models: SILICONFLOW_MODELS.map((model) => {
      return model.id
    }),
    // 列表第一档（DeepSeek-V4-Flash）本身就是给新用户的那档。
    defaultModel: 'deepseek-ai/DeepSeek-V4-Flash',
    docsUrl: 'https://docs.siliconflow.cn/cn/userguide/quickstart',
    // SiliconFlow 是聚合网关，其文档未承诺 reasoning_effort 的透传行为；不声明，
    // 用户不会看到一个可能静默失效的控件。
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    // deepseek-flash 即 DeepSeek-V4.1-Flash（2026-10 升级后模型名不变）；pro 是旗舰。
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    // flash 那一档：新用户默认它（旗舰 pro 留给要旗舰的人自己从下拉里选）。
    defaultModel: 'deepseek-flash',
    docsUrl: 'https://api-docs.deepseek.com/zh-cn/',
    // DeepSeek 官方文档明确 reasoning_effort（low/medium/high）作用于推理模型。
    reasoningControl: 'effort',
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot 月之暗面',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    // 收录依据：官方《模型列表》的在售表 + Chat Completions 的 model 枚举交叉核对，
    // 取两边都有的。
    // 原预设的 moonshot-v1-32k / 128k 看着还挂在《模型列表》的「生成模型 Moonshot V1」
    // 那张表里，但更新日志 2026-08 写明该系列（含 -vision-preview、moonshot-v1-auto）
    // 国内外全平台下线、调用返回 404、请迁 K3 —— 枚举滞后于下线公告，这种条目在下拉框里
    // 和活模型长得一模一样，只有点下去才知道，所以删掉。kimi-k2.5 在同一条公告里一起下线，
    // 尽管它还留在多模态表上。
    // 三个系列的思考参数互不相同：K3 恒开思考、用顶层 reasoning_effort（low/high/max，
    // 默认 max）且关不掉；K2.7 Code 思考恒开、传 disabled 报错；只有 K2.6 能用
    // thinking.type 在开/关之间切（默认 null 不保留历史 reasoning_content）。
    // 访问限制：K3 需先充值解锁（最低 10 元），新用户赠送的 15 元代金券不适用于 K3，
    // 用赠送额度建 Key 的用户点下去会拿到 404 / 无权限。
    // 向导里补 contextWindow 的口径：K3 官方标称「1M / 100 万 token」，保守取 1_000_000
    // （官方另称 max_completion_tokens 上限 1048576，两者打架取小的）；其余三款官方一致标称
    // 256K，即 262_144。
    // 海外站是 platform.kimi.ai / api.moonshot.ai，两站 Key 不可混用，跨站要改 baseUrl。
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'],
    // kimi-k3 要先充值解锁（赠送的代金券不适用），k2.7-code 恒开思考且不能关；
    // 给新用户默认 k2.6——它是这一族里唯一能用 thinking.type 在开/关之间切的。
    defaultModel: 'kimi-k2.6',
    docsUrl: 'https://platform.kimi.com/docs/models',
    // Kimi 官方文档：顶层 reasoning_effort + thinking.type 开关都认，关思考用 disabled。
    reasoningControl: 'thinking-adaptive',
  },
  {
    id: 'zhipu',
    displayName: '智谱 GLM',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    // 2026-10 核对官方「模型概览」的文本模型枚举 + 各模型页给的 Model Code。收录口径
    // 与 SILICONFLOW_MODELS 一致：枚举里有、且历次公告没下线。原来的 glm-4-flash /
    // glm-4-plus 在枚举里已经查无此名——4 系只剩带日期后缀的 glm-4-flash-250414，
    // 而 GLM-4.5 / GLM-4.5-X 的页面已写明「即将下线，建议选择 GLM-4.7」。这两个老 id
    // 留着不会有人报错提示，只会等用户在向导里选完、第一次发消息时才炸。
    //
    // contextWindow 按官方标称取保守值并注明口径：官方只写「1M / 200K」而没公布确切
    // token 上限，故向下取整记 1_000_000 / 200_000（preset 的 models 是 string[]，
    // 这里只能落在注释里；内核按这个数留历史，写大了是攒满几十轮才被服务端 400）。
    //   glm-5.3 / glm-5.3-flash / glm-5.3-flashx —— 1M，最大输出 128K
    //   glm-5.2                         —— 1M，最大输出 128K
    //   glm-4.7-flash                   —— 200K，最大输出 128K
    //
    // 选完模型就可能撞上的思考参数差异：GLM-5.3 系（5.3 / 5.3-flash / 5.3-flashx）
    // 只认 thinking.type=enabled，传 disabled 直接报错；思考程度改用
    // reasoning_effort（low / high / max，默认 max）。glm-5.2 是当前唯一还能传
    // thinking.type=disabled 的在售文本模型，reasoning_effort 另接受
    // xhigh / medium / minimal / none。思考内容不混在 content 里，而在
    // message.reasoning_content（流式则是 delta.reasoning_content）。
    //
    // 订阅 / 额度限制：glm-5.3-flashx 官方标注「套餐当前暂未开放」，只能按量付费，
    // 所以排在同代普通档之后；glm-4.7-flash 是当前唯一免费的文本模型，但限 1 并发。
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2', 'glm-4.7-flash'],
    // 同代的普通档（5.3-flash）：5.3 思考默认 max 太慢，5.3-flashx 官方标注套餐未开放，
    // 4.7-flash 是唯一免费的但限 1 并发。glm-5.2 还能关思考，留给想关的人自己选。
    defaultModel: 'glm-5.3-flash',
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/start/model-overview',
    // 智谱《深度思考》文档：GLM-5.x 的 thinking.type 只接受 enabled，档位走 reasoning_effort；
    // 只有 glm-5.2 还认 disabled，所以只发 reasoning_effort、不发 thinking 更安全。
    reasoningControl: 'effort',
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    protocol: 'openai',
    baseUrl: 'https://api.minimaxi.com/v1',
    // M3 是当前按量可调的旗舰（1M 上下文、原生多模态、思考可关）；M3.1-Flash-Preview
    // 是唯一支持 reasoning_effort 五档（low…max）的，但官方限定「仅 M Plan /
    // MiniMax Code 订阅 Key」，按量 Key 调它会失败——所以放在后面并在此注明。
    // M2.5 / M2.7 已公告 2026-11-18 下线，不再收录。
    models: ['MiniMax-M3', 'MiniMax-M3.1-Flash-Preview'],
    // M3 是按量可调的那档；M3.1-Flash-Preview 只认订阅 Key，按量 Key 调它会失败。
    defaultModel: 'MiniMax-M3',
    docsUrl: 'https://platform.minimaxi.com/document/Models',
    // MiniMax OpenAI 兼容文档：reasoning_effort（low/medium/high/xhigh/max，仅 M3.1 生效）
    // 与 thinking.type（adaptive/disabled）都认。M3.1 收到 disabled 会 400（官方码 2013），
    // 但那是该模型自身的行为，恒开思考也正是它的真实状态。
    reasoningControl: 'thinking-adaptive',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    // 2026-10 核对 /api/v1/models 的全量目录 + 三家的下线公告。OpenRouter 是聚合网关，
    // 它自己的目录里**一直**留着原厂早已关停的模型（gpt-4o-2024-05-13 就是现成的例子），
    // 而下线只写在公告里——只对目录会收进一堆点不动条目：
    // - Anthropic：claude-sonnet-4 已于 2026-06-15 停服（官方指定继任 claude-sonnet-5-5），
    //   目录里连这个 id 都不在了，选了必报错；同代的 sonnet-4.5 虽然还挂着，但官方
    //   2026-09-30 已宣布 deprecated、2026-11-30 退役，同样不收。
    // - OpenAI：gpt-4o-mini 于 2026-10-14 被官方列入 deprecated、2027-01-14 下线，公告
    //   指定的继任就是 gpt-6-luna——按公告换掉，别在预设里留一个已宣布倒数期的条目。
    // - Google：gemini-2.5-flash 在目录上带 expiration_date=2026-10-20，就在这两天；
    //   2.5 全系（flash / pro / flash-lite）同一批到期，官方继任 gemini-3.5-flash 或
    //   更新的 gemini-3.8-flash。
    //
    // 每家两档：主力 + 便宜快。Opus 5.5 与 GPT-6 Astra 同样在售、没进任何下线公告，
    // 但当默认太贵（$4/$20 与 $10/$50 每百万），只在此点名，需要旗舰的用户自己从
    // docsUrl 那个 /models 页挑。
    //
    // contextWindow 按 /api/v1/models 的 context_length 记（preset 的 models 是
    // string[]，只能落在注释里；内核按这个数留历史，写大了是攒满几十轮才被服务端 400）。
    // 这层网关公布的数字与三家官网标称的 1M 口径一致，没有第二个口径打架，故不取更小值；
    // GPT-6 的 1_050_000 看着像手误，但它是网关自己的窗口，别“顺手修正”成 1_000_000：
    //   claude-sonnet-5.5 / claude-haiku-5.5 —— 1_000_000
    //   gpt-6.1-sol / gpt-6-luna               —— 1_050_000
    //   gemini-4-argon / gemini-3.8-flash      —— 1_048_576
    models: [
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-haiku-5.5',
      'openai/gpt-6.1-sol',
      'openai/gpt-6-luna',
      'google/gemini-4-argon',
      'google/gemini-3.8-flash',
    ],
    // 便宜快的那一档（haiku）：默认给旗舰价（$4/$20 每百万）不是个好主意，
    // 用户刚配好 key 时跑的是自己付钱的每一轮。
    defaultModel: 'anthropic/claude-haiku-5.5',
    docsUrl: 'https://openrouter.ai/models',
    // OpenRouter 的 API 参考把 reasoning 列为统一参数并直通各上游。不声明等于
    // 让用户永远调不了思考深度，而它是 OpenRouter 最有用的统一能力之一。
    reasoningControl: 'effort',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    // 收录依据：官方 API 文档的模型目录（developers.openai.com/api/docs/models）里的
    // 「Model ID」枚举，交叉核对《Deprecations》的下线/迁移公告，两个条件都满足才收。
    // 原预设的 gpt-4o / gpt-4o-mini 已在 2026-10-14 公告下线（2027-01-14 停服，官方指定
    // 迁往 gpt-6-luna），整条换掉：文档枚举里它们照旧挂着，只看枚举会把一个点下去就
    // 报错的条目原样留给用户。同批下线的还有 gpt-4.1 / gpt-4.1-mini；gpt-5.1、
    // gpt-5.4-nano、gpt-5.3-codex 早于 2026-10-01 公告（2027-04-01 停服），均不收录。
    // 上下文长度口径：下面每一款官方模型页标的都是 1,050,000 token（不是「1.05M」的
    // 取整，官方标称与平台限制一致、不打架，无需向下取整），补录时按 1_050_000 记；
    // max output 是 128,000，长会话能给输入留的余量要从这个 1.05M 里扣。
    // 为什么主推 GPT-5.6 全系而不是 GPT-6：本项目的适配器只走 chat/completions（见
    // packages/llm/openai），而 GPT-6 在 Chat Completions 上都**不支持工具调用**——Astra
    // 与 GPT-6.1 Sol 明确「Chat Completions is supported without tool calling」，Luna 与
    // 上一代 GPT-6 Sol 要 `reasoning_effort: "none"` 才支持，而适配器不发这个参数、走模型
    // 默认的 medium。带工具的助理选 GPT-6 会在第一次工具调用上就报错，所以 GPT-5.6 全系
    // （模型页 Function calling: Supported，无附加条件）排在前面，GPT-6 只留纯对话可用的
    // 两条。旗舰 Astra 不收：纯对话场景选 GPT-6.1 Sol 就够，$10/$50 的价差没必要默认推荐。
    // reasoning_effort 合法档位（官方 reasoning 指南）：none / minimal / low / medium /
    // high / xhigh / max，实际可用值逐模型不同——GPT-5.6 全系与 GPT-6 Luna / GPT-6 Sol
    // 支持 none、low、medium（默认）、high、xhigh、max 六档（不含 minimal）；GPT-6.1 Sol
    // 与 Astra 不支持 none / minimal（给 Astra 传 none 直接返回 HTTP 400）。
    // 全部条目 Free 档不支持，需 Build 档及以上（文档未查到订阅制专属的模型）。
    //
    // 顺序即推荐序：GPT-5.6 全系排前面，因为它们在 Chat Completions 上能直接调工具；
    // GPT-6 两条排后面并**必须在界面上说明**——本项目适配器只发 model/messages/stream/
    // tools/temperature/max_tokens（见 packages/llm/openai/src/serialize.ts），走不到
    // Responses API，所以这两条只有纯对话可用。留在同一个下拉框里不加说明，用户按
    // 「最新最强」选下去，会在第一次工具调用上撞到 400。
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-luna', 'gpt-6.1-sol'],
    // GPT-5.6 全系在 Chat Completions 上能直接调工具（GPT-6 两条不支持工具调用），
    // 所以给新用户的默认档在 5.6 这一族里。
    defaultModel: 'gpt-5.6-sol',
    docsUrl: 'https://developers.openai.com/api/docs/models',
    // OpenAI reasoning 指南：reasoning_effort 是标准字段。注意 GPT-6.1 不接受 none/
    // minimal，所以目录里只给 low/medium/high 这三档。
    reasoningControl: 'effort',
  },
  {
    id: 'ollama',
    displayName: 'Ollama（本地）',
    protocol: 'ollama',
    // 走 Ollama 官方文档里的 OpenAI 兼容层（其 baseURL 就是 http://localhost:11434/v1），
    // 所以这条路由免 key：本地服务不校验 Authorization 头，见 KEYLESS_API_KEY_PLACEHOLDER。
    baseUrl: 'http://127.0.0.1:11434/v1',
    // 推荐清单（2026-10 核对 ollama.com/library 各 tag 页，tag 与 context 窗口都抄自官方
    // 页面，不凭记忆）。
    //
    // 为什么每一列都得先在官方模型库里查证：这是一份**写死**的推荐目录，而本地预设的特殊
    // 之处恰恰是「用户装了什么只有他本机知道」——目录天生反映不了现状。用户在这里选一个
    // 名字，下游就是拿它当 model id 建模；写错一个 id 的后果不是「目录不全」，而是点了
    // 直接报错。宁可少列。
    //
    // 收录口径：
    // - 只收**本地可拉取**的 tag。模型库里带 `cloud` 标记的一批（gemma4:cloud、
    //   gpt-oss:20b-cloud、glm-5.3 / kimi-k3 / deepseek-v4-pro / minimax-m3 等）要登录
    //   Ollama 账号按订阅计费，收进一个免 key 的本地路由里必然失败。
    // - 全部具备 tools 能力（这是 Agent 应用，模型得能调工具），并且特意留了纯思考档。
    // - 只收 20GB 以内的量化体积：本地预设面向消费级硬件，70B/671B 档不适合当默认推荐。
    // - qwen3.5 而不是更新的 qwen3.6：3.6 最小只到 27b（17GB 起），本地默认档给不出
    //   低门槛选项；而 3.5 有 0.8b–122b 全档，且 :latest 指向 :9b。
    //
    // contextWindow 保守口径：预设的 models 只是 string[]，不带窗口值（真正的窗口由向导
    // 写进 ProviderModelInput.contextWindow，内核按它留历史，填大了最后由本地服务 400）。
    // 官方 tag 页标称 → 保守取值：qwen3.5 全系 256K → 262_144；deepseek-r1 / gpt-oss /
    // llama3.2 均 128K → 131_072；gemma4 同一家族窗口不一致（e2b/e4b 只有 128K、12b 及
    // 以上才是 256K），所以按具体 tag 取而不是按家族取。
    //
    // 关于「自动列出用户本地已装模型」：`GET /api/tags` 正是为此存在（官方 api.md 的
    // List Local Models），返回 name / size / digest / modified_at，另有 details.context_length
    // 与 capabilities 数组，可据此滤掉 embedding 类模型并判断是否支持 tools / thinking。
    // 同一份数据还有个更省事的 OpenAI 兼容口 `/v1/models`，但它只给 id + created +
    // owned_by，拿不到窗口与能力。哪天把这条目录换成实时查询，上面这份「写死的推荐」就该
    // 退化成兜底默认值而不是唯一的真相。
    models: ['qwen3.5:4b', 'qwen3.5:9b', 'gemma4:12b', 'deepseek-r1:8b', 'gpt-oss:20b', 'llama3.2:3b'],
    // 指向模型库而不是 API 文档页：本地预设没有 key 可申请，用户点过去是为了找能
    // `ollama pull` 的模型名。
    docsUrl: 'https://ollama.com/library',
    // Ollama 的思考支持逐模型不同（/api/tags 的 capabilities 里有 thinking 标记），
    // 且没有统一参数名——不声明，由用户按模型自行决定。
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
  return `RYHARNESS_API_KEY_${routeId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
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
const API_KEYS_SCHEMA = 'ryharness/api-keys@2'

/**
 * 改名之前的标记字段：老安装的 api-keys.json 里写的是它。
 *
 * 必须一起认：只认新标记的话，老文件会被当成 v1（扁平明文）读，用户填过的 API key
 * 就"全没了"——而它们明明就在文件里，只是标记对不上。写出去的一直是新标记，
 * 老文件下次被改写时就升级了。
 */
const LEGACY_API_KEYS_SCHEMA = 'ryagent/api-keys@2'

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

/** v2 信封的形状守卫（新旧两种标记都认，见 {@link LEGACY_API_KEYS_SCHEMA}）。 */
function isEnvelope(record: Record<string, unknown>): boolean {
  const schema = record.$schema
  const known = schema === API_KEYS_SCHEMA || schema === LEGACY_API_KEYS_SCHEMA
  return known && typeof record.keys === 'object' && record.keys !== null
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
      return `@ryharness/server: 没有可用的系统密钥库（Electron safeStorage），${path} 里的 API key 只能以明文保存（0600，仅开发环境可用）`
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
      `@ryharness/server: ${path} 里 ${unreadable.length} 个已存 API key（${unreadable.join('、')}）当前解不开：` +
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
        `@ryharness/server: safeStorage 不可用，API key 以明文写入 ${path}（0600，仅开发环境）` +
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

/**
 * 读取 providers.json；不存在则写入默认配置后返回。
 *
 * 内置路由（`siliconflow`）的**模型目录**每次启动都刷成当前随包发出的那份，
 * 凭据与地址原样保留。理由与内置 agent 的种子是同一条：这份目录是我们发的默认
 * 值，不是用户填的，升级就该跟着升级。此前不刷的直接后果是老安装的目录停在
 * 早期那三五个模型上，于是「改助理用的模型」这件事在界面上是坏的——存量模型名
 * 不在目录里，保存被校验挡下，而用户看到的下拉框里根本没有自己一直在用的那个。
 *
 * 自定义路由（带 `custom`）一律不碰：那份列表是用户自己勾的。
 */
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
    throw new Error(`@ryharness/server: invalid providers config at ${path}`)
  }
  const config = parsed as ProvidersConfigFile
  const builtin = config.providers.siliconflow
  if (builtin !== undefined && builtin.custom !== true && !sameModelCatalog(builtin.models)) {
    config.providers.siliconflow = { ...builtin, models: SILICONFLOW_MODELS }
    // 顺手落盘：升级是一次性的，落完这一次之后每次启动都走「已经是最新的」这条
    // 短路。留到下一次写入才落的话，用户打开 providers.json 看到的仍是老目录，
    // 而界面里的下拉框已经是新的——同一份事实两个样子。
    writePrivateJson(path, config)
  }
  return config
}

/** 内置目录是否已是随包发出的那份（逐条比 id、顺序与上下文长度）。 */
function sameModelCatalog(models: OpenAiProviderConfig['models']): boolean {
  if (models.length !== SILICONFLOW_MODELS.length) return false
  return models.every((model, index) => {
    const shipped = SILICONFLOW_MODELS[index]
    return (
      shipped !== undefined &&
      model.id === shipped.id &&
      model.name === shipped.name &&
      model.contextWindow === shipped.contextWindow
    )
  })
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
 * - v2（当前）：`{ "$schema": "ryharness/api-keys@2", "cipher": …, "keys": { … } }`，
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
 *
 * 注意这里**只做内存里的合并**，不动 apiKeyEnv：落盘的 providers.json 一律不写明文
 * key，而那个 apiKeyEnv 引用正是开发时用环境变量覆盖的逃生口，早先落种时就写上了。
 * 合并之后一条路由可能同时带两个凭据来源——那是本函数该容忍的状态，
 * 「恰好一个」由 {@link toAdapterConfig} 归一，因为校验发生在适配器构造那一刻。
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
 * 把一条路由收敛到「恰好一个凭据来源」。
 *
 * 两条并存时选谁：环境变量**真的设了值**就选它（开发逃生口优先），否则选设置里存的
 * 明文 key——那才是用户在界面上真正配过的东西。只带一条的照原样返回。
 */
function normalizeCredential(provider: ProviderConfig, env: (name: string) => string | undefined): ProviderConfig {
  if (provider.apiKeyEnv === undefined || provider.apiKey === undefined) return provider
  const fromEnv = env(provider.apiKeyEnv)
  if (fromEnv !== undefined && fromEnv.length > 0) {
    const { apiKey: _key, ...rest } = provider
    return { ...rest, apiKeyEnv: provider.apiKeyEnv }
  }
  const { apiKeyEnv: _env, ...rest } = provider
  return { ...rest, apiKey: provider.apiKey }
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
export function toAdapterConfig(
  config: ProvidersConfigFile,
  env: (name: string) => string | undefined = (name) => {
    return process.env[name]
  },
): OpenAiAdapterConfig {
  const providers: Record<string, OpenAiProviderConfig> = {}
  for (const [routeId, raw] of Object.entries(config.providers)) {
    // 归一：适配器校验的是「恰好一个凭据来源」，而合并进内存的设置里 key 之后，
    // 一条路由完全可能同时带 apiKey 与 apiKeyEnv（内置条目首启落种时就带后者）。
    // 不在这里归一，适配器构造会直接抛，整台服务起不来——真机上表现为用户保存过
    // key 之后应用弹一个「启动失败」。环境变量真的设了值时它优先。
    const provider = normalizeCredential(raw, env)
    if (hasUsableCredential(provider, env)) {
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
