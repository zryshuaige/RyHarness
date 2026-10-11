/**
 * RyAgent 长期记忆系统（mem0 式异步抽取 + 混合检索）。
 *
 * 调研落地组合（docs/research/agent-memory-self-evolution-survey.md §3）的记忆闭环：
 * - 写入：每轮对话后异步抽取（LLM 抽事实 → top-10 相似 → ADD/UPDATE/DELETE/NOOP，
 *   UPDATE/DELETE 走 superseded 软删链保历史）；单 writer 队列，失败重试一次。
 * - 检索：embedding 余弦 top-10 + FTS5 BM25 top-10 → RRF(k=60) → 时间衰减
 *   exp(-Δdays/30) → top-5 注入；共享画像（'*shared*' 的 profile 类）全量注入。
 * - 降级：无 embedding key 时自动纯 FTS5（代码路径都在）。
 * @module @ryagent/memory
 */

export { MemoryService } from './service.ts'
export type { AgentMemory, MemoryServiceOptions } from './service.ts'
export { MemoryStore } from './store.ts'
export type { MemoryRow, InsertMemoryInput } from './store.ts'
export { migrateMemory, MEMORY_SCHEMA_VERSION, SHARED_SPACE } from './schema.ts'
export type { MemoryKind, MemoryStatus } from './schema.ts'
export {
  SiliconFlowEmbeddings,
  HashEmbeddings,
  NullEmbeddings,
  DEFAULT_EMBEDDING_MODEL,
  cosine,
} from './embeddings.ts'
export type { EmbeddingProvider } from './embeddings.ts'
export { ChatMemoryLlm } from './llm.ts'
export type { MemoryLlm, CandidateFact, MemoryOperation } from './llm.ts'
