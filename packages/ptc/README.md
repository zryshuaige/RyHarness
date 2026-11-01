# @ryharness/ptc

PTC = Program To Call：**让模型写一段程序，在宿主提供的异步函数上跑它**。

模型不直接一个个调工具——它写一小段程序，程序去调宿主给的函数。这样「先查三个地方、
再把结果拼起来」这类多步逻辑由模型自己决定顺序，宿主只负责提供能力与边界。

上游 dsh 把这一族拆成三个包：服务契约（`ptc-runtime`）、Node 后端
（`ptc-runtime-node`）、实验性的 Python 后端（`experimental/ptc-runtime-python`）。
本包把前两个合在一起放在一个包里：契约与后端都是零依赖的纯 Node，放一起省一次
跨包引用。

## 提供什么

| 导出 | 一句话 |
|---|---|
| `PtcRuntime` | 服务契约：**跑一段程序，回报打印、返回值与失败**。 |
| `PtcRequest` / `PtcResult` / `PtcFailure` | 一次请求与一次结果的形状。 |
| `NodePtcRuntime` | Node 后端：在**独立子进程**里跑，子进程里跑的是本包自带的宿主脚本。 |
| `PtcBinding` | 宿主提供的绑定：程序按名字调用的异步函数。 |
| `PtcBindingError` | 绑定调用失败（带分类，跨进程传过去时分类不丢）。 |
| `PtcFilePolicy` / `resolveFilePolicy` / `checkPath` | 文件策略：程序能读哪些路径、能写哪些路径。 |
| `createFileBindings` / `FILE_BINDING_NAMES` | 运行时自带的四个文件绑定。 |
| `isPtcMode` / `PTC_MODES` / `PTC_FAILURE_KINDS` | 模式与失败分类的名单（接口入参校验用）。 |

## 三种跑法

同一段源码，三种跑法，语义不同：

| 模式 | 源码是什么 | 绑定怎么拿 | 返回值 | 进程 |
|---|---|---|---|---|
| `function-body` | 一个 async **函数体** | 函数的**唯一参数**（一个对象，按名取） | `return` 的值 | 每次新进程 |
| `script` | 整段**脚本** | **全局名**，直接按名调用 | `return` 的值 | 每次新进程（可保留） |
| `repl` | **一条语句** | **全局名** | 这条语句的**完成值** | 同一个 owner 共用 |

三处差异是能测出来的：

- `function-body` 里绑定不在全局，`const { greet } = bindings` 才拿得到；`script` /
  `repl` 里 `greet(…)` 直接能用。
- `script` 里没有 `return` 就没有返回值；`repl` 里 `1 + 1` 的完成值是 `2`。
- `repl` 保留状态：同一个 owner 的第二条语句能看到第一条留下的变量。

```ts
const runtime = new NodePtcRuntime()
const result = await runtime.run({
  program: 'const { readTextFile } = bindings; return readTextFile("note.txt")',
  mode: 'function-body',
})
// → { ok: true, output: [], value: '这里有一句话', durationMs: 87 }
```

## 绑定是异步的，程序里要 await

绑定要跨进程回到宿主那边执行，**每一次调用都是异步的**。程序里写 `greet(…)` 拿到的是
一个 promise，要 `await` 才拿到结果：

```ts
program: 'const id = await spawn("查一下")'   // 对
program: 'const id = spawn("查一下")'         // 拿到的是 promise
```

忘了 `await` 也不会把事丢掉：这一轮结束前运行时会把还在路上的绑定调用等完（写文件
不会因为少写一个 await 就丢掉）。但**失败的绑定如果没人接住，这一轮算失败**——否则
模型会以为一切正常。

## 绑定不能传函数句柄

进程之间传不了函数。传过去的只有绑定的**名字与说明**；程序真的调用时，子进程回头问
宿主，宿主执行完再把结果送回去。所以：

- 宿主的绑定实现**只在宿主进程里**跑（文件策略、配额、权限都在这一侧执行）。
- 绑定抛的错会带着分类回到程序里，程序可以 `try/catch` 接住。

## 文件策略

