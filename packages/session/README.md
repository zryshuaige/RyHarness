# @ryagent/session

SQLite 会话持久化。

**选型：Node 内置 `node:sqlite`（DatabaseSync）**。理由：零外部依赖（better-sqlite3 需要原生编译，M2 阶段不引入构建复杂度）；同步 API 与单写者模型匹配；Node `^22.19 || >=24` 下已稳定可用（本仓库开发版 v24.15.0 验证无需 flag）。代价：无 better-sqlite3 的丰富辅助 API，所需的只是 prepare/run/step 薄薄一层。若未来需要加密、WAL 调优或浏览器兼容，再评估 better-sqlite3 / libsql。

**表结构**（`SCHEMA_VERSION = 2`，迁移见 `src/schema.ts`）：

- `agents`：Agent 定义，常用字段展开（name/provider/model/...），tools 存 JSON。
- `conversations`：`kind: direct|group`、memberAgentIds JSON、dispatcherAgentId、updatedAt 索引（最近会话列表）。
- `messages`：senderType user|agent|system、contentBlocks JSON（@ryagent/llm 的 ContentBlock）、mentions JSON、turnIndex（同轮共享）、`seq AUTOINCREMENT` 作分页游标、`tool_call_id`（v2 起）。
- `dispatch_events`：群聊调度决策记录（fromAgent/toAgent/reason/turnIndex），读取按 rowid 保证写入顺序（同毫秒时间戳也不乱序）。

**迁移历史**：

- v1：初始四表。
- v2：`messages` 增加 `tool_call_id`——AgentLoop 的工具结果消息需要带回 callId，多轮对话才能重建正确的请求历史（tool 消息按 OpenAI 协议必须对应 assistant 的 tool_call id）。

**SessionCoordinator**（`src/coordinator.ts`）：把 `@ryagent/agent` 的 AgentLoop 与 `@ryagent/group` 的 GroupDispatcher 事件流自动落成 messages 行：

- `chatDirect`：用户消息落库 → 从 store 重建 Message 历史（user/assistant/tool，tool 消息按 v2 的 toolCallId 还原）→ 跑循环 → assistant 回复与工具结果落库；
- `chatGroup`：mentions 解析落库 → 群历史格式化（"名字:"前缀，预算从最旧裁剪）→ 调度链；每条 dispatch 落 dispatch_events，每条完成的 agent 发言与其工具结果落 messages；
- **失败语义**：assistant 消息只在流正常组装完成后写入（半成品定义上不存在）；接力中途 LLM 报错时，已完成的 agent 发言保留，错误以 system 消息落库收尾。事务边界为"每条完成的发言一个写入单元"——LLM 调用跨 await，不在整链上持有 SQLite 事务。

**演进规则**（沿用 dsh）：`SCHEMA_VERSION` 单调递增，只追加迁移函数，永不修改/删除已发布版本；版本号存 SQLite `user_version`；缺失迁移在单事务内依次应用，任一失败整体回滚；遇到比代码更新的库直接拒绝启动。

**模型**：单写者（一个 `SessionStore` 实例拥有句柄），时间戳为 Unix 毫秒，`PRAGMA journal_mode = WAL` + `foreign_keys = ON`。测试用 `:memory:`。
