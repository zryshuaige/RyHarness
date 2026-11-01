# @ryharness/jobs — 后台任务与计划模式

两族东西放在一个包里，因为它们是同一件事的两头：**一件要花时间的事，怎么跟人打交道**。

- **后台任务**：一件长活交给后台跑，agent 不被卡住；跑完了通过宿主回调通知，写进会话——不是让模型轮询。
- **计划模式**：开着的时候 agent 先探索设计，交一份计划上去**等人批**，批了才执行；打回就改一版再交。

上游对照：[DeepSeek Harness 的 jobs 家族](https://github.com/deepseek-ai) 与 plan 家族。本包是按本仓的
`@ryharness/agent` 工具契约与「人批完才继续」的装配方式重写的，不是移植。

---

## 一、后台任务

### 状态机

```
queued（排队等执行槽位） ──► running（跑着） ──► succeeded
                                    ├──► failed
                                    └──► cancelled
```

`queued` 单独占一档：并发槽位满了的时候任务**真的在等**，把它算成「运行中」会让人以为它已经在干活。

每一步都留痕：`JobPhase[]` 里每一步有 `label` / `status` / `startedAt` / `durationMs` / `summary`。
「没走到」的步骤记 `skipped` 而不是 `failed`——把没做的事说成失败了，主人会以为出了岔子。

### 归属与可见性

**任务属于起它的那个 agent。** 别的 agent 拿着同一个 id 也查不到、也取消不了，哪怕两者在同一个会话里。

| 谁在看 | 看得见吗 |
|---|---|
| 起它的 agent，同一会话 | ✅ |
| 起它的 agent，另一个会话 | ❌（各自独立，通知也各回各家） |
| 别的 agent（同一会话也不行） | ❌ |
| 宿主（`service.list({})` / `list({ conversationId })`） | ✅ 按会话查得到 |

### 模型看得见的四件工具

| 工具 | 干什么 |
|---|---|
| `job_start` | 起一个后台任务。**登记完就回话**，不等它跑完。 |
| `job_list` | 列出**你**（当前 agent、当前会话）起过的任务：状态、跑了多久、结果摘要。 |
| `job_result` | 取结果。还在跑就明说「还在跑」——但**不用它轮询**。 |
| `job_cancel` | 取消还在跑的任务。 |

### 通知怎么回到会话里

包里只负责把「发生了什么」交出去，**落进对话是宿主的事**：

```ts
const jobs = new JobService({
  executors: [createSubagentJobExecutor(subagents)],
  onComplete: (notice) => {
    // notice.job 是最终快照；notice.conversationId 是该写进哪个会话
    writeIntoConversation(notice.conversationId, renderJobNotice(notice.job))
  },
})
```

`renderJobNotice(job)` 给出一句可以直接贴进对话的中文。**模型不必轮询**：通知是宿主推进去的。

### 执行器

一个执行器只需要能回答一件事：**给一段任务描述，把活干完，交回一句结果摘要**。

```ts
export interface JobExecutor {
  readonly kind: string
  run(ctx: JobExecutorContext): Promise<string>
}
```

本包自带一个：`createSubagentJobExecutor(subagents)`——把后台任务接到本仓现成的「耗时活」原语（子代理）上。

> **取消信号**：任务被取消时 abort 的是**这趟活**自己的信号，不是发起那一轮对话的信号。
> 那一轮收尾不会误伤后台任务，后台任务取消却能真的把活停下来。

---

## 二、计划模式

### 计划的数据形状

```ts
interface PlanSnapshot {
  conversationId: string
  version: number          // 每提交一次 +1
  title: string
  steps: { title: string; detail?: string }[]
  status: 'proposed' | 'approved' | 'rejected'
  createdAt: number
  decidedAt?: number
  feedback?: string        // 被打回时人给的反馈
}
```

### 状态机

```
（还没有计划） ──plan_propose──► proposed（待批） ──approve──► approved（可以执行）
                                    │
                                    └──reject──► rejected（打回，带反馈）
```

打回之后 agent 改一版重新交上来，**版本号 +1**：主人因此能分得清「这是改过的第二版」，而不是同一版又递了一次。

### 模式按会话

`enable(conversationId)` / `disable(conversationId)` 只影响那一个会话；另一个会话照常做事。

### 「批了才执行」落在哪

计划模式只**引导**不**封锁**工具——工具清单由宿主另配。它管的是「计划这件事批了没有」：

```ts
const gate = plans.gate(conversationId)
// { allowed: false, reason: '计划已经提交，等人批准；批准之前不要动手。' }
```

宿主拿这个判定决定要不要把这一轮继续跑下去（跟 RyVibe 的盘问是同一类东西：人先回答，队伍才继续）。

### 模型看得见的两件工具

| 工具 | 干什么 |
|---|---|
| `plan_propose` | 交一份计划上去等人批（标题 + 步骤清单）。 |
| `plan_read` | 读当前计划：状态（待批 / 已批 / 被打回）、步骤、被打回的反馈。 |

宿主在计划状态变化时收到 `onChange` 回调，把「待批 / 已批 / 被打回」写进会话，人就能看见并回一句话。

---

## 三、装配

```ts
const jobs = new JobService({
  executors: [createSubagentJobExecutor(subagents)],
  defaultKind: 'subagent',
  onComplete: (notice) => { /* 写进 notice.conversationId */ },
})
const plans = new PlanModeService({
  onChange: (plan) => { /* 写进 plan.conversationId */ },
})

// 给 agent 的工具清单
const tools = [...jobs.modelTools, ...plans.modelTools]
```

`JobService.modelTools` 是那四件后台任务工具，`PlanModeService.modelTools` 是那两件计划工具。

## 四、这轮没做的

- **跨进程 / 跨机器的作业队列**：本包是**进程内**的运行时。活跑在同一个 Electron 进程里，进程退出活就没了。
- **作业持久化与断线续跑**：任务记录只在内存里，重启就没了。
- **`/plan` 命令**：命令本身属于交互层（`apps/server` / 桌面端），本包只提供模式与两件工具。
- **上游的 `wait` / `jobs-local` 分离**：本包把注册表与运行时合在一个服务里。

## 五、门禁

本包对着本仓六道门禁：类型逃逸（0 处 `as unknown as`）、重复代码（0 处 ≥400 token）、lint（biome 干净）、
覆盖率（`packages/jobs/src/**` 每个文件 0 行未覆盖）、中文注释写「为什么」、不用 `as any`。
