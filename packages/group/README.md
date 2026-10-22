# @ryharness/group

群聊调度器：用户确认的混合模式（@提及直路由 + 调度员自然语言选路）。

## 路由规则

- **入口**：用户消息含 `@X` → X 直接响应（支持单 @ / 多 @，按出现顺序）；无 @ → 调度员（`dispatcherAgentId`）响应。入口决策以 dispatch 事件产出（reason: `user-mention` / `default-dispatcher`）。
- **选路即生成**：不做单独的结构化路由 LLM 调用。调度员正常生成回复，其 system prompt 追加路由指令（能答就答 / 转交就 @成员 / 绝不 @自己）；解析输出中的 @提及作为路由信号，输出无 @ 视为"自己回答"，一轮结束。
- **接力**：任何 agent 输出含 @Y → Y 接力（reason: `relay @名字`）。

## 接力护栏（loop-guard 判定）

在**每个接力候选出队时**按发言链 `speakers`（本次 turn 已发言顺序）判定：

1. `候选 === 上一个发言者` → 停止（自己 @ 自己 / 冷却不足；自 @ 在解析阶段即拦截）。
2. `候选 === 倒数第二个发言者`（A-B-A 模式）→ 停止（A↔B 互踢循环）。
3. 单个候选命中即**终止整个 turn**（而非跳过），并写 dispatch 事件 `reason: 'loop-guard'`。
4. 出队前检查 `turns >= maxTurns`（默认 8）→ 停止并写 `reason: 'max-turns'`。

三个及以上成员的合法长链（A→B→C→A…）不受护栏影响。

## 上下文策略

所有成员共享群历史：协调器格式化为 `名字: 内容` 前缀行（工具结果与 system 消息跳过），`buildGroupContext` 按 **token** 预算（`estimateTokens` 逐行加权，默认 `DEFAULT_HISTORY_BUDGET_TOKENS` = 15_000，与 @ryharness/agent、@ryharness/session 同一个常量）**从最旧**裁剪。中文一字一 token，字符近似会让同一份预算在中文群聊里多送 4 倍。调度器无状态，每 turn 独立。

## 扇出

入口一次 @ 多个成员时并发起跑（`fanoutConcurrency`，默认 3），事件按 @ 出现顺序增量转发，结果也按 @ 顺序提交——并发只影响"谁先出字"，不影响消息顺序。

扇出内的**记忆召回按同一段输入共享一次**：N 个成员拿到的是同一个 prompt，于是它们的长记忆召回本该是同一次（同一段输入对同一空间的召回结果相同）。调度器用一次 `FanoutMemory` 视图包住本轮扇出：记忆钩子实现了 `recallMany(agentIds, inputText)`（@ryharness/memory 的 `MemoryService` 实现了）就走批量召回，否则退化为并发 `recall`（记忆侧的 embedding 在途合并仍会把网络往返压成一次）。接力链与单 @ 目标不走这条路径（每轮输入都不同，没有可共享的东西）。

## 与协调器的分工

调度器只产出事件（`dispatch` / `text-delta` / `tool-call-start` / `tool-result` / `agent-message` / `turn-done` / `error`），不碰存储；`@ryharness/session` 的 `SessionCoordinator` 负责落库（dispatch_events、messages、错误 system 消息）。
