/**
 * 文本相关性：归一化 bigram Jaccard。
 *
 * 进化子系统用它做两件事：教训注入时挑相关项、归因计数时判断"这条经验与本轮
 * 有关吗"。不引外部依赖，也不需要向量——桌面规模的 playbook（几十条）用词面
 * 重叠足够，且完全确定性。
 * @module @ryharness/evolve/relevance
 */

/** 归一化：去空白/标点/符号并小写。 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/** bigram 集合（单字文本退化为自身）。 */
export function bigramSet(text: string): Set<string> {
  const compact = normalizeText(text)
  const grams = new Set<string>()
  if (compact.length === 0) return grams
  if (compact.length === 1) {
    grams.add(compact)
    return grams
  }
  for (let i = 0; i < compact.length - 1; i++) grams.add(compact.slice(i, i + 2))
  return grams
}

/** 两段文本的 bigram Jaccard 相似度（0~1；无有效字符时为 0）。 */
export function textSimilarity(a: string, b: string): number {
  return jaccard(bigramSet(a), bigramSet(b))
}

/**
 * 重叠系数（交集 / 较短一方的大小）。相关性判定用它而不是 Jaccard：中文里
 * 「翻译前先确认目标语言」对「帮我翻译这段话」的 Jaccard 只有 0.07（长句稀释），
 * 而重叠系数 0.17 才是"确实在讲同一件事"的直观刻度。
 */
export function textOverlap(a: string, b: string): number {
  const left = bigramSet(a)
  const right = bigramSet(b)
  if (left.size === 0 || right.size === 0) return 0
  return intersection(left, right) / Math.min(left.size, right.size)
}

/** 两组文本与查询的最大重叠系数（多段上下文取最大，适配工具名/用户输入拼接）。 */
export function maxOverlap(query: string, candidates: readonly string[]): number {
  let best = 0
  for (const candidate of candidates) {
    const score = textOverlap(query, candidate)
    if (score > best) best = score
  }
  return best
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  return intersection(left, right) / (left.size + right.size - intersection(left, right))
}

function intersection(left: Set<string>, right: Set<string>): number {
  // 用较小的一方遍历，避免长文本的无效扫描。
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  let shared = 0
  for (const gram of small) {
    if (large.has(gram)) shared++
  }
  return shared
}
