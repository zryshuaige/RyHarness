# 性能基线与优化记录

> 测量日期：2026-10-12，环境：Windows / Node 24.15.0 / RyAgent 内置 node:sqlite（WAL）。
> 复现：`pnpm tsx scripts/bench.ts`（真实 embedding 段需 SILICONFLOW_API_KEY）。

## 基线数字（bench.ts，20 会话 × 100 消息 + 50 记忆数据集）

| 指标 | 数字 | 备注 |
|---|---|---|
| 会话列表（单查询含预览+未读） | **0.25 ms** | A2 优化后：子查询一次取回，消除 N+1 |
| 消息分页 limit=50 | 0.15 ms | idx_messages_conversation_seq 命中 |
| 消息分页 beforeSeq 翻页 | 0.14 ms | — |
| recall 真实 embedding 冷启动 | **164 ms** | 网络往返（SiliconFlow Qwen3-0.6B） |
| recall 真实 embedding 缓存命中 | 2.7 ms | embedding_cache 命中后纯本地 |
| recall 纯 FTS5 降级 | 2.5 ms | 无 key / 超时路径，与本地路径同量级 |
| playbook compile | 0.03 ms | 纯 DB，无网络（确认不阻塞首 token） |
| server 冷启动（建库+迁移+种子+listen） | **15 ms** | 首启种子与迁移不阻塞窗口显示 |

## 优化清单（本轮实施）

### A1 首 token 延迟
- **embedding 请求超时**（`MemoryService.embedTimeoutMs`，默认 **800ms**）：超时返回 null 降级纯 FTS5，并记日志。embedding 缓存（同文本不重复请求）把命中路径压到 2.7ms。
- **recall 整体预算**（`recallBudgetMs`，默认 **1200ms**）：画像注入后检查预算，超预算跳过本轮记忆注入——recall 永不成为首 token 的瓶颈（本地路径 2.5–2.9ms，网络路径最坏 800ms+FTS）。
- playbook compile 实测 0.03ms，无网络，确认不阻塞。

### A2 DB 性能
- 索引审计：messages(conversation_id, seq)、memories(agent_id, status, kind)、conversations(updated_at)、FTS5 虚表——均已在迁移中建好；FTS 写开销 = 每记忆一次 INSERT（bigram 变换在 JS，微秒级）。
- WAL：`SessionStore` 与 `MemoryStore`/`EvolveStore` 均开 `journal_mode=WAL`。
- **N+1 消除**：`GET /api/conversations` 原为"列表 + 每会话 2 次查询（预览/未读）"，改为 `listConversationsWithPreview()` 单查询（相关子查询取末条 content_blocks 与未读计数），20 会话从 ~40 次查询降为 1 次。

### A3 UI 渲染
- **消息列表**：渲染上限 150 条（超长会话截断 + 提示），「加载更早消息」按 historyLimit(+100) 向上翻页（beforeSeq 游标）。
- **memo 气泡**：`MessageBubble` 包 React.memo，自定义相等器按 key/sender/done/parts 序列化比较——流式期间 40ms 节流下未变化的气泡跳过重渲染。
- store 通知 40ms 合并（既有）+ WS 事件折叠进同一快照。

### A4 启动速度
- server 冷启动 15ms（建库/迁移/种子/listen 全同步轻量）；embedding 不做启动探测（首次 recall 惰性发起）；Electron 窗口在 server.create 后立即创建，splash 覆盖渲染层加载。

### 已知的量级边界
- embedding 冷启动 164ms 是网络地板，缓存命中后消失；相同会话的重复问题几乎都命中缓存。
- 单库单写者模型下，写入峰值 = 每轮对话的消息落库（3–6 行），无锁竞争。
