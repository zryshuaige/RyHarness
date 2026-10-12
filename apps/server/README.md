# @ryagent/server

RyAgent 本地后端：HTTP API + WebSocket 推送。可被 Electron 主进程内嵌（`RyAgentServer.create()`），也可独立启动：

```sh
pnpm dev          # 等价于 tsx src/main.ts（在 apps/server 目录）
# 或仓库根：环境变量 RYAGENT_PORT / RYAGENT_HOST / RYAGENT_DATA_DIR
```

- 默认监听 `127.0.0.1:32100`（仅本机，安全边界依赖 OS 账户）。
- 数据目录 `<dataDir>/`（默认 `<cwd>/data`，已 gitignore）：`ryagent.db`（SQLite）、`config/providers.json`（首启写入内置 SiliconFlow 条目，key 走 `SILICONFLOW_API_KEY` 环境变量，配置文件不存明文）、`workspace/`（工具工作区与产物目录）。
- 首启种子：内置 Ryen 保证存在于 agents 表。
- 优雅停机：`RyAgentServer.close()` 关 WS 客户端、HTTP server、SQLite；独立模式 SIGINT/SIGTERM 自动触发。

## HTTP API

统一约定：JSON；错误为 `{ "error": string }`；`content-type: application/json; charset=utf-8`。

### Agents

| 方法与路径 | 说明 |
|---|---|
| `GET /api/agents` | 全部 agent 定义（含 builtin）。 |
| `POST /api/agents` | 创建。body：`{ templateKey? , name?, systemPrompt?, provider?, model?, temperature?, tools?, avatar? }`。带 `templateKey` 时从模板实例化（缺省字段用模板默认值，id 自动生成）。 |
| `PATCH /api/agents/:id` | 合并更新（`isBuiltin` 不可变）。 |
| `DELETE /api/agents/:id` | 删除；builtin 返回 **409**；同时把该 agent 从所有会话的成员/调度员列表摘除。 |
| `GET /api/agent-templates` | 内置模板清单：`general`(通用助理 Ryen) / `coding` / `writing` / `translation` / `file-organizer`，各含 `suggestedSystemPrompt`、`defaultTools`、`defaultModel`。 |

### Conversations

| 方法与路径 | 说明 |
|---|---|
| `GET /api/conversations` | 按 updatedAt 倒序；每项附 `lastMessagePreview`（前 120 字符）与 `unreadCount`（占位，恒 0，未读体系 M4b 后定）。 |
| `POST /api/conversations` | `{"kind":"direct","agentId"}` 或 `{"kind":"group","memberAgentIds":[...],"dispatcherAgentId?","title?"}`（dispatcher 默认 `ryen`；成员须已存在）。 |
| `GET /api/conversations/:id` | 详情。 |
| `DELETE /api/conversations/:id` | 删除；消息与调度事件级联清除。 |
| `GET /api/conversations/:id/messages?before=<seq>&limit=<n>` | 游标分页：`before` 为 seq 游标（向过去翻页），默认取最新 50 条（上限 200），seq 升序返回。 |
| `POST /api/conversations/:id/messages` | body `{ "text": "..." }` → **202** `{accepted:true}`；处理异步进行，过程经 WS 推送。 |

消息行结构（StoredMessage）：`{ id, seq, conversationId, senderType: 'user'|'agent'|'system', senderId?, contentBlocks, mentions, toolCallId?, turnIndex, createdAt }`。`contentBlocks` 为 @ryagent/llm 的 ContentBlock JSON。

### Memories & 进化

| 方法与路径 | 说明 |
|---|---|
| `GET /api/agents/:id/memories` | 长期记忆：私有空间 active + 共享画像。 |
| `DELETE /api/memories/:id` | 记忆软删（status=deleted）。 |
| `GET /api/memory/stats` | 记忆统计 + embedding 可用性。 |
| `POST /api/feedback` | `{conversationId, agentId, signal: thumb_up\|thumb_down}`——👎 即时反思 + 归因 harmful；👍 归因 helpful。 |
| `GET /api/agents/:id/playbook` | 经验手册：playbook 条目（section 分组计数）+ 待验证教训。 |
| `POST /api/playbook/:id/status` | `{status: active\|deprecated}` 手动停用/恢复条目。 |
| `POST /api/evolve/consolidate` | 手动触发巩固（到期清理/重复记忆合并/dormant 统计）。 |

### Providers & 文件

| 方法与路径 | 说明 |
|---|---|
| `GET /api/providers` | 当前配置的供应商与模型清单（UI 选择器数据源）。 |
| `GET /api/files/:name` | 下载 `workspace/.ryagent-artifacts/` 下的产物文件；只允许叶子文件名（含 `/`、`\` 返回 **400**），MIME 按扩展名推断。 |

## WebSocket 事件契约（M4b 按此开发）

连接：`ws://127.0.0.1:32100/ws?conversationId=<id>`（每事件一条 JSON 文本帧）。

| 事件 | 字段 | 时机 |
|---|---|---|
| `message-start` | `conversationId, senderId, senderName, turnIndex` | 一条消息开始：用户消息提交时（senderId=`user`）以及每个 agent 开始生成时（senderId=agent id）。 |
| `text-delta` | `conversationId, senderId, text` | 流式文本增量。 |
| `tool-call-start` | `conversationId, senderId, callId, name, arguments` | 模型发起工具调用（arguments 为原始 JSON 字符串）。 |
| `tool-result` | `conversationId, senderId, callId, name, isError, content` | 工具执行完成。 |
| `produce-card` | `conversationId, senderId, callId, card: { path, name, size, mime }` | file_produce 等产物元数据；UI 据此渲染文件消息，`path` 可直接喂给 `GET /api/files/:name`。 |
| `dispatch` | `conversationId, fromAgent?, toAgent, reason, turnIndex` | 群聊调度决策：`user-mention` / `default-dispatcher` / `relay @名字` / `loop-guard` / `max-turns`。 |
| `message-done` | `conversationId, senderId, turnIndex` | 一条消息完整落库（agent 发言组装完成）。 |
| `error` | `conversationId, message, code` | 一轮中的失败（LLM 错误、内部错误）；已完成的发言保留并已落库。 |

一轮的典型顺序（群聊接力）：`message-start(user)` → `dispatch` → `message-start(agentA)` → `text-delta…` → `message-done(A)` → `dispatch(relay)` → `message-start(agentB)` → `text-delta…` → `message-done(B)`。

## 组装与扩展点

`RyAgentServer.create(options)`：
- `mountLlm(ctx)`：替换默认 OpenAI 适配器挂载（测试注入 mock）；
- `providersConfig`：内存覆盖 providers.json；
- `port: 0` 取随机端口（`server.url` 读实际地址）。

## 测试

`tests/server.test.ts`：真实 HTTP + WS 客户端跑通模板/CRUD/builtin 保护、群聊端到端（WS 事件序列 + 落库一致）、direct 流式、文件下载白名单。mock 适配器注入，不触网。
