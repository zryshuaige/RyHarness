# @ryagent/session

SQLite 会话持久化。

**选型：Node 内置 `node:sqlite`（DatabaseSync）**。理由：零外部依赖（better-sqlite3 需要原生编译，M2 阶段不引入构建复杂度）；同步 API 与单写者模型匹配；Node `^22.19 || >=24` 下已稳定可用（本仓库开发版 v24.15.0 验证无需 flag）。代价：无 better-sqlite3 的丰富辅助 API，所需的只是 prepare/run/step 薄薄一层。若未来需要加密、WAL 调优或浏览器兼容，再评估 better-sqlite3 / libsql。

**表结构**（`SCHEMA_VERSION = 1`，迁移见 `src/schema.ts`）：

- `agents`：Agent 定义，常用字段展开（name/provider/model/...），tools 存 JSON。
- `conversations`：`kind: direct|group`、memberAgentIds JSON、dispatcherAgentId、updatedAt 索引（最近会话列表）。
- `messages`：senderType user|agent|system、contentBlocks JSON（@ryagent/llm 的 ContentBlock）、mentions JSON、turnIndex（同轮共享）、`seq AUTOINCREMENT` 作分页游标。
- `dispatch_events`：群聊调度决策记录（fromAgent/toAgent/reason/turnIndex）。

**演进规则**（沿用 dsh）：`SCHEMA_VERSION` 单调递增，只追加迁移函数，永不修改/删除已发布版本；版本号存 SQLite `user_version`；缺失迁移在单事务内依次应用，任一失败整体回滚；遇到比代码更新的库直接拒绝启动。

**模型**：单写者（一个 `SessionStore` 实例拥有句柄），时间戳为 Unix 毫秒，`PRAGMA journal_mode = WAL` + `foreign_keys = ON`。测试用 `:memory:`。
