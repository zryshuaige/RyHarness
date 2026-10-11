# 前沿实现调研：AI Agent 的「个人长期记忆」与「自我进化」机制（2024–2026）

> 调研日期：2026-10-11。目标读者：RyAgent 桌面应用（TypeScript + SQLite，单用户，多 agent 社交场景）的实现者。
> 每一项给出：核心机制 / 关键数据结构 / 最小工程落地建议（可直接编码）/ 出处。
> 全文结论均来自真实文献与官方仓库（见各节「出处」），非凭印象。

---

## 0. 执行摘要

- 长期记忆 2024–2026 收敛为三条互补路线：**OS 式分层记忆**（MemGPT/Letta，LLM 用函数调用自主翻页）、**抽取式事实记忆**（mem0，LLM 每轮异步抽取原子事实 + ADD/UPDATE/DELETE/NOOP 冲突解决）、**时序知识图谱**（Zep/Graphiti，边带 `valid_at`/`invalid_at` 双时态）。A-MEM 证明「Zettelkasten 式原子笔记 + 自动链接 + 记忆演化」在多跳推理上可达 2 倍提升、token 降 85–93%。
- 工程甜点：**事实记忆（mem0 管线）做主存储，时序字段（Zep 风格）做冲突解决，分层（Letta 风格）做工作区，混合检索（embedding + BM25 + RRF）做召回**。
- 自我进化四条路线：**技能库**（Voyager，可执行代码 + 验证后入库 + 嵌入检索）、**语言强化学习**（Reflexion，失败轨迹 → 语言反思 → 情节记忆回放）、**上下文剧本演化**（ACE，Generator/Reflector/Curator 三角色 + 增量 delta 更新，比 GEPA 低 82–91% 延迟）、**反思式 prompt 进化**（GEPA/DSPy，Pareto 前沿 + 文本反馈变异，比 RL 省 35× rollout）。
- 单用户桌面应用的最优组合：每轮对话后**异步抽取管线**（mem0 式）+ 每 N 轮/每晚**巩固任务**（衰减合并 + 反思沉淀 + 剧本 delta 更新）+ 用户显式反馈时触发**修正→固化**闭环。

---

## 1. 长期记忆（Long-Term Memory）

### 1.1 MemGPT / Letta：分层记忆与记忆工具化

