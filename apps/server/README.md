# @ryagent/server

RyAgent 本地后端：HTTP API + WebSocket 推送。可被 Electron 主进程内嵌（`RyAgentServer.create()`），也可独立启动：

```sh
pnpm dev          # 等价于 tsx src/main.ts（在 apps/server 目录）
# 或仓库根：环境变量 RYAGENT_PORT / RYAGENT_HOST / RYAGENT_DATA_DIR
```

- 默认监听 `127.0.0.1:32100`（仅本机，安全边界依赖 OS 账户）。
- **Origin 白名单**：HTTP 与 WS upgrade 只放行空 Origin（Electron file://、curl/Node 客户端）或回环源（127.0.0.1 / localhost / ::1）；其余源 HTTP 回 403、WS 拒绝升级。
- 数据目录 `<dataDir>/`（默认 `<cwd>/data`，已 gitignore）：`ryagent.db`（SQLite）、`config/providers.json`（首启写入内置 SiliconFlow 条目，key 走 `SILICONFLOW_API_KEY` 环境变量，配置文件不存明文）、`config/api-keys.json`（应用内配置的明文 key，0600）、`workspace/`（工具工作区与产物目录）。两个配置文件都按 0600 原子写入（先 `.tmp` 再 rename）。
- 首启种子：内置 Ryen 保证存在于 agents 表。
- 优雅停机：`RyAgentServer.close()` 幂等（重复调用复用同一停机流程）；先等在途 turn 完成（默认 10s 超时兜底，`shutdownTimeoutMs` 可调），再断 WS 客户端、关 HTTP server、关 SQLite；独立模式 SIGINT/SIGTERM 自动触发。

## HTTP API

统一约定：JSON；错误为 `{ "error": string }`；`content-type: application/json; charset=utf-8`。非法 JSON body 与非法 URL 编码回 **400**（客户端错误），不污染 500。

### Agents

| 方法与路径 | 说明 |
|---|---|
| `GET /api/agents` | 全部 agent 定义（含 builtin）。 |
| `POST /api/agents` | 创建。body：`{ templateKey? , name?, systemPrompt?, provider?, model?, temperature?, tools?, avatar? }`。带 `templateKey` 时从模板实例化（缺省字段用模板默认值，id 自动生成）。 |
| `PATCH /api/agents/:id` | 合并更新：与 POST 同款字段白名单校验（类型错误回 **400**，未知键丢弃；`isBuiltin` 不可变）。 |
| `DELETE /api/agents/:id` | 删除；builtin 返回 **409**；同时把该 agent 从所有会话的成员/调度员列表摘除。 |
| `GET /api/agent-templates` | 内置模板清单：`general`(通用助理 Ryen) / `coding` / `writing` / `translation` / `file-organizer`，各含 `suggestedSystemPrompt`、`defaultTools`、`defaultModel`。 |

### Conversations

| 方法与路径 | 说明 |
|---|---|
| `GET /api/conversations` | 按 updatedAt 倒序；每项附 `lastMessagePreview`（前 120 字符）与 `unreadCount`（seq > lastReadSeq 且非用户发送、含文本块的消息条数）。 |
| `POST /api/conversations` | `{"kind":"direct","agentId"}` 或 `{"kind":"group","memberAgentIds":[...],"dispatcherAgentId?","title?"}`（dispatcher 默认 `ryen`；成员须已存在，且**dispatcher 必须在 memberAgentIds 里**，否则 **400** 不建群）。 |
| `GET /api/conversations/:id` | 详情。 |
| `DELETE /api/conversations/:id` | 删除；消息与调度事件级联清除。 |
| `GET /api/conversations/:id/messages?before=<seq>&limit=<n>` | 游标分页：`before` 为 seq 游标（向过去翻页），默认取最新 50 条（上限 200），seq 升序返回。 |
| `GET /api/conversations/:id/messages?since=<seq>&limit=<n>` | 增量补齐：只回 seq **大于** `since` 的消息（断线重连按 seq 缺口回拉），seq 升序、取最新 `limit` 条；`since` 不是数字回 **400**（悄悄当 0 会把整段历史当增量发过去）。与 `before` 互斥，`since` 优先。 |
| `GET /api/conversations/:id/stream-seq` | 该会话当前的事件序号（WS 握手前取基线用）。 |
| `POST /api/conversations/:id/messages` | body `{ "text": "..." }` → **202** `{accepted:true, conversationId, streamSeq}`；处理异步进行，过程经 WS 推送。 |

消息行结构（StoredMessage）：`{ id, seq, conversationId, senderType: 'user'|'agent'|'system', senderId?, contentBlocks, mentions, toolCallId?, turnIndex, createdAt }`。`contentBlocks` 为 @ryagent/llm 的 ContentBlock JSON。

### Memories & 进化

