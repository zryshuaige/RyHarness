# @ryharness/server

RyHarness 本地后端：HTTP API + WebSocket 推送。可被 Electron 主进程内嵌（`RyHarnessServer.create()`），也可独立启动：

```sh
pnpm dev          # 等价于 tsx src/main.ts（在 apps/server 目录）
# 或仓库根：环境变量 RYHARNESS_PORT / RYHARNESS_HOST / RYHARNESS_DATA_DIR
```

- 默认监听 `127.0.0.1:32100`（仅本机，安全边界依赖 OS 账户）。
- **Origin 白名单**：HTTP 与 WS upgrade 只放行空 Origin（Electron file://、curl/Node 客户端）或回环源（127.0.0.1 / localhost / ::1）；其余源 HTTP 回 403、WS 拒绝升级。
- 数据目录 `<dataDir>/`（默认 `<cwd>/data`，已 gitignore）：`ryharness.db`（SQLite）、`config/providers.json`（首启写入内置 SiliconFlow 条目，key 走 `SILICONFLOW_API_KEY` 环境变量，配置文件不存明文）、`config/api-keys.json`（应用内配置的明文 key，0600）、`proactive.json`（主动消息开关与每日发送时刻）、`conversation-state.json`（置顶/静音/改名等界面态）、`workspace/`（工具工作区与产物目录）。配置文件都按 0600 原子写入（先 `.tmp` 再 rename）。
- 首启种子：内置 Ryen 保证存在于 agents 表。
- 优雅停机：`RyHarnessServer.close()` 幂等（重复调用复用同一停机流程）；先等在途 turn 完成（默认 10s 超时兜底，`shutdownTimeoutMs` 可调），再断 WS 客户端、关 HTTP server、关 SQLite；独立模式 SIGINT/SIGTERM 自动触发。

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
| `GET /api/conversations` | 按 updatedAt 倒序；每项附 `lastMessagePreview`（前 120 字符）与 `unreadCount`（seq > lastReadSeq 且非用户发送、含文本块的消息条数）。有主动消息落过的会话另附 `proactive:true`（列表行的"主动"角标，见「主动消息」一节）。 |
| `POST /api/conversations` | `{"kind":"direct","agentId"}` 或 `{"kind":"group","memberAgentIds":[...],"dispatcherAgentId?","title?"}`（dispatcher 默认 `ryen`；成员须已存在，且**dispatcher 必须在 memberAgentIds 里**，否则 **400** 不建群）。 |
| `GET /api/conversations/:id` | 详情。 |
| `DELETE /api/conversations/:id` | 删除；消息与调度事件级联清除。 |
| `GET /api/conversations/:id/messages?before=<seq>&limit=<n>` | 游标分页：`before` 为 seq 游标（向过去翻页），默认取最新 50 条（上限 200），seq 升序返回。 |
| `GET /api/conversations/:id/messages?since=<seq>&limit=<n>` | 增量补齐：只回 seq **大于** `since` 的消息（断线重连按 seq 缺口回拉），seq 升序、取最新 `limit` 条；`since` 不是数字回 **400**（悄悄当 0 会把整段历史当增量发过去）。与 `before` 互斥，`since` 优先。 |
| `GET /api/conversations/:id/stream-seq` | 该会话当前的事件序号（WS 握手前取基线用）。 |
| `POST /api/conversations/:id/messages` | body `{ "text": "..." }` → **202** `{accepted:true, conversationId, streamSeq}`；处理异步进行，过程经 WS 推送。 |

消息行结构（StoredMessage）：`{ id, seq, conversationId, senderType: 'user'|'agent'|'system', senderId?, contentBlocks, mentions, toolCallId?, turnIndex, usage?, createdAt }`。`contentBlocks` 为 @ryharness/llm 的 ContentBlock JSON；`usage` 只挂在模型调用产出的 assistant 消息上（`{inputTokens, outputTokens, totalTokens?, …}`），`GET /api/usage` 的账单就是从这里聚合出来的。

