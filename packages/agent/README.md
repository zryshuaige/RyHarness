# @ryagent/agent

精简 agent 运行时（M0 决策：自写，不拷上游 dsh-agent/agent-loop 的 32k LOC 生态）。

- **AgentDefinition**：可持久化的身份 + 能力定义（id/name/avatar/systemPrompt/provider/model/temperature/tools 白名单/isBuiltin）。
- **内置模板**：`RYEN_TEMPLATE`（Ryen，猫管家总管家人设，中文、温暖、干练）+ `BUILTIN_TEMPLATES` + `forkTemplate()` 从模板派生用户 agent。
- **AgentLoop**：经典消息+工具循环——组装请求（systemPrompt + 历史 + 工具白名单）→ `llm.stream()` → `BlockAssembler` 边组装边发事件 → tool_call 调度执行、结果追加历史、继续循环；终止于 finish 或 maxSteps（默认 16，防死循环）。构造注入 `LlmRuntime`，不依赖 cordis 插件化。`onAssistantMessage` 回调暴露每步组装完成的 assistant 消息（群聊调度器据此持久化/解析 @提及）。
- **事件流**：text-delta / tool-call-start / tool-result / done / error，供 UI 订阅。

与上游的关系：只保留"循环 + 工具调度"内核；不带 session 发布、sandbox 执行器、审批生态（那些是 M0 盘点出的 26 包耦合主体）。
