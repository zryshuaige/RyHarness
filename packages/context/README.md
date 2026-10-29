# @ryharness/context

上下文装配：把**模型看不见但应该知道**的信息装进请求——工作区里的项目规矩、用户提到的文件、现在几点、另一个会话聊到哪。

装出来的东西是一组 **user 角色的消息**（`ContextMessage`），不是系统提示词、也不是工具结果。理由是上游 dsh 的同一口径：注入内容以用户消息进历史，于是它能落库、能重放、能被压缩，和普通对话内容走同一套生命周期。代价是注入块会留在历史里——重放同一轮时得装出同样的块，否则历史对不上。

本包**不碰存储、不碰请求组装**：跨会话快照的数据源由宿主实现，装出来的消息由宿主决定放哪儿。

## 四块上下文

| 块 | `kind` | 装什么 | 上限（默认） |
|---|---|---|---|
| 工作区指令文件 | `workspace-instructions` | 根目录的 `AGENTS.md` / `RYHARNESS.md` | 8000 字符 |
| @文件引用 | `file-references` | 用户消息里 `@` 到的文件内容 | 单文件 4000 字符、合计 12000 字符、最多 8 个 |
| 当前时间 | `time` | 本地时间 + 时区 + UTC 偏移 | 固定长度 |
| 跨会话快照 | `session-snapshot` | 另一个会话的最近几条消息 | 8 条、2000 字符 |

每块都能单独关掉（`assembleContext` 的 `blocks`），默认开关是：指令文件开、@文件引用开、当前时间开、**跨会话快照关**（它把别的会话带进来，得由宿主明确要）。

装配顺序固定为 **项目指引 → 当前时间 → @文件 → 跨会话快照**。顺序固定是因为重放同一轮时装出的块必须前后一致；指引排最前，是因为它讲的是「规矩」，模型读后面几块时得先知道规矩。

## 工作区指令文件

`loadWorkspaceInstructions({ workspaceRoot })` 在工作区根找 `AGENTS.md`、`RYHARNESS.md`（候选名可改），把内容变成一段「给模型的指引」，开头写明来自哪个文件——模型得看得出这是项目规矩，不是用户这轮随口说的。

- **找不到就不注入**：留一个空块只会占位置，还会让模型以为「项目没规矩」也是一条信息。空文件同样当没有。
- 超长时截断，并在正文里写明「全文 N 字符，这里只保留前 M 字符」。
- 候选名指向工作区外时不装配。

## @文件引用

`collectFileReferences({ workspaceRoot, text })` 从用户这轮的文本里找 `@` 到的路径，把工作区内的文件内容装进来。

- **哪些 `@` 算文件引用**：只有「长得像路径」的才算——带分隔符（`/` 或 `\`）或带扩展名。本仓的 `@` 也用于 @ 某个 agent（群聊里 `@阿码` 派工），所以 `@阿码` 不动。引号形式 `@"带空格的 名字.md"` 单独认。
- **工作区外不装配**：路径要先过工作区边界。词法层之外还查一次真实路径——工作区里指向外部的符号链接 / Windows junction 词法层看不出来，却能把外面的内容读进来。被拒的引用会告诉模型「这个路径不在工作区里」，但不装配内容。
- **找不到要说一声**：静默丢掉会让模型以为文件已经读过了，于是它照着「用户提到的那个文件」继续编。
- 总量与文件数都有上限；超出的引用也会说明没装，不留空。

## 当前时间

`buildTimeContext({ now, timeZone })` 给出本地时间、时区与 UTC 偏移。`now` 可注入（测试用固定时刻），`timeZone` 缺省取系统时区。偏移是拿「时区里的挂钟时间」和「同一时刻的 UTC 挂钟时间」相减算的——夏令时切换时偏移会变，时区名不会。

## 跨会话快照

`buildSessionSnapshot({ source, conversationId, currentConversationId })` 把**另一个会话**的最近若干条消息装成一段有界快照，让模型知道「上次我们聊到哪」。

数据源由宿主实现，本包只定接口（`SessionSnapshotSource`）：

```ts
interface SessionSnapshotSource {
  /** 取会话元信息；没有这个会话时返回 undefined。 */
  session(conversationId: string): SnapshotSession | undefined
  /** 取会话最近的消息（旧→新）。 */
  recentMessages(conversationId: string, limit: number): readonly SnapshotMessage[]
  /** 最近会话列表；excludeId 里的要排除。 */
  recentSessions(excludeId: string | undefined, limit: number): readonly SnapshotSession[]
}
```

本仓的实现方是 `packages/session` 的 `SessionStore`（`getConversation` / `listMessages` / `listConversations`）。本包不 import 它——上下文装配不该被会话存储拖着走。

不指定 `conversationId` 时取最近的一个会话（当前会话除外）。正文开头写明「下面这段来自另一个会话（不是本次对话里说过的话）」：否则模型会把里面的话当成自己说过的话，接着编出「我们之前讨论过」这种其实没发生过的对话。

## 边界（这一包不做什么）

- **不做 @补全 / UI 侧的建议**：上游 dsh 有 `file-reference/` 与 `file-reference-local/` 给输入框做路径补全，本轮只做「装配」，补全留给界面层。
- **不做符号链接之外的内容过滤**：被 @ 到的文件按内容装配，工作区里的 `.env` 也会进去。真正的闸在工具层（`shell_exec` 的敏感路径闸）与宿主策略。
- **不做会话检索**：上游的 `session-query/` 家族（SQLite FTS5 全文搜索、关系追溯、`/export`）不在本轮；快照只取最近几条，走的是宿主给的窄接口。
- **不做 tmux / harness 路径这类运行时上下文**：上游 dsh 有 `tmux-context/` 与 `harness-dev-context/`，我们是桌面应用，没有这套位置语义。
- **不做注入块的压缩**：注入内容原样进历史，压缩交给会话层已有的那套。

## 与上游 dsh 的差距（诚实列出来）

上游 dsh 的 `context/` 家族有 7 个包 + 独立的 `session-query/` 家族。本轮做的是其中四块的**装配**部分：

| 上游包 | 本轮 | 差在哪 |
|---|---|---|
| `agent-instructions/` | 做了 | 上游在文件被编辑后**刷新**指令；本轮不自动刷新，宿主每轮重新装配即可 |
| `file-reference/` | 做了装配 | 上游还提供**给宿主 UI 用的共享 mention 语法**与补全，本轮没有 |
| `time-context/` | 做了当前时间 | 上游还有**每步的已用时长**与浏览器时区，本轮没有 |
| `session-reference/` | 做了有界快照 | 上游有**规范化的 mention URI**（`session://…`）与稳定的错误分类，本轮只认裸的会话 id |
| `file-reference-local/`、`tmux-context/`、`harness-dev-context/` | 没做 | 与桌面应用的形态不合：没有路径补全、没有 tmux 位置、没有 harness checkout URL |
| `session-query/`（全文搜索、追溯、导出） | 没做 | 超出「装配进请求」的范围；快照只取最近几条 |