**核心机制**
MemGPT（UC Berkeley，ICML 2024，现生产化为 Letta，Apache 2.0）把 OS 虚拟内存概念搬到 LLM：上下文窗口是「RAM」，外部存储是「磁盘」，LLM 通过**函数调用**自主在三层之间翻页。三层为：**Core Memory**（始终驻留上下文的小容量工作区，存 persona、关键状态）、**Recall Memory**（完整可搜索的对话历史，类比磁盘）、**Archival Memory**（大规模向量存储，如 PostgreSQL + pgvector）。其本质是「memory tool 化」：给 agent 一组 `core_memory_append/replace`、`archival_memory_insert/search`、`conversation_search` 等工具，由 LLM 自己决定存什么、取什么、删什么，从而在有界上下文内模拟无界记忆。2025 年后 Letta 增加 **sleep-time compute**（对话空闲时后台跑「睡眠 agent」做记忆压缩/整合，把记忆管理与活跃对话解耦）与基于 Git 的记忆版本控制。来源：[MemGPT 论文 arXiv:2310.08560](https://arxiv.org/abs/2310.08560)、[Letta 架构综述（Zylos）](https://zylos.ai/research/2026-04-05-ai-agent-memory-architectures-persistent-knowledge/)、[Letta sleep-time 与 Git 版本控制（腾讯云社区）](https://cloud.tencent.com/developer/article/2664973)。

**关键数据结构**

- `CoreMemoryBlock { name: "persona"|"human"|"task", value: string, limit: number /* 如 5000 chars/块 */ }` — 固定上限，超限由 LLM 调用 `core_memory_replace` 腾挪。
- `Passage { id, agent_id, text, embedding: float[], created_at, source: "conversation"|"manual", }` — archival 存储单元。
- 工具集（即 function schemas）：`archival_memory_insert(text)`, `archival_memory_search(query, page)`, `conversation_search(query, page)`, `core_memory_append(key, value)`, `core_memory_replace(key, old, new)`。
- Letta 服务端：agents 表 + blocks 表 + passages 表（PG + pgvector）。

**TS + SQLite 最小实现建议**

- 表：`blocks(agent_id, name, value, char_limit)`、`passages(id, agent_id, text, created_at, source)`、`messages(...)`（recall 层直接复用消息表，FTS5 检索）。
- 向量化不要上 pgvector：SQLite 单用户规模（<10 万条）下**暴力余弦 + 一个 embedding 列（BLOB）**即可，或装 `sqlite-vec` 扩展；真不够用再上 `usearch`/`hnswlib` Node 绑定。
- 工具化：把 5 个 memory 工具注册进 agent 的 tool-calling schema，system prompt 中写明各层用途与容量限制（这是 MemGPT 的关键——分层由 prompt 约定 + 硬上限共同保证）。
- 简化：桌面单 agent 会话可把「sleep-time compute」实现为**每轮结束后异步任务队列**（见 §3），不单独起后台进程。

**出处**
- [MemGPT: Towards LLMs as Operating Systems, arXiv:2310.08560](https://arxiv.org/abs/2310.08560)
- [Letta（原 MemGPT）架构与生产细节](https://zylos.ai/research/2026-04-05-ai-agent-memory-architectures-persistent-knowledge/)
- [ForgetEval 对 Letta 的评测（agent-scoped 架构描述）](https://arxiv.org/html/2606.15903v2)

### 1.2 mem0：记忆抽取管线（事实抽取 → 冲突解决 → 向量存储）

**核心机制**
mem0 是一套「记忆中间件」：不做全量历史存储，而是**每轮对话增量地走两段管线**。（1）**抽取阶段**：输入 = 全局对话摘要 `S` + 最近 `m` 条消息（论文 `m=10`）+ 新消息对 `(m_{t-1}, m_t)`，一个 LLM 调用（GPT-4o-mini 级）抽出候选原子事实集合 `Ω = {ω₁…ωₙ}`；摘要有独立的异步刷新模块周期更新，不阻塞主链路。（2）**更新阶段**：对每个候选事实，先用向量库取 top-s（论文 `s=10`）语义最相似的已有记忆，连同候选事实一起交给 LLM 的 function-calling 接口，由 LLM 在四种操作中选择：**ADD**（无相似记忆则新增）、**UPDATE**（信息互补则合并）、**DELETE**（新事实与旧记忆矛盾则删除/替换，如用户搬家了）、**NOOP**（无需变更）。这套「检索相似 → LLM 判操作」的机制天然实现了冲突解决与时序一致性。效果：LOCOMO 基准上比 OpenAI 记忆高 26%（LLM-as-Judge），p95 延迟比全上下文低 91%、token 省 90%+。来源：[mem0 论文 arXiv:2504.19413](https://arxiv.org/html/2504.19413v1)。

**关键数据结构**

- `Memory { id, user_id, agent_id?, text /* 原子事实，自然语言一句 */, embedding, created_at, updated_at, metadata }`
- 抽取 prompt 的形状：`P = (S, {m_{t-m}…m_{t-2}}, m_{t-1}, m_t) → φ(P) = Ω`
- 更新阶段的 tool schema（四选一）：
  ```json
  { "type": "function", "function": {
      "name": "manage_memory",
      "parameters": { "oneOf": [
        {"properties": {"action": {"const": "ADD"}, "text": {"type": "string"}}},
        {"properties": {"action": {"const": "UPDATE"}, "memory_id": {"type": "string"}, "new_text": {"type": "string"}}},
        {"properties": {"action": {"const": "DELETE"}, "memory_id": {"type": "string"}}},
        {"properties": {"action": {"const": "NOOP"}}}
      ]}}}
  ```
- 另有异步组件：`conversation_summary { conversation_id, text, updated_at }`。

**TS + SQLite 最小实现建议**

- 表：`memories(id TEXT PK, agent_id, user_id, text, embedding BLOB /* Float32Array */, created_at, updated_at, access_count, last_accessed_at)`、`conversation_summaries(conversation_id, text, updated_at)`。
- 每轮对话落库后立即 `setImmediate`/`queueMicrotask` 异步触发管线，不阻塞回复；摘要每 10–20 轮或会话结束时用一次 LLM 调用刷新。
- 抽取用**结构化输出（JSON schema / tool calling）**而非自由文本解析。
- 冲突解决批处理：一条候选事实一次工具调用；候选多时合并成单次调用带 `operations[]` 数组以省 token。
- 可选改进（来自社区 issue）：mem0 开源版 ADD-only 时不处理「语义相似但矛盾」的事实，落地时把 `s` 提高到 10–15 并强制走四操作判断即可覆盖。

**出处**
- [Mem0 论文 arXiv:2504.19413（抽取/更新两阶段、四操作、m=10/s=10 超参、LOCOMO 结果）](https://arxiv.org/html/2504.19413v1)
- [mem0 管线生产解读（llms.blog 2026-08）](https://www.llms.blog/posts/agent-memory-frameworks-in-production-comparing-mem0-zep-letta-and-langgraph-store-architecture-fact-extraction-pipelines-episodic-graphs-and-long-term-retrieval-economics)
- [mem0 ADD-only 冲突解决缺陷 issue #4896](https://github.com/mem0ai/mem0/issues/4896)

### 1.3 Zep：时序知识图谱（Graphiti）

**核心机制**
Zep（底层引擎 Graphiti，Apache 2.0，~29k stars）把记忆建成**带有效期的时序知识图谱**。原始输入单元是 **Episode**（message / text / JSON 三类）；图谱分三层：**episodic 节点**（原始消息）、**semantic 实体与事实**（LLM 从 episode 抽取实体节点 + `(subject, predicate, object)` 事实边）、**community 摘要**（对图谱做社区发现/标签传播的聚类级抽象）。核心创新是**双时态（bi-temporal）**：每条事实边携带 `valid_at`（何时为真）与 `invalid_at`（何时被取代）——新信息取代旧事实时不删除旧边，而是把旧边「作废」并挂新边，因此可以回答「当时什么是真的」。检索是三类组合：语义（embedding 相似）、BM25、图遍历（社区 + 广度/深度），再经重排。DMR 基准 94.8%，时序/多跳查询最强。图数据库可用 Neo4j 或 FalkorDB。来源：[Zep 论文 arXiv:2501.13956](https://arxiv.org/html/2501.13956v1)、[Graphiti vs Zep 对比（Anchor Terminal）](https://www.anchorterminal.com/compare/graphiti-vs-zep)。

**关键数据结构**

- `Episode { uuid, source: "message"|"text"|"json", content, source_description, created_at, actor_id }`
- `EntityNode { uuid, name, labels: string[], created_at, summary? }`
- `EntityEdge { uuid, source_node_uuid, target_node_uuid, name /* 关系谓词 */, fact /* 自然语言陈述 */, episodes: string[], created_at, valid_at, invalid_at /* 可空 */, expired_at }`
- 检索 API：`search(query_text, node_ids?, center_node_uuid?, max_depth?, num_results=10)`。

**TS + SQLite 最小实现建议**

- 单用户桌面规模**不需要图数据库**：三张表 + 递归 CTE 即可。
  ```sql
  CREATE TABLE episodes(id TEXT PK, agent_id, source, content, actor_id, created_at);
  CREATE TABLE nodes(id TEXT PK, name, labels_json, summary, created_at);
  CREATE TABLE edges(id TEXT PK, src_id, dst_id, predicate, fact,
                     valid_at, invalid_at, created_at,
                     src_embedding BLOB, dst_embedding BLOB, fact_embedding BLOB);
  ```
- 冲突解决：抽出新事实 `(s,r,o)` 时，用嵌入找相似边，`invalid_at = now()` 标记旧边失效（Zep 式软删除），再插新边——与 mem0 的 DELETE 语义等价但保留历史。
- 多跳检索：先向量命中锚点节点，再用 `WITH RECURSIVE` 按 `invalid_at IS NULL` 过滤做 1–2 跳展开（对应 Graphiti 的 center-node search）。
- 成本注意：每条 episode 抽取实体+事实要 1–2 次 LLM 调用，写入比纯向量库贵；可只对「值得长期记」的消息对开图谱管线，闲聊走 mem0 式事实管线（混合架构，见 §3）。

**出处**
- [Zep 论文 arXiv:2501.13956（Episode 三层、bi-temporal 边）](https://arxiv.org/html/2501.13956v1)
- [Graphiti 开源引擎（Apache-2.0，13-tool MCP server）](https://www.anchorterminal.com/compare/graphiti-vs-zep)
- [DMR 94.8% 等基准数字（hermes-agent-evolution issue #1465 汇总）](https://github.com/Lexus2016/hermes-agent-evolution/issues/1465)

### 1.4 A-MEM：Zettelkasten 式记忆链接与记忆演化

**核心机制**
A-MEM（Rutgers，arXiv 2502.12110，被引 1300+）把知识管理领域的 **Zettelkasten（卡片盒）方法**搬进 agent 记忆：每条记忆是一条**原子笔记**，由 LLM 生成丰富属性——`keywords`（关键概念，≥3 个）、`tags`（分类标签，≥3 个，含 domain/format/type 维度）、`context`（LLM 生成的上下文描述，一段话讲清「这条记忆在说什么」）。新笔记入库时：① embed 笔记全文；② 向量召回 top-k 近邻；③ LLM 判断新笔记与每个近邻是否建立**链接**（Zettelkasten 的「box」概念——相关笔记通过相似的 context 描述互联，但一条笔记可同时属于多个 box）；④ **记忆演化**——新笔记
还可触发对近邻旧笔记的 context/keywords/tags 的更新，使记忆网络持续精炼。检索：query 向量化 → top-k 相似笔记 → 把与命中笔记**同链的笔记一并带出**（链接即免费扩展上下文）。效果：多跳推理较 LoCoMo/MemGPT 提升 2–6 倍；每条记忆操作仅 ~1200 token（比基线 16900 token 降 85–93%），GPT-4o-mini 平均 5.4s/条、本地 Llama-3.2-1B 仅 1.1s；检索 top-k=10 为甜点，k 再大收益递减。来源：[A-MEM 论文](https://arxiv.org/abs/2502.12110)、[生产版仓库 agiresearch/A-mem](https://github.com/agiresearch/A-mem)。

**关键数据结构**

```
MemoryNote {
  id: string;
  content: string;          // c_i 原始交互内容
  timestamp: number;        // t_i
  keywords: string[];       // K_i，LLM 生成，≥3
  tags: string[];           // G_i，LLM 生成，≥3（domain/format/type）
  context: string;          // X_i，LLM 生成的上下文描述（一段）
  embedding: number[];      // 全文（content+context）的稠密向量
  links: string[];          // L_i，链接的记忆 id 集合
}
```
LLM 笔记生成 prompt 要点（论文附录原文）：抽取 keywords「focus on nouns, verbs, and key concepts；不要包含说话人名和时间；至少 3 个」；tags「include domain, format, and type tags；至少 3 个」。

**TS + SQLite 最小实现建议**

- 表：`notes(id, agent_id, content, context, keywords_json, tags_json, embedding, created_at, updated_at)`、`note_links(src_id, dst_id, reason, created_at)`（边带 LLM 给出的链接理由，便于调试与演化）。
- 写管线三步（每步一次 LLM 调用，共 ~1200 token/条）：
  1. 生成 `{keywords, tags, context}`（JSON schema 约束）；
  2. embed(content + context)；
  3. top-10 近邻 → 单次 LLM 调用输出 `{links: [{note_id, reason}], evolutions: [{note_id, new_context?, new_keywords?, new_tags?}]}`，事务性落库。
- 检索：向量 top-10 → 沿 `note_links` 展开一跳（UNION 出链+入链）→ 按 `similarity + 0.3 * link_bonus` 重排取 top-k 注入 prompt。
- 与 mem0 的关系：A-MEM 的「演化」步骤等价于 mem0 的 UPDATE，但额外产出**显式链接图**，适合社交应用里「话题/人物/事件」的关联记忆。

**出处**
- [A-MEM 论文 arXiv:2502.12110](https://arxiv.org/abs/2502.12110) / [HTML 版（笔记结构、链接、演化、k=10、1200 token/操作）](https://arxiv.org/html/2502.12110v8)
- [生产版实现 github.com/agiresearch/A-mem](https://github.com/agiresearch/A-mem)

### 1.5 embedding + BM25 混合检索与记忆衰减/巩固

**核心机制（混合检索）**
纯稠密检索擅长改写/同义，纯 BM25 擅长精确术语（人名、地名、错误码、ID），两者融合是 2024–2026 生产 RAG/记忆的共识做法。标准配方：dense top-K（40–100）∥ BM25 top-K → **Reciprocal Rank Fusion (RRF)** 融合：`score(d) = Σ 1/(k + rank_i(d))`，标准平滑常数 `k=60`；可选再叠 cross-encoder 重排（如 bce-reranker）。RRF 用「名次」而非「分数」融合，规避两个检索器分数尺度不可比的问题（BM25 0–15 vs cosine 0.6–0.95）。来源：[RRF 公式与 k=60（pinnaclepubs）](https://pinnaclepubs.com/index.php/JSISI/article/download/727/698/2133)、[hybrid search 生产实践（dunedive）](https://dunedive.com/en/wissen/hybridsuche-bm25-plus-vektor)。

**核心机制（衰减与巩固）**
人类记忆模型（Ebbinghaus 遗忘曲线；Tulving 情景/语义二分）被系统性地搬进 agent 记忆，主流做法：
- **分层衰减率**：情节记忆（episodic，一次性事件）快衰减，语义记忆（semantic，用户偏好/事实）慢衰减或不衰减——检索打分乘时间衰减因子或定期降权/归档。参考 [negentropy memory whitepaper 的「Episodic 快衰减 / Semantic 慢衰减」条目](https://github.com/ThreeFish-AI/negentropy/blob/master/docs/concepts/subsystems/026-memory-whitepaper.md)。
- **访问驱动巩固（MemoryBank 式）**：每条记忆带 `access_count`/`last_accessed_at`，经常被访问的记忆重要性升高（巩固），长期未访问的衰减——`importance` 随检索命中递增，结合 Ebbinghaus 曲线计算保留概率。
- **后台巩固任务（Letta sleep-time / Auto Dream 式）**：对话空闲时异步跑记忆压缩——合并冗余事实、把多条情节蒸馏成语义摘要、清理低价值记忆。Letta 将其产品化为「sleep-time agents」与 Git 式记忆版本控制。来源：[腾讯云社区对 Letta sleep-time 的介绍](https://cloud.tencent.com/developer/article/2664973)。

**关键数据结构**

```ts
interface MemoryRecord {
  id: string;
  kind: "episodic" | "semantic" | "procedural";
  text: string;
  embedding: Float32Array;      // dense
  importance: number;           // 0..1，写入时 LLM 打分或访问驱动更新
  access_count: number;
  created_at: number;
  last_accessed_at: number;
  decay_rate: number;           // 由 kind 决定：episodic ~0.05/天，semantic ~0.005/天（自调）
  status: "active" | "archived" | "expired";  // 软删除/归档，不物理删
}
// 检索分 = alpha*hybrid_score + beta*(1 - decay) + gamma*importance
// RRF: score(d) = sum_i 1/(60 + rank_i(d))
```

**TS + SQLite 最小实现建议**

- BM25：**SQLite FTS5 默认即 BM25 排序**（`ORDER BY bm25(memories_fts)`），零依赖；建一个 FTS5 虚表 `memories_fts(text)` 与主表同步（触发器或应用层双写）。
- 融合算法（每查询 <1ms 规模）：

```ts
function rrf(denseRanked: string[], bm25Ranked: string[], k = 60) {
  const scores = new Map<string, number>();
  denseRanked.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  bm25Ranked.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}
```

- 衰减任务：应用启动或每天一次，`UPDATE memories SET status='archived' WHERE status='active' AND importance * exp(-decay_rate * (now - last_accessed_at)/86400000.0) < 0.1`；归档不删除（对齐 Zep 软删除哲学）。
- 巩固任务：每 N 轮对话后，把高 access_count 的情节记忆交给 LLM 蒸馏成语义记忆（合并进既有语义记忆，走 mem0 四操作）。

**出处**
- [RRF 融合公式 k=60](https://pinnaclepubs.com/index.php/JSISI/article/download/727/698/2133)
- [混合检索生产实践（BM25+HNSW+RRF）](https://dunedive.com/en/wissen/hybridsuche-bm25-plus-vektor)
- [分层衰减/类型化记忆设计参考（negentropy whitepaper）](https://github.com/ThreeFish-AI/negentropy/blob/master/docs/concepts/subsystems/026-memory-whitepaper.md)
- [Letta sleep-time compute / Auto Dream](https://cloud.tencent.com/developer/article/2664973)

---

## 2. 自我进化（Self-Evolution）

### 2.1 Voyager：技能库（Skill Library）

**核心机制**
Voyager（NVIDIA + Caltech + UT Austin，2023，首个 LLM 驱动的终身学习 agent）在 Minecraft 中做到「不更新权重、持续变强」，三模块循环：① **自动课程**（GPT-4 根据 agent 状态与历史提出下一个探索任务）；② **技能库**（最关键、最具迁移性的设计）：成功的行为以**可执行 JavaScript 代码**形式入库，代码经「环境反馈 + 执行错误 + 自我验证」迭代打磨至通过为止，然后以嵌入向量索引，未来任务先检索相关技能再合成新代码；③ **迭代提示机制**（整合环境反馈、执行错误、自我验证来修正代码生成）。技能库的本质洞察：**代码是比自然语言更精确、可直接执行验证、可组合复用的技能表示**；技能随使用复利增长。来源：[Voyager arXiv:2305.16291](https://arxiv.org/abs/2305.16291)、[o-mega 自改进 agent 综述](https://o-mega.ai/articles/self-improving-ai-agents-the-2026-guide)。

**关键数据结构**

```ts
interface Skill {
  id: string;
  name: string;              // 如 "collectWoodenPlanks"
  description: string;       // 一段自然语言说明（用于嵌入检索 + 注入 prompt）
  code: string;              // 可执行代码（Voyager: JS；桌面应用: TS 函数体）
  embedding: Float32Array;   // description 的向量
  created_at: number;
  usage_count: number;
  success_count: number;     // 用于质量分
  dependencies: string[];    // 其他 skill id（代码中调用的技能）
}
// 任务循环：curriculum 提任务 → 检索 top-k 相关技能注入 prompt → 生成代码 →
//           沙箱执行 → 失败则带错误信息迭代（≤N 轮）→ 成功则 verify → 入库
```

**TS + SQLite 最小实现建议**

- 表：`skills(id, name, description, code, embedding, usage_count, success_count, created_at)`、`skill_dependencies(skill_id, dep_id)`、`skill_executions(skill_id, task_desc, ok, error, created_at)`。
- 桌面场景把「Minecraft 环境」替换为「沙箱执行 TS 函数」：新技能生成后用 `node:vm` 或 `isolated-vm` 在限时限权限沙箱里跑测试用例，`ok=true` 且 LLM self-verify 通过才入库。
- 检索注入：任务到来时 `embed(task_description)` → top-5 技能的 `name + description + 签名` 注入 system prompt（代码本体按需懒加载，省 token——这也是 2026 年 Claude Agent SDK skills / skillkit 的做法）。
- 质量门禁：`success_count / usage_count < 0.5` 的技能降权或标记 `needs_revision`，避免错误技能污染。

**出处**
- [Voyager arXiv:2305.16291](https://arxiv.org/abs/2305.16291)
- [Self-Improving AI Agents: The 2026 Guide（Voyager 技能库解析）](https://o-mega.ai/articles/self-improving-ai-agents-the-2026-guide)
- [Claude Agent SDK skills / skillkit 的技能表示落地](https://taibui.dev/phases/14-agent-engineering/10-skill-libraries-voyager)

### 2.2 自我反思（Reflexion）与经验回放

**核心机制**
Reflexion（Shinn et al., NeurIPS 2023）把强化学习改成**「语言强化学习」**：不更新模型权重，而把失败信号变成自然语言反思文本存入情节记忆，下一次尝试把反思注入上下文从而改变行为。三角色：**Actor**（生成动作/回答，条件为当前状态 + 反思缓冲区）、**Evaluator**（打分：环境 reward、单元测试、LLM 评判）、**Self-Reflection**（LLM 阅读失败轨迹，生成「哪里错了、下次怎么办」的简洁 verbal feedback）。循环：`尝试 → 评估 → 反思 → 存 buffer → 带着反思重试`（一般 1–3 轮）。关键点：反思必须**简洁、可操作**（"Next time I should use x because y" 式），且只保留 1–3 条最近反思在上下文中，长反思反而有害；跨会话持久化后即为「经验回放」。来源：[Reflexion arXiv:2303.11366](https://arxiv.org/abs/2303.11366)、[Reflexion 框架解析（Zylos）](https://zylos.ai/research/2026-03-06-ai-agent-reflection-self-evaluation-patterns/)、[Self-Refine vs Reflexion 对照](https://awesome-agentic-ai-site.vercel.app/en/stages/06-memory-rag/)。

**关键数据结构**

```ts
interface Reflection {
  id: string;
  agent_id: string;
  task_summary: string;     // 任务是什么
  trajectory_digest: string;// 失败轨迹摘要（原轨迹可存关联 id）
  feedback: string;         // Evaluator 给的原始反馈（测试输出/错误）
  lesson: string;           // Self-Reflection 产出的经验教训（≤3 句话）
  outcome: "failure" | "partial" | "success";
  created_at: number;
  hit_count: number;        // 被后续检索注入次数
}
// 每会话：reflection buffer（1–3 条）拼进 Actor prompt；
// 持久层：reflections 表，新任务时按任务相似度检索 top-k 注入
```

**TS + SQLite 最小实现建议**

- 表：`reflections(...)` 如上 + `episode_reflections(episode_id, reflection_id)` 关联。
- 触发时机：任务失败（评测未通过 / 用户差评 / 工具调用报错重试超过 2 次）→ 立即做一次反思调用（输入：任务、轨迹、错误），产物写库。
- 注入：组装 prompt 前 `embed(task)` → 命中 `outcome != 'success'` 且 lesson 相似度 > 阈值的 top-3 反思，以「经验教训」小节注入。
- 退化防护：同 lesson 若 hit_count 高但同类任务仍反复失败，说明反思无效——用 §2.4 的 GEPA 机制在剧本层修复，而非继续堆反思。

**出处**
- [Reflexion: Language Agents with Verbal Reinforcement Learning, arXiv:2303.11366](https://arxiv.org/abs/2303.11366)
- [三角色结构与 buffer 细节（Zylos Research）](https://zylos.ai/research/2026-03-06-ai-agent-reflection-self-evaluation-patterns/)
- [Reflexion 持久化版本（跨会话经验回放）](https://awesome-agentic-ai-site.vercel.app/en/stages/06-memory-rag/)

### 2.3 ACE：Agentic Context Engineering 的增量上下文演化

**核心机制**
ACE（Stanford 等，arXiv 2510.04618，2025-10）把 agent 的 system prompt/context 视为**可演化的剧本（playbook）**，用三角色流水线持续更新：**Generator**（带当前剧本跑新任务，产出轨迹——成功的策略与反复踩的坑）、**Reflector**（评估轨迹对错、抽取洞见，并给剧本里的条目打 `helpful/harmful` 计数）、**Curator**（把洞见转成**结构化增量条目（delta entries）**做确定性合并——去重、剪枝、合并——而不是重写整个 prompt）。这解决了文本自进化的两大失败模式：**brevity bias**（LLM 重写 prompt 倾向越写越短、丢细节）与 **context collapse**（反复整体重写导致知识逐代流失）。论文数字：agent 任务（AppWorld）平均 +10.6%，域内（金融 FiNER）+8.6%；比 GEPA 少 75.1% rollout、低 82.3% 延迟；在线模式比 Dynamic Cheatsheet 低 91.5% 延迟、83.6% token。来源：[ACE 论文 arXiv:2510.04618](https://arxiv.org/abs/2510.04618)、[ACE 官方仓库（playbook 格式）](https://github.com/ace-agent/ace)。

**关键数据结构（playbook 条目格式，仓库原文）**

```
## STRATEGIES & INSIGHTS
[str-00001] helpful=5 harmful=0 :: Always verify data types before processing
[str-00002] helpful=3 harmful=1 :: Consider edge cases in financial data

## FORMULAS & CALCULATIONS
[cal-00003] helpful=8 harmful=0 :: NPV = Σ(Cash Flow / (1+r)^t)

## COMMON MISTAKES TO AVOID
[mis-00004] helpful=6 harmful=0 :: Don't forget timezone conversions
```

- 条目 = `id`（section_slug + 序号）+ `helpful/harmful` 计数 + `:: 内容`。
- 超参（仓库默认值）：`num_epochs=1, max_num_rounds=3, curator_frequency=1, playbook_token_budget=80000, use_bulletpoint_analyzer=true 时相似度阈值 0.9`。

**TS + SQLite 最小实现建议**

- 表：`playbook_sections(id, agent_id, title, sort_order)`、`playbook_entries(id, section_id, entry_key /* str-00001 */, content, helpful, harmful, active, created_at, updated_at)`、`curator_ops_log(id, op /* add|merge|prune|update_counts */, payload_json, created_at)`。
- 每次 Curator 运行**只追加/修改条目**，system prompt 由条目按 section 拼接生成（带 token 预算截断：helpful-harmful 分低的先被挤出）——prompt 永远是从结构化数据「编译」出来的，可回滚、可 diff。
- 单用户桌面预算：Reflector 每轮对话后顺手打 helpful/harmful；Curator 每天一次或每 20 轮一次；`bulletpoint_analyzer` 用嵌入相似度 ≥0.9 判定合并候选，足够。
- 这正是「记忆」与「进化」的接口点：playbook 本身是**程序性记忆（procedural memory）**，与用户事实记忆分库存储。

**出处**
- [ACE 论文 arXiv:2510.04618](https://arxiv.org/abs/2510.04618)
- [ACE 官方仓库 README（三角色、playbook 格式、默认超参、效率数字）](https://github.com/ace-agent/ace)
- [ACE 效率对比（SambaNova 博客）](https://sambanova.ai/blog/ace-open-sourced-on-github)

### 2.4 GEPA / DSPy：反思式 prompt 自动优化

**核心机制**
GEPA（Genetic-Pareto，Cerebras Research + Stanford，arXiv 2507.19457，ICLR 2026 Oral，已集成 `dspy.GEPA`）用**反思式变异 + Pareto 逐实例选择**进化 prompt/指令/任意文本参数，三个耦合机制缺一不可：① **Reflective mutation**：捕获完整执行 trace（输入、输出、错误、工具调用），连同当前指令交给 reflection LLM，从真实失败的语言分析中写出新指令（不是随机扰动）；② **文本反馈作为优化信号**：metric 返回 `dspy.Prediction(score=…, feedback=…)`，feedback 是自由文本（评测日志、解析失败、约束违反、单测输出），比稀疏标量 reward 信息量大得多；③ **Pareto-per-instance 选择**：维护「在每个评测实例上都曾最优」的候选前沿，按覆盖率采样下一个变异对象，保留边缘 case 上表现好但整体分不高的候选，可再做 system-aware merge 跨血统重组。数字：平均比 GRPO 高 6%（最高 20%）且少 35× rollout；比 MIPROv2 高 10%+；典型预算 100–500 次评测（RL 要 5000–25000+）。失效条件：反馈只有二元对错、评测集同质化、长时间在线演化（此时 ACE 的 delta 更新更优——GEPA 是**编译期**优化器，ACE 是**在线**适应循环）。来源：[GEPA 论文 arXiv:2507.19457](https://arxiv.org/abs/2507.19457)、[dspy.GEPA 模式详解（Agent Patterns）](https://agentpatterns.ai/patterns/agent-design/gepa-reflective-prompt-evolution/)。

**关键数据结构**

```ts
interface EvalInstance { input: unknown; expected?: unknown; }
interface MetricResult { score: number; feedback: string; }  // feedback 必须含阶段归因文本
interface Candidate {
  id: string;
  promptVars: Record<string, string>;  // 每个模块的指令文本
  scores: Map<string, number>;         // instanceId -> score（Pareto 前沿用）
  lineage: string[];                   // 变异谱系
}
// 循环：前沿按覆盖率采样候选 → minibatch rollout 收集 trace →
//       Reflector 对单模块反思 → 生成新候选 → 评测 → 入前沿/淘汰
```

GEPA-friendly metric 反例/正例（Agent Patterns 原文改编）：

```ts
// 反例：只有标量，反思饿死
const emMetric = (gold: any, pred: any) => Number(pred.answer === gold.answer);

// 正例：分阶段归因 + 文本反馈
function ragMetric(gold: any, pred: any) {
  const missing = gold.supporting_ids.filter((x: string) => !pred.retrieved_ids.includes(x));
  const recall = gold.supporting_ids.length
    ? (gold.supporting_ids.length - missing.length) / gold.supporting_ids.length : 1;
  const correct = Number(pred.answer === gold.answer);
  const feedback: string[] = [];
  if (missing.length) feedback.push(`Retriever missed documents: ${missing.sort()}`);
  if (!missing.length && !correct)
    feedback.push(`Retrieval was adequate (recall=${recall}) but answer '${pred.answer}' != '${gold.answer}'. Synthesis step is the bottleneck.`);
  return { score: 0.5 * recall + 0.5 * correct, feedback: feedback.join(" ") };
}
```

**TS + SQLite 最小实现建议**

- 表：`evolution_candidates(id, agent_id, module, prompt_text, parent_id, created_at)`、`evolution_evals(candidate_id, instance_id, score, feedback)`、`evolution_frontier(agent_id, module, candidate_id)`。
- 桌面单用户规模把 GEPA 当「离线编译器」用：攒 30–100 条带反馈的历史评测样本 → 手动点「优化 prompt」按钮 → 跑 50–200 次评测的 GEPA 循环 → 新 prompt 经 A/B 保留旧版本（playbook 版本化，见 §2.3）。
- 不需要实现完整 DSPy：一个 `reflect(prompt, traces, feedback[]) -> newPrompt` LLM 调用 + Pareto 记录就够；Pareto 判据：候选 c 入前沿 ⟺ 不存在 c' 在所有已评测实例上 ≥ 且至少一个 >。
- 度量设计是最高杠杆：务必让反馈文本**归因到阶段**（检索错 / 合成错 / 工具错 / 语气错）。

**出处**
- [GEPA 论文 arXiv:2507.19457](https://arxiv.org/abs/2507.19457)
- [dspy.GEPA 三机制、适用条件、失效模式（Agent Patterns）](https://agentpatterns.ai/patterns/agent-design/gepa-reflective-prompt-evolution/)
- [GEPA vs RL 成本解读（Flowtivity）](https://flowtivity.ai/blog/gepa-reflective-prompt-optimization/)

### 2.5 「用户反馈 → 修正 → 固化」在线学习闭环

**核心机制**
把用户的显式/隐式反馈变成进化信号的最短闭环：**显式反馈**（👍/👎、编辑回复、「记住这个」按钮）直接作为高置信监督；**隐式反馈**（重生成、追问澄清、快速关闭会话）作为弱信号需聚合。闭环五步：① 捕获反馈并关联当轮轨迹；② 归因——LLM 判断问题是出在检索（没找到该找的记忆）、事实（找到了但记忆错/过时）、策略（prompt 层缺陷）还是执行（工具/skill 层）；③ 修正——按归因路由：事实层走 mem0 四操作修正记忆；策略层生成 Reflexion lesson 或 ACE playbook 条目候选；执行层修正/新增 skill；④ **固化**——修正必须经过验证（下次同类任务验证通过 / helpful 计数累积）才从「候选」转正为长期记忆或 playbook 正式条目，防止把用户一次性的情绪波动写入永久记忆；⑤ 回放——修正产物进入 §2.2 经验回放与 §1 检索体系，下次组装 prompt 时生效。这正是 Reflexion（轨迹→反思）+ ACE（条目+计数+策展）+ Voyager（验证后入库）三个机制的复合。

**关键数据结构**

```ts
interface FeedbackEvent {
  id: string; agent_id: string; turn_id: string;
  kind: "explicit_thumb" | "edit" | "pin" | "implicit_regenerate" | "implicit_clarify";
  polarity: 1 | -1 | 0;
  user_comment?: string;
  created_at: number;
}
interface CorrectionCandidate {
  id: string; feedback_id: string;
  attribution: "retrieval" | "fact" | "strategy" | "execution";
  fix_payload: unknown;  /* mem0 operation | reflection lesson | playbook delta | skill patch */
  status: "candidate" | "validated" | "rejected";
  validation_hits: number;  // 固化阈值，如 ≥2 次验证通过
}
```

**TS + SQLite 最小实现建议**

- 表：`feedback_events(...)`、`correction_candidates(...)` 如上。
- 归因一个 LLM 调用搞定（输入：消息对 + 反馈 + 当前注入的记忆快照），输出 JSON 带 `attribution` 与 `fix_payload`。
- 固化规则：显式 👍 的 pin → 直接转正（用户意图明确）；👎 产生的修正 → 进 candidate，在接下来 3 次同类任务中观察 helpful/harmful 再转正；candidate 表就是审查队列，UI 上给用户一个「记忆/策略审查」面板（桌面应用的用户就是 owner，可人工加速转正）。
- 与衰减联动：被 👎 打回的记忆立即降 importance 并触发 mem0 管线重新评估该事实。

**出处**
- [Reflexion（轨迹→语言反思的学习信号）](https://arxiv.org/abs/2303.11366)
- [ACE（helpful/harmful 计数 + Curator 验证后合并）](https://arxiv.org/abs/2510.04618)
- [Voyager（环境验证通过才入库的固化门禁）](https://arxiv.org/abs/2305.16291)

---

## 3. 综合架构建议：接入「多 agent 社交应用」

场景设定：一个桌面应用，用户与多个 agent（每个有独立人设/记忆空间）社交对话；所有 agent 共享一份「用户画像」（user profile）；单用户、SQLite、TypeScript（Electron/Tauri 均适用）。

### 3.1 分层架构总览

```
| Agent 运行时（每轮对话）                                    |
|  1) 检索：组装 prompt 前                                     |
|     embed(query) → agent 私有记忆(top-k1) + 用户画像(top-k2) |
|     + BM25 召回 → RRF 融合 → 反思教训(top-3) + playbook 注入 |
|  2) 生成：LLM（带 memory tools: pin/forget/correct）        |
|  3) 反馈收集：👎/编辑/pin → feedback_events                  |
| 异步管线（每轮对话结束后入队，不阻塞 UI；单并发 worker）       |
|  A. 记忆抽取（mem0 式）：摘要+近 10 条 → 抽事实 → top-10 相似 |
|     → LLM 四操作（软删除: status='expired' + 时态字段）       |
|  B. 笔记结构化（A-MEM 式，可选/每日）：keywords/tags/context/ |
|     links/evolutions → note_links                            |
|  C. 反思（Reflexion 式，失败轮或有 👎 时）：lesson 入库       |
|  D. 剧本演化（ACE 式，每 N=20 轮或每日）：Reflector 打计数 →  |
|     Curator delta 合并 → playbook 版本 +1                   |
| 离线/夜间任务（手动触发或空闲调度）                           |
|  E. 巩固：高 access_count 情节记忆蒸馏成语义记忆；低分记忆归档 |
|  F. GEPA 式 prompt 优化：攒评测样本 → 反思变异 → Pareto →    |
|     候选 prompt 入 playbook 审查队列                         |
|  G. 衰减扫描：importance·exp(-decay·Δt) < 阈值 → archived    |
```

### 3.2 SQLite 数据模型（单库，agent 隔离靠 agent_id 列）

```sql
-- 会话与消息（Recall 层）
CREATE TABLE conversations(id TEXT PK, agent_id, title, created_at, summary TEXT, summary_updated_at);
CREATE TABLE messages(id TEXT PK, conversation_id, agent_id, role, content, created_at, embedding BLOB);
CREATE VIRTUAL TABLE messages_fts USING fts5(content);          -- BM25

-- 长期事实记忆（mem0 式 + Zep 式时态字段）
CREATE TABLE memories(
  id TEXT PK, agent_id,          -- agent_id='*shared*' 表示用户画像层
  kind TEXT CHECK(kind IN ('episodic','semantic','procedural')),
  text TEXT, embedding BLOB,
  importance REAL DEFAULT 0.5, access_count INTEGER DEFAULT 0,
  valid_at INTEGER, invalid_at INTEGER,      -- Zep 式双时态；invalid_at NULL = 当前有效
  status TEXT DEFAULT 'active',              -- active|archived|expired
  created_at INTEGER, updated_at INTEGER);
CREATE VIRTUAL TABLE memories_fts USING fts5(text);

-- A-MEM 式笔记链接（可选增强层）
CREATE TABLE notes(id TEXT PK, agent_id, memory_id, content, context,
  keywords_json TEXT, tags_json TEXT, embedding BLOB, created_at, updated_at);
CREATE TABLE note_links(src_id, dst_id, reason, created_at, PRIMARY KEY(src_id,dst_id));

-- 自我进化
CREATE TABLE skills(id TEXT PK, agent_id, name, description, code,
  embedding BLOB, usage_count, success_count, created_at);
CREATE TABLE reflections(id TEXT PK, agent_id, task_summary, feedback,
  lesson, outcome, hit_count, created_at);
CREATE TABLE playbook_sections(id TEXT PK, agent_id, title, sort_order);
CREATE TABLE playbook_entries(id TEXT PK, section_id, entry_key, content,
  helpful INTEGER DEFAULT 0, harmful INTEGER DEFAULT 0, active INTEGER DEFAULT 1,
  version INTEGER DEFAULT 1, created_at, updated_at);
CREATE TABLE playbook_versions(id TEXT PK, agent_id, version, snapshot_json, created_at);

-- 反馈闭环
CREATE TABLE feedback_events(id TEXT PK, agent_id, turn_id, kind, polarity,
  user_comment, created_at);
CREATE TABLE correction_candidates(id TEXT PK, feedback_id, attribution,
  payload_json, status, validation_hits, created_at);

-- 后台任务队列
CREATE TABLE jobs(id TEXT PK, type, payload_json, status, run_at, created_at);
```

### 3.3 记忆写入时机

- **每轮对话后（异步，秒级）**：Job A 记忆抽取管线——输入 `(conversation_summary, 最近 10 条, 新消息对)`，LLM 抽事实 → top-10 相似 → 四操作落库。这是 mem0 论文验证过的节奏；单用户下成本可忽略。
- **每轮对话后（条件触发）**：Job C 反思——仅当本轮出现 工具错误重试≥2 / 用户 👎 / 会话内自评失败。
- **每 20 轮或会话结束**：Job D 剧本计数 + 摘要刷新（摘要刷新与 mem0 论文一致，独立异步模块）。
- **每日/手动**：Job E 巩固 + Job G 衰减；Job B 笔记结构化（社交场景的话题/人物链接很值）。
- **用户显式动作（pin/forget/correct）**：立即同步执行——这是最高置信写入，绕过管线直接落库并记 feedback_events。

### 3.4 检索时机（组装 prompt 前注入）

组装 system+context 的顺序与预算（建议总注入 ≤ 1500 token）：

1. **Core（Letta 式，静态）**：agent persona block + 用户画像 Top 记忆（`agent_id='*shared*'` 且 importance 高且 `invalid_at IS NULL`，5–10 条）——始终注入。
2. **反思教训（Reflexion 式）**：`embed(当前任务)` → reflections top-3，注入「注意事项」小节。
3. **情节检索（混合检索，按当前查询动态触发）**：`embed(user_msg)` + FTS5 BM25 各取 top-20 → RRF(k=60) 融合 → 过滤 `invalid_at IS NULL` → 按 `0.6·rrf + 0.25·importance + 0.15·recency(衰减后)` 重排 → top-5 注入「相关记忆」小节。
4. **Playbook 编译（ACE 式）**：`playbook_sections × playbook_entries WHERE active=1` 按 `(helpful-harmful)` 降序、token 预算 2000 内拼接；snapshot 版本号进日志便于回滚。
5. **Skills 懒加载**：仅当本轮被检索到（description 相似度 > 0.75）才把代码本体注册为工具，否则只注名单。

注入前用一句「记忆引用格式」约束 LLM：每条记忆带 `[mem:ID]` 前缀，输出若引用记忆须带 ID——为反馈归因（§2.5 第②步）提供可定位锚点。

### 3.5 进化触发条件（汇总）

| 触发器 | 条件 | 动作 |
|---|---|---|
| 每轮后 | 无条件（异步） | Job A 记忆抽取四操作 |
| 失败信号 | 工具重试≥2 / 👎 / 自评失败 | Job C Reflexion 反思入库 |
| 计数阈值 | 剧本 helpful+harmful 新增 ≥20 | Job D Curator delta 合并 |
| 显式反馈 | pin / 👎 / 编辑 | §2.5 归因 → candidate（👍pin 直接转正） |
| 验证转正 | candidate 在后续 ≥2 次同类任务验证通过 | candidate → validated，写入正式记忆/playbook |
| 周期任务 | 每日空闲 / 手动按钮 | Job E 巩固、Job G 衰减、Job F GEPA 优化 |
| 版本回滚 | 新版本 playbook 评测低于旧版 | 回滚到 playbook_versions 快照 |

### 3.6 多 agent + 共享用户画像的关键设计

- **写隔离、读共享**：`memories.agent_id` 区分私有与共享（`*shared*`）；用户画像层**只允许**由「用户对 agent 说出的关于用户自身的事实」写入（抽取时按内容路由：关于用户 → shared；关于 agent 或对话 → agent 私有），避免 agent A 的私密对话污染共享画像。
- **画像更新仍走 mem0 四操作**：冲突解决在共享层更严格（涉及多 agent 一致性）。
- **人设（persona）即 Core Memory**：每个 agent 的 persona block 对应 Letta 的 core memory，可由 ACE playbook 演化（人设的策略部分）+ 用户 pin 修正（事实部分）。
- **SQLite 并发**：所有异步写走单 writer 队列（`jobs` 表 + 单 worker），读走 WAL 模式，桌面单用户无锁竞争问题。
- **Embedding 选型**：本地 `Xenova/all-MiniLM-L6-v2`（onnxruntime-node，~25MB，对齐 A-MEM 论文用模型）起步；中文场景换 `Xenova/bge-small-zh-v1.5`；向量存 Float32 BLOB，内存中余弦。

### 3.7 落地里程碑建议

1. **M1（1–2 周）**：messages + memories + FTS5 + 本地 embedding + mem0 抽取管线 + RRF 混合检索注入——核心记忆闭环跑通。
2. **M2（+1 周）**：feedback_events + 归因 + 反思入库 + pin/forget 工具——反馈闭环跑通。
3. **M3（+1 周）**：playbook 表 + Reflector 计数 + Curator delta 合并 + 版本快照——ACE 式演化跑通。
4. **M4（可选）**：notes/links（A-MEM 式）、skills 库（Voyager 式）、GEPA 离线优化按钮。

---

## 附：主要出处索引

| 主题 | 出处 |
|---|---|
| MemGPT/Letta | https://arxiv.org/abs/2310.08560 · https://letta.ai · https://zylos.ai/research/2026-04-05-ai-agent-memory-architectures-persistent-knowledge/ |
| mem0 | https://arxiv.org/html/2504.19413v1 · https://github.com/mem0ai/mem0 |
| Zep/Graphiti | https://arxiv.org/html/2501.13956v1 · https://github.com/getzep/graphiti |
| A-MEM | https://arxiv.org/abs/2502.12110 · https://github.com/agiresearch/A-mem |
| 混合检索/RRF | https://dunedive.com/en/wissen/hybrid
suche-bm25-plus-vektor · https://pinnaclepubs.com/index.php/JSISI/article/download/727/698/2133 |
| 衰减/巩固 | https://github.com/ThreeFish-AI/negentropy/blob/master/docs/concepts/subsystems/026-memory-whitepaper.md · https://cloud.tencent.com/developer/article/2664973 |
| Voyager | https://arxiv.org/abs/2305.16291 |
| Reflexion | https://arxiv.org/abs/2303.11366 |
| ACE | https://arxiv.org/abs/2510.04618 · https://github.com/ace-agent/ace |
| GEPA/DSPy | https://arxiv.org/abs/2507.19457 · https://agentpatterns.ai/patterns/agent-design/gepa-reflective-prompt-evolution/ |