### Memories & 进化

| 方法与路径 | 说明 |
|---|---|
| `GET /api/agents/:id/memories` | 长期记忆：私有空间 active + 共享画像。 |
| `DELETE /api/memories/:id` | 记忆软删（status=deleted）。 |
| `GET /api/memory/archived` | 已归档（巩固判定长期零访问、status=inactive）的记忆，**全量**返回 `{ items }`，由调用方按 agentId 过滤。记忆系统关闭时回 `{ items: [] }`（面板每次打开都会拉，不该因此报错）。 |
| `POST /api/memory/restore` | body `{id}`：把一条归档记忆拉回 active（重新入检索与 FTS 索引）。不存在回 **404**，非归档状态回 **409**（软删不能靠 id 复活），记忆系统关闭回 **409**。 |
| `POST /api/memory/reembed` | 重建向量索引：为存量记忆回填当前 embedding 模型的向量（换模型后旧向量会被检索侧排除，不回填等于旧记忆静默退化成只走 BM25），返回 `{reembedded: n}`。无 embedding 凭据（纯 FTS5）或记忆系统关闭回 **409**——不假装"重建成功 0 条"。 |
| `GET /api/memory/stats` | 记忆统计 + embedding 可用性 + `recentLearned`（近 24h 新增）+ `consolidation`（周期与上次巩固时间）。 |
| `GET /api/memory/health` | 记忆库整体健康度（一次请求给全，不用再去拼 stats / archived / telemetry 三条）：`{ enabled:true, total, archived, missingVectors, bySpace, dbBytes, embeddings:{label,model,dim?}, lastRecall? }`。`total` 含归档与软删链（口径同 `/api/memory/stats`），`missingVectors` 只数 active + inactive 中缺**当前** embedding 模型向量的条目，`dim` 在一条向量都没有时缺省而不猜；`lastRecall` 取遥测环形缓冲里最近一轮真的注入了记忆的轮次（`{conversationId, items, ms, at}`，只存在于本次运行内）。`dbBytes` 是 `<dataDir>` 下库文件（含 WAL）的总字节——记忆与会话/进化共用同一个 `ryharness.db`，这是"数据一共多大"而非"记忆独占多少"。记忆系统关闭回 **200** `{enabled:false}`，未知查询参数回 **400**。 |
| `POST /api/feedback` | `{conversationId, agentId, signal: thumb_up\|thumb_down, messageId?}`——👎 即时反思 + 归因 harmful；👍 归因 helpful。亲密度 bump 内联在这里做（反馈被接受才涨），回包带更新后的 `agent`。带 `messageId` 时按 messageId+signal 防刷去重：同一消息同一信号重复提交幂等返回 `{recorded:false, duplicate:true}`，不动亲密度、不进进化通道；换信号算改主意，照常接受。进化系统关闭回 **409**。 |
| `GET /api/agents/:id/playbook` | 经验手册：playbook 条目（section 分组计数）+ 待验证教训。 |
| `POST /api/playbook/:id/status` | `{status: active\|deprecated}` 手动停用/恢复条目。 |
| `POST /api/evolve/consolidate` | 手动触发巩固（到期清理/重复记忆合并/dormant 统计）。 |
| `GET /api/evolve/stats?limit=<n>` | 进化管线可观测性：最近 `limit` 轮（新的在前）+ 各类轮次合计与耗时。进化在服务端是后台异步跑的（反思/归因/巩固都不在用户那一轮的关键路径上），出错时界面上没有任何提示——这个端点是那条唯一的观测面。进化系统关闭回 **200** `{enabled:false}`。 |
| `GET /api/evolve/entries/:id/explain` | 单条 playbook 条目的证据链（条目本体 + 溯源的教训/对话/记忆 + 一句人话摘要），回答"它凭什么这么说"。未知 id 回 **404**，进化系统关闭回 **409**。 |

