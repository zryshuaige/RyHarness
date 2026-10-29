# @ryharness/mcp

MCP（Model Context Protocol）客户端：把外部 MCP server 的工具接进 RyHarness 的工具体系。

- **一条 stdio 连接**（`McpStdioClient`）：用 `node:child_process` 起一个子进程，按 JSON-RPC 2.0 over stdio（NDJSON，一行一条消息）与它对话。
- **一批工具**（`McpClientRegistry`）：登记配置 → 连接 → 拿到一串 `@ryharness/agent` 的 `Tool`，宿主直接注册进工具表。
- **资源的读法**：`listResources()` / `readResource(uri)` / `readResourceText(uri)`。资源**不**做成模型工具——它们是按需读的东西，全塞进工具描述会让每次调用的提示词都长一截。

## 装配

```ts
import { McpClientRegistry } from '@ryharness/mcp'

const mcp = new McpClientRegistry({ timeoutMs: 10_000 })
mcp.register('files', { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] })
mcp.register('search', { command: 'mcp-server-search' })

const report = await mcp.connectAll()
// report.failed 里是起不来的 server 与原因，其余 server 的工具照常可用
for (const tool of mcp.tools()) ctx.tools.register(tool)

await mcp.close() // 关连接时把子进程连同子孙一起收掉
```

配置形状是纯数据，怎么存、存哪儿由宿主决定：

```jsonc
{
  "servers": {
    "files": { "command": "npx", "args": ["-y", "server-filesystem", "/tmp"], "env": { "TOKEN": "…" } }
  }
}
```

本包不落盘、不注册 cordis 服务、不碰工具注册表——它只给数据与对象，装配留给上层。

## 工具命名

对外名字是 `mcp__<server>__<tool>`，两段用双下划线隔开。名字要进 agent 的工具白名单、要进模型的 tools 列表、还要出现在对话记录里，所以它必须**稳定**：同一个 server 的同一个工具，今天叫什么明天还得叫什么。

清洗规则：server 名与工具名都只保留 `[a-zA-Z0-9_-]`，其余换成下划线，两端的下划线去掉（`weird name/with:chars` → `weird_name_with_chars`）。清洗后撞名的用尾部序号兜住（`__2`、`__3`…），序号按 server 名、工具名排序后分配——于是「谁拿到 `__2`」与登记顺序、连接顺序都无关。

server 侧报了两个同名工具时只留第一个：模型唯一能看见的标识就是名字，两个同名工具挑哪个全看运气。

参数 schema 原样透传，不改写——server 怎么定义就怎么给模型，改了只会让模型的调用和 server 的期望对不上。

## 错误与超时

失败一律变成 `isError` 的工具结果（`execute` 不抛异常，炸掉一整轮不值当），文案是中文。`McpError` 带一个 `kind`，方便调用方分类：

| kind | 什么时候 | 文案长什么样 |
|---|---|---|
| `startup` | 命令起不来 | `MCP 服务器「x」启动失败：spawn x ENOENT` |
| `timeout` | 单次请求没等到回包 | `MCP 服务器「x」在 10000ms 内没有响应（tools/call）` |
| `protocol` | stdout 上出现非 JSON-RPC 的东西 | `MCP 服务器「x」协议出错：这一行不是合法 JSON：…` |
| `request` | server 回 JSON-RPC 错误 | `MCP 服务器「x」返回错误（代码 -32602）：unknown tool: y` |
| `cancelled` | 调用方的 signal 取消了这一轮 | `MCP 服务器「x」的调用被取消（tools/call）` |
| `closed` | 连接已关或 server 已退出 | `MCP 服务器「x」已经退出（退出码 1，信号 无）` |

- 超时默认 10 秒，`timeoutMs` 可注入；超时会先给 server 发 `notifications/cancelled`，再把失败交回调用方。
- server 自己报的 `isError` 内容**照收**（那往往是它自己的错误说明），只是前面加一句「MCP 工具「x」执行失败」。
- 一个 server 起不来不影响其他：批量连接时每个 server 各自成败，失败原因进 `connectAll()` 的报告里。

## 进程与环境

- **stdout 是协议流，stderr 是日志**，两者严格分开——server 打一行日志到 stdout 就会把 JSON 解析带崩。stderr 通过 `onStderr` 回调交出去，同时留一份尾巴，server 突然没了时那句「它最后说了：…」是唯一的线索。
- **关连接时收干净进程树**。Windows 走 `taskkill /T /F`（父进程一先死，这棵树就再也拼不出来，里面的孙进程会以孤儿身份继续跑）；POSIX 靠 spawn 时开出的进程组，一次带走整组。收尾是 await 的——「发射完就不管」的写法在杀不掉时等于没杀。
- **环境变量默认只给白名单**（PATH、HOME、TEMP、SYSTEMROOT 之类）。MCP server 是外部程序，它能读到哪些环境变量，就等于我们把哪些凭据递到了它手上。其余要用的由宿主在配置的 `env` 里显式写出来；`inheritEnv: true` 可以整个传过去。

## 审批

MCP 工具默认**不**要求审批（`requiresApproval: false`）：配置一个 server 本身就是用户的信任动作，跟装扩展一样。宿主可以在登记处统一打开：

```ts
new McpClientRegistry({ requiresApproval: true })
```

边界要说清楚：MCP server 对宿主没有沙箱，它能干什么取决于那个 server 自己。默认不审批是信任配置，不是信任工具。

## 没做的部分

上游 dsh 的 MCP 家族有 `mcp-client` 与 `mcp-resources` 两个包，本包只做了 `mcp-client` 里「一条 stdio 连接」这一层，下面这些是**故意没做**的：

- **HTTP / SSE 传输**：只支持 stdio。远程 MCP server 接不上。
- **协议版本协商**：固定请求 `2024-11-05`，server 回什么版本就用什么版本，不做双向协商。
- **分页**：`tools/list` / `resources/list` 返回 `nextCursor` 时不翻页，只读第一页。工具多的 server 会少一半工具。
- **断线重连**：连接断了就是断了，要靠宿主重新 `connect()`。
- **`prompts/get`**：只实现了 `prompts/list`（列出有哪些 prompt），没有取 prompt 正文的接口。
- **server instructions 注入**：`initialize` 里的 `instructions` 取到了（`client.instructions`），但不会自动进系统提示词——那是宿主的决定。
- **共享资源工具**（上游 `mcp-resources` 那个包）：我们只给 `listResources` / `readResource` 这些 API，没做成「带 server 选择的模型工具」。
- **采样 / roots / elicitation / logging**：协议的这几个方向一概没实现。
- **配置的落盘与装配**：不存盘、不注册 cordis 服务。

## 测试

`tests/`：线路层（分片拼接、CRLF、坏行）、命名规则（清洗、重名、序号与顺序无关）、回包解码（畸形数据读成空而不是炸）、工具适配（中文错误、schema 透传、参数类型不对），以及**真的起一个子进程**的集成用例（`tests/fixtures/fake-mcp-server.mjs`）：initialize → tools/list → tools/call 全链路、stderr 不污染协议流、超时与取消、协议违规、server 半路退出、命令起不来、资源与 prompt、进程回收。
