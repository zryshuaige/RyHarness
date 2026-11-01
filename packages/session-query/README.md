# @ryharness/session-query

查会话历史：一个服务，把「精确读、筛选列表、关系追踪、血缘、全文搜索」收在一起。

上游 dsh 把这一族拆成三个包：`session-query`（统一查询服务）、`session-query-sqlite`（FTS5 全文检索后端）、`session-log-export`（导出会话 ZIP）。这一轮把三件事合进一个包：查询服务、两个可换的搜索后端、会话导出 ZIP。

## 提供什么

- `SessionQueryService` —— 统一的历史查询面。
  - **精确读**：按 id 取一条消息、一轮、一个会话。
  - **筛选列表**：按会话 / 发言者 / 消息种类 / 时间区间列消息，带游标翻页。
  - **关系追踪**：一条消息和谁有关系。
  - **血缘**：一条消息是哪一轮的第几条、那轮之前是什么。
  - **全文搜索**：跨会话搜正文，后端可换。
- 两个搜索后端：`MemorySearchBackend`（内存倒排，零配置）与 `Fts5SearchBackend`（SQLite FTS5，索引另存一个文件）。
- `exportSession()` —— 把一个会话导成一个 ZIP（会话元数据 + 消息 + 产物清单 + 可选的产物文件本体）。
- 三件模型工具 —— `session_search` / `session_read` / `session_trace`。

## 一条硬规矩：搜出来的与模型看到的对得上

内容一律从 `@ryharness/session` 的 `SessionStore` 读。模型看到的历史是从那里读出来的，于是两边天然是同一份。

搜索还有一道回查：索引里的命中会拿回存储核一遍——消息还在不在、正文还对不对得上。核不上的**不给**（只记在 `dropped` 里）。索引过期、消息被删、正文被改过，都只会让结果变少，不会给出一条模型看不到的消息。搜出来的等于没用，所以宁可少给。

正文抽取直接用底座的 `messageSearchText`：它取的就是 `type === 'text'` 的内容块，与模型在历史里看到的正文逐字一致。自己再写一份抽取逻辑，早晚与底座分叉。

## 怎么用

```ts
import { SessionQueryService, exportSession } from '@ryharness/session-query'

const service = new SessionQueryService({ store })

// 精确读
service.getMessage(messageId)
service.getTurn(conversationId, turnIndex)
service.getConversation(conversationId)

// 筛选列表（带游标翻页）
const page = service.listMessages({ conversationId, senderType: 'user', limit: 20 })
const next = service.listMessages({ conversationId, senderType: 'user', limit: 20, cursor: page.nextCursor })

// 关系追踪
const trace = service.traceRelations(messageId)
trace.turnMessages // 同一轮里的其它消息
trace.repliesTo // 它回复的那条
trace.referencedBy // 引用了它的那些
trace.before / trace.after // 同会话的前后文

// 血缘
const lineage = service.getLineage(messageId)
lineage.positionInTurn // 它是这一轮的第几条（从 1 开始）
lineage.turnSize // 这一轮一共几条
lineage.previousTurn // 上一轮（轮次号 + 第一条 + 条数）

// 全文搜索
service.search('配置里那几个键', { conversationId, limit: 10 })

// 导出
const { data, entries } = exportSession(service, {
  conversationId,
  artifacts: [{ path: 'artifacts/配置导出.zip', data: fileBytes }],
})
```

### 搜索后端

后端是可插拔的，接口是 `SessionSearchBackend`（灌索引、去掉一个会话、搜、清空、关掉）。

```ts
// 零配置：内存倒排
new SessionQueryService({ store })

// 大库：SQLite FTS5，索引另存一个文件（不碰会话库的 schema）
const backend = new Fts5SearchBackend({ path: join(dataDir, 'session-search.db') })
const service = new SessionQueryService({ store, search: backend })
```

两个后端的分数方向一致：**越大越相关**（FTS5 的 `bm25()` 取了负号）。分词口径也一致（底座的 bigram + unicode61），两边对同一个词的解释不会打架。

索引由服务自己维护：搜索前会同步范围内的会话（会话没变就不同步），也可以显式 `syncConversation(id)` / `reindexAll()`。

### 导出 ZIP

包里有什么：

| 文件 | 内容 |
|---|---|
| `session.json` | 会话元数据（id、标题、成员、时间、消息条数） |
| `messages.json` | 全部消息（一个 JSON 数组） |
| `messages.jsonl` | 同一条数据，一行一条 |
| `artifacts.json` | 产物清单：哪个消息产出了什么文件 |
| `README.md` | 这个包里有什么、怎么读 |
| `artifacts/*` | 产物文件本体（调用方给什么就放什么，不给就只留清单） |

ZIP 格式是自己拼的（`node:zlib` 的 raw deflate + IEEE CRC32），不引外部依赖。产物文件本体由调用方给：本包不碰文件系统——它不知道工作区在哪儿，也不知道哪些产物还在。

## 边界

- **不改 `@ryharness/session` 的 schema**。会话库是底座的地盘；FTS5 索引另存一个文件。
- **不做投影层（projection）**。投影是把提交过的事件流折成「当前值」的机制，属于**写侧**；上游把它放在 `session/` 那一族里。本包只管读。
- **不做界面**。给的是服务、工具与导出；界面上的搜索框、导出按钮是宿主的事。
- **软删的会话按查不到处理**，与底座的会话列表一致。
- **每次调用重新读会话**，不缓存：消息会被追加、截断、改写，缓存一放就与模型看到的历史对不上——而「对得上」是本包唯一不能让步的一条。
- **跨会话查询有上限**：默认最多看 50 个会话（`maxConversations`），单个会话最多读 20000 条（`maxMessagesPerConversation`）。

## 与上游 dsh 的差距

- **投影层（projection）**：上游有「把提交过的事件折成当前值」的投影单元（会话统计、轮次大纲等）。这轮不做——那是写侧的事，且我们的会话库本来就是「当前值」形状，没有事件流可折。
- **上游的 `session-log-export` 走的是 Web `/export` 命令 + 浏览器下载**：那套含界面与 HTTP 路由。这轮只给 `exportSession()`（产出 ZIP 字节），HTTP 与下载由宿主接。
- **上游的 `session-query-sqlite` 是独立包**，索引与底座之间有「对账（reconciliation）」机制。这轮把 FTS5 后端合进本包，对账靠「搜索前回查存储」这一道——机制不同，目的相同（不给对不上的结果）。
- **上游的分词器是独立决策**：这轮直接沿用底座 `@ryharness/session` 的 bigram 口径，为的是与底座自带的 FTS5 索引对同一个词解释一致。
- **上游有「实验性模型工具包」**（`experimental/tool-session-query`）：那是一个可选的消费者。这轮的三件工具直接在本包里（`createSessionQueryTools`），没有单独拆包，也没有做多语言（locale）资源。
