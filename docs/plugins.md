# 插件开发

RyHarness 的插件体系建立在内联的 [`@ryharness/cordis`](../vendor/cordis) 上：依赖驱动装载、可逆 effect、卸载即清理。**开关不是写配置，而是真实地把插件 fiber 挂上/卸下**——工具会从注册表消失、路由会从 HTTP 表消失。

## 一个插件长什么样

实现一个 `PluginEntry`（`apps/server/src/plugins/host.ts`）：

```ts
export const myPlugin: PluginEntry = {
  id: 'my-plugin',              // 稳定 id，也是 plugins.json 的键
  name: '我的能力',              // 插件页显示名
  description: '一句话说清它替用户做了什么',
  group: 'feature',             // core | feature | voice | tool
  capabilities: { tools: ['my_tool'], routes: ['GET /api/my'] },
  impact: '关闭后助理将无法……，已有数据保留。',
  inject: ['tools', 'routes'],  // 依赖的服务；缺一个就不激活
  apply(ctx) {
    ctx.tools.register(defineTool({ /* … */ }))
    ctx.routes.register('GET', '/api/my', handler)
  },
}
```

三件套就够跑：`id` / `inject` / `apply`。`apply` 里注册的一切都走 `ctx.effect()`，插件卸载时自动注销；不要手写 `try/finally` 清理。

## 注册位置

在 `apps/server/src/app.ts` 的 `pluginEntries` 里追加（core 插件在前）：

```ts
pluginEntries.push(myPlugin)
```

启动时按顺序 `ctx.plugin()`；停机时逆序 dispose。插件清单与开关经 `GET /api/plugins`、`PATCH /api/plugins/:id` 暴露给界面，开关文件是 `<dataDir>/config/plugins.json`。

## 两个注册表

**工具**（`packages/tools` 的 `ToolRegistry`，服务名 `tools`）：

```ts
ctx.tools.register(defineTool({
  name: 'my_tool',
  description: '给模型看的说明。写清什么时候该用、什么时候不该用。',
  parameters: { query: { type: 'string', required: true, description: '…' } },
  executionMode: 'sequential', // 有副作用时声明，整批调用会串行
  execute: async (args, context) => ({ content: '…' }),
}))
```

`execute` 拿到的 `ToolContext` 里有 `conversationId` / `agentId` / `workspaceRoot` / `signal`；不要从全局变量猜当前会话。

**路由**（`apps/server/src/plugins/routes.ts` 的 `RouteRegistry`，服务名 `routes`）：

```ts
ctx.routes.register('GET', '/api/things/:id', async (req, res) => { … })
```

路由挂在插件 fiber 上，卸载即 404。核心路由与插件路由使用同一个 Router，路径冲突会在挂载时显式报错。

**语音引擎**（`apps/server/src/plugins/voice.ts` 的 `VoiceRegistry`，服务名 `voice`）：

```ts
ctx.effect(() => {
  const dispose = ctx.voice.registerProvider({
    engine: 'my-engine',
    describe: () => ({ name: '我的语音', available: true }),
    profiles: () => [profile],
    synthesize: (request, deps) => …, // deps.signal 必须能中止真进程
  })
  return () => { dispose() }
}, 'my-voice.provider')
```

`describe` 可选；实现它之后，`GET /api/voice/catalog` 会把「未安装 / 未配置」连同 `reason` 一起给界面，而不是等用户点了才失败。`synthesize` 抛 `VoiceError`，宿主按 `profile.engine` 路由；没有 provider 的引擎回 `VOICE_ENGINE_UNAVAILABLE`。provider 注册必须包在调用方插件的 `ctx.effect` 里，插件卸载时目录才会同步消失。

**动态音色还要多注册一步**：只 `registerProvider` 的话，音色在目录里看得见，但人格保存时会被
`normalizeVoiceId` 洗成「不朗读」——它只放行内核认得的 id。插件里还要把目录条目注册进
`@ryharness/voice` 的运行时注册表（`registerVoiceProfile`），注销时一并撤掉。

**声线文件**：`voice-minimax` 插件把 `<dataDir>/voice/voices/*.json` 里的每一条读成一条音色，
随装默认的那条是 `ryen-cat.json`（Ryen 的猫猫音）。文件里的 `voice` / `model` / `speed` /
`pitch` / `vol` / `emotion` 就是上游请求的参数——改文件存盘、重启应用就换一种念法，不必改
代码重新出包。字段不合格的文件整条跳过（不让一份写坏的手改 JSON 把软件卡在启动上）。

## 状态与存储

- 插件自己的数据放在 `<dataDir>/` 下，按插件命名（如 `todos.json`、`questions.json`）。
- 写文件必须**原子写**：同目录临时文件 + `rename`；并发读改写用 Promise 队列串行化（参考 `todo-store.ts`）。
- 不要往 SQLite 的业务表里加列——那需要迁移，插件应能独立装卸。

## 安全约定

