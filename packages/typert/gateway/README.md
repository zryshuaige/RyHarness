# @ryharness/typert-gateway

类型图网关。三件事：

- **类型图**：从带 `@Remote` 的实例上反射出「有哪些方法、参数叫什么」，组成一张 namespace → service → method 的表。类型由注解补上。
- **网关**：把「调一个 remote 方法」变成一次跨连接调用。线上是 JSON-RPC 2.0（自己写的，不引依赖），错误带机器码，超时、取消、断线都有明确说法。
- **生成的客户端**：照着类型图生成 TypeScript 类型与运行时代理——调一个不存在的方法，编译期或运行期立刻报错。

上游对照：dsh 的 `typert` 组里，`protocol` 放装饰器与描述符，`generator` 在编译期生成类型图，
`registry` 在运行时存着生成物，`loader` 负责自动注册。本包对应的是「协议面」的另外半边：
**运行时反射 + 网关 + 客户端生成**，底座（`@ryharness/typert-protocol`）在本仓已经落地，本包只读不改。

## 类型图

```ts
import { Remote } from '@ryharness/typert-protocol'
import { buildTypeGraph } from '@ryharness/typert-gateway'

class Greeter {
  @Remote
  greet(name: string, greeting = '你好'): string {
    return `${greeting}，${name}`
  }
}

const graph = buildTypeGraph([
  {
    namespace: 'greeting',
    service: new Greeter(),
    // 运行时反射拿不到 TS 类型，类型由这里补。
    methods: {
      greet: {
        params: [
          { name: 'name', type: 'string' },
          { name: 'greeting', type: 'string', optional: true },
        ],
        returns: 'string',
      },
    },
  },
])

graph.namespaces // ['greeting']
graph.entries[0]?.name // 'greet'
```

三件事要记住：

1. **反射的是实例，不是类**。`@Remote` 的标记是实例构造时才写到原型上的（装饰器的
   initializer 跟着实例走），所以想从一个类读出方法清单，得先有一个实例。
2. **参数名与个数是反射出来的，类型不是**。TS 的类型在运行时被抹掉了，图里存的是**类型
   表达式文本**（`'string'`、`'number[]'`），由注解补；没补的地方一律 `'unknown'`，不猜。
3. **同名冲突在装配时就报错**。同一个命名空间里两个 remote 抢同一个名字，直接抛
   `gateway/conflict`，并把冲突的命名空间与方法名写进错误详情——这种错等到「客户端调
   `greet` 不知道该调谁」时再发现，排查成本已经高得离谱。

## 网关（线协议）

线上是 **JSON-RPC 2.0**，分帧用**按行分隔的 JSON**（一条消息一行）——TCP、管道、stdio
都能用同一套。

一次调用的线上形状：

```json
{"jsonrpc":"2.0","id":"r1","method":"remote/call","params":{"namespace":"greeting","method":"greet","args":["世界"]}}
```

回包要么 `result` 要么 `error`。错误里带**机器码**：

```json
{"jsonrpc":"2.0","id":"r1","error":{"code":-32001,"message":"请求超时（1500ms 内没有回包）","data":{"remoteCode":"gateway/timeout","details":{"timeoutMs":1500}}}}
```

`data.remoteCode` 才是判别依据（协议包的规定：判别看 `code`，不看 `instanceof`）。本包自己
的机器码：

| 机器码 | 什么时候 |
|---|---|
| `gateway/bad-request` | 方法不存在、参数个数对不上、线上消息不合法 |
| `gateway/cancelled` | 调用方用 AbortSignal 取消了 |
| `gateway/timeout` | 时限内没回包 |
| `gateway/disconnected` | 连接断了（对端进程没了、socket 关了） |
| `gateway/conflict` | 装配时两个 remote 抢同一个名字 |
| `gateway/internal` | 宿主侧没分类的失败 |

