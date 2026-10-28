# 性能基线与优化记录

> 测量环境：Windows / Node 24.15.0 / tsx 4.23 / RyHarness 内置 node:sqlite（WAL）。
> 复现：`pnpm bench`（= `tsx scripts/bench.ts`，真实 embedding 段需 SILICONFLOW_API_KEY）。
>
> **两张表要一起读**：2026-10-17 那一轮是在本机并行跑多个 agent 的负载下测的
> （绝对值偏高，是上界），2026-10-12 那一轮是空闲机器。跨表比"涨了几倍"没有意义，
> 要比的是同一张表内的相对关系——这也是下面每行都带备注的原因。

## 基线数字（bench.ts，20 会话 × 100 消息 + 50 记忆数据集）

| 指标 | 2026-10-12（空闲机） | 2026-10-17（并行负载） | 备注 |
|---|---|---|---|
| 会话列表（单查询含预览+未读） | 0.25 ms | **1.58 ms** | A2 优化后：子查询一次取回，消除 N+1 |
| 消息分页 limit=50 | 0.15 ms | 0.40 ms | idx_messages_conversation_seq 命中 |
| 消息分页 beforeSeq 翻页 | 0.14 ms | 0.35 ms | — |
| recall（50 记忆，Hash 伪向量） | — | **1.67 ms** | 纯本地：向量常驻缓存 + FTS5 + RRF |
| recall 纯 FTS5 降级 | 2.5 ms | 1.39 ms | 无 key / 超时路径 |
| recall 真实 embedding 冷启动 | 164 ms | 未复现 | 网络往返（SiliconFlow Qwen3-0.6B），本次无 key |
| recall 真实 embedding 缓存命中 | 2.7 ms | 未复现 | 同上；无 key 时该段被 bench 跳过 |
| playbook compile | 0.03 ms | 0.11 ms | 纯 DB，无网络（确认不阻塞首 token） |
| server 冷启动（建库+迁移+种子+listen） | 15 ms | **67 ms** | 同样受并行负载影响（本轮 Electron/tsdown 未参与） |

未复现的两行保留 10-12 的数字并标注日期：它们是**网络**数字，只在有
`SILICONFLOW_API_KEY` 时才测得到，机器噪声对它们的影响可以忽略，别用今天的
本地数字去替换它们。

## 优化清单（本轮实施）

### A1 首 token 延迟
- **两段式召回**：`recallSync` 同步组装注入块（落库向量缓存 + FTS5 + 上一轮回灌的语义命中，全程零 await），`recallRefine` 在开流之后才等 embedding（`firstTokenDeadlineMs`，默认 **150ms**）。embedding 的网络往返不排在第一次 `llm.stream` 之前。
- **语义回灌**：补正拿到向量后会顺手算出本轮语义通道的余弦 top-3 留给下一轮（见 `packages/memory/README.md`）。只落缓存的话语义通道在线上等于不存在——`embedding_cache` 的键是查询文本原样，真人对话里同一句输入不会被说第二遍。
- **embedding 请求超时**（`MemoryService.embedTimeoutMs`，默认 **800ms**）：超时返回 null 降级纯 FTS5，并记日志。embedding 缓存（同文本不重复请求）把命中路径压到本地毫秒级。
- **recall 整体预算**（`recallBudgetMs`，默认 **1200ms**）：画像注入后检查预算，超预算跳过本轮记忆注入——recall 永不成为首 token 的瓶颈。
- playbook compile 实测 0.03–0.11ms，无网络，确认不阻塞。
- 相关不变量由 `pnpm perf` 钉住（不进 PR 通道、夜间跑）：`packages/memory/tests/recall.perf.ts` 量"同步召回比异步召回快一个量级""补正 deadline 是硬上界""一轮同步召回的 SQL 条数有固定上界"；`packages/agent/tests/token-budget.perf.ts` 量"两段式召回把首 token 的等待压到网络往返的一个零头""注入块照样出现在 system prompt 里"。

### A2 DB 性能
- 索引审计：messages(conversation_id, seq)、memories(agent_id, status, kind)、conversations(updated_at)、FTS5 虚表——均已在迁移中建好；FTS 写开销 = 每记忆一次 INSERT（bigram 变换在 JS，微秒级）。
- WAL：`SessionStore` 与 `MemoryStore`/`EvolveStore` 均开 `journal_mode=WAL`。
- **N+1 消除**：`GET /api/conversations` 原为"列表 + 每会话 2 次查询（预览/未读）"，改为 `listConversationsWithPreview()` 单查询（相关子查询取末条 content_blocks 与未读计数），20 会话从 ~40 次查询降为 1 次。

### A3 UI 渲染
- **消息列表**：渲染上限 150 条（超长会话截断 + 提示），「加载更早消息」按 historyLimit(+100) 向上翻页（beforeSeq 游标）。
- **memo 气泡**：`MessageBubble` 包 React.memo，自定义相等器按 key/sender/done/parts 序列化比较——流式期间 40ms 节流下未变化的气泡跳过重渲染。
- store 通知 40ms 合并（基础档）+ WS 事件折叠进同一快照。
- **订阅者级节流**（`subscribeThrottled` / `useChatSlice`，`store.ts`）：40ms 是**下限不是
  上限**，每个订阅者可以要自己的窗口。右栏从 `useChat(store)`（整份快照）迁到
  `useChatSlice(store, panelSliceOf(store), 200)`——它只用接力链与产物，两者在流式期间
  身份不变，纯流式期间一次都不重渲染。切片必须成组：产物不是快照字段而是
  `store.artifacts()` 现场算的，只切 relays 会让 produce-card 到达时不重渲染，产物卡片
  要等到下一次 dispatch 才出现。
