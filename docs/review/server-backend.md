# apps/server 后端评审报告

评审日期：2026-10-12。评审范围：`apps/server`（HTTP API、WS 协议、进程生命周期、单会话串行队列、配置/.env 边界），必要时下钻到 `packages/session`、`packages/evolve` 取证。只读评审，未修改任何源码。

代码量：8 个源文件约 1400 行。总体印象：骨架干净、抽象克制（零依赖自研 Router/EventHub），错误码语义大体一致，turn 链实现正确。主要差距集中在 **WS 协议完备性**（无心跳/无 seq/无鉴权）与 **输入校验/错误码精度**（PATCH 裸合并、非法 JSON 回 500）两处。

---

## P0（正确性 / 安全 / 数据损坏）

无。路径穿越、SQL 注入面、Promise 断链等高危项均未发现实锤问题。

---

## P1（明显的健壮性 / 安全 / UX 缺陷）

### P1-1 `PATCH /api/agents/:id` 无输入校验，原始 body 直接合并入库

`app.ts:292-306`：`const merged = { ...existing, ...body ?? {}, id, isBuiltin }` —— 客户端可写入任意形状：`temperature: "abc"`、`tools: "not-an-array"`、甚至 `createdAt`/`updatedAt` 等无关字段，全部原样进 `store.upsertAgent()`（`packages/session/src/store.ts:83-101` 无校验），`rowToAgent`（store.ts:115-129）读出时产生 `NaN`/`parseJsonArray` 兜底值，后续 LLM 调用拿到非法 temperature 直接失败。对比同文件 `POST /api/agents`（app.ts:262-290）有完整的字段类型白名单，PATCH 明显是漏网。
**修复**：抽取 POST 用的白名单校验为共用函数，PATCH 只合并通过校验的字段。

### P1-2 非法 JSON body / 非法 URL 统一回 500，错误码语义错误

`router.ts:60-67`：`JSON.parse(text)` 抛 `SyntaxError` 后冒泡到 `app.ts:183-186` 的全局 catch，回 `{ error: message }` + 500。`router.ts:53` 的 `decodeURIComponent` 抛 `URIError`、`app.ts:237` 的 `new URL()` 抛 `TypeError` 同理。客户端 malformed request 收到 500（服务器内部错误）而非 400（请求错误），违背 REST 语义，也污染日志告警。
**修复**：Router 内捕获 parse/decode 错误回 400；`onRequest` 的 URL 解析同样 try/catch 回 400。

### P1-3 WS 无心跳、无背压，死连接与慢客户端会静默堆积

`app.ts:221-223` + `bus.ts:30-40`：`hub.publish` 同步调用 `ws.send()`，不检查 `ws.bufferedAmount`；也没有 ping/pong 心跳。后果：(a) 渲染进程崩溃/系统休眠后的半死连接永远留在 `wss.clients` 和 hub 订阅里，事件持续写入其缓冲区，内存只增不减；(b) 一个忙于重绘的慢客户端会把全量 text-delta 积在缓冲中，恢复后收到陈旧洪峰。
**修复**：30s 间隔 `ws.ping` + 未响应即 `terminate()`；`send` 前检查 `bufferedAmount` 超阈值（如 1MB）时丢弃 delta 类事件或断开。

### P1-4 优雅停机不等在途 turn：DB 先关，写库抛错、error 事件无处可达

`app.ts:195-204`：`close()` 先 terminate WS 客户端、再 `http.close()`、**立即** `store.close()`，但 `turnChains`（app.ts:245）里仍在跑的 LLM 流会继续执行 `coordinator.chatDirect/chatGroup` 并写已关闭的 SQLite（better-sqlite3 抛 `ERR_INVALID_STATE`），只能靠 `runTurn` 的 try/catch（app.ts:737-742）兜住——而 WS 客户端已被 terminate，error 事件无人接收，用户看到的就是消息永远停在半路。Electron 侧 `before-quit` 还是 `void server.close()`（`apps/desktop/electron/main.ts:102-104`）不 await。
**修复**：`close()` 先 `await Promise.race([Promise.allSettled([...this.turnChains.values()]), timeout(5s)])` 再关 DB。

### P1-5 WS/HTTP 无任何鉴权或 Origin 校验（独立模式固定端口）

`app.ts:209-219`：upgrade 只校验 `conversationId` 存在；`DEFAULT_PORT = 32100` 固定（app.ts:92）。浏览器网页可跨源建立 WS（WS 不受 CORS 约束），知道/猜到 conversationId 即可订阅全部事件流；HTTP 虽受 CORS 读限制但写（POST）可被 `no-cors` 简单请求发起。Electron 模式用随机端口（`apps/desktop/electron/main.ts:80`）部分缓解，但独立 dev 模式（`pnpm dev`）完全暴露。
**修复**：启动生成随机 token，注入 `server.url` 与 preload，`/ws` upgrade 与 `/api/*` 校验之；或至少校验 `Origin` 头为本地应用。

### P1-6 `close()` 非幂等，重复调用直接 reject/throw

`app.ts:195-204`：双 SIGINT（`main.ts:29-30` 的 handler 无重入保护）、或 `before-quit` 与信号同时触发时，第二次 `close()` 会因 `http.close` 回调 error、`wss.close` 及 `store.close()`（重复关闭 better-sqlite3 句柄抛 `ERR_INVALID_STATE`）而整体 reject。`main.ts:20-28` 的 `shutdown` 也没有 once 保护。
**修复**：类内加 `private closed = false` 短路；`shutdown` 用 `once` 语义包裹。

