/**
 * Embedding 提供商：OpenAI 兼容 /v1/embeddings（SiliconFlow / OpenAI /
 * 任何自建网关）、确定性本地哈希向量（测试）、null（无凭据时纯 FTS5 降级）。
 *
 * 向量必须带模型溯源：同一段文本在不同模型下是不同向量，混库后维度不符会
 * 让余弦静默塌成 -1（检索质量无声下降）。`model` 是向量身份的一部分，
 * 存储层按 (hash, model) 缓存并在检索时按模型过滤。
 * @module @ryagent/memory/embeddings
 */

/** 统一接口：批量嵌入；不可用时 embed 返回 null（走纯 FTS5 路径）。 */
export interface EmbeddingProvider {
  /** 展示用标签（"siliconflow:Qwen3-Embedding" / "hash:test"）。 */
  readonly label: string
  /** 向量模型标识：向量身份的 key，必须随向量一起存储。缺省回落到 label。 */
  readonly model?: string
  readonly available: boolean
  embed(texts: readonly string[]): Promise<Float32Array[] | null>
}

/** 提供商的向量身份（model 优先，其次 label）。 */
export function embeddingModelOf(provider: EmbeddingProvider): string {
  return provider.model ?? provider.label
}

/** 默认 embedding 模型 id（仅在调用方未指定时作为提示，不静默替代配置）。 */
export const DEFAULT_EMBEDDING_MODEL = 'Qwen/Qwen3-Embedding-0.6B'

/**
 * 任意 OpenAI 兼容端点的 /v1/embeddings。baseURL 与 model 必须显式给出：
 * 这里不做任何供应商默认值，避免"配置了别的供应商却仍在打 SiliconFlow"。
 */
export class OpenAiCompatibleEmbeddings implements EmbeddingProvider {
  readonly available: boolean
  readonly model: string

  constructor(
    private readonly config: {
      apiKey: string
      baseURL: string
      model: string
      fetchImpl?: typeof fetch
    },
  ) {
    this.available = config.apiKey.length > 0
    this.model = config.model
  }

  get label(): string {
    return this.model
  }

  async embed(texts: readonly string[]): Promise<Float32Array[] | null> {
    if (!this.available || texts.length === 0) return null
    const fetchImpl = this.config.fetchImpl ?? fetch
    const base = this.config.baseURL.replace(/\/+$/, '')
    try {
      const response = await fetchImpl(`${base}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ model: this.config.model, input: [...texts] }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) return null
      const body = (await response.json()) as { data?: { embedding: number[] }[] }
      if (body.data === undefined || body.data.length !== texts.length) return null
      return body.data.map((entry) => {
        return Float32Array.from(entry.embedding)
      })
    } catch {
      // 网络/解析故障降级为 null（调用方回落纯 FTS5），不把异常抛进召回热路径。
      return null
    }
  }
}

/**
 * @deprecated 保留旧名（首版只支持 SiliconFlow）；新代码用 {@link OpenAiCompatibleEmbeddings}，
 * 并显式给出 baseURL/model。
 */
export class SiliconFlowEmbeddings extends OpenAiCompatibleEmbeddings {
  constructor(config: { apiKey: string; baseURL?: string; model?: string; fetchImpl?: typeof fetch }) {
    super({
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? 'https://api.siliconflow.cn/v1',
      model: config.model ?? DEFAULT_EMBEDDING_MODEL,
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    })
  }
}

/**
 * 确定性伪向量（测试/离线降级演示）：同一文本永远得到同一单位向量，
 * 相似文本共享前缀方向——足够驱动管线测试，不接网络。
 */
export class HashEmbeddings implements EmbeddingProvider {
  readonly available = true
  readonly label = 'hash:test'
  readonly model = 'hash:test'
  readonly dim: number

  constructor(dim = 16) {
    this.dim = dim
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      return this.vectorOf(text)
    })
  }

  vectorOf(text: string): Float32Array {
    const vector = new Float32Array(this.dim)
    let seed = 2166136261
    for (let i = 0; i < text.length; i++) seed = Math.imul(seed ^ text.charCodeAt(i), 16777619) >>> 0
    for (let i = 0; i < this.dim; i++) {
      seed = Math.imul(seed ^ (seed >>> 13), 0x5bd1e995) >>> 0
      vector[i] = (seed % 2000) / 1000 - 1
    }
    const norm = Math.hypot(...vector) || 1
    for (let i = 0; i < this.dim; i++) vector[i] = vector[i] / norm
    return vector
  }
}

/** 无 embedding：检索退化为纯 FTS5。 */
export class NullEmbeddings implements EmbeddingProvider {
  readonly available = false
  readonly label = 'none:fts-only'
  readonly model = 'none'
  async embed(): Promise<null> {
    return null
  }
}

/** 余弦相似度；维度不符返回 -1（调用方必须先做维度校验，不得据此排序）。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number)
  return dot
}

/** 文本相似度：归一化（去空白/标点/大小写）后的 bigram Jaccard。 */
export function textSimilarity(a: string, b: string): number {
  const left = bigramSet(a)
  const right = bigramSet(b)
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const gram of left) {
    if (right.has(gram)) intersection++
  }
  return intersection / (left.size + right.size - intersection)
}

/**
 * 文本近重复（无 embedding 时的去重底座）：同一事实换个说法，不是"更完整"。
 *
 * 判据两条——bigram Jaccard 高，或短句的 bigram 基本被长句覆盖且长度接近
 * （"用户养了只橘猫叫布丁" vs "用户养了一只橘猫叫布丁"）。两条附加约束都是
 * 为了放过细化式改写（"用户喜欢川菜" vs "用户喜欢川菜和湘菜"、"用户住在北京"
 * vs "用户住在北京市朝阳区"）：那类该走 UPDATE，丢掉就是漏记。
 */
export function textNearDuplicate(a: string, b: string): boolean {
  const left = bigramSet(a)
  const right = bigramSet(b)
  if (left.size === 0 || right.size === 0) return false
  let intersection = 0
  for (const gram of left) {
    if (right.has(gram)) intersection++
  }
  if (intersection / (left.size + right.size - intersection) >= 0.7) return true
  const shorter = Math.min(left.size, right.size)
  const longer = Math.max(left.size, right.size)
  return intersection / shorter >= 0.85 && shorter / longer >= 0.65
}

function bigramSet(text: string): Set<string> {
  const compact = text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
  const grams = new Set<string>()
  if (compact.length === 0) return grams
  if (compact.length === 1) {
    grams.add(compact)
    return grams
  }
  for (let i = 0; i < compact.length - 1; i++) grams.add(compact.slice(i, i + 2))
  return grams
}
