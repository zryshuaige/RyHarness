# RyAgent

从 [deepseek-harness](../deepseek-harness)（DeepSeek Harness / dsh 上游原版，TypeScript pnpm monorepo，cordis DI）裁剪出的精简内核 + 社交化多 Agent 桌面应用。

![通讯录](apps/desktop/docs/screenshot-contacts.png)

**定位**：类微信的社交化 Agent 桌面应用，但不是微信克隆——过程播报气泡、产物文件卡片、群聊接力链可视化、猫管家吉祥物 Ryen（三态 SVG）。底层是完全自有的精简内核（LLM 服务缝 + 消息/工具循环 + 群聊调度 + SQLite 持久化），LLM 走 OpenAI 兼容协议的多供应商适配层。

## 架构

```
┌─────────────────────────── apps/desktop（Electron + React）───────────────────────────┐
│  三栏主界面 / 通讯录 / 模板建 Agent / 建群 / 设置面板                                    │
│  REST 客户端 + WS 事件折叠（ChatStore）                                                │
├─────────────────────────── apps/server（@ryagent/server）────────────────────────────┤
│  HTTP API（agents/conversations/messages/providers/files）+ WS 推送 + 事件总线          │
├───────────────────────────── packages（内核，自写 + dsh 裁剪）─────────────────────────┤
│  @ryagent/agent   AgentDefinition + Ryen 模板 + AgentLoop（消息/工具循环）              │
│  @ryagent/group   群聊调度器（@直路由 + 调度员自然语言选路 + loop-guard 护栏）           │
│  @ryagent/session SQLite 持久化（SCHEMA_VERSION=3 单调迁移）+ SessionCoordinator        │
│  @ryagent/tools   fs_read/fs_write/shell_exec/file_produce（产物卡片）                  │
├───────────────────────────── LLM 层 ─────────────────────────────────────────────────┤
│  @ryagent/llm         dsh-llm 契约：LlmAdapter/LlmRuntime/StreamChunk/BlockAssembler  │
│  @ryagent/llm-openai  OpenAI 兼容适配器（SSE、tool calling、usage、多供应商路由）        │
├───────────────────────────── 地基（dsh vendor 裁剪改名）──────────────────────────────┤
│  @ryagent/cordis + cosmokit + schemastery + typert-protocol + util 小包                │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

裁剪决策与依赖盘点见 [M0-dependency-audit.md](./M0-dependency-audit.md)：不带上游 agent-loop 的 32k LOC 生态（sandbox/ptc/approval），agent 循环与 SQLite 持久化均为自写精简版。

## 快速开始

```sh
pnpm install
pnpm build
```

配置 LLM key（SiliconFlow，也可改 `data/config/providers.json` 加别的 OpenAI 兼容供应商）：

```powershell
# Windows 用户环境变量（设置后重启应用）
[Environment]::SetEnvironmentVariable('SILICONFLOW_API_KEY', '<你的 key>', 'User')
# 或开发时放在仓库根 .env（已 gitignore），从仓库根启动的脚本会读取
```

启动桌面应用（内嵌后端，数据在 `%APPDATA%/ryagent-data`）：

```sh
pnpm --filter @ryagent/desktop start        # 生产模式（file:// 单文件渲染层）
pnpm --filter @ryagent/desktop dev          # 开发模式（Vite HMR + Electron）
```

也可以只跑后端 headless（`pnpm --filter @ryagent/server dev`，127.0.0.1:32100）。

## 功能清单

- **单聊**：流式气泡、agent "正在输入"、过程播报（工具调用进度行）、产物文件卡片（打开/下载）。
- **群聊**：@提及直路由；无 @ 时调度员（默认 Ryen）自然语言选路——生成即路由，回复里的 @ 就是接力信号；接力链可视化（流转提示，loop-guard/max-turns 红色标注）；调度轨迹留在右栏。
- **Agent**：内置 Ryen（猫管家总管）+ 5 个模板（通用/Coding/写作/翻译/文件整理）；fork 模板、改人设/模型/工具白名单；builtin 删除保护。
- **持久化**：SQLite（WAL），agents/conversations/messages/dispatch_events 四表，单调迁移；未读徽标（seq 比较，本人消息不计）；per-conversation 消息串行队列（排队有 WS 提示）。
- **LLM 层**：`chat/completions` + SSE；流式 tool-call 组装；usage 提取（含 reasoning/cache token）；统一错误码（RATE_LIMIT/QUOTA/CONTEXT_WINDOW_EXCEEDED/…）；配置驱动多供应商路由。

## 测试

```sh
pnpm test          # 168 个测试：内核单测 + mock SSE 适配器 + 真实 HTTP/WS 集成 + jsdom 组件测试
pnpm typecheck     # 严格模式（根程序；vendor 由其自身 tsc build 校验）
pnpm -r build      # 全量构建（vendor 用 tsc，packages 用 tsdown，desktop = tsdown + vite）
pnpm demo:agent    # M2 集成：mock 适配器跑 AgentLoop + 落库断言
pnpm demo:group    # M3 三场景：接力链 / @直路由 / loop-guard
pnpm demo:server   # M4a 只读端点冒烟（真实配置）
pnpm smoke:siliconflow  # 真实 API 冒烟（无 key 时打印提示并 exit 0 跳过）
```

## 目录结构

```
apps/
  server/      @ryagent/server   本地后端（HTTP + WS；API/事件契约见其 README）
  desktop/     @ryagent/desktop  Electron + React 桌面（启动方式见其 README）
packages/
  llm/llm/     @ryagent/llm      LLM 服务缝（dsh-llm 裁剪）
  llm/openai/  @ryagent/llm-openai  OpenAI 兼容适配器
  agent/ group/ tools/ session/  自写运行时
  typert/protocol/ attachment/types/ util/ runtime-diagnostics/  地基与 stub
vendor/        cordis / cosmokit / schemastery（dsh vendor 改名）
scripts/       demo-*.ts 冒烟与集成脚本、tsdown-decorators.mjs
docs（各包 README）· M0-dependency-audit.md · .zcode/ 分析脚本
```
