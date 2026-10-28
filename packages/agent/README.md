# @ryharness/agent

精简 agent 运行时（M0 决策：自写，不拷上游 dsh-agent/agent-loop 的 32k LOC 生态）。

- **AgentDefinition**：可持久化的身份 + 能力定义（id/name/avatar/systemPrompt/provider/model/temperature/tools 白名单/isBuiltin）。
- **内置模板**：`RYEN_TEMPLATE`（Ryen，猫管家总管家人设，中文、温暖、干练）+ `BUILTIN_TEMPLATES` + `forkTemplate()` 从模板派生用户 agent。
- **AgentLoop**：经典消息+工具循环——组装请求（systemPrompt + 历史 + 工具白名单）→ `llm.stream()` → `BlockAssembler` 边组装边发事件 → tool_call 调度执行、结果追加历史、继续循环；终止于 finish 或 maxSteps（默认 16，防死循环）。构造注入 `LlmRuntime`，不依赖 cordis 插件化。`onAssistantMessage` 回调暴露每步组装完成的 assistant 消息（群聊调度器据此持久化/解析 @提及）。
- **事件流**：text-delta / tool-call-start / tool-result / done / error，供 UI 订阅。
- **token 预算**（`budget.ts`）：`resolveRequestBudget` 按供应商报的上下文窗口算一次请求的额度（输入阈值 / headroom / 输出预留），`trimHistoryToBudget` 从最旧裁历史。全程按 **token** 记账（`estimateTokens`，中文一字一 token），不用「4 字符 ≈ 1 token」的字符近似——ASCII 上近似成立，中文上会多送 4 倍。固定读取窗口 `DEFAULT_HISTORY_BUDGET_TOKENS = 15_000`，`@ryharness/session` 与 `@ryharness/group` 取的是同一个常量，三处必须同值同单位。
- **压缩链路**（`compact.ts`）：输入装不下时两段走，不让任何一轮因压缩失败。① `pruneToolResults` 不调模型——单条工具输出超过 `toolResultPruneTokens`（默认 2000）就换成 head + `PRUNE_MARKER` + tail（尾部必须留：报错栈、exit code 常在结尾）；② `resolveCompactSpec` + `compactHistory` 在预裁剪之后仍超阈值才摘要，逐字保留最近 `retainTokens`（默认输入阈值的 1/4），摘要指令作为最后一条 user 消息跟在待摘要历史之后——图的是形状合法（OpenAI 兼容适配器只允许 system 领衔，中途插 system 会被拒）与近因优先（指令落在最后一轮，不会被几千 token 的原话稀释），**不是**为了命中供应商 KV cache：压缩恰好把窗口外那段历史换成了摘要、system 又是压缩器自己的提示，前缀缓存命不中。摘要拿不到就退回丢弃式裁剪。摘要**只存在于那一次请求、不落库**，会话日志永远是原文。

与上游的关系：只保留"循环 + 工具调度"内核；不带 session 发布、sandbox 执行器、审批生态（那些是 M0 盘点出的 26 包耦合主体）。

## 压缩参数的生产口径

`AgentLoopOptions.compaction` 有五个覆盖项（`toolResultPruneTokens` / `retainTokens` / `summaryMaxTokens` / `summarize` / `enabled`）。**生产链路一个都没传**——协调器与群调度器都不带这个字段，走的是 `loop.ts` 里的默认口径（预裁剪 2000 token、逐字窗口取输入阈值的 1/4、摘要上限 1024、摘要器用当前 LLM 运行时）。

这是有意的：压缩参数是**跟模型窗口走**的量（阈值比例来自 `resolveRequestBudget`），不是用户该调的旋钮——按模型换供应商时手工留一组绝对值，反而会在新窗口下失配。要改口径，改 `budget.ts` 的比例常量；要让用户能调，得先把「按预算比例表达」这件事做出来（现在的字段全是绝对 token 数），不能直接把五个绝对值暴露成设置项。