- **切会话分桶缓存**（`ConversationCache` / `ConversationBucket`）：此前聊天区用
  `key={conversationId}` 整体重建 + `store.reset()` 重拉历史，一天来回切几十次就是几十次
  卸载重建与数据丢失（草稿被清掉）。现在按 id 交出桶：草稿、滚动锚点、已加载历史、
  流式快照原样还在，组件不卸载；上界 5 个会话，有草稿的桶最后逐出。
- **断口续接**：WS 重连按 `lastSeq` 只补缺口（不重拉整页），断口那条未完成的气泡就地收口。

### A4 启动速度
- server 冷启动 15ms（空闲机）/ 67ms（并行负载）；建库、迁移、种子、listen 全同步轻量；embedding 不做启动探测（首次 recall 惰性发起）；Electron 窗口在 server.create 后立即创建，splash 覆盖渲染层加载。

### A5 长会话：压缩链路（2026-10-17 补）
输入装不下时不再只是"截断+丢弃"，而是两段压缩（口径对齐 dsh 的
compaction-tool-result-pruner / compaction-basic）：

1. **工具结果预裁剪**（`pruneToolResults`，不需要模型）：单条工具输出超过
   `toolResultPruneTokens`（默认 2000）就换成 head + `PRUNE_MARKER` + tail。尾部必须留：
   报错栈、exit code 之类最关键的信息常在结尾，只留头等于骗模型"看到的是全部输出"。
2. **阈值触发的摘要**（`compactHistory`）：预裁剪之后仍超 `thresholdTokens` 才摘要，
   逐字保留最近 `retainTokens`（默认输入阈值的 1/4）。摘要指令作为最后一条 user 消息
   跟在待摘要历史之后，图的是形状合法（适配器只允许 system 领衔）与近因优先（指令落在
   最后一轮）。这里**没有**供应商侧的 KV cache 收益：压缩把窗口外那段历史换成了摘要、
   system 又是压缩器自己的提示，前缀缓存要求从第一条消息起逐字节相同，这里命不中。

取舍与边界：

- 摘要拿不到（没实现、抛错、返回空）时退回丢弃式裁剪；**压缩永远不让一轮对话比不压缩更糟**。
- 预算装不下摘要时直接不摘要（阈值 ≤ 抬头 + 摘要上限）：把最旧的逐字内容换成一段
  同样放不下的文本，只是白跑一趟。
- 切点保证逐字窗口首条不是孤立的 tool 结果——切在 tool_call 与 tool_result 之间会被
  供应商拒绝整个请求。
- 系统提示与工具声明自己就吃满窗口时（room ≤ 0）不动历史，"至少保留最新一条"的既有
  约定不受压缩影响。
- 摘要**只活在这一次请求里、不落库**（会话日志永远是原文，压缩只改发给模型的那一份）。
  代价要说清楚：超预算的长会话可能**每轮**都付一次摘要调用，而不是只付一次；换来的是
  摘要永远与当前日志一致，不会攒出一份越滚越偏的二手摘要。
- 摘要本身的耗时与它的 token 开销**没有**进 bench 表：它只在超阈值时触发，留在真实
  对话里看（`/api/telemetry`），不进这张表免得被读成"每轮都花这么久"。

### 已知的量级边界
- embedding 冷启动 164ms 是网络地板，缓存命中后消失；但**命中缓存的前提是查询文本原样
  重复**（键是 sha256(text)），真人对话里这件事很少发生——所以首 token 路径上真正让语义
  通道活着的是回灌，不是缓存。
- 压缩链路的摘要只在超阈值时触发一次；它不在上表的常驻开销里，也不要按"每轮多花
  N 毫秒"去理解。
- 单库单写者模型下，写入峰值 = 每轮对话的消息落库（3–6 行），无锁竞争。

## 性能用例清单（客户端 + 内核）

上面那张表全是服务端数字。性能用例另有一条通道：`pnpm perf`（`vitest.perf.config.ts`），
它现在盯三件事：

- **客户端渲染**（`apps/desktop/tests/perf/streaming.perf.ts`）：**流式渲染的增量代价**——
  逐帧追加时只重算尾巴那一段，而不是每帧整篇重新解析；外加 ChatStore 的事件折叠
  （2000 个 text-delta 只触发个位数次订阅通知）。
- **内核**（`packages/*/tests/**/*.perf.ts`）：recall 的 SQL 条数不随数据规模增长、
  同步召回相对异步召回的加速比、补正的 deadline 硬上界、token 预算估算本身的耗时。
  这两条 glob（`packages/*/tests/**` 与 `packages/*/*/tests/**`）是显式列出来的：
  主配置的 include 是 `*.test.ts`，不显式列就没人跑到它们。

这条通道的通则：

- 它**不进 PR 通道**：性能用例对机器负载敏感，混在默认通道里只会让「测试全绿」变成噪声。
- 但它有**夜间通道**：`.github/workflows/ci.yml` 的 `schedule` 任务每晚跑一遍
  （`continue-on-error`，失败不挡任何人），数字以 `perf-numbers-*` artifact 上传留存。
  一份从不执行的脚本会腐烂到没人发现它已经坏了。
- 这条通道只钉住**相对关系**（单帧成本 vs 整篇重解析的比值），不产出可跨机器比较的绝对
  毫秒数；绝对数字要看上面的服务端表，以及运行时遥测 `GET /api/telemetry`。
