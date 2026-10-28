# @ryharness/session

SQLite 会话持久化。

**选型：Node 内置 `node:sqlite`（DatabaseSync）**。理由：零外部依赖（better-sqlite3 需要原生编译，M2 阶段不引入构建复杂度）；同步 API 与单写者模型匹配；Node `^22.19 || >=24` 下已稳定可用（本仓库开发版 v24.15.0 验证无需 flag）。代价：无 better-sqlite3 的丰富辅助 API，所需的只是 prepare/run/step 薄薄一层。若未来需要加密、WAL 调优或浏览器兼容，再评估 better-sqlite3 / libsql。

**表结构**（`SCHEMA_VERSION = 11`，迁移见 `src/schema.ts`）：

- `agents`：Agent 定义，常用字段展开（name/provider/model/...），tools 存 JSON，`persona` 存人格 JSON（v6 起），`reasoning_effort` 存思考档位（v8 起，NULL = 用模型默认），`route_locked` 记「这条路由是用户手动挑的」（v11 起）。
- `conversations`：`kind: direct|group`、memberAgentIds JSON、dispatcherAgentId、updatedAt 索引（最近会话列表），`last_read_seq`（v3 起，未读徽标）、`deleted_at`（v10 起，软删标记，NULL = 没删过）。
- `messages`：senderType user|agent|system、contentBlocks JSON（@ryharness/llm 的 ContentBlock）、mentions JSON、turnIndex（同轮共享）、`seq AUTOINCREMENT` 作分页游标、`tool_call_id`（v2 起）、`usage`（v4 起）、`artifacts_json`（v7 起，产物卡片随消息落库，刷新后历史里查得到）。
- `messages_fts`：消息正文的 FTS5 索引（v5 起），**中文 bigram 分词**（写法与 @ryharness/memory 的 `memories_fts` 同一套，但本包不依赖那个包）。行键是 `messages.seq`（rowid 别名），写消息时同步建索引、删会话时同步清理，只有 `type=text` 的块进索引（工具载荷不进）；存量消息在 v5 迁移里一次性补齐。
- `settings`：键值表（v9 起），存「这台机器上的偏好」——个人资料、默认工作区等。不落库就只能各开一个 localStorage，于是它变成内核和 agent 都看不见的字符串。
- `dispatch_events`：群聊调度决策记录（fromAgent/toAgent/reason/turnIndex），读取按 rowid 保证写入顺序（同毫秒时间戳也不乱序）。

**迁移历史**：

- v1：初始四表。
- v2：`messages` 增加 `tool_call_id`——AgentLoop 的工具结果消息需要带回 callId，多轮对话才能重建正确的请求历史（tool 消息按 OpenAI 协议必须对应 assistant 的 tool_call id）。
- v3：`conversations` 增加 `last_read_seq`（未读徽标）。
- v4：`messages` 增加 `usage`（token 用量随消息落库）。
- v5：新增 `messages_fts` 并回填存量消息——关键词搜索此前只能分页把消息拉进内存做子串匹配（每条都要 JSON.parse），会话一多就是全库同步扫描；`store.searchMessages(query, { conversationId?, limit?, window? })` 一次 MATCH 返回 `{ messageId, conversationId, seq, senderType, senderId?, createdAt, text, score }`，按 BM25 相关度升序（越小越相关）。
- v6：`agents` 增加 `persona`（一列 JSON 而非十几个标量：人格要么整体是它、要么是默认值，且维度还会长）。存量行 NULL，存储层按 `PERSONA_DEFAULTS` 补齐，不回填。
- v7：`messages` 增加 `artifacts_json`——产物卡片此前只经 WS 实时事件推给前端，刷新或重开后历史里查不到痕迹。存量行 NULL，带存在性守卫以便迁移重放。
- v8：`agents` 增加 `reasoning_effort`——思考档位不落库的话，用户在「新建助理」里选的强度重启就没了，而这类设置悄悄丢失比「没这个设置」更让人怀疑软件本身。存量行留 NULL = 用模型默认。
- v9：新增 `settings` 键值表——「我的」页要能改自己的名字和头像，不落库就只能塞 localStorage，于是它变成一个内核和 agent 都看不见的字符串：界面显示「你叫张三」，Ryen 那边仍然只知道有个用户。个人资料、默认工作区这类「这台机器上的偏好」都该落在这里，而不是各开一个 localStorage。
- v10：`conversations` 增加 `deleted_at`——删除会话改成「标记」而不是「物理删」：物理删不可撤销，用户连「我删错了」都说不出口。这里只做前半截（删除 = 打标记，撤销 = 清标记），消息、FTS 索引、调度事件一条都不动；存量行 NULL = 没删过，语义与迁移前完全一致。
- v11：`agents` 增加 `route_locked`——记下「这条路由是用户自己挑的，别自动改」。内置助理的供应商会在用户配好新 key 时自动跟着走，光看 `provider` 字段分不出是系统自动指的、还是用户手动挑的（自动搬过一次之后 provider 已经等于种子默认值）。用户手动改过的置 1，服务器此后不再动它；系统自动搬的保持 0，下次仍然能跟着走。存量行一律 0。

**全文索引的调用方契约**：命中自带 `text`（建索引时的正文抽取结果），调用侧据此截片段即可，不必再读 `content_blocks`；要"时间倒序"就自己按 `createdAt` 再排一次。

**SessionCoordinator**（`src/coordinator.ts`）：把 `@ryharness/agent` 的 AgentLoop 与 `@ryharness/group` 的 GroupDispatcher 事件流自动落成 messages 行：

- `chatDirect`：用户消息落库 → 从 store 重建 Message 历史（user/assistant/tool，tool 消息按 v2 的 toolCallId 还原）→ 跑循环 → assistant 回复与工具结果落库；
- `chatGroup`：mentions 解析落库 → 群历史格式化（"名字:"前缀，按 `HISTORY_BUDGET_TOKENS` 的 **token** 预算从最旧裁剪；与 @ryharness/agent、@ryharness/group 同一个常量、同一套行权重）→ 调度链；每条 dispatch 落 dispatch_events，每条完成的 agent 发言与其工具结果落 messages；
- **失败语义**：assistant 消息只在流正常组装完成后写入（半成品定义上不存在）；接力中途 LLM 报错时，已完成的 agent 发言保留，错误以 system 消息落库收尾。事务边界为"每条完成的发言一个写入单元"——LLM 调用跨 await，不在整链上持有 SQLite 事务。

**演进规则**（沿用 dsh）：`SCHEMA_VERSION` 单调递增，只追加迁移函数，永不修改/删除已发布版本；版本号存 SQLite `user_version`；缺失迁移在单事务内依次应用，任一失败整体回滚；遇到比代码更新的库直接拒绝启动。

**模型**：单写者（一个 `SessionStore` 实例拥有句柄），时间戳为 Unix 毫秒，`PRAGMA journal_mode = WAL` + `foreign_keys = ON`。测试用 `:memory:`。
