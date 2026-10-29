# @ryharness/subagent

子代理：一个助理把一段活交给一个独立的子代理去干，干完把结论带回来。

上游 dsh 把这一族拆成好几个包（provider 注册表、进程内 spawn、fork、ACP、Codex、Claude Code、dsh-sdk，外加模型侧的两件工具）。这轮只做**进程内**那一档：契约、进程内实现、状态与生命周期、两件模型侧工具。

## 提供什么

- `SubagentProvider` —— provider 契约：**给一段任务描述 + 一份工具集，跑一次独立的任务，把最终结果回给父代理**。模型路由、工具集、步数、时长、结果回法都在这一份契约里。
- `createInProcessSubagentProvider()` —— 进程内实现：拿 `@ryharness/agent` 的 `AgentLoop` 起一次**上下文干净**的运行。
- `SubagentService` —— 派活、管生命周期、留记录；模型看得见的两件工具从这里取（`service.modelTools`）。
- `SubagentRunRecord` —— 每次委派一条可查的记录：id、任务、模型、步数、用过的工具、耗时、终态。

## 怎么用

宿主（服务端）建一个服务，把两件工具挂进工具注册表：

```ts
const service = new SubagentService({
  llm: ctx.llm,
  route: { provider: 'deepseek', model: 'deepseek-chat' }, // 父代理的路由
  tools: ctx.tools, // 子代理可用的工具集（委派工具会被自动裁掉）
})
ctx.tools.register(service.modelTools[0])
ctx.tools.register(service.modelTools[1])
```

一行会话里跑多个 agent 时，用 `resolveRoute` 按 `ToolContext` 解析父代理的路由（每个 agent 的模型可能不一样）：

```ts
new SubagentService({
  llm: ctx.llm,
  route: { provider: 'deepseek', model: 'deepseek-chat' },
  resolveRoute: (ctx) => agentRouteOf(ctx.agentId),
})
```

`model` 参数缺省时用父代理的路由；`model` 传了就换子代理的模型（provider 路由不变）。

模型侧看到的是两件工具：

- **`subagent`**：参数 `{ task, model? }`。`task` 要写全——子代理看不到父对话的历史，缺的信息它只能猜。返回子代理的最终文本，外加一句过程说明（跑了几步、用了哪些工具）。
- **`subagent_list`**：列出这次对话这一轮起过的子代理（id、状态、任务摘要、结果摘要）。用来看「刚才那趟活到底跑完没有」。

宿主在每轮收尾时调 `service.endRound(conversationId)`：没跑完的子代理会被收回来，轮次推进到下一轮（下一轮再看 `subagent_list`，看到的就是新一轮新起的那几个）。服务下线时调 `service.dispose()`。

宿主不调 `endRound` 的话轮次不推进，`subagent_list` 会一直攒着这次对话起过的所有子代理——不会出错，只是列表会越来越长。

## 子代理拿到什么上下文

**只有任务描述。** 父对话的历史一个字都不进子代理的上下文——它看得见的只有父代理写进 `task` 里的那几个字，外加它自己在这趟活里产生的工具结果。

代价是父代理得多写几个字，收益是子代理不会被一屏无关的历史带偏（「刚才那个文件」「上次说的那个方案」对它一律不存在）。

子代理自己的工具调用在自己的上下文里跑完：它的工具结果回给它自己，不回父代理。父代理拿到的只有最后一条 assistant 文本。

## 不许套娃

子代理**不能再起子代理**。两道闸：

1. 服务裁掉子代理工具集里的 `subagent` 与 `subagent_list`——模型连声明都看不到。
2. 万一模型硬塞一个 `subagent` 调用进来，循环按「未知工具」回一条错误结果，委派不会真的发生。

层数没有尽头的话，每一层都自带一份上下文与一套工具，几层就能把机器跑满。委派结果里会写明「子代理不能再起子代理」，父代理看得见这条边界。

## 状态与超时

四种状态：

| 状态 | 含义 |
|---|---|
| `running` | 还在跑 |
| `completed` | 跑完了，有结论 |
| `failed` | 跑挂了，或者被取消（父对话结束 / 被中断） |
| `timeout` | 超时（默认 120 秒） |

失败与超时都变成**可读的中文错误结果**回给父代理（`子代理没有跑完：子代理超时（120000 毫秒）……`），不是一句英文异常——父代理看到的是「这趟活没拿到结果，任务可以拆小再派」，而不是无从下手的堆栈。

步数上限默认 12，超时默认 120 秒，都在 `SubagentServiceOptions` 上可配。

「取消」没有单列一档：父对话被打断与子代理自己跑挂，对父代理来说是同一件事——这趟活没拿到结果。把它并进 `failed`，父代理只需要处理一种坏结果。

## 可观测

每次委派留一条记录（`service.listRuns()` / `service.getRun(id)`）：子代理 id、任务、模型路由、步数、用过的工具、开始与结束时刻、耗时、终态、失败原因。`subagent_list` 读的是同一份。

记录是快照：调用方拿到的是副本，不会跟着内部状态变。还在跑的子代理也能查——`onProgress` 回调会把「跑到第几步、用过哪些工具」实时写回记录。

## 与上游 dsh 的差距

上游这一族还有下面这些，这轮**没做**：

- **跨进程子代理**（`subagent-acp` / `subagent-codex` / `subagent-claude-code` / `subagent-dsh-sdk`）：子代理跑在另一个进程或另一个 Harness 运行时里，靠 ACP 或各家官方协议通信。这轮只有进程内实现——`SubagentProvider` 契约留好了接缝，但没有任何跨进程后端。
- **可续接的子代理**（continuable subagents）：上游的子代理跑完之后还能接着对话、接受追问。这轮是一次性委派：跑完就结束，没有续接。
- **相邻 agent 之间的消息与打断**（`tool-subagent-control`）：上游允许 agent 给邻居发消息、打断对方。这轮只有「父 → 子」这一条向。
- **fork**：上游能拿父对话已完成的历史起一个子代理。这轮刻意不做——子代理拿到的上下文只有任务描述。

为什么这轮不做：跨进程后端要处理进程生命周期、协议适配与失败恢复，是一整套东西；可续接子代理要处理状态的持久化与恢复；相邻通信要处理多 agent 之间的路由与权限。先把「派一趟活、拿到结论、这一轮收干净」这条最常用的路走通，再往上加。

`SubagentProvider` 契约本身与上游是对齐的：接一个跨进程后端，就是实现同一个 `run(input)` 接口，不用改调用方。
