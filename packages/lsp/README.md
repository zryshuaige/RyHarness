# @ryharness/lsp

用语言服务器在代码里导航：跳定义、找引用、找实现、读 hover 文档。

- **一条服务**（`LspService`）：按文件扩展名挑一个能处理它的 provider，把四个只读操作派下去，结果一律归一化成 `{ uri, line, character }` 或一段文本。
- **一个 stdio provider**（`StdioLspProvider`）：按配置把本机的语言服务器拉起来，自己实现 LSP 的 `Content-Length` 帧协议，走完整握手（`initialize` → `initialized` → `textDocument/didOpen` → 请求）。
- **一套结构化失败**（`LspError`）：每种失败有机器可读的 `code` 与一句中文原因。

本包**不含任何语言服务器**。`typescript-language-server`、`gopls`、`pyright-langserver` 这些都要用户自己装——命令不在 PATH 上时，本包会明说「找不到这个语言服务器命令」，**不会**静默降级成 grep 之类的替代品。假装能导航比明说不能导航坏得多：模型会以为拿到了定义位置，然后每一步都建立在错的前提上。

## 装配

```ts
import { LspService, StdioLspProvider } from '@ryharness/lsp'

const lsp = new LspService()
lsp.register(
  new StdioLspProvider({
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.ts', '.tsx'],
    rootPath: workspace,
  }),
)

const targets = await lsp.definition('src/app.ts', { line: 10, character: 4 })
// [{ uri: 'file:///…/src/util.ts', line: 3, character: 9 }]

const usages = await lsp.references('src/util.ts', { line: 3, character: 9 })
const impls = await lsp.implementations('src/app.ts', { line: 10, character: 4 })
const doc = await lsp.hover('src/util.ts', { line: 3, character: 9 })
// { contents: '```ts\nfunction parse(input: string): AST\n```', range: { … } }

await lsp.dispose() // 关掉所有语言服务器进程
```

配置形状是纯数据，怎么存、存哪儿由宿主决定：

```jsonc
{
  "servers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensions": [".ts", ".tsx"],
      "rootPath": "F:/work/my-project",
      "initOptions": { "preferences": { "includeInlayParameterNameHints": "all" } }
    }
  }
}
```

本包不落盘、不注册 cordis 服务、不碰工具注册表——它只给数据与对象，装配留给上层。

## 挑 provider

规则只有一条：**扩展名对得上**（大小写不敏感，`.TS` 与 `.ts` 一样）。多个 provider 都对得上时，先登记的赢——登记顺序是宿主定的，所以结果是可预期的。

挑不到就说清楚：

| 情况 | 结果 |
|---|---|
| 没有扩展名 | `no-provider`，文案说「这个文件没有扩展名，没法配语言服务器，请先给它配一个」 |
| 扩展名没人管 | `no-provider`，文案里带上是哪个扩展名 |

`providerFor(filePath)` 返回 `undefined`（不抛），而四个操作方法在挑不到时会抛 `LspError('no-provider')`。要判断而不报错，用 `providerFor`。

## 结果归一化

provider 可以换，模型拿到的东西不能变。各家协议的说法差异全部挡在 provider 内部：

| 协议里长什么样 | 出这层之后 |
|---|---|
| 单个 `Location` / `Location[]` / `LocationLink[]` | `{ uri, line, character }[]`（行、列都从 0 起） |
| `null` | `[]` |
| hover 的纯字符串 | 一段文本 |
| hover 的 `MarkupContent` | 它的 `value` |
| hover 的 `MarkedString`（带 `language`） | 包成 Markdown 围栏代码块 |
| hover 的 `MarkedString[]` | 拼成一段文本（块之间空一行） |

位置里的列是 **UTF-16 code unit**，与 LSP 协议一致（协议自己也是这个口径）。本包不参与 `positionEncoding` 协商。

## 失败

失败一律抛 `LspError`：`code` 机器可读（调用方可以按它分支处理），`message` 一句中文原因（会原样进模型上下文）。

| code | 什么时候 | 文案长什么样 |
|---|---|---|
| `no-provider` | 这个文件类型没配语言服务器 | `这个文件类型（.py）没有配语言服务器，请先给它配一个` |
| `command-not-found` | 配置里的命令不在 PATH 上 | `找不到这个语言服务器命令：typescript-language-server。请先装上它…` |
| `server-unavailable` | 服务器没起来或中途没了 | `语言服务器进程已退出（退出码 3，信号 无）` |
| `unsupported-operation` | 这个服务器不提供这个操作 | `这个语言服务器（stdio:xxx）不支持 implementations 操作` |
| `timeout` | 它没在时限内回包 | `语言服务器在 15000ms 内没有响应（textDocument/definition）` |
| `protocol-error` | 它说的话不是协议说得清的话 | `帧头里没有 Content-Length，这不是一个合法的 LSP 帧` |
| `file-not-in-workspace` | 文件在工作区外 | `这个文件不在工作区里：…（工作区是 …）` |
| `file-not-found` | 文件读不到 | `读不到这个文件：…` |
| `request-failed` | 它明确回了一个错误 | `语言服务器返回错误（代码 -32601）：method not found: …` |
| `cancelled` | 调用方把这一轮取消了 | — |

