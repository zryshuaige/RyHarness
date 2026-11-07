# 死代码门禁规则 C 审计：未引用值导出的分类

> 2026-11-07 · 基准 v0.5.0 工作树 · 数据来自 `scripts/verify-no-dead-code.mjs --list`
> （修复 `$` 假阳性后为 108 条）逐条复核。

## 口径

- 规则 C 的「引用」是**纯文本出现**：全仓语料挖掉定义文件后按词边界找名字，注释、
  字符串、测试里的出现都算引用。所以清单上是「连文本都没出现过一次」的导出；动态
  引用（字符串方法名、运行时拼接、配置 JSON）不会被它报出来。
- 每条的「值是否活着」由复核脚本判定：在定义文件里数名字的出现次数（挖掉导出声明
  行那一行）。大于 0 → 值活着；等于 0 → 值也死了（已对 7 条 DEAD 在全仓范围内含
  json/md 交叉核对，均为零出现）。
- 保守方向：注释里的 `{@link X}` 也算「活着」，ALIVE 判定不会导致误删；DEAD 判定
  动手前仍要人眼确认。

## 结论：108 条 = 101 条「导出死了、值活着」+ 7 条「值也死了」

- **导出死了、值活着（101 条）**：定义文件内部仍在使用，只多了 export 关键字。
  处置 = 去掉 export（或留作测试注入点时在行内注明），**不动函数体**，零行为风险。
- **值也死了（7 条）**：真死代码候选，处置 = 下个清理波次逐条确认后删除。

**本轮一条都不清**（评审结论：动态引用静态证不了，不一把清）。这张表是清理波次的输入。

## 一、值也死了（7 条，真死代码候选）

| 文件 | 导出名 | 种类 | 说明 |
|---|---|---|---|
| apps/desktop/renderer/src/store.ts | streamingOf | function | ChatSnapshot 的派生判定函数，渲染层重构后无人调用 |
| apps/server/src/plugins/browser.ts | detectBrowserExecutable | function | browser 插件改用 @ryharness/browser-use 的探测后遗留 |
| packages/util/brand/src/index.ts | brandNumber | function | util/brand（豁免包）的库面，monorepo 内无人用 |
| packages/util/crypto/src/index.ts | bytesToBase64 | function | util/crypto（豁免包）的库面，monorepo 内无人用 |
| packages/util/timeout/src/index.ts | clampTimeout | function | util/timeout（豁免包）的库面，monorepo 内无人用 |
| packages/util/values/src/index.ts | WeakMapWithValues | class | util/values（豁免包）的库面，monorepo 内无人用 |
| packages/util/values/src/index.ts | isJsonValue | function | util/values（豁免包）的库面，monorepo 内无人用 |

## 二、导出死了、值活着（101 条）