取消是**协作式**的：调用方放弃之后会发一条 `$/cancelRequest` 通知，对端收到才知道该收手；
对端不理这条通知也不影响调用方——调用方早就拿到失败了。方法最后一个参数叫 `signal` 时，
宿主会把这一次的取消信号塞进去（本仓 `LlmRuntime` 就是这个写法）。

## 生成的客户端

```ts
import { generateClientSource } from '@ryharness/typert-gateway'

const source = generateClientSource(graph)
// → 一个完整的 TS 模块：类型接口 + 内嵌的类型图 + 工厂函数
```

生成的东西有两半：

- **类型**：每个命名空间一个接口。调用一个图里没有的方法，**编译期就报错**。
- **运行时代理**：按图校验的代理对象。访问图里没有的命名空间或方法，**运行期立刻抛错**，
  不会把一个「未知方法」发出去等对端回一句看不懂的。

想手写客户端也行，用同一个代理：

```ts
import { createRemoteClientProxy } from '@ryharness/typert-gateway'

const proxy = createRemoteClientProxy(graph, (namespace, method, args) => gateway.call(namespace, method, args))
await proxy.greeting.greet('世界')
proxy.greeting.nope // 立刻抛错：类型图里没有这个方法
```

## 导出

| 导出 | 一句话 |
|---|---|
| `buildTypeGraph` / `buildTypeGraphBundle` | 按挂载项建类型图（后者连宿主侧的可调用形态一起给） |
| `findEntry` / `isTypeGraph` / `formatGraph` | 在图里找方法 / 校验一张图 / 把图写成人能读的几行字 |
| `RemoteRegistry` | 宿主侧的登记表：类型图 + 本地调用 |
| `RemoteGatewayServer` | 服务端：接一条连接，按图分发 |
| `RemoteGatewayClient` | 客户端：照着图调，先看图再发 |
| `JsonRpcPeer` / `JsonRpcFrameDecoder` | JSON-RPC 对端（关联、超时、取消、断线）与按行分帧 |
| `encodeMessage` / `decodeMessage` / `encodeFailure` / `decodeRemoteError` | 线协议的编解码 |
| `createMemoryTransportPair` | 内存传输对：同进程两角色不用起网络 |
| `createRemoteClientProxy` | 按图校验的运行时代理 |
| `generateClientTypes` / `generateClientSource` | 生成类型声明 / 生成完整客户端模块 |
| `RemoteError` 机器码助手 | `badRequest` / `cancelled` / `timeoutFailure` / `disconnectedFailure` / `conflictFailure` |

## 与上游的差距

1. **没有编译期代码生成器**。上游的 `typert/generator` 从 `.ts` 源码编译出类型图、schema
   与描述符；本包是**运行时反射**（装饰器把描述符写在原型上）。差在哪：
   - 反射拿到的是**实例**上的标记，不是类；上游编译的是源码，能拿到完整类型。
   - 反射**拿不到 TS 类型**，要人写注解；上游从类型声明自动生成。
   - 上游能编译 `.d.ts` 之外的 schema（Zod 之类）并做运行时校验；本包不做参数校验，
     只校验个数。
   - 代价换来的好处：不用在构建期跑一遍 TS 编译器，加一个 `@Remote` 就能上线。
2. **没有多路复用**。上游的 Gateway 有一条 mux，承载流与事件；本包一条连接一次一个请求，
   没有流、没有事件转发、没有双向流。
3. **没有二进制协议**。线上只有 JSON（按行分隔）；上游有可选的二进制帧。
4. **没有鉴权框架**。本包不识别身份、不管权限；连接可信由宿主负责。
5. **没有上游那套 registry/loader**（运行时注册表、Loader 自动注册生成物）。本包不缓存
   生成物，每次挂载现算。

## 边界

- 不碰 agent 循环、不碰会话、不碰 LLM：它给的是「怎么把一个方法调用送到对面去」。
- 不做重连：连接断了就是断了，失败带 `gateway/disconnected`，重连由上层决定。
- 参数校验只到**个数**这一层（多了少了都拒），不做值的形状校验——值的形状交给注解与
  调用方。
