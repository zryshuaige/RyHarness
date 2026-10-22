/**
 * RyHarness 长期记忆系统（mem0 式异步抽取 + 混合检索）。
 *
 * 调研落地组合（docs/research/agent-memory-self-evolution-survey.md §3）的记忆闭环：
 * - 写入：每轮对话后异步抽取（LLM 抽事实 → top-10 相似 → ADD/UPDATE/DELETE/NOOP，
 *   UPDATE/DELETE 走 superseded 软删链保历史）；单 writer 队列，失败重试一次；
 *   NOOP 由相似度阈值兜底（<0.7 强制 ADD，>0.85 才允许 NOOP）。
 * - 检索：embedding 余弦 + FTS5 BM25 → RRF(k=60) → 访问基准
 *   衰减 exp(-Δdays/30)×recallGain（1+ln(1+命中次数)±用户反馈） → top-5 注入；
 *   共享画像（'*shared*' 的 profile 类）全量注入。
 * - 词法通道：FTS5 查询串逐 token 转义（`:`/`"`/`OR` 等元字符会让 MATCH 直接
 *   抛错，整条长期记忆静默失效）；BM25 通道异常单独降级，不牵连画像注入。
 * - 归档质量：归档同步清出 FTS 行（恢复时重建），召回质量不随时间单调退化。
 * - 纯 FTS5 安装：写路径补文本近重复判定，不靠 embedding 的判重也不丢。
 * - 延迟：active 向量常驻缓存，recall 不再每轮全表读 BLOB。
 * - 首 token：注入块同步组装（recallSync）+ 后台补正（recallRefine），
 *   embedding 的网络往返不再排在第一次 llm.stream 之前。
 * - 语义回灌：recallRefine 拿到向量后顺手算出本轮语义通道 top-3（按 agent 空间
 *   隔离），下一轮的 recallSync 当第三条通道并进 RRF。只落 embedding 缓存的话，
 *   缓存键是查询文本原样——真人对话里同一句输入不会被说第二遍，语义通道会等于没有。
 * - 向量溯源：embedding 缓存按 (hash, model) 分桶，检索按模型与维度过滤，
 *   换模型不混库。
 * - 出包投影：接口回包只给业务字段，向量（Float32Array）留在包内
 *   （toPublicMemory），否则一条 1024 维记忆会序列化成几千个「下标→数值」。
 * - 扇出召回：同一段输入的并发召回共享一次 embedding 请求与共享空间扫描
 *   （recallMany），N 个成员不再发 N 次网络往返。
 * - 反向信号：👍/👎 回灌到该空间最近一轮注入的记忆（recordFeedback），并从
 *   召回增益里扣回（recallGain）。没有它时召回是单向棘轮——错误记忆越注入越牢固。
 * - 降级：无 embedding 凭据时自动纯 FTS5（代码路径都在）。
 *
 * 口径提醒：所谓「mem0 式」指**抽取管线的形状**（异步 LLM 抽候选 → 查相似 →
 * 判定操作），不是 mem0 的操作集。mem0 v3 已收敛为 single-pass ADD-only（删掉了
 * UPDATE/DELETE），而这里是 ADD/UPDATE/DELETE/NOOP 四操作 + 软删链，见 README。
 * @module @ryharness/memory
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
  textNearDuplicate,
  textSimilarity,
} from './embeddings.ts'
export type { CandidateFact, MemoryLlm, MemoryOperation } from './llm.ts'
export { ChatMemoryLlm, MEMORY_LLM_CODES } from './llm.ts'
export type { PublicMemoryRow } from './project.ts'
export { toPublicMemories, toPublicMemory } from './project.ts'
export type { MemoryKind, MemoryStatus } from './schema.ts'
export { MEMORY_SCHEMA_VERSION, MIGRATIONS, migrateMemory, SHARED_SPACE } from './schema.ts'
export type { AgentMemory, MemoryRecallMany, MemoryServiceOptions } from './service.ts'
export { MemoryService, recallGain } from './service.ts'
export type { InsertMemoryInput, MemoryRow } from './store.ts'
export { bigrams, ftsMatchQuery, MemoryStore, textHash } from './store.ts'