| 文件 | 导出名 | 种类 | 备注 |
|---|---|---|---|
| apps/desktop/electron/main.ts | generateApiToken | function | 值在文件内自用 |
| apps/desktop/electron/main.ts | isDoNotDisturb | function | 值在文件内自用 |
| apps/desktop/electron/main.ts | setDoNotDisturb | function | 值在文件内自用 |
| apps/desktop/electron/security.ts | ALLOWED_PERMISSIONS | const | 值在文件内自用 |
| apps/desktop/electron/security.ts | EXECUTABLE_EXTENSIONS | const | 值在文件内自用 |
| apps/desktop/renderer/src/App.tsx | loadPanelCollapsed | function | 渲染层文件内自用 |
| apps/desktop/renderer/src/App.tsx | startupFailureHint | function | 渲染层文件内自用 |
| apps/desktop/renderer/src/api.ts | readApiBaseFromLocation | function | 渲染层文件内自用 |
| apps/desktop/renderer/src/api.ts | readApiTokenFromLocation | function | 渲染层文件内自用 |
| apps/desktop/renderer/src/components/ChatView.tsx | REVEAL_WINDOW | const | 渲染层文件内自用 |
| apps/desktop/renderer/src/components/CsvTable.tsx | MAX_CSV_PREVIEW_ROWS | const | 渲染层文件内自用 |
| apps/desktop/renderer/src/components/MessageBubble.tsx | MessagePartView | function | 渲染层文件内自用 |
| apps/desktop/scripts/gen-portraits.mjs | FRAMING | const | 值在文件内自用 |
| apps/server/src/approvals.ts | DEFAULT_APPROVAL_TIMEOUT_MS | const | 值在文件内自用 |
| apps/server/src/config.ts | KEYLESS_API_KEY_PLACEHOLDER | const | 值在文件内自用 |
| apps/server/src/config.ts | providersConfigPath | function | 值在文件内自用 |
| apps/server/src/config.ts | reservedApiKeyEnv | function | 值在文件内自用 |
| apps/server/src/plugins/browser.ts | BROWSER_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/browser.ts | readBrowserConfig | function | 配置读取器，文件内自用 |
| apps/server/src/plugins/commands.ts | COMMANDS_EXECUTE_ROUTE | const | 工具/路由名常量，文件内自用 |
| apps/server/src/plugins/commands.ts | COMMANDS_LIST_ROUTE | const | 工具/路由名常量，文件内自用 |
| apps/server/src/plugins/commands.ts | COMMANDS_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/computer.ts | COMPUTER_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/computer.ts | readComputerConfig | function | 配置读取器，文件内自用 |
| apps/server/src/plugins/core-tools.ts | CORE_TOOLS_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/credentials.ts | CREDENTIALS_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/document.ts | DOCUMENT_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/document.ts | createDocumentConvertTool | function | 值在文件内自用 |
| apps/server/src/plugins/document.ts | readDocumentConfig | function | 配置读取器，文件内自用 |
| apps/server/src/plugins/extensions.ts | EXTENSIONS_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/goal.ts | GOAL_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/grill-me.ts | MAX_GRILL_QUESTION | const | 值在文件内自用 |
| apps/server/src/plugins/jobs.ts | JOBS_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/llm-openai.ts | LLM_OPENAI_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/lsp.ts | LSP_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/lsp.ts | createLspTool | function | 值在文件内自用 |
| apps/server/src/plugins/lsp.ts | readLspConfig | function | 配置读取器，文件内自用 |
| apps/server/src/plugins/mcp.ts | MCP_CONFIG_FILE | const | 值在文件内自用 |
| apps/server/src/plugins/mcp.ts | MCP_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/mcp.ts | readMcpConfig | function | 配置读取器，文件内自用 |
| apps/server/src/plugins/schedule.ts | SCHEDULE_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/session-query.ts | SESSION_QUERY_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/settings.ts | SETTINGS_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/skill.ts | SKILL_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/spill.ts | SPILL_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/ssh.ts | SSH_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/ssh.ts | findSshHost | function | 值在文件内自用 |
| apps/server/src/plugins/ssh.ts | readSshConfig | function | 配置读取器，文件内自用 |
| apps/server/src/plugins/subagent.ts | SUBAGENT_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/terminal.ts | TERMINAL_CD_TOOL | const | 工具/路由名常量，文件内自用 |
| apps/server/src/plugins/terminal.ts | TERMINAL_CLOSE_TOOL | const | 工具/路由名常量，文件内自用 |
| apps/server/src/plugins/terminal.ts | TERMINAL_EXEC_TOOL | const | 工具/路由名常量，文件内自用 |
| apps/server/src/plugins/terminal.ts | TERMINAL_INTERRUPT_TOOL | const | 工具/路由名常量，文件内自用 |
| apps/server/src/plugins/terminal.ts | TERMINAL_OPEN_TOOL | const | 工具/路由名常量，文件内自用 |
| apps/server/src/plugins/terminal.ts | TERMINAL_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/terminal.ts | TERMINAL_READ_TOOL | const | 工具/路由名常量，文件内自用 |
| apps/server/src/plugins/todo.ts | TODO_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/voice-piper.ts | PIPER_PARALLEL_CHUNKS | const | 值在文件内自用 |
| apps/server/src/plugins/voice-piper.ts | PIPER_PARALLEL_MIN_BYTES | const | 值在文件内自用 |
| apps/server/src/plugins/voice-piper.ts | PIPER_REQUEST_TIMEOUT_MS | const | 值在文件内自用 |
| apps/server/src/plugins/voice-piper.ts | PIPER_SYNTHESIS_TIMEOUT_MS | const | 值在文件内自用 |
| apps/server/src/plugins/voice-piper.ts | PIPER_TOTAL_BYTES_ESTIMATE | const | 值在文件内自用 |
| apps/server/src/plugins/web.ts | WEB_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/plugins/web.ts | readWebConfig | function | 配置读取器，文件内自用 |
| apps/server/src/plugins/workflow.ts | WORKFLOW_PLUGIN_ID | const | 插件 id 常量，文件内自用；id 的字符串值可能进配置/设置库——只去 export，值不动 |
| apps/server/src/proactive.ts | DEFAULT_PROACTIVE_HOUR | const | 值在文件内自用 |
| apps/server/src/proactive.ts | DEFAULT_PROACTIVE_INTERVAL_MS | const | 值在文件内自用 |
| apps/server/src/proactive.ts | DEFAULT_PROACTIVE_SETTINGS | const | 值在文件内自用 |
| apps/server/src/proactive.ts | PROACTIVE_DEFAULT_WINDOW_MS | const | 值在文件内自用 |
| apps/server/src/proactive.ts | collectProactiveFacts | function | 值在文件内自用 |
| apps/server/src/proactive.ts | isProactiveHour | function | 值在文件内自用 |
| apps/server/src/proactive.ts | loadProactiveSettings | function | 值在文件内自用 |
| apps/server/src/proactive.ts | loadProactiveState | function | 值在文件内自用 |
| apps/server/src/proactive.ts | saveProactiveSettings | function | 值在文件内自用 |
| apps/server/src/proactive.ts | saveProactiveState | function | 值在文件内自用 |
| apps/server/src/routes/backup.ts | BACKUPS_KEPT | const | 值在文件内自用 |
| apps/server/src/routes/backup.ts | backupFileName | function | 值在文件内自用 |
| apps/server/src/seed.ts | SEED_DEFAULT_PROVIDER | const | 值在文件内自用 |
| apps/server/src/telemetry.ts | DEFAULT_TELEMETRY_LIMIT | const | 值在文件内自用 |
| apps/server/src/telemetry.ts | TurnRecorder | class | 值在文件内自用 |
| apps/server/src/vibe/project.ts | PROJECTS_DIR | const | 值在文件内自用 |
| apps/server/src/vibe/project.ts | escapeHtml | function | 值在文件内自用 |
| apps/server/src/vibe/project.ts | renderArtifact | function | 值在文件内自用 |
| apps/server/src/vibe/project.ts | renderReadme | function | 值在文件内自用 |
| apps/server/src/vibe/project.ts | renderTodo | function | 值在文件内自用 |
| apps/server/src/vibe/project.ts | slugOf | function | 值在文件内自用 |
| packages/attachment/types/src/index.ts | AttachmentStore | class | 值在文件内自用 |
| packages/evolve/src/store.ts | reflectionRelevance | function | 值在文件内自用 |
| packages/llm/llm/src/attribution.ts | APP_IDENTITY | const | 值在文件内自用 |
| packages/llm/llm/src/attribution.ts | userAgent | function | 值在文件内自用 |
| packages/llm/llm/src/content.ts | textOnlyImageText | function | 值在文件内自用 |
| packages/llm/llm/src/message.ts | createMessage | function | 值在文件内自用 |
| packages/tools/src/edit.ts | countOccurrences | function | 值在文件内自用 |
| packages/typert/gateway/src/reflect.ts | isCallable | function | 值在文件内自用 |
| packages/util/timeout/src/index.ts | TimeoutReason | class | 值在文件内自用 |
| packages/util/values/src/index.ts | deepEqualJson | function | 值在文件内自用 |
| packages/util/values/src/index.ts | snapshotJsonValue | function | 值在文件内自用 |
| packages/web/src/http.ts | DEFAULT_USER_AGENT | const | 值在文件内自用 |
| scripts/notice-audit.mjs | renderMarkers | function | 脚本内自用 |
| scripts/notice-audit.mjs | scanRepo | function | 脚本内自用 |
| scripts/voice/runtime.ts | VOICE_FILES_SUBDIR | const | 脚本内自用 |

## 三、清理时的动态引用面提醒

这些机制让名字「跑在静态扫描之外」。本表条目都已被证明**当前**没有这类引用，但清理
时若仓库形态变了，对相关条目要重新过一遍：

1. JSON-RPC 方法表：`apps/server/src/rpc/endpoint.ts`、`selfcheck.ts` 的人写签名表；
   `packages/sdk` 的 `call(method, args)` 按字符串分发。
2. 运行时代码生成：`packages/typert/gateway/src/codegen.ts`（生成的客户端源码文本扫描不到）。
3. MCP 工具名拼接：`packages/mcp/src/naming.ts`（`mcp__<server>__<tool>`，名字来自配置）。
4. 插件 id 与设置面：`*_PLUGIN_ID` 常量的**值**可能以字符串形式进设置库/配置 JSON
   （本表这类条目只去 export，值不动，不受影响）。
5. desktop preload/contextBridge：`apps/desktop/electron/preload.ts` 的通道名是字符串。
6. 斜杠命令与技能目录：命令名、技能名是数据（用户输入、文件 frontmatter），不是符号。
