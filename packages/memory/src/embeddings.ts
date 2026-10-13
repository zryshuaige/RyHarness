/**
 * Embedding 提供商：SiliconFlow（OpenAI 兼容 /v1/embeddings）、
 * 确定性本地哈希向量（测试）、null（无 key 时纯 FTS5 降级）。
 * @module @ryagent/memory/embeddings
 */

/** 统一接口：批量嵌入；不可用时 embed 返回 null（走纯 FTS5 路径）。 */
export interface EmbeddingProvider {
  readonly label: string
  readonly available: boolean
  embed(texts: readonly string[]): Promise<Float32Array[] | null>
}

/** SiliconFlow /v1/embeddings（实测 Qwen/Qwen3-Embedding-0.6B 为 1024 维）。 */
export class SiliconFlowEmbeddings implements EmbeddingProvider {
  readonly available: boolean

  constructor(
    private readonly config: {
      apiKey: string
      baseURL?: string
      model?: string
      fetchImpl?: typeof fetch
    },
  ) {
    this.available = config.apiKey.length > 0
  }

  get label(): string {
    return `siliconflow:${this.config.model ?? DEFAULT_EMBEDDING_MODEL}`
  }

  async embed(texts: readonly string[]): Promise<Float32Array[] | null> {
    if (!this.available || texts.length === 0) return null
    const fetchImpl = this.config.fetchImpl ?? fetch
    const base = (this.config.baseURL ?? 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
    const response = await fetchImpl(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ model: this.config.model ?? DEFAULT_EMBEDDING_MODEL, input: [...texts] }),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { data?: { embedding: number[] }[] }
    if (body.data === undefined || body.data.length !== texts.length) return null
    return body.data.map((entry) => {
      return Float32Array.from(entry.embedding)
    })
  }
}

export const DEFAULT_EMBEDDING_MODEL = 'Qwen/Qwen3-Embedding-0.6B'

/**
 * 确定性伪向量（测试/离线降级演示）：同一文本永远得到同一单位向量，
 * 相似文本共享前缀方向——足够驱动管线测试，不接网络。
 */
export class HashEmbeddings implements EmbeddingProvider {
  readonly available = true
  readonly label = 'hash:test'
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
  async embed(): Promise<null> {
    return null
  }
}

/** 余弦相似度。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number)
  return dot
}
