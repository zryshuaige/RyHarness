# @ryharness/llm

LLM 服务缝：LlmAdapter 抽象（适配器只需实现 stream()）、LlmRuntime（registerAdapter 路由注册、prepareCall、llm/stream 瀑布）、StreamChunk 流式协议、消息/内容块类型与 BlockAssembler 组装。从 @deepseek-ai/dsh-llm 裁剪改名。

## 本产品用到了哪些原语

上游 dsh 的 LLM 缝比这里大得多（本仓库只裁了「够用」的一部分），下表把**在本产品里真正活着**的与**保留但当前惰性**的分开写清楚——留着的那些不是死代码，是给插件与后续能力留的口子，但每一处都写明它为什么现在不生效。

| 原语 | 状态 | 说明 |
|---|---|---|
| `LlmAdapter.stream()` | 活着 | 唯一的必实现方法；OpenAI 兼容适配器在 `@ryharness/llm-openai`。 |
| `LlmRuntime.registerAdapter` / `replace` | 活着 | 供应商增删时热换路由集合，正在进行的 turn 不受影响。 |
| `llm/stream` 瀑布 | 扩展点 | 每次模型调用都过这道瀑布：插件可以 `ctx.on('llm/stream', ...)` 观察或短路。它是**公开的扩展缝**，仓内目前没有内置监听方（计量走会话层的 turn 计量，不在这条路上）。 |
| `llm/adapters-updated` 事件 | 扩展点 | 路由集合变化时广播；仓内暂无监听方，插件可用来刷新自己的路由缓存。 |
| `GenerateOptions.purpose` | 活着 | 区分辅助调用与普通对话：压缩摘要走 `'compaction'`。 |
| `BlockAssembler` 的 replay 分支 | 活着 | 适配器在终止 chunk 上带 `replayState`（OpenAI 适配器带响应级元数据），装配层据此保留可重放的元数据。 |
| `GenerateOptions.toolHistory` + 工具增删原语 | **当前惰性** | 上游用它支持「对话中途增删工具」（developer 消息里的 tool-addition / tool-removal）。本产品的工具集是**每个助理一份固定白名单**，对话中途不变，因此这条原语不参与投影（`projectToolUpdates` 走「无声明」分支）。要支持动态工具集时，从这里接。 |
| `ToolUpdate` / `SystemPromptUpdate` 的 `'in-history'` 模式 | **当前惰性** | 同上：没有工具增删历史，也就没有需要按历史过滤的声明。 |

## 一句话口径

**保留 ≠ 生效**：上面标「当前惰性」的两处不是忘了接线，是本产品没有那个需求（工具白名单是静态的）。改动 agent 的工具集语义时，这两处要一起改，否则会出现「声明说增删、运行时按静态白名单发」的分裂。
