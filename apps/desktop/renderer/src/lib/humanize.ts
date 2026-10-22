/**
 * 面向用户的人话层（唯一真源）：模型标识、错误预览、额度表述。
 *
 * 服务端下发的 provider id、model id、token 计数都是**开发者单位**，
 * 直接上屏就是评审指出的「siliconflow / deepseek-ai/DeepSeek-V3」「累计 12840 tokens」
 * 这类用户读不懂、也不该被要求读懂的东西。集中在这里转换，界面各处引用同一份口径。
 */
import { explainTurnError } from './turn-errors.ts'

/** 已知供应商的品牌写法；未知的原样保留（不猜、不隐藏信息）。 */
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  siliconflow: 'SiliconFlow',
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  moonshot: 'Moonshot',
  zhipu: '智谱',
  bailian: '百炼',
  ollama: 'Ollama',
}

/** 供应商展示名。 */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider.toLowerCase()] ?? provider
}

/**
 * 接入协议的展示名。协议名是配置层的标识，不是用户要读的答案：
 * 「openai」在这里的意思是「按 OpenAI 那套接口说话」，不是让用户去查文档。
 */
const PROTOCOL_LABELS: Readonly<Record<string, string>> = {
  openai: 'OpenAI 兼容',
  ollama: '本地 Ollama',
  anthropic: 'Anthropic 协议',
}

/** 协议展示名；将来新增的协议没登记时按「自定义协议」说，不把标识原样上屏。 */
export function protocolLabel(protocol: string): string {
  return PROTOCOL_LABELS[protocol.toLowerCase()] ?? '自定义协议'
}

/**
 * 「模型 · 供应商」，去掉厂商路径前缀：`deepseek-ai/DeepSeek-V3` → `DeepSeek-V3`。
 * 前缀对用户没有信息量，反而让一行标签长到要被截断。
 */
export function modelPair(provider: string, model: string): string {
  const leaf = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  const label = providerLabel(provider)
  return label.length === 0 ? leaf : `${leaf} · ${label}`
}

/**
 * 会话预览里的一条文本。
 *
 * 内核把失败写成 `[error:CODE] 原文` 落库（`coordinator.ts` 的 error 分支），
 * 而会话列表的预览直接取自这条消息——不转换的话，列表里会挂着
 * 「[error:NO_ADAPTER] no adapter registered for provider "mock"」这类
 * 开发期字符串（评审在 review3/05-group-chat 截图里抓到的就是它）。
 *
 * 前缀是纯文字而不是符号：预览是纯文本一行，插不进图标组件，而渲染层的 chrome
 * 已经统一不许出现 emoji（tests/icon-a11y.test.tsx 钉住），所以失败态靠「无法完成」
 * 这四个字本身说出来。
 */
export function humanPreview(text: string): string {
  const match = /^\[error:([A-Z_]+)\]\s*([\s\S]*)$/.exec(text.trim())
  if (match === null) return text
  const explanation = explainTurnError(match[1], match[2] ?? '')
  return `无法完成 · ${explanation.title}`
}

/**
 * 用量表述：token 是开发者单位，用户语言是「字」。
 * 口径与「本会话已用」一行保持一处真源，别处不要再各写一套。
 */
export function humanTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens} 字`
  if (tokens < 10000) return `约 ${(tokens / 1000).toFixed(1)} 千字`
  return `约 ${(tokens / 10000).toFixed(1)} 万字`
}

/**
 * 耗时表述：毫秒是给排障用的，用户只需要知道「快不快」。
 * 一秒以下保留两位（0.04 秒），一秒以上只留一位（约 1.8 秒）——再精确也没有意义。
 */
export function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 秒'
  if (ms < 1000) return `${(ms / 1000).toFixed(2)} 秒`
  if (ms < 60_000) {
    const seconds = (ms / 1000).toFixed(1)
    return `约 ${seconds.endsWith('.0') ? String(Math.round(ms / 1000)) : seconds} 秒`
  }
  return `约 ${Math.round(ms / 60_000)} 分钟`
}

/**
 * 文件类型的展示名。
 *
 * MIME 是给程序分派的，用户看到 `application/vnd.openxmlformats-officedocument.…`
 * 只会得到一屏乱码。这里只回答「这是什么文件」；认不出就老实说「文件」，原始 MIME
 * 留在调用点的 title 上，需要排障的人仍然拿得到。
 */
const MIME_LABELS: readonly (readonly [RegExp, string])[] = [
  [/^image\//, '图片'],
  [/^audio\//, '音频'],
  [/^video\//, '视频'],
  [/pdf/, 'PDF'],
  // 表格/演示文稿要排在 Word 前面：它们的 MIME 里也含 `officedocument` 这个词，
  // 先匹配 Word 会把 xlsx / pptx 全说成「Word 文档」。
  [/presentation|powerpoint/, '演示文稿'],
  [/sheet|excel|csv|spreadsheet/, '表格'],
  [/wordprocessingml|msword|opendocument\.text/, 'Word 文档'],
  [/zip|rar|7z|tar|gzip/, '压缩包'],
  [/^text\/|json|xml|javascript/, '文本'],
]

export function humanMime(mime: string): string {
  const lower = mime.toLowerCase()
  for (const [pattern, label] of MIME_LABELS) {
    if (pattern.test(lower)) return label
  }
  return '文件'
}

/**
 * 隐私口径的唯一真源。
 *
 * 旧文案写着「只写在这台电脑上，不上传到任何服务器」——推理时上下文必然发往用户
 * 选择的模型供应商，这句话把「本地存储」偷换成了「本地推理」，是不准确的承诺。
 * 这里分成两件事说清：存哪里，以及什么会离开这台机器。
 */
export const LOCAL_DATA_NOTE =
  '对话与记忆存储在本机；推理时会把当前上下文发送给你选择的模型供应商。Key 只保存在本机，并作为凭据发送给该供应商。'
