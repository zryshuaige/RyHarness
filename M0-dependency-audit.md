# M0 依赖盘点：从 deepseek-harness 裁剪精简内核

> 日期：2026-10-11
> 源仓库：`F:\AgenticResearch\deepseek-harness`（上游原版 clone，pnpm monorepo，cordis DI）
> 目标仓库：`F:\AgenticResearch\RyAgent`（空目录，仅放本报告 + `.zcode/` 分析脚本）
> 分析方法：对 `packages/*/*/package.json`（name → dir 映射）做依赖闭包遍历 + 对 `src/` 做 import 扫描的"src 级闭包"遍历。脚本见 `.zcode/depscan.mjs`、`.zcode/srcclosure.mjs`，可复跑。

---

## 0. 执行摘要（TL;DR）

- **LLM 层可以单独裁剪**：`dsh-llm` 的声明依赖闭包只有 10 个包（llm 本体 + cordis/cosmokit/schemastery + 4 个 util 小包 + typert-protocol），约 **7.8k LOC**，与 agent 生态完全解耦。`dsh-attachment`、`dsh-invariants` 只是 `import type`（类型级依赖），运行期可不拷。
- **agent 运行时（dsh-agent + dsh-agent-loop）是耦合重灾区**：src 级闭包 26 个包、约 32k LOC。硬耦合点是 `AgentLoop.static inject = ['agents','sessions','llm','tools','systemPrompt','sessionProjections']`——tools（5.8k）会再拖入 sandbox / sandbox-policy / ptc-runtime / user-approval（约 1.7k）。
- **两个可低成本斩断的类型级依赖**：`dsh-agent → dsh-workspace`（仅 1 个 `SessionActivity` 类型 + 1 处接口增强，而 workspace 会拖入 storage 全家桶约 3.7k LOC）；`dsh-llm → dsh-attachment`（纯类型）。
- **"SQLite 会话持久化"是误判**：上游运行时会话持久化走 `session-persistence`（抽象缝）+ `session-persistence-jsonl`（唯一 shipped 后端，zstd 压缩 JSONL，约 5k LOC）。SQLite 只出现在 `storage-sqlite`（通用存储）和 `session-query-sqlite`（opt-in 全文检索/导出），**不在运行时关键路径上**。
- **多供应商有两条路**：(a) 直接拷 `llm-pi-ai`（4k LOC，靠 `@earendil-works/pi-ai` 库 + 配置 profile 声明协议，支持 openai-completions 等）；(b) 新写一个精简 OpenAI 兼容适配器，估算 **450–700 行**。
- **cordis 本体绕不开**：`LlmRuntime`、`AgentLoop`、`Session`、`LlmAdapter` 全部继承 cordis `Service`/`Context`。可以不带 cordis *插件生态*（loader/include/各插件包），但 cordis 核心（2.7k LOC）+ cosmokit + schemastery 是地基。若愿意做外科手术式重构（去掉 `TypertRemoteService` 基类），还能再省 typert-protocol（1.2k），但不建议 M0 阶段做。

---

## 1. `dsh-llm`（@deepseek-ai/dsh-llm）依赖闭包

### 1.1 package.json 声明依赖闭包（10 个包）