程序能碰哪些路径由宿主定（`filePolicy`）。判定分两层：

- **词法层**：相对路径按 `cwd` 解析，解析完必须落在允许的根目录里。
- **真实路径层**：把路径里最近的那个真实存在的祖先解一遍符号链接，再判一次——工作区里
  放一个指向外面的链接，词法层看不出来，这一层能。

运行时自带四个文件绑定（`readTextFile` / `writeTextFile` / `listDirectory` /
`fileExists`），越界的读写会被拒，失败分类是 `policy`。

## 失败是结果，不是异常

语法错、运行时抛错、超时、取消、越界——全都变成 `PtcResult.failure` 里的信息，
`run()` 不会抛。调用方要能把它原样呈现给模型：「这段程序报错了，错误是……」比一句
500 有用得多。

失败分类（`PtcFailureKind`）：`syntax`（模型写错了）、`runtime`（跑挂了）、`timeout`
（跑太久）、`policy`（越界）、`aborted`（人叫停的）、`spawn`（子进程没起来）、`limit`
（超出配额）。

## 保留状态

`persistence` 决定进程活多久：

- `none`（默认）：每次执行起一个新进程。
- `script`：同一个 owner 复用同一个进程，脚本之间能看到上一次留下的全局变量。
- `repl`：同上，语义上按 REPL 逐条执行。

`mode: 'repl'` 默认按 `repl` 保留状态。进程结束、超时或被释放，状态跟着一起没——
`release(owner)` 显式收掉某个 owner，`dispose()` 收掉全部。

## 边界

- **程序没有宿主的环境**：跑在 `node:vm` 的独立上下文里，那里没有 `process`、没有
  `require`、没有 `fs`。它想干别的，只能通过宿主给的绑定。
- **子进程不继承宿主的环境变量**：只留跑 node 需要的那几个（PATH、SystemRoot 等），
  宿主的密钥不会递过去。
- **返回值必须能序列化成 JSON**：循环引用这类会变成一条失败，不是静悄悄变成空。
- **没有内存配额**：上游给子进程加了内存上限，本轮没有——程序死循环吃光内存这件事
  由超时兜底（超时是墙钟，不是内存）。

## 与上游 dsh 的差距

上游这一族有三个包，本包做了两个，差距逐条列出来：

- **实验性 Python 后端**（`experimental/ptc-runtime-python`）：**没做**。它要一个
  CPython 进程，还要一套 fd-3 上的线协议（宿主与 Python 进程之间用第三个文件描述符
  传帧）。本轮没有 Python 运行时可依赖，也不想为「实验性」后端先铺一套线协议；等
  Node 这边跑稳了再说。
- **上游的输出账本（output ledger）与 JSON 输出流**：上游把打印拆成「流」与「账本」
  两层，方便中途截断与回放。本轮的打印是一次性汇总成 `output: string[]`，够用但
  没有流式回放。
- **上游的沙箱化 Node 运行时**（上游有一份 "sandboxed node ptc runtime" 的设计）：
  本包靠「独立进程 + vm 上下文 + 文件策略」划边界，没有内核级沙箱（那属于
  `@ryharness/sandbox` 的活）。进程内逃逸拿到的是子进程的权限，不是宿主的。
- **上游的 REPL 语义更细**（补全、历史、多行编辑那一层）：本包只做「逐条执行 + 保留
  状态」。

## 包里的文件

- `src/types.ts` —— 服务契约（模式、请求、结果、绑定、文件策略）。
- `src/node.ts` —— Node 后端（起进程、发请求、管时限）。
- `src/session.ts` —— 一个子进程会话（发执行、回绑定调用、收结果）。
- `src/policy.ts` —— 文件策略的判定。
- `src/bindings.ts` —— 四个文件绑定。
- `src/wire.ts` —— 跨进程传值与错误的小工具。
- `src/errors.ts` —— `PtcBindingError`。
- `child.mjs` —— **子进程里跑的宿主脚本**（放在包根目录：源码态与构建产物都差一层，
  `../child.mjs` 一次写对）。它按模式执行源码，把打印、返回值、失败原因发回宿主。
