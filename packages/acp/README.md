# @ryharness/acp

Agent Client Protocol：编辑器之类的**客户端**用它驱动一个 agent 会话。

握手 → 开一个会话 → 发一条用户消息 → 收一串事件 → 这一轮结束。中间能取消。

上游对照：dsh 的 `acp` 组只有**一个包**，而且是**服务端**——让程序与自动化通过标准 ACP
跑持久化的 Harness agent（建会话、挂 MCP 服务器、选模型、发图文 prompt、答权限询问、
取消）。本包做的是**客户端这一侧**：把同一套协议变成「编辑器能直接用的会话句柄」。

## 用法

```ts
import { AcpClient } from '@ryharness/acp'

const client = new AcpClient({ transport })

await client.initialize() // { protocolVersion, agentCapabilities }

const session = await client.newSession({ cwd: '/tmp' })

const off = session.onEvent((event) => {
  if (event.kind === 'message_chunk') process.stdout.write(event.text)
  if (event.kind === 'tool_call') console.log('工具：', event.title)
})

const stopReason = await session.send('你好') // 'end_turn' | 'cancelled' | 'error'
session.cancel() // 取消当前这一轮
await session.close()
off()
```

## 事件形状

事件是这一层对外的承诺：**字段名固定、带版本号**。每个事件都有 `version`（当前是 `1`）、
`sessionId` 与 `seq`（会话内序号，从 1 开始，用来判断有没有漏收）。

| `kind` | 字段 |
|---|---|
| `message_chunk` | `text` |
| `tool_call` | `callId`、`title`、`status`（`pending` / `in_progress` / `completed` / `failed`）、`toolKind`（`read` / `edit` / `execute` / `other`，可选） |
| `tool_result` | `callId`、`status`（`completed` / `failed`）、`content` |
| `completed` | `stopReason`（`end_turn` / `cancelled` / `error`） |
| `error` | `code`、`message` |

收到**不认识**的事件（版本不对、字段缺、类型没见过的）会被**丢掉**，不猜、不炸——对端升级
了协议不该让整个会话垮掉。解析器 `parseAcpEvent` 是公开的，调用方可以自己决定要不要收。

事件按会话分发：只有 `sessionId` 对得上的事件才会送到那个会话的回调。

## 线上方法

| 方法 | 类型 | 说明 |
|---|---|---|
| `initialize` | 请求 | 握手：说清协议版本与能力 |
| `session/new` | 请求 | 新建会话，回 `{ sessionId }` |
| `session/prompt` | 请求 | 发一条用户消息，回 `{ stopReason }` |
| `session/cancel` | 通知 | 取消当前这一轮，不等回包 |
| `session/close` | 请求 | 关闭会话 |
| `session/update` | 通知 | 会话有更新，参数是一条事件 |

线协议是 JSON-RPC 2.0 + 按行分帧，与 Remote 层、进程外 SDK **同一套**（从 `@ryharness/api`
转出）。

## 导出

| 导出 | 一句话 |
|---|---|
| `AcpClient` | ACP 客户端：`initialize` / `newSession` / `onEvent` / `close` |
| `AcpSession` | 会话句柄：`send` / `cancel` / `close` / `onEvent` / `sessionId` / `isClosed` |
| `parseAcpEvent` | 把线上的一条东西解析成事件；不认识给 undefined |
| `isMessageChunk` / `isToolCall` / `isToolResult` / `isCompleted` / `isError` | 事件判别 |
| `ACP_EVENT_VERSION` / `ACP_PROTOCOL_VERSION` | 事件格式版本 / 协议版本 |
| `ACP_METHODS` | 线上方法名 |

## 与上游的差距

1. **只有客户端，没有服务端**。上游 `acp` 包的交付物是**服务端**：让 Harness 把自己暴露成
   一个 ACP agent。本包提供的是客户端，**不能**拿它把 RyHarness 变成一个可被编辑器驱动的
   agent——那需要服务端侧的实现（会话管理、MCP 挂载、模型选择、权限询问）。
2. **没有权限询问**。上游的自动化流程里 agent 会**问权限**（要权限时等客户端回答）。本包的
   事件里没有「要权限」这一类，客户端也无从回答。
3. **没有图片 prompt**。上游支持图文 prompt；本包的 `AcpPrompt` 只有 `type: 'text'`。
4. **没有模式与模型选择**。上游有 `current_mode_update`、`available_commands_update` 与模型
   选项；本包没有对应事件。
5. **没有会话列举与恢复**。上游能列出已有会话、能恢复；本包只能新建。
6. **方法名是本包定的**。上游跟着标准 ACP 的方法名走；本包用了 `session/new`、
   `session/prompt`、`session/update` 这套形状，但没有逐字对齐某个版本的规范文本。

## 边界

- 不实现 agent：本包只是「跟一个说 ACP 的话的对端说话」。
- 不做重连、不做多路复用：一条连接一个客户端。