| 包 | 路径 | 文件数 | LOC | 角色 |
|---|---|---|---|---|
| @deepseek-ai/dsh-llm | packages/llm/llm | 14 | 4136 | LLM 服务缝：`LlmRuntime`（index.ts:342）、`LlmAdapter` 抽象类（index.ts:208）、`registerAdapter`（index.ts:396）、`StreamChunk` 协议（types.ts:452）、assistant-stream 组装、content/消息类型 |
| @deepseek-ai/cordis | vendor/cordis | 9 | 2705 | DI 核心（Context/Service/effect/logger/events）。**不可绕开** |
| @deepseek-ai/cosmokit | vendor/cosmokit | 7 | 598 | cordis 基础工具库，零依赖 |
| @deepseek-ai/schemastery | vendor/schemastery | 1 | 963 | schema 校验（config 校验用），依赖 cosmokit + @standard-schema/spec |
| @deepseek-ai/dsh-typert-protocol | packages/typert/protocol | 5 | 1196 | `TypertRemoteService` 基类 + `@Remote` RPC。LlmRuntime 继承它。**类型级可拆，继承级是硬依赖** |
| @deepseek-ai/dsh-brand | packages/util/brand | 1 | 40 | 常量字符串 |
| @deepseek-ai/dsh-util-values | packages/util/values | 1 | 307 | assertNever 等小工具 |
| @deepseek-ai/dsh-util-crypto | packages/util/crypto | 1 | 42 | hash 小工具 |
| @deepseek-ai/dsh-timeout | packages/util/timeout | 1 | 191 | idleWatchdog / timeoutOf（适配器流式超时用） |
| （npm 外部）zod ^4.4.3 | — | — | — | 已在 dependencies |

外部 npm 依赖：`zod`、`@standard-schema/spec`（schemastery 用）。

### 1.2 src 级 import 补充发现

- `@deepseek-ai/dsh-attachment`（content.ts / types.ts / index.ts）——**全部是 `import type`**（`AttachmentStore`、`FileAttachmentRef`、`ImageAttachmentRef`、`RequestImageAttachment` 等）。运行期零依赖；只有要支持图片/文件输入的运行时解析时才需要真身。
- `@deepseek-ai/dsh-invariants`（invariant.ts）——也是 `import type`（`InvariantFailure`/`InvariantInstaller`）。
- **结论**：只拷 LLM 包族 + vendor 三件套即可跑通"注册适配器 → stream"，不需要任何 agent/session 包。这是全仓库耦合度最低、价值最高的包。

---

## 2. agent 运行时 + 会话持久化闭包

### 2.1 种子包

- **agent 运行时核心**：`@deepseek-ai/dsh-agent`（packages/core/agent，agent 身份/模型选择/调度）+ `@deepseek-ai/dsh-agent-loop`（packages/core/agent-loop，消息循环 + tool calling 循环 + 会话发布）。注意：没有叫 "dsh-agent-core" 的包，就是这两个。
- **会话持久化缝**：`@deepseek-ai/dsh-session-persistence`（packages/session/session-persistence，后端无关的 create/open/append/flush 契约）。

### 2.2 src 级闭包（26 个包，约 32k LOC）

依赖链要点（谁拉进了谁）：

```
agent-loop → tools(5798) → sandbox(549) + sandbox-policy(284) + ptc-runtime(317) + user-approval(518)
agent      → workspace(1464) → storage(333) + storage-domain(927)   ← workspace 仅被 type-only 使用！
session    → scope / system-prompt / llm / typert-protocol（真用）
agent-loop → session-projection(740)（static inject 硬依赖）
agent-loop → session-persistence（ctx.get 可选，运行期可挂可不挂）
```

| 包 | LOC | 用途 | 耦合性质 |
|---|---|---|---|
| dsh-agent | 1695 | Agent 定义、dispatch、模型选择 | 硬 |
| dsh-agent-loop | 2481 | 循环本体：`AgentLoop extends Service implements AgentFactory`；inbox 调度；tool-calls 执行；turn 边界 | 硬 |
| dsh-session | 3398 | 会话模型/事件日志（消息、工具结果、版本化） | 硬 |
| dsh-tools | 5798 | 工具定义/调度缝（`TOOL_RUNTIME_SCHEDULER`、`ToolExecutionInput/Result`）。agent-loop 的 tool calling 循环走它 | 硬（via static inject），但接口收敛 |
| dsh-scope | 566 | 上下文作用域服务 | 硬（session/agent 都用） |
| dsh-system-prompt | 700 | 系统提示组装 | 硬（AgentLoop inject） |
| dsh-session-projection | 740 | 投影注册表（turnBoundary/inbox 投影） | 硬（AgentLoop inject），但接口很小 |
| dsh-session-persistence | 627 | 持久化契约（create/open/append/flush/close） | 硬（契约）；实现可换 |
| sandbox / sandbox-policy / ptc-runtime / user-approval | 1668 | 被 dsh-tools 拖入（工具执行运行时/审批） | 硬但可剪（见 §3） |
| workspace | 1464 | **仅 2 处 type-only import**（`SessionActivity` + 接口增强） | **假依赖，可 stub** |
| storage / storage-domain | 1260 | 被 workspace 拖入 | 随 workspace 一起可去掉 |
| dsh-attachment | 677 | llm 类型依赖 + tools 里可能真用 | 视工具需求 |
| cordis / cosmokit / schemastery / typert-protocol / brand / util-values / util-crypto / timeout / invariants | ≈6.3k | 同 §1 | 硬 |