| 方法与路径 | 说明 |
|---|---|
| `GET /api/agents/:id/memories` | 长期记忆：私有空间 active + 共享画像。 |
| `DELETE /api/memories/:id` | 记忆软删（status=deleted）。 |
| `GET /api/memory/archived` | 已归档（巩固判定长期零访问、status=inactive）的记忆，**全量**返回 `{ items }`，由调用方按 agentId 过滤。记忆系统关闭时回 `{ items: [] }`（面板每次打开都会拉，不该因此报错）。 |
| `POST /api/memory/restore` | body `{id}`：把一条归档记忆拉回 active（重新入检索与 FTS 索引）。不存在回 **404**，非归档状态回 **409**（软删不能靠 id 复活），记忆系统关闭回 **409**。 |
| `POST /api/memory/reembed` | 重建向量索引：为存量记忆回填当前 embedding 模型的向量（换模型后旧向量会被检索侧排除，不回填等于旧记忆静默退化成只走 BM25），返回 `{reembedded: n}`。无 embedding 凭据（纯 FTS5）或记忆系统关闭回 **409**——不假装"重建成功 0 条"。 |
| `GET /api/memory/stats` | 记忆统计 + embedding 可用性 + `recentLearned`（近 24h 新增）+ `consolidation`（周期与上次巩固时间）。 |
| `POST /api/feedback` | `{conversationId, agentId, signal: thumb_up\|thumb_down}`——👎 即时反思 + 归因 harmful；👍 归因 helpful。 |
| `GET /api/agents/:id/playbook` | 经验手册：playbook 条目（section 分组计数）+ 待验证教训。 |
| `POST /api/playbook/:id/status` | `{status: active\|deprecated}` 手动停用/恢复条目。 |
| `POST /api/evolve/consolidate` | 手动触发巩固（到期清理/重复记忆合并/dormant 统计）。 |

### Providers & 文件

| 方法与路径 | 说明 |
|---|---|
| `GET /api/providers` | 当前配置的供应商与模型清单：`{ id, displayName, protocol, baseUrl, custom, apiKeyConfigured, models }`。`custom` 区分内置/用户添加（决定 UI 分组与删除入口）；凭据只回答"配没配"，不回显值。 |
| `GET /api/provider-presets` | 添加供应商向导的预设目录：SiliconFlow / DeepSeek / Moonshot / 智谱 GLM / MiniMax / OpenRouter / OpenAI / Ollama，各含 `{ id, displayName, protocol, baseUrl, models, docsUrl }`。 |
| `POST /api/providers` | 新增供应商：body `{ displayName, protocol, baseUrl, models[], apiKey?, presetId? }` → **201** `{provider: ProviderInfo}`。路由写 `providers.json`，明文 key 写 `api-keys.json`（0600）；随后**热注册**适配器，不重启。校验失败（缺 displayName / 非法 protocol / 非 http(s) baseUrl / 空 models / 未知 presetId）回 **400**。`protocol: 'ollama'` 允许不填 key；其余也允许先留空（缺 key 的路由指向预留环境变量 `RYAGENT_API_KEY_<ID>`，真正用到时以"缺凭据"在本地失败，而不是发假 token 换回 401）。id 取未占用的 `presetId`，否则 `custom-<8位>`。 |
| `DELETE /api/providers/:id` | 删除用户添加的供应商（路由 + 其 key 一起清掉并热摘适配器）；内置条目回 **409**，未知 id 回 **404**。 |
| `POST /api/settings/api-key` | `{providerId, apiKey}`：写 `api-keys.json`（0600）并热更新适配器配置；未知 provider 回 **404**。 |
| `GET /api/files/:name` | 下载 `workspace/.ryagent-artifacts/` 下的产物文件；只允许叶子文件名（含 `/`、`\` 返回 **400**），MIME 按扩展名推断。 |

## WebSocket 事件契约（M4b 按此开发）

连接：`ws://127.0.0.1:32100/ws?conversationId=<id>`（每事件一条 JSON 文本帧）。

**协议完备性**：每条事件带该会话内单调递增的 `seq`（从 1 起，无订阅者时也递增）——客户端按 seq 发现断线缺口并重拉历史补齐。服务器每 30s 发 ping（`wsHeartbeatMs` 可调），连续两轮未 pong 的连接被 terminate；发送前检查 `bufferedAmount`，超过 1MB 判定慢消费者并断开。

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
- `llm`（只读）：`LlmRuntime`，用于查已注册的供应商路由与模型目录；
- `port: 0` 取随机端口（`server.url` 读实际地址）。

供应商的热注册：服务自己 `registerAdapter` 并持有句柄（重复 `registerAdapter` 会撞 `DUPLICATE_ADAPTER`），增删供应商时原地换适配器配置内容并 `replace` 路由集合——在途 turn 不受影响，每个请求在发出那一刻现读配置。

## 测试

`tests/server.test.ts`：真实 HTTP + WS 客户端跑通模板/CRUD/builtin 保护、PATCH 白名单校验、400/500 分界、Origin 白名单、WS seq/心跳 terminate、群聊端到端（WS 事件序列 + 落库一致）、direct 流式、文件下载白名单、close 幂等与优雅停机（等在途 turn + 超时兜底）。
`tests/providers.test.ts`：供应商预设目录、新增/删除自定义供应商（落盘 + 0600 + 热注册 + 跨重启持久化）、凭据热更新。
`tests/memory-admin.test.ts`：已归档列表、恢复（含 FTS 索引回来）、重建向量索引与"纯 FTS5 时 409"。
mock 适配器注入，不触网。
