# @ryharness/workflow

编排：**让模型写一段编排脚本，脚本把活派给子代理并行去做，最后带回一个值**。

跟「派一趟活」的区别在 `subagent` 那件工具上：`subagent` 是派一个任务、拿一份结论；
`workflow` 是模型自己写一段脚本——派几个、谁先谁后、怎么合起来，模型说了算。适合
「同一件事拆成几块同时查」这类多步的活。

上游 dsh 把这一族拆成三个包：编排引擎（`workflow`）、用 PTC 跑脚本的那一层
（`workflow-ptc`）、给模型的 `workflow` 工具（`tool-workflow`）。本包把三个合在
一起：引擎 + 工具是本包自己的东西，中间那层直接用 `@ryharness/ptc`。

## 提供什么

| 导出 | 一句话 |
|---|---|
| `WorkflowEngine` | 跑一段编排脚本，管扇出上限、时限与收尾。 |
| `WorkflowAgentExecutor` | 子代理执行器契约：**派一个活出去，等它回来**。宿主注入。 |
| `WorkflowAgentRequest` / `WorkflowAgentResult` | 一次委派的请求与结果。 |
| `WorkflowRequest` / `WorkflowResult` / `WorkflowAgentRun` | 一次编排的请求、结果与派活记录。 |
| `createWorkflowTool` / `WORKFLOW_TOOL_NAME` | 模型看得见的那件 `workflow` 工具。 |
| `createInMemoryWorkflowExecutor` | 内存执行器：测试与干跑用，不起真的子代理。 |
| `DEFAULT_WORKFLOW_TIMEOUT_MS` / `DEFAULT_WORKFLOW_MAX_FAN_OUT` | 缺省时限（60 秒）与扇出上限（8）。 |

## 脚本里能用的四个函数

```js
const id = await spawnAgent('查一下城南那几家店')        // 派一个
const ids = await spawnAgents(['查甲', '查乙', '查丙'])    // 一次派多个，并行跑
const text = await awaitAgent(id)                        // 等一个
const texts = await awaitAgents(ids)                     // 等一批，按传入顺序
return texts.join('\n')                                  // 这次编排的结果
```

- **这四个都是异步的**，调用要 `await`（它们要跨进程回到宿主执行）。
- `spawnAgents` 一次派多个，**并行跑**；`awaitAgents` 的结果**按传入顺序**返回，不按
  跑完的顺序。
- 派出去的子代理在 `result.agents` 里留一条记录（id、任务、状态、耗时、结论），
  顺序就是派出的顺序。
- 子代理失败或超时，`awaitAgent` 会抛错——脚本可以 `try/catch` 接住，也可以让它冒泡
  出去（冒泡出去就是这次编排的失败）。

## 扇出上限

一次编排最多派 **8** 个子代理（`maxFanOut` 可调）。超了就不派了，这次编排失败，
失败分类是 `limit`，原因写明「一次最多派 8 个子代理」。

为什么要有这个闸：模型一次派 100 个是常事，不限的话一屏就把机器吃满了。

## 时限与收尾

- 一次编排有时限（默认 60 秒）。到点子进程被终止，这次编排是一条 `timeout` 失败。
- 编排结束时（成功、失败、超时都一样），**脚本没收回来的子代理一律被中止**——后台
  还在跑的活不会一直烧 token。

## 子代理执行器：宿主注入

引擎不认识 agent、不认识会话、不认识模型路由。它只认 {@link WorkflowAgentExecutor}
这一条契约：

```ts
interface WorkflowAgentExecutor {
  run(request: WorkflowAgentRequest): Promise<WorkflowAgentResult>
}
```

所以「派出去的活由谁跑」是宿主的事。接本仓的子代理，就是写一个十几行的适配器：

```ts
const executor: WorkflowAgentExecutor = {
  async run(request) {
    const result = await subagentService.delegate({ task: request.task }, toolCtx)
    return { text: result.text, status: result.status === 'completed' ? 'completed' : 'failed', error: result.error }
  },
}
```

本包自带一个**内存执行器**（`createInMemoryWorkflowExecutor`），测试与干跑用它：
不接真的模型，按一句规则把活干完。

## 模型工具

`workflow` 工具，参数两个：

- `script`（必填）：编排脚本源码。
- `description`（可选）：这次编排要干什么（一句话），记在运行记录里。

跑完给模型回一段文本：结论在前、脚本打印的内容、派出去的子代理（谁、跑成什么样）、
这次编排花了多久。编排失败时回一条错误结果，模型看到的是「编排没跑完：……」。

## 怎么用

```ts
const runtime = new NodePtcRuntime({ filePolicy: { cwd: workspaceRoot } })
const engine = new WorkflowEngine({ runtime, executor, filePolicy: { cwd: workspaceRoot } })
ctx.tools.register(createWorkflowTool({ engine }))
```

服务端插件在 `apps/server/src/plugins/workflow.ts`（`workflowPlugin(options)`）：
`options.executor` 是必填的（宿主注入），`options.filePolicy` / `timeoutMs` /
`maxFanOut` 可选。插件卸了以后，编排留下的子进程会收干净。

## 边界

- **脚本跑在独立子进程里**：模型写的代码碰不到宿主进程的内存；它能读写的路径由
  文件策略说了算（见 `@ryharness/ptc`）。
- **引擎不碰 agent 循环**：模型路由、工具白名单、步数上限都归宿主那侧。
- **编排不持久化**：这轮跑完就完了，没有「跑到一半存下来明天接着跑」。上游有
  durable workflow runs，本轮没有。

## 与上游 dsh 的差距

上游这一族有三个包，本包把三个合在一起，差距逐条列出来：

- **上游的 `workflow-ptc`（用 PTC 跑脚本的那一层）**：上游那一层还管「脚本沙箱复用」
  ——同一轮里多个脚本共用一个 PTC 进程。本包每次编排起一个新进程，多脚本之间不共享
  状态（脚本之间要共享状态时，用 PTC 自己的 `persistence` 能力）。
- **上游的 workflow 事件流**（`workflow/*` 事件、后台运行、界面上的运行面板）：本包
  只有「跑完给一份结果」，没有事件流、没有后台运行、没有界面。
- **上游的 `ralph` 那件工具**（固定循环的「新鲜子代理」执行法）：本包没有。
- **上游的持久化编排**（durable workflow runs）：本编排不落盘，跑完就完了。
- **上游的执行器不止一种**（上游能派给不同的 provider）：本包只留一条执行器契约，
  具体派给谁由宿主注入。