### 2.3 SQLite 澄清

- 运行时会话持久化**不是 SQLite**：上游唯一 shipped 后端是 `@deepseek-ai/dsh-session-persistence-jsonl`（13 文件 4963 LOC，含 zstd 压缩、schema 迁移 generation、lease 单写者、worker 线程解码）。挂载方式：后端注册为 `ctx.sessionPersistence`，agent-loop 在发布会话前获取写句柄——**persistence 缺席时 loop 照常跑**（`ctx.get('sessionPersistence')` 可选）。
- SQLite 相关包都在可选路径上：`storage-sqlite`（443，通用 KV/entity 存储）、`session-query-sqlite`（1781，opt-in 全文检索，默认 `:memory:` + `openAt: never`）、`session-query/tool-session-query`（会话查询工具）。**M0 不需要**。

---

## 3. 耦合度判断：能否只拷 llm 包族？

**能，且非常干净。** 三档方案：

| 方案 | 内容 | 体量 | 代价 |
|---|---|---|---|
| A. 仅 LLM 层 | §1.1 的 10 个包 | ≈7.8k LOC | 自己写循环；拿不到 assistant-stream 组装之上的任何东西 |
| B. LLM + 自写薄循环（推荐 M0） | A + cordis 生态最小集 + dsh-session + dsh-agent（可参考） | ≈13k LOC | 自己实现 tool calling 循环（参照 agent-loop/src/tool-calls.ts 的接口形状，约 300 行可写个最小版） |
| C. 完整拷运行时 | §2.2 全量 | ≈32k LOC | tools 拖入 sandbox/ptc/approval 全家桶；workspace 假依赖需处理 |

- **cordis 插件生态完全可选**：vendor/loader（1064）+ vendor/include（343）只是 cordis.yml 声明式组合用的；bundle/preset/client/host/web 等全部不用拷。RyAgent 可以用代码方式组装 Context（`Context.activate` / 直接 new Service），不碰 yml loader。
- **typert-protocol**：LlmRuntime extends `TypertRemoteService`（RPC/远程 BFF 用）。保留 = 1.2k LOC 直接可用；想省就要改 dsh-llm 源码基类（M0 不建议）。
- **dsh-tools 的 4 个拖油瓶**（sandbox/sandbox-policy/ptc-runtime/user-approval ≈1.7k）：agent-loop 只用 `TOOL_RUNTIME_SCHEDULER` 一个符号做"工具怎么执行"的调度缝。若选方案 C 且不想带 sandbox，可给 dsh-tools 做一次小手术（把 scheduler 默认值改为内置直接执行），或接受这 1.7k。
- **可 stub 项汇总**：`dsh-workspace`（1 个类型）、`dsh-attachment`（类型）、`dsh-invariants`（类型，或拷真身仅 201 LOC）。

**硬依赖（任何方案都逃不掉）**：cordis、cosmokit、schemastery、dsh-llm、brand、util-values、util-crypto、timeout。
**可选插件（砍掉无感）**：llm-retry、token-meter、llm-pi-ai、llm-deepseek 全家、session-query-*、storage-*、attachment-local、loader/include、所有 bundle/preset/ui/api 包。

---

