# @ryagent/evolve

自我进化系统：ACE 式 playbook + Reflexion 反思 + 用户反馈闭环 + 巩固调度（调研落地组合的自我进化部分，见 `docs/research/agent-memory-self-evolution-survey.md` §2.2/§2.3/§2.5）。

## 闭环图

```
每轮对话
  │
  ├─ 组装 prompt 前（同步，故障静默降级）
  │   compile(agentId) →
  │     [经验手册] 策略/坑/偏好/工具用法：active 条目按 helpful-harmful
  │                全局排序取候选池 top-12，按 section 分组
  │     [上次教训] 与本轮输入相关的 pending 教训（最多 3 条）
  │   返回注入的 entryIds/reflectionIds（归因种子）
  │
  └─ 每轮结束后（异步单 writer，确定性计数只跑一次；LLM 阶段超时 + 阶段隔离）
      enqueueTurn(轨迹 = user/assistant 文本 + 工具成败 + llmError + 注入归因)
        │
        ├─ Reflector（确定性，不烧 LLM）
        │   本轮注入的 playbook 条目：成功 helpful+1 / 失败 harmful+1
        │   harmful ≥ 3 自动 deprecate（软删，可恢复）
        │
        ├─ 教训验证
        │   注入的教训本轮成功（无工具错、无负反馈）→ hitCount+1
        │   hitCount ≥ 2 → 转正：合并为 playbook pitfall 条目（source=reflection，
        │                    过完全/近似去重）并标记 converted（从待验证清理）
        │
        ├─ Reflexion（失败触发：工具连错≥2 / LLM error / 用户负反馈词表）
        │   LLM 读失败轨迹写一条可操作教训（"下次应该…因为…"式）→ reflections(pending)
        │
        └─ Curator（LLM，增量 delta——绝不整段重写，避免 brevity bias/context collapse）
            add（同 section 完全/近似去重）/ update / deprecate 条目

用户反馈（UI 气泡 hover 👍/👎 → POST /api/feedback）
  👎 → 即时反思入库 + 归因条目 harmful+1（可触发自动 deprecate）
  👍 → 归因条目 helpful+1
  归因 = 该 agent 在该会话最近一次注入的条目集合（串行队列近似）
  反馈同时进证据链（entry_origins kind=feedback）

巩固（runOnce()：手动 /api/evolve/consolidate 或周期调度默认 6h，幂等）
  1. 到期清理：>30 天未转正 reflections → expired（一条 UPDATE，同步做完）
  2. 重复记忆合并：同空间 embedding 余弦 >0.95 → supersede 旧条目
  3. 溯源关联：条目与词面重合的记忆关联进 entry_origins（kind=memory）
  4. dormant 统计 + 记忆归档（90 天零访问 / 180 天软删链）
  2–4 按切片推进（见「不阻塞主循环」），单空间失败只跳过该空间
```

## 不阻塞主循环（分片 / 超时 / 失败隔离）

本包跑在服务进程的事件循环里，任何「一次性跑很久」的同步段都会把整个
server（HTTP + WS + 在途对话）一起冻住。三处重活都有边界：

| 重活 | 边界 | 触发配置 |
|---|---|---|
| 每轮进化管线 | `turnTimeoutMs`（默认 60s）超时即放弃该轮；Reflexion 与 Curator 阶段各自 try/catch，一个挂不带走另一个 | `limits.turnTimeoutMs` |
| 待处理轮次队列 | `maxQueuedTurns`（默认 64）上限，溢出丢最旧的一轮并计入 `metrics().droppedTurns` | `limits.maxQueuedTurns` |
| 巩固（O(n²) 判重/溯源/归档） | `runOnce()` 同步只做一片（`consolidationSliceMs` ≤12ms 或 `consolidationSliceUnits` ≤2000 次比较），剩余切片 `setImmediate` 让出事件循环后台续跑，整轮受 `consolidationBudgetMs`（默认 30s）约束，超时丢弃剩余工作下一轮重来 | `limits.consolidation*` |

要点：

- **确定性计数不重试**。旧实现整轮重试一次，Reflector 的 ±1 会被记两遍，auto-deprecate
  建在重复的 harmful 上。现在归因计数只跑一次，只有 LLM 阶段有失败隔离。
- **`runOnce()` 仍是同步的**（server 直接 JSON 回去，签名与前 5 个字段不变），
  但返回值是**第一片**的快照；整轮跑完后的完整口径用 `runUntilIdle()`（await）
  或 `lastConsolidationResult()` 取。新增字段 `scannedMemories / linkedOrigins /
  errors / durationMs / pending / truncated`。
- **超时不等于取消**：LLM 请求本身无法中断，超时只是不再阻塞管线（迟到的
  promise 挂 catch，不会变成 unhandledRejection）。

## 证据链（可解释性）

`EvolveService.explain(entryId)` 返回 `{ entry, origins, summary }`，回答
「这条经验从哪几条记忆 / 哪次反馈 / 哪条教训来」：