想知道一条失败该怎么处理，看 `code` 就够：重试有用的（`server-unavailable`、`timeout`）与重试没用的（`no-provider`、`command-not-found`、`unsupported-operation`、`protocol-error`）分开得很清楚。

## 生命周期

- **懒起**：第一次调用某个操作时才起进程并握手；`start()` 可以提前起，`stop()` 提前关。
- **握手**：发 `initialize` 请求 → 等回包 → 发 `initialized` 通知 → 之后才能发请求。服务器自述的能力（`capabilities.definitionProvider` 等）与配置里限定的操作取**交集**，交集之外的操作直接报 `unsupported-operation`，不去打服务器。
- **每次导航前发 `textDocument/didOpen`**：服务器得先看见文件内容才能答。少了这一步，它答「没有定义」不是因为真没有，而是因为它压根没读过这个文件——这是语言服务器集成里最常见的哑巴失败。同一个文件不会反复打开。
- **崩了会重起**：进程自己没了，provider 变成 `unavailable` 并记下原因（「语言服务器进程已退出（退出码 3，信号 无）」）；下一次调用自动重起（`autoRestart: false` 可关掉）。语言服务器崩了多半是它自己某个文件解析炸了，重起一次通常就好了。
- **关的时候有顺序**：先发 `shutdown` 请求并等回包，再发 `exit` 通知，然后关 stdin、等它退；到点（2 秒）就强杀。强杀的时限比等待的时限短——两个时限一样的话，等待会先把「关好了」交出去，强杀还没来得及动手，那个不退的进程就一直活着。
- **主动关的不算崩**：我们关的连接报「连接已经关闭」，不报「进程已退出」——后者会让人以为语言服务器自己挂了。

## 进程与 Windows

- **stdout 是协议流，stderr 是日志**，两者严格分开——服务器往 stdout 打一行日志就会把帧解析带崩。stderr 通过 `onStderr` 回调交出去，同时留一份尾巴，服务器突然没了时那句「它最后说了：…」是唯一的线索。
- **Windows 上 `.cmd` / `.bat` 不能直接 spawn**。Node 要求这类文件必须经过 shell，直接 spawn 报 EINVAL。而全局装的 npm 包（`typescript-language-server.cmd` 之类）在 Windows 上恰恰都是 `.cmd` 垫片——所以这里在 Windows 上把 `.cmd` 包一层 `cmd.exe /d /s /c`，参数自己加引号。其余平台直接起。
- **环境变量**默认继承宿主的那一份，配置里的 `env` 同名覆盖。语言服务器是用户自己装的开发工具，不是外部服务，默认继承是合适的。
- 本包**不碰** `packages/subprocess`：那一包做的是完整的进程托管（环境清洗、进程树回收、配额）。这里只需要「把语言服务器拉起来、给它三根管子」，所以自己写最小的一份；将来集成时由主控决定要不要换过去。

## 没做的部分

上游 dsh 的 lsp 家族有三个包（`lsp` / `lsp-stdio` / `tool-lsp`），本包把前两个合成了一个，因为上游那边要挂到 cordis 的 ctx 上，而我们这边还没有那一层装配。下面这些是**故意没做**的：

- **模型工具那一层**（上游的 `tool-lsp`）：本包只给 API，没有做成 `@ryharness/agent` 的 `Tool`，也没有模型看到的那套 schema 与提示词。做工具是宿主的事——工具名、参数形状、怎么在界面上展示，都该由上层定。
- **workspace symbol / 跨文件重构**：上游也没有，本包也不做。四个只读操作就是全部。
- **远程 LSP**：只支持 stdio。走 TCP / WebSocket 的语言服务器接不上——`LspProvider` 是接口，将来要接再写一个实现。
- **改代码**：一个写操作都没有。这个包只读。
- **诊断（diagnostics）、代码动作、格式化**：不在射程内。
- **`didChange` / 增量同步**：只发 `didOpen`，文件改了不通知服务器（同一个文件也不会被重新打开）。要跟着文件变化走，得由宿主决定什么时候重建 provider。
- **多根工作区**：只支持一个 `rootPath`。
- **语言服务器本体**：不含。用户自己装。

## 测试

`tests/`：帧协议（字节长度、分片、多帧、坏帧头）、URI 与扩展名、结果归一化（三种位置形态、四种 hover 内容、畸形数据）、服务层（挑 provider、派发、`no-provider` 与 `unsupported-operation`）、连接层（通知被忽略、错误对象缺字段、乱帧、非 JSON、进程死掉）、以及**真的起一个子进程**的集成用例（`tests/fixtures/fake-lsp-server.mjs`）：握手顺序（`initialize` → `initialized` → `didOpen` → 请求）、`didOpen` 送过去的确实是文件内容、超时、崩溃与自动重起、命令找不到、协议错误、文件不在工作区、`shutdown` + `exit` 的收尾顺序。
