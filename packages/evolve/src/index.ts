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

export { EvolveService } from './service.ts'
export type {
  AgentEvolutionHooks,
  CompiledEvolution,
  EvolutionTurn,
  EvolveServiceOptions,
  MemorySweep,
} from './service.ts'
export { EvolveStore } from './store.ts'
export type { PlaybookEntry, ReflectionRow } from './store.ts'
export { migrateEvolve, EVOLVE_SCHEMA_VERSION, AUTO_DEPRECATE_HARMFUL, CONVERT_HIT_THRESHOLD } from './schema.ts'
export type { PlaybookSection, EntryStatus, ReflectionStatus } from './schema.ts'
export { ChatEvolveLlm, NEGATIVE_FEEDBACK_RE } from './llm.ts'
export type { EvolveLlm, TurnTrajectory, PlaybookDelta } from './llm.ts'
export { SEED_PLAYBOOKS, seedIfEmpty } from './seeds.ts'