- 凭据只从供应商配置读取，**永远不要**把 Key 发给渲染层或写进日志。
- 网络型工具必须做协议白名单与私网拦截（参考 `web-read.ts` 的 `isPrivateAddress` / 逐跳重定向复核）。
- 失败返回结构化的中文 `ToolResult`（`isError: true`），不要把英文异常直接抛给模型或界面。
- 有副作用的工具声明 `executionMode: 'sequential'`，并默认不出现在助理的工具白名单里。

## 现有插件

| id | 分组 | 提供 | 可关闭 |
|---|---|---|---|
| `core-tools` | core | `fs_read` / `fs_write` / `fs_glob` / `fs_grep` / `fs_edit` / `shell_exec` / `file_produce` | 否 |
| `llm-openai` | core | 模型路由 | 否 |
| `voice` | voice | `/api/voice/catalog`、`/api/voice/speak` | 是 |
| `voice-piper` | voice | 离线音色 provider + `/api/voice/engines/piper/install`、`/api/voice/engines/piper/status` | 是 |
| `voice-minimax` | voice | 声线文件里的音色 provider（MiniMax 合成） | 是 |
| `todo` | feature | `todo` 工具 + `/api/todos` | 是 |
| `ask-user` | feature | `ask_user` 工具 + `/api/questions` | 是 |
| `grill-me` | feature | `grill` / `vibe_scaffold` 工具 + 一条 skill（盘问与落地） | 是 |
| `web-read` | tool | `read_url`（带私网拦截） | 是 |
| `mcp` | tool | 外部 MCP server 的工具（配置在 `<dataDir>/config/mcp-servers.json`） | 是 |
| `subagent` | feature | `subagent` / `subagent_list` 工具（把活派给上下文独立的子代理） | 是 |

## 外部 MCP server

`mcp` 插件读 `<dataDir>/config/mcp-servers.json`：

```json
{
  "servers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
  }
}
```

每个 server 起一条 stdio 连接，它提供的工具以 `mcp__<server>__<tool>` 的名字注册进来
（名字里的字符会被清洗成 `[a-zA-Z0-9_-]`，撞名自动加序号）。**连不上不影响其余 server**：
失败原因写进日志，其余 server 的工具照常可用。文件不存在或写坏了都按「没有配置」处理，
不让一份手改坏的 JSON 把应用卡在启动上。

关闭插件时连接的子进程会被收干净（Windows 上按进程树杀）。审批默认关——在配置里写下一个
server 本身就是一次信任动作；要更严就在装配处把 `requiresApproval` 打开。

## 权限档位

每个助理有一档权限：`只读` / `工作区可写` / `全权`（见 `@ryharness/agent` 的
`PERMISSION_PRESETS`）。档位管的是**内置工具**的范围，插件自己的工具（待办、提问、网页、
MCP…）不受影响——用户自己装的插件不该被换档卸掉。

档位清单由服务端出（`GET /api/permission-presets`），界面不抄一份：抄了就会与实际放行的
工具漂，漂了之后界面上写着「只读」、实际工具箱里却还挂着执行命令。

要说明白的边界：**目前没有内核级隔离**。上游 dsh 那一档还管着沙箱（bwrap / Landlock /
Windows ACL），我们这里只是工具面上的收窄——「只读」意味着拿不到写与执行工具，不意味着
模型碰不到工作区外的任何东西。真正的隔离见 [dsh 对账](dsh-parity.md) 的 sandbox 一行。

开关是真实装卸，关掉之后的行为跟各插件的 `impact` 文案一致。两条容易踩的：

- `ask-user` 关掉后助理发不了问题卡，**待回答的旧问题也不再注入模型**——模型已经没有
  `ask_user` 工具可用了，手里那份答案也没人能再回答，拿它往下走没有意义。问题记录仍留在
  `questions.json` 里，重新打开后恢复。
- `grill-me` 关掉后 RyVibe 不再盘问、也不再落盘项目，它那条 skill（可复用的工作法）也不再
  注入。已有记录保留。

> `voice-piper` 的二进制来自 [rhasspy/piper](https://github.com/rhasspy/piper)（MIT）。
> 中文模型 `zh_CN-huayan-medium` 的 [model card](https://hf-mirror.com/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/MODEL_CARD)
> 标注训练集为 [PlayVoice/HuaYan_TTS](https://github.com/PlayVoice/HuaYan_TTS)、**License: Unknown**。
> 二进制与模型都不随安装包分发，由用户点击后从公开镜像下载；商用或再分发前需自行复核模型许可。

## 测试与门禁

新增插件至少覆盖：注册/卸载后工具与路由的可见性、参数校验、错误路径、存储的原子性与并发、插件页元数据。跑：

```sh
npx vitest run apps/server
npx tsc -p tsconfig.typecheck.json
pnpm verify
```

改 `packages/*/src` 后记得 `pnpm run build`（应用消费 `lib/` 产物）。