### P1-7 WS 事件无单调序号，断线重连后客户端无法精确对齐

`events.ts:13-65` 全部 9 种事件都没有 seq/offset 字段；`POST /api/conversations/:id/read`（app.ts:509-517）推进 `lastReadSeq` 的前提是客户端能知道"我看到哪条"，但 WS 流式事件（text-delta 等）与 `store.listMessages` 的 `seq` 体系无对应关系。断线期间的丢窗只能靠整页重拉历史，无法增量补齐，流式中途断开的那条消息状态也无法恢复。
**修复**：给 message-start/done 等关键事件带上与消息表一致的 `seq`，客户端按 seq 续传。

---

## P2（简洁性 / 一致性 / 打磨）

### P2-1 首启时 `loadProvidersConfig` 读文件两次
`app.ts:133` 与 `app.ts:139` 在无 `providersConfig`/`mountLlm` 时各调一次（首次启动会重复写一遍默认文件，内容相同无害）。**修复**：提一个 `const providers = ...` 于 if/else 之前。

### P2-2 500 响应回显 `error.message`
`app.ts:184`：把内部异常原文回给客户端。本机单用户场景可接受，但按顶级项目惯例应内部 log、外部回 `"internal error"`。**修复**：响应固定文案，细节写 stderr。

### P2-3 路由无 405
`router.ts:42-72`：路径匹配但 method 不符时落入 404。**修复**：遍历时记录"路径曾匹配"，method 全不符回 405 + `Allow` 头。

### P2-4 `queued` 事件 turnIndex 重复
`app.ts:556-561` 与 `app.ts:608-613`：排队消息在入库前读 `nextTurnIndex`，同一链上多条 queued 事件拿到相同 turnIndex，UI 无法区分排队顺序。**修复**：入链时以"链上已有消息数"递增分配 turnIndex。

### P2-5 body 无大小上限
`router.ts:60-67`：chunks 无界累积，单请求可耗尽内存（本机自用场景影响有限，但一行可堵）。**修复**：累计超 1MB 回 413 并 `req.destroy()`。

### P2-6 文件下载流无错误处理
`app.ts:595-596`：`createReadStream` 在 existsSync 与 open 之间的竞态（或中途读错误）下触发 stream `error` 事件，无 handler 会导致进程级 unhandled error。**修复**：`stream.on('error', () => { if (!res.headersSent) json(res, 500, ...) else res.destroy() })`。

---

## 关于 .env 解析（边界说明）

`apps/server` 本身**不解析 .env**，只读 `process.env`（`config.ts:55-63` 的 `providerKeyConfigured` 只看存在性、不泄露值；apiKey 一律经 `apiKeyEnv` 间接引用不落盘——设计正确）。`.env` 解析在 `apps/desktop/electron/main.ts:21-41`（属 desktop 评审域），快速过一眼：环境变量优先不覆盖、key 白名单正则、逐文件命中即停，安全基线 OK；小瑕疵（不支持行内 `#` 注释、引号剥离只剥边缘单个字符）留待 desktop 报告。

## 单会话串行队列专项结论

`enqueueTurn`（app.ts:602-623）是本次评审最担心的点，结论：**实现正确**。(a) `tail.catch(() => {})` 保证前置 turn 失败不阻断后续；(b) map 清理挂在 `run` 的派生链上而非 `run` 本身，且 resolve/reject 双路径都做了"仅当仍是自己时才删除"的比对（app.ts:617-621），无断链、无错删。`EventHub` 单订阅者异常隔离（bus.ts:34-38）也到位。

---

## 做得好的地方

- **turn 链无双删/断链**（见上节），这是事件驱动串行队列最容易写错的地方。
- **路径穿越防护完备**：`/api/files/:name`（app.ts:584-597）拦 `/`、`\`、`.`、`..`，且 router 先 `decodeURIComponent`（router.ts:53）再校验，`%2e%2e` 等编码绕过无效。
- **SQL 全参数化**：下钻确认 `packages/session/src/store.ts` 全部 `prepare(...).run(?)`，无字符串拼接 SQL，无注入面。
- **错误码大体一致且有语义**：404（不存在）/409（builtin 禁删、子系统禁用、冲突）/202（异步 Accepted + 经 WS 推送）/201（创建），delete 回 `200 {deleted:id}` 而非语义含混的 204。
- **凭据不落盘**：providers.json 只存 `apiKeyEnv` 引用（config.ts:19-30），`GET /api/providers` 只暴露 `apiKeyConfigured` 布尔（app.ts:567-580），不泄露 key 值。
- **优雅停机顺序正确**：terminate WS → http.close → 关三个 DB（顺序对，只是不等在途任务，见 P1-4）。
- **consolidation timer 有 stopConsolidation** 且 `close()` 会清（`packages/evolve/src/service.ts:95-98, 344-361`），无 timer 泄漏。

## 总体判断：离顶级开源项目还差什么

架构与骨架已达"可维护的开源项目"水准（分层清晰、零依赖核心、错误码有思考、串行队列写对了）。差距是**完备性**而非**方向**：WS 协议还停在"能跑"阶段——心跳、背压、seq 对齐、握手鉴权四件事补上了才算生产级协议；输入校验呈"POST 严、PATCH 裸"的不一致状态，需要收敛到 schema 校验一层；错误码精度（400/500 分界、405）需要一轮打磨。修复量估计：P1 全部 + P2 大部约 200-300 行改动 + 若干测试，无架构级返工。

计数：**P0 = 0，P1 = 7，P2 = 6**。