## 4. 新写精简 OpenAI 兼容适配器工作量评估

### 4.1 接口面（`LlmAdapter`，index.ts:208–291）

| 方法 | 必要性 | 说明 |
|---|---|---|
| `stream(options: GenerateOptions)` | **唯一抽象方法，必须实现** | 返回 `AsyncIterable<StreamChunk>`，必须 honor `options.signal` |
| `providerInfo(provider)` | 可选（有默认） | 返回 `{id, name}` |
| `providerRetryPolicy(provider)` | 可选 | 返回 `ResolvedRetryPolicy` 或 undefined |
| `listModels(provider)` | 可选 | GUI 选择用；返回 `[]` 不影响核心路由 |
| `resolveModel(provider, model, signal)` | 可选（有默认） | 返回 `LlmResolvedModelInfo`；默认只回显 id/name |
| `prepareCall(provider, model, signal)` | 可选（默认=resolveModel+stream） | 每步调用冻结用；精简版用默认即可 |
| `imageRequestPricing(...)` | 可选 | 图片计费，可不管 |

### 4.2 需要写的内部件（参照 llm-deepseek 与 llm-pi-ai）

| 部件 | 参照 | 估算 |
|---|---|---|
| 请求序列化：GenerateOptions（messages 含 tool 结果回传、ToolSchema[]、callConfig 温度/ maxTokens）→ OpenAI `chat/completions` JSON | llm-deepseek/src/serialize.ts（168 行，但那是 Anthropic Messages 协议 + 图片/文件） | 120–180 行 |
| SSE 解析 | llm-deepseek/src/sse.ts（28 行，用了 eventsource-parser）；llm-pi-ai 用 pi-ai 内建 | 30–50 行（直接依赖 `eventsource-parser` npm 包） |
| OpenAI chunk → `StreamChunk` 翻译：`choices[].delta` → text-delta / tool-call-delta（index/id/name/argumentsDelta）；`usage`（prompt/completion tokens）→ usage chunk；finish_reason → finish | llm-deepseek/src/translate.ts（166 行）；llm-pi-ai/src/stream.ts（234 行） | 150–220 行 |
| fetch + 错误映射（HTTP 状态 → `LlmError` code）、attributionHeaders() 注入 | llm-deepseek/src/adapter.ts（160 行）+ transport.ts | 60–100 行 |
| 配置/host（baseURL、apiKey 解析、cordis 插件注册类） | llm-pi-ai/src/index.ts（317 行） | 60–100 行 |
| idle watchdog / abort 编排 | dsh-timeout 已拷，`idleWatchdog` 直接用 | ≈0 |

**合计：约 450–700 行新代码**（含 host 插件类）。对照：llm-deepseek 全套 2810 行（含文件上传/图片/beta 头/重放等 DeepSeek 专属逻辑），llm-pi-ai 4057 行（通用但背着 pi-ai 库的配置/登录/catalog 体系）。精简版砍掉：图片/文件附件、reasoning replay（`replayState` 可省略，StreamChunk.finish 的 replayState 是可选字段）、目录发现、登录/OAuth。

**风险提示**：`GenerateOptions` 的消息历史是"provider 所见即所得"的规范化消息（含 tool_addition/tool_removal 等更新原语），OpenAI 协议没有 tool-removal 概念，序列化时需要做降级映射（llm-deepseek/serialize.ts 的 `onReplayDegrade` 思路可借鉴）。这是唯一有设计含量的点，其余是体力活。

### 4.3 另一条路：直接复用 llm-pi-ai

pi-ai 库（`@earendil-works/pi-ai` ^0.85.1）本身就支持 `openai-completions` 协议（dist 里可见 `api/openai-completions`），llm-pi-ai 的配置 profile 可按路由声明协议、baseURL、apiKeyEnv——**SiliconFlow/任何 OpenAI 兼容端点可以纯配置接入，零新代码**。代价：背 4k LOC 适配器 + pi-ai 库本体 + 配置解析。多供应商诉求强时这比新写更省；只想要"一个 OpenAI 适配器 + 也许 Anthropic"时新写更轻。

