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

- `memories(id, agent_id, kind, content, embedding BLOB 可空, dim, created_at, updated_at, last_accessed_at, access_count, source_conversation_id, status, supersedes_id)`——`agent_id='*shared*'` 为共享画像；`status: active|superseded|deleted|inactive`；软删链用 `supersedes_id` 串联（Zep 思路）。
- `memories_fts`：FTS5 虚表，**中文 bigram 分词**（unicode61 不切 CJK，整句一个 token 会失效；索引与查询都变换为相邻二字一 token，OR 语义 + BM25）。查询串逐 token 加引号转义（`:`/`"`/`OR` 等 ASCII 元字符会让 MATCH 直接抛错，整条记忆静默失效）。
- `embedding_cache(hash=sha256(text), vector, dim)`：相同文本不重复请求。

索引与主表同步：软删与归档都删索引行，`restore` 先删后插重建（rowid 唯一）。索引里不留死行——否则 BM25 候选窗口（limit×3）被非 active 行吃光，召回质量随时间单调退化。

## 检索配方参数

| 参数 | 值 |
|---|---|
| 语义通道 | 余弦 top-10（向量常驻内存，按空间+模型分桶缓存） |
| 词法通道 | FTS5 BM25 top-10 |
| 融合 | RRF，k=60 |
| 时间衰减 | `score *= exp(-Δdays/30)` |
| 注入 | top-5 + 共享画像全量，格式 `[记忆] 用户画像：… / 相关记忆：…` |
| 命中反馈 | access_count+1、last_accessed_at=now |
| 单通道超时 | 召回 800ms / 向量重建 30s（后台分片，默认 64 条一批） |

## 降级策略

- **有 SILICONFLOW_API_KEY**：`SiliconFlowEmbeddings`（默认 `Qwen/Qwen3-Embedding-0.6B`，实测 1024 维）+ `ChatMemoryLlm` 抽取，全管线。
- **无 key**：`NullEmbeddings` + 无 LLM → 纯 FTS5 检索（写入管线关闭，记忆可手工/API 种入），代码路径都在；此时写入前补一次**文本近重复判定**，否则同一事实换个说法会无限堆积。
- **网络失败**：embed 返回 null → 该次召回走纯 FTS5；抽取失败重试一次后记日志。
- **通道异常**：BM25 通道单独 try/catch，坏掉只丢它自己，共享画像照常注入。
- embedding 不可用的记忆行（手写/API 种入）自动跳过语义通道，仅参与 BM25。

## 扇出与出包

- **一次召回、多成员共享**：`recallMany(agentIds, inputText)` 把同一段输入的
  查询向量、共享画像、共享空间的语义打分与 BM25 候选窗口各算一次，各成员只补
  自己的私有空间（@ryagent/group 的扇出走这条路径；没有实现它时退化为逐成员
  并发 recall）。embedding 请求还有一层**在途合并**：同一段文本的并发请求共享
  一个 promise，落库缓存只能挡跨轮重复，挡不住同轮扇出（那时谁都还没写回）。
- **向量不出包**：`MemoryRow.embedding` 是 Float32Array，直接序列化就是一坨
  `{"0":…}` 下标对象（一页列表可到数 MB）。凡是接口回包都先过
  `toPublicMemory / toPublicMemories`，只给 id/agentId/kind/content/时间戳/
  访问数/来源会话。

## 接入点

- `AgentLoop`：`memory` 选项——组装前 recall、finally 中 enqueue（群聊中每个发言 agent 走自己的空间 + 共享画像）。
- `SessionCoordinator`：`memory` 选项透传并绑定 conversationId。
- `@ryagent/server`：默认按环境构建（有 key 全管线/无 key 纯 FTS），`GET /api/agents/:id/memories`（**回包要过 `toPublicMemories`**）、`DELETE /api/memories/:id`（软删）、`GET /api/memory/stats`。

## 测试

`tests/`：四操作、UPDATE 软删链、RRF 语义压过 BM25 / 纯 FTS 降序、时间衰减、注入格式、缓存去重、空间隔离、扇出共享召回（`recallMany` 与逐成员 recall 内容一致、在途合并只发一次请求、共享画像访问计数按一次输入记）、归档分片、对外投影（响应体不含 embedding）、闭环集成（一轮写入二轮召回）、AgentLoop 钩子（注入/finally 入队/故障降级）、server 端点。