### 主动消息（每日回顾）

agent 每天至多主动说一次：把**确实发生过**的变化（手册新增的条目、新记住的事、上一轮巩固合并/归档了多少、哪个会话还没看）写成一条 assistant 消息，落在用户与 Ryen 的单聊里。

- **触发**：服务启动后一次（当天还没发过时），之后每天一次；默认发送时刻是本地 9 点（错过就在当天后面的检查里补发），检查间隔 30 分钟。判重按**本地日期**，同一天反复检查也只发一次。
- **内容只来自真实数据**：没有可说的事就**安静**——不发消息，也不凭空建一个空会话。手册里的种子条目不算"学到的"（否则每次启动都会报一次假新闻）。
- **落库形状**：`senderType:'agent'`、`senderId:'ryen'`，`contentBlocks` 为 `[{type:'proactive'},{type:'text',…}]`。标记块独立于正文：正文照常喂给模型与全文索引，渲染层凭这个块给"Ryen 主动找你"标识。`GET /api/conversations` 在有主动消息的会话上附 `proactive:true`（列表行的"主动"角标）。
- **默认开启**，用户可关：设置写在 `<dataDir>/proactive.json`（`{"enabled":true,"hour":9}`），重启后仍生效。

| 方法与路径 | 说明 |
|---|---|
| `GET /api/proactive` | `{ enabled, hour, intervalMs, lastSentAt?, lastSentDay?, sentToday, conversationId? }`：`sentToday` 是判重的真值（重启后回到 false），`lastSentAt`/`lastSentDay` 回答"上次主动消息是什么时候发的"。同一份快照也挂在 `GET /api/telemetry` 的 `proactive` 字段上。 |
| `PATCH /api/proactive` | body `{ enabled?: boolean, hour?: number }`（`hour` 为本地小时 0-23）→ **200** 改完之后的完整快照。只认这两个键：未知键、非布尔 `enabled`、越界或非整数的 `hour` 一律回 **400**（悄悄忽略后回一份"看起来对"的值等于没关）。 |

### 用量 & 运行时可观测性

| 方法与路径 | 说明 |
|---|---|
| `GET /api/usage?since=<毫秒时间戳>` | token 账单的**两个维度**：`{ byConversation:[{conversationId,title,kind,input,output,total,messages}], byProvider:[{provider,displayName,input,output,total,agents:[{agentId,name,total}]}], totals:{input,output,total} }`。数据来自 `messages.usage`（每条 assistant 消息挂一次模型调用的开销）与 `agents.provider`，两个维度从同一批消息算出，因此 `Σ byConversation == Σ byProvider == totals`；`totalTokens` 缺失时按 `input+output` 兜底。只回有消耗的会话/供应商（空账本回空数组），两维都按花费倒序。供应商 `displayName` 取自 `GET /api/providers` 的同一份配置；发言 agent 已被删除时归到 `provider:"unknown"`（显示名"未知供应商"），花费不从账单里消失。`?since=` 缺省或空串 = 不限（`{input:0,output:0,total:0}` 空账本），非数字/负数或任何未知查询参数回 **400**。 |
| `GET /api/telemetry?limit=<n>` | 运行时可观测性：`{ turns, requests, capacity, proactive }`，两类环形缓冲（各 `capacity=200`）按时间倒序。轮次项含 `firstTokenMs`（首 token 延迟）、`totalMs`、`memoryRecallMs`/`memoryItems`（该轮的召回计量）、`status`。**只含方法/路径/状态码/耗时等计量数字，不含查询串、消息正文与凭据**（快照要原样发给渲染层，搜索词与正文会随 query 进来）。`proactive` 与 `GET /api/proactive` 同源，见上一节。 |

### Providers & 文件