> 备注：任务背景里提到的 `cordis.patch.yml:359-369` SiliconFlow 配置在本 clone 中不存在（该文件相应行是 ui-* 插件清单；全仓 grep 无 siliconflow）。多供应商配置的真实机制是 `packages/bundle/base/cordis.patch.yml:127` 挂载 llm-pi-ai + settings 里的 `llm-pi-ai:` profile 段。

---

## 5. 最小拷贝清单

### 5.1 必拷（任何方案都需要）

| 包 | 路径（源仓库内） | 文件数 | LOC | 用途 |
|---|---|---|---|---|
| @deepseek-ai/dsh-llm | packages/llm/llm | 14 | 4136 | LLM 缝：LlmAdapter/LlmRuntime/StreamChunk/assistant-stream |
| @deepseek-ai/cordis | vendor/cordis | 9 | 2705 | DI 地基 |
| @deepseek-ai/cosmokit | vendor/cosmokit | 7 | 598 | cordis 依赖 |
| @deepseek-ai/schemastery | vendor/schemastery | 1 | 963 | config schema 校验 |
| @deepseek-ai/dsh-typert-protocol | packages/typert/protocol | 5 | 1196 | LlmRuntime 基类（如选重构方案可剔除） |
| @deepseek-ai/dsh-brand | packages/util/brand | 1 | 40 | 常量 |
| @deepseek-ai/dsh-util-values | packages/util/values | 1 | 307 | 工具函数 |
| @deepseek-ai/dsh-util-crypto | packages/util/crypto | 1 | 42 | hash |
| @deepseek-ai/dsh-timeout | packages/util/timeout | 1 | 191 | 流式 idle 超时 |
| @deepseek-ai/dsh-invariants | packages/runtime-diagnostics/invariants | 1 | 201 | 类型级依赖，建议直接拷真身（才 201 行） |
| @deepseek-ai/dsh-session | packages/core/session | 11 | 3398 | 会话模型（方案 B/C） |
| @deepseek-ai/dsh-agent | packages/core/agent | 9 | 1695 | agent 定义（方案 B/C；type-only 用到 workspace，需 stub `SessionActivity`） |
| @deepseek-ai/dsh-scope | packages/core/scope | 4 | 566 | 作用域服务（方案 C） |
| @deepseek-ai/dsh-system-prompt | packages/core/system-prompt | 2 | 700 | 系统提示组装（方案 C） |
| @deepseek-ai/dsh-agent-loop | packages/core/agent-loop | 8 | 2481 | 消息/tool 循环（方案 C） |
| @deepseek-ai/dsh-tools | packages/core/tools | 10 | 5798 | 工具调度缝（方案 C；会拖入下 4 个） |
| @deepseek-ai/dsh-sandbox | packages/sandbox/sandbox | 4 | 549 | 被 tools 拖入 |
| @deepseek-ai/dsh-sandbox-policy | packages/sandbox/sandbox-policy | 3 | 284 | 被 tools 拖入 |
| @deepseek-ai/dsh-ptc-runtime | packages/ptc-runtime/ptc-runtime | 2 | 317 | 被 tools 拖入 |
| @deepseek-ai/dsh-user-approval | packages/interaction/user-approval | 3 | 518 | 被 tools 拖入 |
| @deepseek-ai/dsh-session-projection | packages/session/session-projection | 2 | 740 | AgentLoop inject 需要 |
| @deepseek-ai/dsh-session-persistence | packages/session/session-persistence | 5 | 627 | 持久化契约 |

npm 外部依赖：`zod@^4`、`@standard-schema/spec`、`eventsource-parser`（新适配器用）、`@earendil-works/pi-ai`（若选 pi-ai 路线）。

### 5.2 建议拷（按诉求选）

