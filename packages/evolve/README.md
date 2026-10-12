# @ryagent/evolve

自我进化系统：ACE 式 playbook + Reflexion 反思 + 用户反馈闭环 + 巩固调度（调研落地组合的自我进化部分，见 `docs/research/agent-memory-self-evolution-survey.md` §2.2/§2.3/§2.5）。

## 闭环图

```
每轮对话
  │
  ├─ 组装 prompt 前（同步，故障静默降级）
  │   compile(agentId) →
  │     [经验手册] 策略/坑/偏好/工具用法：active 条目按 helpful-harmful
  │                排序 top-12，按 section 分组
  │     [上次教训] 最近 1–3 条 pending 反思
  │   返回注入的 entryIds/reflectionIds（归因种子）
  │
  └─ 每轮结束后（异步单 writer，失败重试一次）
      enqueueTurn(轨迹 = user/assistant 文本 + 工具成败 + llmError + 注入归因)
        │
        ├─ Reflector（确定性，不烧 LLM）
        │   本轮注入的 playbook 条目：成功 helpful+1 / 失败 harmful+1
        │   harmful ≥ 3 自动 deprecate（软删，可恢复）
        │
        ├─ 教训验证
        │   注入的教训本轮成功（无工具错、无负反馈）→ hitCount+1
        │   hitCount ≥ 2 → 转正：合并为 playbook pitfall 条目（source=reflection）
        │                    并标记 converted（从待验证清理）——"验证 ≥2 次转正"
        │
        ├─ Reflexion（失败触发：工具连错≥2 / LLM error / 用户负反馈词表）
        │   LLM 读失败轨迹写一条可操作教训（"下次应该…因为…"式）→ reflections(pending)
        │
        └─ Curator（LLM，增量 delta——绝不整段重写，避免 brevity bias/context collapse）
            add（同 section 完全去重）/ update / deprecate 条目

用户反馈（UI 气泡 hover 👍/👎 → POST /api/feedback）
  👎 → 即时反思入库 + 归因条目 harmful+1（可触发自动 deprecate）
  👍 → 归因条目 helpful+1
  归因 = 该 agent 在该会话最近一次注入的条目集合（串行队列近似）

巩固（runOnce()：手动 /api/evolve/consolidate 或周期调度默认 6h，幂等）
  1. 到期清理：>30 天未转正 reflections → expired
  2. 重复记忆合并：同空间 embedding 余弦 >0.95 → supersede 旧条目
  3. dormant 统计：90 天零访问记忆记日志
```

## 表结构（evolve_meta 自管版本轴，只追加规则）

- `playbook_entries(id, agent_id, section: strategy|pitfall|preference|tooling, content, helpful, harmful, status: active|deprecated, created_at, updated_at, source: curator|reflection|seed|manual)`——deprecated 软删可恢复。
- `reflections(id, agent_id, lesson, context_digest, source_conversation_id, hit_count, status: pending|converted|expired, created_at, updated_at)`。
- `feedback_events(id, agent_id, conversation_id, turn_index, signal: thumb_up|thumb_down, created_at)`。

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
| 周期/手动 | 6h interval 或 /api/evolve/consolidate | 到期清理 + 判重合并 + dormant 统计 |

## 接入点

- `AgentLoop`：`evolution` 选项——组装前 compile、finally 入队（失败轮无文本也入队）。
- `SessionCoordinator`/`GroupDispatcher`：透传并绑定 conversationId。
- `@ryagent/server`：`POST /api/feedback`、`GET /api/agents/:id/playbook`、
  `POST /api/playbook/:id/status`（手动 deprecate/恢复）、`POST /api/evolve/consolidate`；
  按环境构建（有 key 全管线/无 key 仅确定性计数）；周期调度可关（`consolidationIntervalMs: 0`）。

## 测试

`tests/`：注入编译格式与排序、helpful/harmful 累加、自动 deprecate、三类反思触发、
hitCount 转正闭环、Curator 三操作与去重、👎/👍 反馈链路、种子幂等、runOnce 幂等、
"失败→反思→注入→成功→转正"端到端；`packages/agent/tests/evolution-hooks.test.ts`
覆盖运行时接线（注入/finally 入队/llmError 轨迹/故障降级）。
