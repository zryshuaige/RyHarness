# @ryagent/memory

长期记忆系统：mem0 式异步抽取管线 + 混合检索（调研落地组合的记忆闭环，见 `docs/research/agent-memory-self-evolution-survey.md` §3；自我进化部分见 `@ryagent/evolve`）。

## 管线图

```
每轮对话
  │
  ├─ 组装 prompt 前（同步，故障静默降级）          ┐
  │   recall(agentId, input)                      │ 读
  │     ├─ 共享画像：'*shared*' 的 profile 全量注入  │ 路
  │     └─ 混合召回：embedding 余弦 top-10          │ 径
  │                  + FTS5 BM25 top-10（中文 bigram）
  │                  → RRF(k=60) 融合              │
  │                  → 时间衰减 exp(-Δdays/30)      │
  │                  → top-5 → "[记忆] 用户画像/相关记忆"
  │                                                │
  └─ 每轮结束后（异步，绝不阻塞回复）                ┐
      enqueueExtraction → 单 writer 队列           │ 写
        1. LLM 抽候选事实（scope 路由：             │ 路
           用户事实 → '*shared*'；互动经验 → agent 空间）│ 径
        2. 每条候选查 top-10 相似记忆               │
        3. LLM 四操作：ADD / UPDATE / DELETE / NOOP │
        4. UPDATE/DELETE → superseded 软删保历史    │
      失败重试一次，再败记日志不炸主流程             │
```

## 表结构（与 session 共用 ryagent.db，本包自管 memory_meta 版本轴）

- `memories(id, agent_id, kind, content, embedding BLOB 可空, dim, created_at, updated_at, last_accessed_at, access_count, source_conversation_id, status, supersedes_id)`——`agent_id='*shared*'` 为共享画像；`status: active|superseded|deleted`；软删链用 `supersedes_id` 串联（Zep 思路）。
- `memories_fts`：FTS5 虚表，**中文 bigram 分词**（unicode61 不切 CJK，整句一个 token 会失效；索引与查询都变换为相邻二字一 token，OR 语义 + BM25）。
- `embedding_cache(hash=sha256(text), vector, dim)`：相同文本不重复请求。

## 检索配方参数

| 参数 | 值 |
|---|---|
| 语义通道 | 余弦 top-10（内存暴力，单用户 <10k 规模足够） |
| 词法通道 | FTS5 BM25 top-10 |
| 融合 | RRF，k=60 |
| 时间衰减 | `score *= exp(-Δdays/30)` |
| 注入 | top-5 + 共享画像全量，格式 `[记忆] 用户画像：… / 相关记忆：…` |
| 命中反馈 | access_count+1、last_accessed_at=now |

## 降级策略

- **有 SILICONFLOW_API_KEY**：`SiliconFlowEmbeddings`（默认 `Qwen/Qwen3-Embedding-0.6B`，实测 1024 维）+ `ChatMemoryLlm` 抽取，全管线。
- **无 key**：`NullEmbeddings` + 无 LLM → 纯 FTS5 检索（写入管线关闭，记忆可手工/API 种入），代码路径都在。
- **网络失败**：embed 返回 null → 该次召回走纯 FTS5；抽取失败重试一次后记日志。
- embedding 不可用的记忆行（手写/API 种入）自动跳过语义通道，仅参与 BM25。

## 接入点

- `AgentLoop`：`memory` 选项——组装前 recall、finally 中 enqueue（群聊中每个发言 agent 走自己的空间 + 共享画像）。
- `SessionCoordinator`：`memory` 选项透传并绑定 conversationId。
- `@ryagent/server`：默认按环境构建（有 key 全管线/无 key 纯 FTS），`GET /api/agents/:id/memories`、`DELETE /api/memories/:id`（软删）、`GET /api/memory/stats`。

## 测试

`tests/`：四操作、UPDATE 软删链、RRF 语义压过 BM25 / 纯 FTS 降序、时间衰减、注入格式、缓存去重、空间隔离、闭环集成（一轮写入二轮召回）、AgentLoop 钩子（注入/finally 入队/故障降级）、server 端点。