| 包 | LOC | 何时拷 |
|---|---|---|
| @deepseek-ai/dsh-session-persistence-jsonl | 4963 | 要"开箱即用的 durable 会话"就拷（唯一 shipped 后端）；想极简可自写 JSONL/ SQLite 后端实现同一契约（契约才 627 行，后端接口不大） |
| @deepseek-ai/dsh-llm-pi-ai | 4057 | 多供应商诉求强、愿意背 pi-ai 库时——openai-completions/anthropic 等协议零代码接入 |
| @deepseek-ai/dsh-attachment | 677 | 要支持图片/文件输入时（llm/tools 的类型与运行时解析） |
| @deepseek-ai/dsh-llm-retry | 531 | 要瀑布式自动重试时（挂在 `llm/stream` waterfall 上，纯插件） |
| @deepseek-ai/dsh-token-meter | 1471 | 要 token 用量统计/计费投影时 |
| @deepseek-ai/cordis-plugin-loader + cordis-plugin-include | 1064+343 | 想用 cordis.yml 声明式组合时；代码组装则不需要 |
| @deepseek-ai/dsh-session-format (+ v0→…→v4 迁移链) | 945+ | 要兼容上游已发布的会话文件格式时；全新项目不需要 |
| @deepseek-ai/dsh-storage / storage-domain / storage-sqlite | 333+927+443 | 要 SQLite 通用存储时（与会话持久化无关） |
| @deepseek-ai/dsh-attachment-local | 1552 | 附件本地后端 |
| @deepseek-ai/dsh-session-query-sqlite | 1781 | 要会话全文检索时（非运行时必需） |

### 5.3 不用拷

- **DeepSeek 专属**：llm-deepseek（2810）、deepseek-llm-api-extensions、llm-deepseek-account、llm-deepseek-api-key、plugin-package-inventory-deepseek、session-log-deepseek。
- **整个上层应用**：bundle/*、preset/*、client/*、host/*、web/*、api/*、sdk/*、boot/*、acp/*、typert/*（protocol 除外）、workflow、webhook、schedule、hooks、extensions、guard、goal、plan、todo、jobs、subagent、skill、context、compaction、feedback、identity、settings、credentials、authorization、deliverables、interaction（user-approval 除外）、lsp、mcp、shell、subprocess、ssh、terminal、computer-use、browser-use、spill、document、fs、storage-json、experimental、test-support、runtime-diagnostics（invariants 除外）、workspace（stub 一个类型即可）。
- 上游各 profile bundle 的 cordis.patch.yml / cordis.yml 组合文件——RyAgent 用自己的组装代码替代。

---

## 6. 建议的 M0 落地形态

1. **拷 §5.1 的 LLM 子集**（llm + cordis + cosmokit + schemastery + typert-protocol + 4 util + invariants ≈ 10.5k LOC），vendor 三件套原样带 license 说明。
2. **新写 OpenAI 兼容适配器**（§4，450–700 行），只实现 `stream()` + 薄配置 host；`@deepseek-ai/dsh-timeout` 的 idleWatchdog 直接用。
3. **会话持久化二选一**：
   - 快：拷 session + session-persistence + session-persistence-jsonl（≈9k LOC），拿上游久经测试的 durable 实现；
   - 省：只拷契约（session-persistence 627 行）+ 自写 SQLite/JSONL 后端（估 400–600 行，契约方法只有 create/open/list/append/read/flush/close 七个）。
4. **agent 循环**：M0 建议参照 agent-loop 的接口形状自写最小循环（inbox → prepareCall → stream → assistant-stream 组装 → 执行 tool_calls → 追加消息），而不是整包搬运 dsh-tools/sandbox 生态；待需求明确后再决定要不要升级到方案 C。
5. cordis 组装用代码而非 yml（不拷 loader/include）。

**遗留问题**（需主 agent/用户决策）：
- 多供应商走 pi-ai 复用还是新写适配器（§4.3）；
- 会话持久化走 jsonl 后端还是自写 SQLite（若 RyAgent 明确要 SQLite，后者更顺）；
- agent 循环自写还是整包拷贝（体量差约 12k LOC）。
