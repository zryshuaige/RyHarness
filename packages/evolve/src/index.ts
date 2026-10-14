/**
 * RyAgent 自我进化（ACE 式 playbook + Reflexion 反思 + 反馈闭环 + 巩固调度）。
 *
 * 闭环图（详见包 README）：
 * 每轮对话后（异步） → Reflector 归因计数（注入条目 helpful/harmful，
 * harmful≥3 自动 deprecate）→ 失败触发 Reflexion 写教训 → 教训注入后验证
 * 成功 hitCount+1（≥2 转正合并进 playbook 并清理）→ Curator 产出增量
 * delta（add/update/deprecate，绝不整段重写）。
 * 组装 prompt 前 compile() 注入 [经验手册] + [上次教训]；
 * 👎 即时反思 + 归因 harmful；👍 归因 helpful；runOnce() 巩固（到期清理/
 * 重复记忆合并/dormant 统计）。
 * @module @ryagent/evolve
 */

export type { CuratorEntryView, EvolveLlm, PlaybookDelta, TurnTrajectory } from './llm.ts'
export { ChatEvolveLlm, CURATOR_ENTRY_LIMIT, EVOLVE_LLM_CODES, NEGATIVE_FEEDBACK_RE } from './llm.ts'
export type { EvolutionRoundMetrics, EvolveMetricsSnapshot, RoundKind, RoundTotals } from './metrics.ts'
export { RoundRecorder } from './metrics.ts'
export { maxOverlap, normalizeText, textOverlap, textSimilarity } from './relevance.ts'
export type { EntryOriginKind, EntryStatus, PlaybookSection, ReflectionStatus } from './schema.ts'
export { AUTO_DEPRECATE_HARMFUL, CONVERT_HIT_THRESHOLD, EVOLVE_SCHEMA_VERSION, migrateEvolve } from './schema.ts'
export { SEED_PLAYBOOKS, seedIfEmpty } from './seeds.ts'
export type {
  AgentEvolutionHooks,
  CompiledEvolution,
  ConsolidationResult,
  EntryExplanation,
  EvolutionTurn,
  EvolveLimits,
  EvolveServiceOptions,
  MemorySweep,
} from './service.ts'
export { DEFAULT_EVOLVE_LIMITS, EvolveService } from './service.ts'
export type { EntryOrigin, EntryOriginInput, PlaybookEntry, ReflectionRow } from './store.ts'
export { EvolveStore, NEAR_DUPLICATE_THRESHOLD, REFLECTION_RELEVANCE_THRESHOLD } from './store.ts'