| 方法与路径 | 说明 |
|---|---|
| `GET /api/providers` | 当前配置的供应商与模型清单：`{ id, displayName, protocol, baseUrl, custom, apiKeyConfigured, models }`。`custom` 区分内置/用户添加（决定 UI 分组与删除入口）；凭据只回答"配没配"，不回显值。 |
| `GET /api/provider-presets` | 添加供应商向导的预设目录：SiliconFlow / DeepSeek / Moonshot / 智谱 GLM / MiniMax / OpenRouter / OpenAI / Ollama，各含 `{ id, displayName, protocol, baseUrl, models, docsUrl }`。 |
| `POST /api/providers` | 新增供应商：body `{ displayName, protocol, baseUrl, models[], apiKey?, presetId? }` → **201** `{provider: ProviderInfo}`。路由写 `providers.json`，明文 key 写 `api-keys.json`（0600）；随后**热注册**适配器，不重启。校验失败（缺 displayName / 非法 protocol / 非 http(s) baseUrl / 空 models / 未知 presetId）回 **400**。`protocol: 'ollama'` 允许不填 key；其余也允许先留空（缺 key 的路由指向预留环境变量 `RYHARNESS_API_KEY_<ID>`，真正用到时以"缺凭据"在本地失败，而不是发假 token 换回 401）。id 取未占用的 `presetId`，否则 `custom-<8位>`。 |
| `DELETE /api/providers/:id` | 删除用户添加的供应商（路由 + 其 key 一起清掉并热摘适配器）；内置条目回 **409**，未知 id 回 **404**。 |
| `POST /api/settings/api-key` | `{providerId, apiKey}`：写 `api-keys.json`（0600）并热更新适配器配置；未知 provider 回 **404**。 |
| `GET /api/plugins` | 插件清单：`{ plugins:[{ id, name, description, group?, capabilities?:{tools?,routes?}, impact?, enabled, core, status, error? }] }`。`group` 给设置页分组（`core`/`feature`/`voice`/`tool`），`capabilities` 声明该插件提供的工具名与 HTTP 路由，`impact` 是关闭后果的一句人话；`status` 是运行态（`running`/`stopped`/`error`），不是配置文件里的愿望值。 |
| `PATCH /api/plugins/:id` | body `{ enabled: boolean }` → **200** `{plugin}`。切换会**真实卸载/重挂**该插件的 cordis fiber（注册表里的工具与模型路由同时增减），不是只写配置；`core` 插件（`core-tools`、`llm-openai`）回 **403** `CORE_PLUGIN`，未知 id 回 **404**。开关落盘在 `<dataDir>/config/plugins.json`（缺省=启用）。 |
| `GET /api/questions?conversationId=<id>&status=pending` | `ask_user` 的问题列表：`{ questions:[{ id, conversationId, agentId?, question, options?, multiple?, askedAt, answer?, selected?, answeredAt?, deliveredAt? }] }`。`status` 取 `pending`/`answered`/`all`（缺省 all）；会话不存在回 **404**。 |
| `POST /api/questions/:id/answer` | body `{ text, selected?: string[] }` → **200** 问题对象。`text` 非空；回答写入 `<dataDir>/questions.json`，下一轮用户消息会把它注入发起提问的 agent。未知 id 回 **404**。 |
| `GET /api/files/:name` | 下载 `workspace/.ryharness-artifacts/` 下的产物文件；只允许叶子文件名（含 `/`、`\` 返回 **400**），MIME 按扩展名推断。 |
| `GET /api/files/:name/info` | 产物预览的元数据 `{name, path, size, mime}`；`path` 是工作区内的**绝对路径**，渲染层靠它做「用系统程序打开 / 复制路径」。只允许叶子文件名，另走 fs 工具那一份 `resolveTarget`（工作区里的符号链接指到外面回 **403**）。 |
| `GET /api/files/:name/raw` | 产物预览的原始字节，`Content-Disposition: inline`（`?download=1` 改成 attachment）。给内嵌预览的 `<img src>` / `<iframe src>` 直接消费；超过 32MB 回 **413**（整份拒，不截断——截断出来的 PDF 看起来正常、其实缺内容）。边界校验同 `/info`。 |
| `POST /api/conversations/:id/files` | 上传附件：body `{name, mime?, data(base64)}` → `{name, size, mime}`。字节与消息体走同一条 JSON 通路，解码后落进工作区产物目录（与 `file_produce` 的产物同一份）；同名自动加 `-2`/`-3` 后缀不覆盖，上限 20MB（超限 **413**），base64 必须规范，文件名只放行叶子名。 |
| `POST /api/vibe` | 开一次 RyVibe：body `{ requirement }`（≤500 字）→ **201** `{ session }`。服务端建一个群会话并给它挂上「盘问与落地」这套方法（skill）与两个工具：盘问（每题必带选项）与落盘（把方案写成产物）。需求为空或超长回 **400**；通讯录里没有助理回 **409**。 |
| `GET /api/vibe/:id` | 这次 RyVibe 的当前状态：`{ session, questions[], output[], todos[] }`。`output` 只回 `?after=<seq>` 之后的新产出（增量轮询，别把整份方案重发一遍）；`questions` 含已答的（答完折成一行留在页面上，用户要能核对「AI 到底问过我什么」）；`todos` 是落盘时写进待办的那几条任务。未知 id 回 **404**。 |
| `GET /api/vibe/:id/file?name=<文件名>` | 读产物里的一个文件 → `{ name, size, content }`。**只认落盘时记下的那份文件清单**：目录名与文件名都来自模型，这条路不能变成任意文件读取的口子（清单外的名字回 **404**），超过 512KB 回 **413**。 |
| `POST /api/vibe/:id/answer` | 回答盘问：body `{ answers: [{questionId, selected[]}], skipped? }` → **200** `{ session }`。**一次交上整张卡**（分四次请求会让小队跑两遍），答案写进小队共同看到的那条正文里——问是全队一起问的，答案也得全队一起看见。题 id 不属于这次 RyVibe 回 **404**。 |
| `POST /api/vibe/:id/retry` | 重来一次：带着已经答过的答案重新排队一轮 → **202** `{ session }`。失败之后用户最需要的就是这条。 |
| `POST /api/vibe/:id/restore` | 恢复产物版本：body `{ versionId }` → **200** `{ session }`。每次验收通过都会保存独立文件快照，恢复会把快照内容写回当前项目，不是只改元数据。未知任务或版本回 **404**。 |
| `GET /api/vibe` | 最近几次 RyVibe（新→旧，最多 10 条）：`{ sessions[] }`，给页面挂载时「回到上次」用。`session.stage` 是持久阶段（clarify/plan/execute/verify/deliver/failed），`project.validation` 是验收报告，`versions` 是可恢复版本；没有通过的验收报告不能进入 done。 |

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

`RyHarnessServer.create(options)`：
- `mountLlm(ctx)`：替换默认 OpenAI 适配器挂载（测试注入 mock）；
- `plugins`：在全部内置插件之后追加的插件清单（`core-tools`、`llm-openai`、`voice`、`voice-piper`、`todo`、`ask-user`、`web-read`），用于测试注入与预留的用户插件位；
- `providersConfig`：内存覆盖 providers.json；
- `llm`（只读）：`LlmRuntime`，用于查已注册的供应商路由与模型目录；
- `tools`（只读）：`ToolRegistry`，当前注册的工具（按 agent 白名单逐轮解析）；
- `port: 0` 取随机端口（`server.url` 读实际地址）；
- `consolidationIntervalMs`：巩固周期（默认 6 小时，0 = 关闭）；
- `proactive: false`：关掉主动消息（默认开，见「主动消息」一节）；`proactiveHour` 覆盖每日发送时刻，`proactiveIntervalMs: 0` 只保留启动那一次（测试用小值把每日检查拉成毫秒级）。

插件装配：`ctx.plugin(LlmRuntime)` → `ctx.plugin(ToolRegistry)` → 按清单顺序 `await ctx.plugin(entry.apply, entry.config)`；关闭时 `PluginHost` 逆序 dispose 各插件 fiber。`core-tools` 在 apply 里把四个基础工具注册进 `ctx.tools`，`llm-openai` 首次挂载供应商路由并把 `replace` 句柄交回服务；`ask-user` 注册 `ask_user` 工具与问题路由，`web-read` 注册 `read_url` 工具（无 HTTP 面）。

供应商的热注册：服务持有 `llm-openai` 插件交回的 `AdapterRegistrationHandle`（重复 `registerAdapter` 会撞 `DUPLICATE_ADAPTER`），增删供应商时原地换适配器配置内容并 `replace` 路由集合——在途 turn 不受影响，每个请求在发出那一刻现读配置。启动时零路由（插件 dormant）后新增第一个供应商，则走 `mountOpenAiAdapters` 补挂。

## 测试

`npx vitest run apps/server`（全部用临时数据目录，mock 适配器注入，不触网）。

- `tests/server.test.ts`：真实 HTTP + WS 客户端跑通模板/CRUD/builtin 保护、PATCH 白名单校验、400/500 分界、Origin 白名单、WS seq/心跳 terminate、群聊端到端（WS 事件序列 + 落库一致）、direct 流式、文件下载白名单、close 幂等与优雅停机（等在途 turn + 超时兜底）。
- `tests/conversation-admin.test.ts`：会话改名/置顶/静音/群成员覆盖的落盘与重启后恢复、删会话/删 agent 的级联清理。
- `tests/turn-lifecycle.test.ts`：一轮 turn 的落库与 WS 序列、取消时"半截回复已落库、消息正常收尾、再以 ABORTED 结束"。
- `tests/attachments.test.ts`：附件上传/下载、同名不覆盖、叶子名白名单与穿越防护、20MB 上限回 413 且不留残骸。
- `tests/providers.test.ts` / `tests/provider-verify.test.ts`：供应商预设目录、新增/删除自定义供应商（落盘 + 0600 + 热注册 + 跨重启持久化）、凭据热更新；连通性探测的三种中文诊断（401 / 连接被拒 / 网络不可达）都是 200 而非 500。
- `tests/memory-admin.test.ts`：已归档列表、恢复（含 FTS 索引回来）、重建向量索引与"纯 FTS5 时 409"。
- `tests/evolve-observability.test.ts`：`GET /api/evolve/stats` 与 `/explain`，以及巩固走 `runUntilIdle`（分片任务不能拿第一片当整轮结果）。
- `tests/telemetry.test.ts`：环形缓冲与单轮累计器的语义；端到端一轮真实对话后遥测里有完整轮次计量、请求计时不含查询串与正文；多会话并发时召回计量各归各的轮次。
- `tests/proactive.test.ts`：主动消息的一天一次（假时钟跨天）、关闭后不发（含设置落盘与重启）、没有内容就安静（连空会话都不建）、文案里的数字与真实数据对得上、`GET/PATCH /api/proactive` 与遥测里的观测字段。
- `tests/usage-health.test.ts`：`GET /api/memory/health`（总数/归档/缺向量/各空间/体积/embedding 状态、重建向量后缺向量清零、纯 FTS5 降级、记忆关闭回 `{enabled:false}`、一轮真实对话后的 `lastRecall`、未知参数 400）与 `GET /api/usage`（两维聚合口径与合计自洽、`totalTokens` 缺失兜底、`?since=` 过滤与空参数、非法参数 400、空账本、agent 已删除归未知供应商、界面态改名后的标题）。
- `tests/seed.test.ts`：内置模板与首启种子。