| kind | refId 指向 | 何时写入 |
|---|---|---|
| `trajectory` | 会话 id + 入队时刻 | Curator add/update/deprecate、教训转正 |
| `reflection` | `reflections.id` | 教训验证通过转正进手册 |
| `feedback` | `feedback_events.id` | 👍/👎 命中该条目 |
| `memory` | `memories.id` | 巩固期按词面重叠（`memoryOriginMinOverlap`，默认 0.3）关联 |
| `seed` | 模板 key | 冷启动播种 |

`(entry_id, kind, ref_id)` 唯一 → 重复触发（每 6 小时的巩固、反复点反馈）只是幂等 no-op。

## 耗时埋点

不引外部依赖、不落盘。每轮进化 / 反馈 / 巩固记一条
`{ kind, startedAt, durationMs, processed, ok, error? }`：

- 构造参数 `onRound(round)` 实时回调；
- `metrics(limit?)` 取快照：`rounds`（环形缓冲，默认最近 100 轮）、`totals`、
  `byKind`（turn/feedback/consolidate）、`droppedTurns`。

`durationMs` 对巩固记的是**真正占住事件循环的时间**（切片耗时之和，不含让出），
服务端要看的是「进化/巩固把主进程卡了多久」。历史趋势由调用方聚合落盘。

## 表结构（evolve_meta 自管版本轴，只追加规则）

- `playbook_entries(id, agent_id, section: strategy|pitfall|preference|tooling, content, helpful, harmful, status: active|deprecated, created_at, updated_at, source: curator|reflection|seed|manual)`——deprecated 软删可恢复。
- `reflections(id, agent_id, lesson, context_digest, source_conversation_id, hit_count, status: pending|converted|expired, created_at, updated_at)`。
- `feedback_events(id, agent_id, conversation_id, turn_index, signal: thumb_up|thumb_down, created_at)`。
- `entry_origins(id, entry_id, kind: trajectory|reflection|feedback|memory|seed, ref_id, detail, created_at, UNIQUE(entry_id, kind, ref_id))`——证据链，见上。

## 冷启动种子

`SEED_PLAYBOOKS`：5 个内置模板各 2–3 条（Coding Agent："改代码前先读完整文件"等）。
`seedIfEmpty(store, agentId, templateKey)` 幂等播种；server 启动时为 Ryen 播通用模板，
新建 agent 可按模板播种。

## 触发条件清单（调研 §3.5 汇总）

| 触发器 | 条件 | 动作 |
|---|---|---|
| 每轮后 | 无条件（异步） | Reflector 计数 + Curator delta |
| 失败信号 | 工具连错≥2 / LLM error / 负反馈词表 | Reflexion 写教训 |
| 教训验证 | 注入后本轮成功 | hitCount+1；≥2 转正进 playbook 并清理 |
| 显式反馈 | 👎 | 即时反思 + 归因 harmful |
| 显式反馈 | 👍 | 归因 helpful |
| harmful 阈值 | 条目 harmful ≥ 3 | 自动 deprecate |
| 周期/手动 | 6h interval 或 /api/evolve/consolidate | 到期清理 + 判重合并 + 溯源关联 + 记忆归档 |

## 接入点

- `AgentLoop`：`evolution` 选项——组装前 compile、finally 入队（失败轮无文本也入队）。
- `SessionCoordinator`/`GroupDispatcher`：透传并绑定 conversationId。
- `@ryagent/server`：`POST /api/feedback`、`GET /api/agents/:id/playbook`、
  `POST /api/playbook/:id/status`（手动 deprecate/恢复）、`POST /api/evolve/consolidate`；
  按环境构建（有 key 全管线/无 key 仅确定性计数）；周期调度可关（`consolidationIntervalMs: 0`）。
  服务端侧可接的三个新读口：`explain(entryId)`、`metrics()`、
  `runUntilIdle()`/`lastConsolidationResult()`（整轮巩固口径）。

## 测试

`tests/evolve.test.ts`：注入编译格式与排序、helpful/harmful 累加、自动 deprecate、
三类反思触发、hitCount 转正闭环、Curator 三操作与去重、👎/👍 反馈链路、种子幂等、
runOnce 幂等、"失败→反思→注入→成功→转正"端到端。
`tests/consolidation.test.ts`：分片不冻结主循环（巩固期间事件循环仍在跑）、
预算截断、单空间失败隔离、耗时埋点。
`tests/provenance.test.ts`：教训/对话/反馈/种子/记忆五类溯源与 explain()。
`tests/pipeline.test.ts`：LLM 超时与阶段隔离、过载丢弃、埋点，
以及「进化真的改变后续行为」（候选池排序 → 注入 → 转正 → 去重 → 退出注入）。
`packages/agent/tests/evolution-hooks.test.ts` 覆盖运行时接线（注入/finally 入队/
llmError 轨迹/故障降级）。
