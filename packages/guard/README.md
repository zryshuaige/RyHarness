# @ryharness/guard

循环卫生与崩溃恢复。三个东西：

- **重复工具调用提醒**：模型原样重发同一条工具调用时，在结果里附一句提醒，让它换做法或者收尾。
- **单次工具调用超时**：工具自己声明了 `timeoutMs`，宿主就在这个时限内把它收掉，别让它一直挂着。
- **checkpoint**：把「这一轮打算做什么」「工具调用的请求与结果」按顺序写下去，崩了能读回来继续。

本包**不碰 agent 循环、不碰存储层**：它给的是挂点与契约。什么时候提醒、超时怎么收口、checkpoint
文件放哪、崩了读回来之后怎么续，都由宿主决定。

上游对照：dsh 的 `guard/repeat-tool-reminder`、`guard/timeout-policy` 与
`session/session-checkpoint-policy`。本轮做的是它们在 RyHarness 里的最小可用版本。

## 重复工具调用提醒

判定口径（三条同时成立才算「重复」）：

1. 工具名相同；
2. 参数**逐字节相同**——不做 JSON 归一化，`{"a":1}` 与 `{ "a": 1 }` 算不同的调用；
3. **连续**：中间没有插入别的工具调用。插入一条别的调用就断链。

两套计数，别混：**重复次数**按连续链累加（链断一次归零）；**提醒次数是这台提醒器的总额**，
只有 `reset()` 才清零——每换一条链就重新给额度的话，模型来回换着调就能一直收到提醒，等于没设上限。

```ts
const reminder = new RepeatToolReminder({ maxReminders: 2 })
for (const call of calls) {
  // 执行前按模型给出的调用顺序逐条登记
  const verdict = reminder.note({ name: call.name, arguments: call.arguments })
  const result = await tool.execute(call.args, ctx)
  if (verdict.remind) result.content += `\n\n${verdict.reminder}`
}
```

提醒是**建议不是拦截**：提醒额度用完了，调用照常执行。宿主每轮开始时调一次 `reset()`。

## 单次工具调用超时

现在有「整轮取消」与「会话配额」，但没有单次调用的时限——工具不返回就永远挂着，这一轮就停在那儿。

```ts
const outcome = await runToolWithTimeout({
  name: tool.name,
  timeoutMs: resolveToolTimeoutMs(tool), // 工具没声明就没有上限
  signal: ctx.signal,
  execute: (signal) => tool.execute(args, { ...ctx, signal }),
})
if (outcome.status !== 'completed') return outcome.result // 中文错误结果，直接回给模型
```

「收掉」的实际含义（JS 里没有强杀）：宿主给工具派发自己的 `AbortSignal`，到点 abort 掉，并**立刻**
把一条中文超时错误结果回给模型；工具自己收不收得住由工具决定（`shell_exec` 已经在用 `ctx.signal`
杀进程树）。宿主**不等待**工具的收尾——等它就等于把超时又拖回成挂起。

工具抛错时 guard 原样抛出：错误文案怎么写是宿主自己的语义，guard 不越权改写。

## checkpoint（崩溃可恢复）

现在的顺序是「工具执行完 → 结果进内存历史 → 整条发言落库」。崩在中间时，**副作用已经发生但日志里
没有这条调用**——重开之后模型不知道发生过什么，重试又会把副作用做第二遍。

本包把顺序反过来：**调用请求先落盘 → 工具执行 → 结果落盘 → 宿主才让结果进历史**。

```ts
const journal = new CheckpointJournal({ filePath: defaultCheckpointPath(dataDir, conversationId) })
journal.appendTurnStart({ turnId, intent: '把 README 翻译成中文' })
const result = await runCheckpointedToolCall({
  journal, turnId, callId, name: call.name, arguments: call.arguments,
  execute: () => tool.execute(args, ctx),
})
// 到这里 result 已经在盘上了，宿主可以放心让它进历史
journal.appendTurnEnd({ turnId })
```

工具抛错时同样落一条错误结果：那次调用**已经发生过**，不落盘等于把副作用藏起来。

### 落在哪

一个会话一份 JSONL 文件，追加写，每条都 `fsync`。不复用会话库，三条理由：

1. 会话库是**单写者**模型，而 checkpoint 要写在工具执行的关键路径上，多一个写者就破坏了这个前提；
2. 会话库的 schema 与迁移归 `packages/session` 管，另起一份文件免得两套迁移互相踩；
3. 崩溃恢复只需要「尾部若干行」，追加写就够，不需要索引与查询；JSONL 人能直接读——崩了 cat 一下
   就知道最后一步停在哪。

崩在半行上时那行是残缺的，但前面的记录仍然是好的，所以**解析不了的行被跳过而不是让整个读取失败**。

### 恢复入口

```ts
const recovery = recoverCheckpoint(filePath)
// recovery.unfinished：请求落盘了但结果没落盘的调用——副作用可能已经发生
// recovery.intent / recovery.turnId：最后一轮打算做什么
// recovery.damagedLines：读到了但解析不了的行数
```

判定口径：**有 `call` 记录但没有对应 `result` 记录**的调用就是没跑完的。怎么续由上层决定
（重试、提示模型「刚才那次可能已经做过了」、或者直接跳过）——guard 只负责把事实报准。

## 导出

| 导出 | 一句话 |
|---|---|
| `RepeatToolReminder` | 重复调用判定与提醒（`note()` 登记一次调用，`reset()` 清空） |
| `repeatReminderText` | 默认提醒文案 |
| `runToolWithTimeout` | 在工具声明的时限内跑完一次调用，超时给中文错误结果 |
| `resolveToolTimeoutMs` | 从工具对象上读它自己声明的时限（没声明就是没有上限） |
| `toolTimeoutMessage` / `toolAbortedMessage` | 超时与取消的中文文案 |
| `CheckpointJournal` | checkpoint 写入器（turn-start / call / result / turn-end） |
| `runCheckpointedToolCall` | 先落盘再执行的工具调用（结果落盘后才返回） |
| `recoverCheckpoint` | 崩溃恢复入口：读出「上次没跑完的调用」 |
| `readCheckpointRecords` | 读出文件里的全部记录 |
| `defaultCheckpointPath` | 一个会话的 checkpoint 文件路径 |
