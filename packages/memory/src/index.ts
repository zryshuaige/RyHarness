/**
 * RyAgent 长期记忆系统（mem0 式异步抽取 + 混合检索）。
 *
 * 调研落地组合（docs/research/agent-memory-self-evolution-survey.md §3）的记忆闭环：
 * - 写入：每轮对话后异步抽取（LLM 抽事实 → top-10 相似 → ADD/UPDATE/DELETE/NOOP，
 *   UPDATE/DELETE 走 superseded 软删链保历史）；单 writer 队列，失败重试一次；
 *   NOOP 由相似度阈值兜底（<0.7 强制 ADD，>0.85 才允许 NOOP）。
 * - 检索：embedding 余弦 top-10 + FTS5 BM25 top-10 → RRF(k=60) → 访问基准
 *   衰减 exp(-Δdays/30)×(1+ln(1+命中次数)) → top-5 注入；共享画像
 *   （'*shared*' 的 profile 类）全量注入。
 * - 向量溯源：embedding 缓存按 (hash, model) 分桶，检索按模型与维度过滤，
 *   换模型不混库。
 * - 降级：无 embedding 凭据时自动纯 FTS5（代码路径都在）。
 * @module @ryagent/memory
 */

export type { EmbeddingProvider } from './embeddings.ts'
export {
  cosine,
  DEFAULT_EMBEDDING_MODEL,
  embeddingModelOf,
  HashEmbeddings,
  NullEmbeddings,
  OpenAiCompatibleEmbeddings,
  SiliconFlowEmbeddings,
  textSimilarity,
} from './embeddings.ts'
export type { CandidateFact, MemoryLlm, MemoryOperation } from './llm.ts'
export { ChatMemoryLlm, MEMORY_LLM_CODES } from './llm.ts'
export type { MemoryKind, MemoryStatus } from './schema.ts'
export { MEMORY_SCHEMA_VERSION, MIGRATIONS, migrateMemory, SHARED_SPACE } from './schema.ts'
export type { AgentMemory, MemoryServiceOptions } from './service.ts'
export { MemoryService } from './service.ts'
export type { InsertMemoryInput, MemoryRow } from './store.ts'
export { bigrams, MemoryStore, textHash } from './store.ts'
