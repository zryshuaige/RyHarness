# @ryharness/sdk

进程外 SDK：起一个子进程，用 JSON-RPC 跟它说话。

线协议与网关**同一套**（JSON-RPC 2.0 + 按行分帧），从 `@ryharness/api` 转出来的——所以
「进程内的 Remote 层」与「进程外的 SDK」说的是同一种话，没有第二份实现。

上游对照：dsh 的 `sdk` 组里，`protocol` 定义按行分隔的 JSON-RPC 消息，`client` 起一个
`dsh` 子进程并用命名 profile 与有序 patch 驱动它，`server` 用 `jsonrpc` 插件在 stdio 上
服务。本包是其中**协议与客户端**那一半：起进程、发请求收响应、进程没了要报错、能收干净。

## 用法

```ts
import { SdkClient } from '@ryharness/sdk'

const client = SdkClient.start({
  command: 'dsh',
  args: ['--profile', 'sdk'],
  timeoutMs: 30_000, // 单次请求的默认超时
})

const result = await client.request('session/open', { cwd: '/tmp' })
client.notify('session/ping')

await client.close() // 收干净：先请它自己退，等不到再杀
```

可执行文件与参数**由宿主给**：本包不决定跑什么、也不决定怎么拼参数。

## 三件容易忽略的事

1. **进程没了**：请求挂在半路时子进程退出，挂起的请求**立刻**失败（`sdk/process-exit`，
   带着退出码或信号），不等到超时才发现。
2. **收干净**：`close()` 先关 stdin 请子进程自己收尾，等不到就 `kill()`，再等不到就
   `SIGKILL`——不留下孤儿进程。
3. **stderr**：子进程写到 stderr 的东西留最后 4000 个字符（`client.stderr`），失败时能看出
   它临死前说了什么。

## 失败

| 机器码 | 什么时候 |
|---|---|
| `sdk/process-exit` | 子进程退出了（正常退出或崩了），请求没能完成 |
| `sdk/spawn-failed` | 子进程根本没起来（可执行文件不存在等） |
| `gateway/timeout` | 时限内没回包 |
| `gateway/cancelled` | 调用方用 AbortSignal 取消了 |
| `gateway/bad-request` | 线上消息不合法 |

子进程自己回的错误**原样**到客户端：机器码、消息、结构化详情都不改。

## 导出

| 导出 | 一句话 |
|---|---|
| `SdkClient` | 进程外客户端：`start` / `request` / `notify` / `close` / `exited` / `stderr` / `isRunning` |
| `SdkExit` | 子进程的退出信息（退出码、信号） |
| 线协议转出 | `JsonRpcPeer`、`encodeMessage`、`decodeMessage`、`JSON_RPC_VERSION` 等——与 Remote 层共用同一套 |

## 与上游的差距

1. **不启动 Harness**。上游的 `client` 会用命名 profile 与有序 patch 起一个 `dsh` 运行时
   （`--profile sdk` 那个应用包），还管着 profile 的解析与 patch 的顺序。本包只管
   「起一个可执行文件、跟它说 JSON-RPC」——**起什么、怎么起由宿主决定**。
2. **没有协议层方法库**。上游有一层「协议级 API」（开会话、发 prompt、看会话事件、agent
   状态变化、子代理完成），本包只有通用的 `request` / `notify`；具体方法名由宿主与子进程
   约定。
3. **没有 Python 那一半**。上游的 Python SDK 与 TS 客户端共用同一套协议；本包只有 TS。
4. **不做命名 profile 与 patch 编排**（上游 `sdk-app` 的活）。
5. **stdio 一种载体**。上游也是 stdio，但本包不处理「宿主往子进程发一条自定义帧」这类
   扩展。

## 边界

- 不管子进程内部跑什么：本包只负责管道与协议。
- 不做重连：进程退出就是退出，重来由上层决定。
- `env` 给了就是**完整的一份**（不继承当前进程的环境变量）；不给才继承。
