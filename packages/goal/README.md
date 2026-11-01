# @ryharness/goal

跨重启的目标：一个会话有一件要跨着做完的事，助理看得见，人也随时查得到、改得动。

上游 dsh 把这一族拆成四个包（goal 服务、tool-goal 模型工具、command-goal 人的 `/goal` 命令、goal-round-driver 自动续跑）。这轮做前三个的语义，**不做 goal-round-driver**——理由见下面「不做什么」。

## 提供什么

- `GoalService` —— 一个会话至多一个目标：建、改、暂停、恢复、完成、标记卡住、清除；每次改动留一笔历史。
- `GoalStore` —— 存储接口；包内给 `FileGoalStore`（落盘，跨重启还在）与 `MemoryGoalStore`（进程内）。
- 三件模型工具 —— `get_goal` / `create_goal` / `update_goal`。
- `/goal` 命令 —— `createGoalCommand()` 给出的**纯数据**命令定义（名字、说明、execute 函数），宿主直接注册进命令表即可。

## 目标是什么

目标是**完成状态**，不是排程。它记的是「这件事做到什么程度算完」，不记「什么时候提醒我」——后者是 `@ryharness/schedule` 的事。

一条目标记这些：

| 字段 | 含义 |
|---|---|
| `title` | 一句话标题：这件事叫什么 |
| `description` | 展开说：具体要做出什么 |
| `criteria` | 完成判据：怎么算做完 |
| `status` | 现在怎么样（见下） |
| `createdAt` / `updatedAt` | 建立与最近一次改动的时刻 |

## 状态机

五档，流转是显式的（`ALLOWED_TRANSITIONS`）：

| 状态 | 含义 | 能去哪儿 |
|---|---|---|
| `active` | 在推进 | 暂停 / 卡住 / 完成 / 清除 |
| `paused` | 人按了暂停 | 恢复 / 卡住 / 完成 / 清除 |
| `blocked` | 卡住了（缺东西、等别人、等授权） | 恢复 / 完成 / 清除 |
| `completed` | 做完了 | 只能清除 |
| `cleared` | 人不要了 | 谁也回不去（要重来就重新建一个） |

两条硬规矩：

- **完成是终态**。不能从「完成」跳回「进行中」——目标记的是状态，不是待办清单里的一个勾。
- **终态不许改文案**。做完的事就是做完的，回头想改就重新定一个。

## 归属按会话

目标归会话所有：别的会话的目标**看不见也动不了**。隔离做在服务这一层（每个方法都要求带 `sessionId`），不靠调用方自觉。

模型工具这一层更是白送的：会话 id 从工具上下文取，模型编不出来，所以它连「填别的会话 id」这件事都做不到。

## 跨重启

目标与它的历史都落在 `GoalStore` 里，重启后读回来还是那一条、那些历史。

```ts
const service = new GoalService({ storePath: join(dataDir, 'goals.json') })
```

文件后端写「临时文件 + rename」：崩在写一半时留下的是一份完整的旧数据，不是半份 JSON。整份文件坏了就当没有目标（用户重设一个就行），单条记录坏了只丢那一条。

## 每次改动留一笔

`service.history(sessionId)` 给出按时间正序的变更记录：什么时候、改了什么、状态从哪儿到哪儿。

```ts
service.create({ sessionId: 'c1', title: '把周报写完' })
service.update({ sessionId: 'c1', criteria: '周报发到群里' })
service.pause('c1')
service.complete('c1')

service.history('c1').map((c) => c.action)
// ['created', 'updated', 'paused', 'completed']
```

清掉目标之后历史仍然留着：清掉的是「这件事」，不是「这段经历」。

## 模型侧的三件工具

- **`get_goal`**：看当前目标（标题、状态、完成判据）。手上有一件要跨着做完的事时先看它。
- **`create_goal`**：参数 `title`（必填）、`description`、`criteria`。一个会话只能有一个目标，已经有再建会失败——这时该用 `update_goal`。
- **`update_goal`**：参数 `title` / `description` / `criteria` 改内容，`status` 换状态（`active` / `paused` / `blocked` / `completed` / `cleared`）。

参数缺了、状态非法、流转不合法，工具都给一句能照着改的中文，不是英文异常。

## 人的 `/goal` 命令

命令是**纯数据**：`name`、`description`、`execute`。形状与 `@ryharness/commands` 的命令定义一致，但本包**不依赖**那个包——宿主拿它直接注册即可。

```ts
const command = createGoalCommand(service, {
  resolveSessionId: () => 当前会话 id,
})
```

支持的写法：

| 命令 | 干什么 |
|---|---|
| `/goal` 或 `/goal list` | 看现状：目标 + 最近几次改动 |
| `/goal set <标题>` | 定目标（没有就建，有了就改标题） |
| `/goal stop` | 暂停 |
| `/goal resume` | 恢复 |
| `/goal complete` | 标记完成 |
| `/goal clear` | 清除 |

命令**不花模型一轮**：它直接跑服务，结果给界面看。

## 不做什么

- **不做 goal-round-driver（自动续跑）**。上游有个包把「进行中的目标」变成一轮接一轮的自动续跑。这轮不做：那是「一轮接一轮地推」的产品决策，跟「一个会话一个目标、跨重启还在」这个核心是两件事。目标记的是完成状态，要不要自动续跑是另一层的决定。接缝在 `GoalService` 的状态上——`active` 的目标就是自动续跑的输入，宿主要加这一层时直接接得上。
- **不做目标之间的编排**。一个会话一个目标，没有「目标 A 完成后自动开始目标 B」。
- **不碰会话历史**。目标记在目标自己的存储里；它不会进对话历史，也不会被模型轮的上下文压缩带走。
- **不做 UI**。这一族给的是服务与命令定义；界面上的目标条是宿主的事。

## 与上游 dsh 的差距

- **goal-round-driver**：上游有，这轮没有。理由见上面「不做什么」。
- **目标变更事件（durable `goal/change` 事件）**：上游的目标改动会作为持久事件流出去，让别的部分（UI、统计）订阅。这轮只在本服务里留历史（`history()`），没有做成对外的事件流——宿主要接事件，自己订阅服务的变化点即可。
- **goal 配置文件（config catalog）**：上游的目标服务有一份配置（存哪、默认判据之类）。这轮配置走构造参数（`GoalServiceOptions`），没有独立的配置文件层。
- **fork 继承**：上游 fork 会话时目标跟着走。这轮目标按会话 id 存，fork 出来的会话是新的会话 id，**不会自动继承目标**——要继承由宿主显式拷一次。
- **goal-bar（界面上的目标条）**：上游有专门的目标条组件。这轮只给命令与工具，界面由宿主做。
