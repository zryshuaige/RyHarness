# @ryharness/api

Remote 层：客户端调宿主。

宿主把本地对象挂出来，客户端连上去，照着**类型图**调——两边可以不在同一个进程。
线协议（JSON-RPC 2.0 + 按行分帧）由 `@ryharness/typert-gateway` 提供，本包负责把它接到
真实的 TCP 连接上。

上游对照：dsh 的 `api` 组里，`gateway` 承载调用与结果、`remotes` 决定暴露什么、
`remote-access` 决定谁能调。本包是这条链路里**最小可用的一段**：挂载、类型图、调用、
错误回传。

## 用法

宿主侧：

```ts
import { Remote } from '@ryharness/typert-protocol'
import { createRemoteHostServer, RemoteHost } from '@ryharness/api'

class Counter {
  @Remote
  add(a: number, b: number): number {
    return a + b
  }
}

const host = new RemoteHost()
host.mount({ namespace: 'counter', service: new Counter() })

const server = await createRemoteHostServer({ host })
console.log(server.port) // 0 表示让系统挑一个空闲端口
```

客户端侧：

```ts
import { RemoteClient } from '@ryharness/api'

const client = await RemoteClient.connect({ port: server.port })

client.graph.namespaces // ['counter'] —— 客户端连上先要一张类型图
await client.call('counter', 'add', [2, 3]) // 5
await client.call('counter', 'nope') // 立刻失败：类型图里没有这个方法
```

`client.invoke` 是给**生成的客户端**用的调用入口（namespace + 方法名 + 位置参数），
生成的代码只认这一个形状，换传输、换网关都不用改生成的代码。

## 挂载

```ts
host.mount({
  namespace: 'counter', // 不给就问本地对象的 typertRemote.namespace
  service: new Counter(), // 带 @Remote 方法的实例
  serviceKey: '账房', // 写进类型图给人看，缺省取构造函数名
  methods: {
    // 签名注解：运行时反射拿不到 TS 类型，类型由这里补。
    add: {
      params: [
        { name: 'a', type: 'number' },
        { name: 'b', type: 'number' },
      ],
      returns: 'number',
    },
  },
})
```

挂载是**装配时**的动作，冲突当场报：同一个命名空间里两个 remote 抢同一个名字，抛
`gateway/conflict`。挂载之后类型图立刻更新（服务端每次请求都重新看一眼登记表），
已经连着的客户端不用重连。

## 失败

| 机器码 | 什么时候 |
|---|---|
| `gateway/bad-request` | 方法不存在、参数个数对不上 |
| `gateway/timeout` | 时限内没回包（客户端侧的 `timeoutMs`） |
| `gateway/cancelled` | 调用方用 AbortSignal 取消了 |
| `gateway/disconnected` | 宿主停服、连接断了 |

宿主侧抛的 `RemoteError` **原样**到客户端：机器码、消息、结构化详情都不改。宿主抛普通
异常时，包成 `gateway/internal`，但**原文不丢**。

## 导出

| 导出 | 一句话 |
|---|---|
| `RemoteHost` | 宿主：挂载本地对象、给出类型图、接管连接 |
| `RemoteClient` | 客户端：连上宿主、照着类型图调方法 |
| `createRemoteHostServer` | 起一个真的能连的 TCP 宿主服务（端口 0 = 系统挑） |
| `connectRemoteSocket` / `createSocketTransport` | 把 socket 连上 / 包成传输 |
| 线协议转出 | `JsonRpcPeer`、`encodeMessage`、`decodeMessage`、`JSON_RPC_VERSION` 等——与进程外 SDK 共用同一套 |

## 与上游的差距

1. **只做单次的远程调用**。上游的 Remote 层还有：多路复用的流、流上的上行数据（客户端
   往流里发东西）、宿主事件转发给客户端。本包一条连接一次一个请求，没有流。
2. **没有权限模型**。上游有 `remote-access`：决定哪些 Peer 能调哪些方法、过滤列表结果、
   推每个 Peer 的权限快照。本包不识别身份、不管权限。
3. **没有会话路由**。上游的 `session-controller` 负责「这次调用该落到哪个会话的哪个
   agent」，还有 Agent/Session 身份策略。本包是**一个命名空间一个本地对象**的直连模型，
   多会话路由由上层自己分命名空间或分宿主。
4. **只有 TCP 与内存对两种连接**。上游跑在应用自己的 Connection 层上（HTTP+WS，带
   `/api` 信任边界与响应信封）。本包是一条裸的 JSON-RPC 连接。
5. **没有流式结果**。上游的调用可以回一条流；本包的调用回一个值。

## 边界

- 不碰 agent 循环、不碰会话、不碰 LLM：它只负责「把一个方法调用送到对面去」。
- 不做鉴权：连接可信由宿主负责。
- 端口 0 让系统挑端口是给测试与「同机不同连接」用的；真部署请显式给端口与地址。
