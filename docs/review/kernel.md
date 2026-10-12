# RyAgent 内核评审（packages/ 全包）

- 评审日期：2026-10-12；范围：llm、llm-openai、agent、tools、session、memory、evolve、group、typert、attachment、util、runtime-diagnostics。vendor/ 仅扫一眼，不作要求。
- 方法：逐文件精读 src（类型文件与 index 除外共约 40 个实现文件），并与 apps/server 的实际消费方交叉验证"谁在用这个 API"。
- 分级：P0 = 正确性/安全/数据损坏；P1 = 明显性能/健壮性/UX 缺陷；P2 = 简洁性/一致性/文档。

## 结论速览

| 级别 | 数量 |
|---|---|
| P0 | 1 |
| P1 | 5 |
| P2 | 18 |

整体判断：adapter/assembler 层（llm-openai、llm 的流协议内核）质量接近上游 dsh 水准，错误分类、SSE 状态机、用量拆分都做得细；但**持久化层与 OpenAI 消息序列契约之间有一个 P0 断裂**（多轮工具调用必炸），**重试策略整套机制存在却从未接线执行**，且 **llm 包保留了大量未裁剪的死表面**（约占该包 40%）。离顶级开源项目差的是：端到端契约测试（用真实 provider 消息序列校验重建历史）和一次大胆的删除。

---

## P0

### P0-1 单聊工具轮的历史重建违反 OpenAI 消息序列契约，第二轮必 400

- 证据：
  - `packages/session/src/coordinator.ts:128-133`：tool-result 在循环进行中即时落库（seq 较小）；
  - `packages/session/src/coordinator.ts:144-149`：assistant 回复在循环结束后才落库，且条件为 `reply.length > 0`；
  - `packages/agent/src/loop.ts:117-121`（对应 coordinator.ts）：chatDirect 创建 AgentLoop 时**没有传 `onAssistantMessage`**，因此 assistant 的 tool_call 消息从未落库；
  - `packages/session/src/coordinator.ts:57-59`：重建时把带 `toolCallId` 的行映射为 `role: 'tool'` 消息。
- 后果链：一轮"调工具"的回合，落库顺序是 `[user, tool-result, ...]`，assistant 的 tool_calls 消息丢失；若该轮还有文本回复则顺序变成 `[user, tool-result, assistant]`。下一轮重建历史发给 OpenAI 时，`tool` 角色消息前面没有带 `tool_calls` 的 assistant 消息 → API 400。也就是说：**任何用过工具的单聊，在真实 provider 下第二轮必然失败**。现有测试（`packages/session/tests/coordinator.test.ts:57-99`）只断言了 tool 消息被重建，没有断言序列合法性，所以测试全绿。
- 修复：chatDirect 里挂上 `onAssistantMessage`，在每条 assistant 消息完成时先落库（或让 tool-result 携带"所属 assistant 消息 seq"并在读取时恢复正确序）；无文本的 tool_call 消息也必须落库。

## P1

### P1-1 序列化丢弃 assistant 的文本块（text + tool_calls 共存时 content=null）

- 证据：`packages/llm/openai/src/serialize.ts:60` —— `content: toolCalls.length > 0 ? null : blocksToText(...)`。OpenAI 协议允许 tool_calls 与字符串 content 共存；模型"先说一段话再调工具"时，这段话在下一步请求的 wire 上被静默丢弃。
- 修复：`const text = blocksToText(...); content: toolCalls.length > 0 && text === '' ? null : text`。

### P1-2 重试策略整套机制存在但没有任何执行者

- 证据：`packages/llm/llm/src/retry-policy.ts:5` 注释说"由可选 dsh-llm-retry 插件执行"——该插件不在本仓库；全仓 grep `retryPolicy/backoff` 无任何消费方；`packages/agent/src/loop.ts:177-182` 一步出错直接 `yield error` 结束本轮。`EMPTY_RESPONSE/RATE_LIMIT/TIMEOUT/SERVER/TRANSPORT` 这类可重试故障一次就终止对话，429 的 `providerRetryAfterMs`（adapter.ts:54-57 辛苦解析出来的）无人使用。
- 修复：要么在 `llm/stream` waterfall 上接一个重试中间件（策略已是现成的 ResolvedRetryPolicy），要么在 AgentLoop 步内对可重试 code 做 backoff 重试；二选一，别让策略继续空转。

### P1-3 记忆四操作未校验 memoryId 归属空间，可跨空间软删/改写

- 证据：`packages/memory/src/service.ts:233-249` —— UPDATE/DELETE 只检查 `existing.status === 'active'`，不检查 `existing.agentId === spaceId`。LLM 幻觉出的 memoryId 可以 supersede 其他 agent 空间（或共享画像）的记忆；UPDATE 还会把外空间的 `kind` 搬进本空间新插一行。对比之下 `packages/evolve/src/service.ts:234` 的 Curator 是校验了 `existing.agentId === agentId` 的——memory 这里属于漏写。
- 修复：两个分支各加一行 `existing.agentId !== spaceId` 则 `break`。

### P1-4 终态 error/aborted finish 被当作正常 done 收尾

- 证据：`packages/llm/llm/src/index.ts:1089-1106`（adapterStream 把适配器异常规范化为 `finish{kind:'error'}` chunk，而不是 throw）；`packages/agent/src/loop.ts:194-201`：无 tool_call 时一律 `yield {type:'done', finish}`；`packages/session/src/coordinator.ts:135` 只有 `event.type === 'error'` 才记失败。结果：provider 故障被规范化成 finish chunk 后，协调器不落错误消息、UI 发 `message-done`，半截回复被当作完整回复呈现。
- 修复：loop.ts 在 `calls.length === 0 && (finish.kind === 'error' || finish.kind === 'aborted')` 时改发 error 事件（或 coordinator 依据 done 事件里的 finish.kind 判断）。

### P1-5 fsRead 整文件读入内存后才截断

- 证据：`packages/tools/src/fs.ts:47-48` —— `readFileSync(target, 'utf8')` 然后 `truncateOutput(..., 64_000)`。2GB 日志直接把后端读 OOM，截断形同虚设。
- 修复：`stat.size` 超限直接返回提示，或用 `createReadStream` 读前 64k 字符后销毁流。

## P2（简洁性/一致性/文档）

1. **evolve harmful 计数重复加一**（`packages/evolve/src/service.ts:181`、`273`）：`addCounts` 已把 harmful+1，随后又 `entry.harmful + 1 >= 阈值` 再算一次，👎 路径会早一轮触发 auto-deprecate。删掉多余的 `+ 1`。
2. **evolve 归因表永不清理**（`service.ts:85,144`）：`attribution` Map 按 `conversationId:agentId` 只增不删，长跑桌面应用内存只涨。会话删除时摘除，或改 WeakRef/定界队列。
3. **evolve 记忆合并 O(n²·dim)**（`service.ts:322-334`）：对一个空间全部 active 记忆两两余弦，注释自称规模 <10k——真到 10k 是 500 亿次乘加。加条数上限或按 updatedAt 窗口预筛。
4. **evolve 转正教训不去重**（`service.ts:195-201`）：converted reflection 插 pitfall 条目前不走 `hasDuplicate`（Curator 的 add 走了，`228`）。
5. **memory recall 预算只守到 embedding 之前**（`packages/memory/src/service.ts:103`）：注释承诺"超预算跳过本轮注入"，但 `hybridRecall` 内部（余弦+排序+FTS）无任何预算检查。要么补检查，要么改注释。
6. **memory FTS 检索 N+1 查询**（`packages/memory/src/store.ts:148-161`）：rowid 列表逐条 `SELECT *`。一条 JOIN 或 `IN (...)` 即可。
7. **memory ADD 的 embedding 与内容错位**（`service.ts:224-229`）：`op.text` 覆盖内容时，embedding 仍是 `candidate.text` 的向量。对最终落库文本做 embed。
8. **bigrams 毁掉英文检索**（`packages/memory/src/store.ts:78-85`）：`replace(/\s+/g, '')` 后英文被切成字母二元组（"hello world"→`he el ll lo…`），BM25 语义退化。英文走整词、CJK 走 bigram 的混合分词更对。
9. **memory 四操作字段命名不自洽**（`packages/memory/src/llm.ts:123`）：ADD 分支读 `op.newText`，prompt 与 `MemoryOperation` 类型却叫 `text`（`llm.ts:16`）。统一成一个名字。
10. **coordinator 重复构造 hook 包装**（`packages/session/src/coordinator.ts:197-198`）：`this.bindMemory(conversationId)` 在三元里调一次、spread 里又调一次（bindEvolution 同）。先取局部变量再判断。
11. **deleteAgent 清理上限 10_000**（`packages/session/src/store.ts:136`）：`listConversations(10_000)` 硬编码，超出的会话保留已删 agent 的 id。改成全量或按成员反查。
12. **hook 接口的 conversationId 形同虚设**（`packages/agent/src/loop.ts:61,79,232,247-252`）：AgentLoop 永远传 `''`，由 coordinator 重新绑定。把该参数从 hooks 接口删掉，让 coordinator 闭包直接捕获。
13. **argString 三份拷贝**（`packages/tools/src/fs.ts:13`、`shell.ts:38`、`produce.ts:32`）：同函数复制三处。挪进 workspace.ts 或共享小工具。
14. **llm 包死表面（未裁剪干净）**：`markAgentLoopRequest/isAgentLoopRequest`（`call-config.ts:66-78`）全仓零调用；`RetryPolicySchema`（`retry-policy.ts:100` schemastery 版）无任何配置消费方，手工校验已覆盖；`assistant-stream.ts` 534 行压缩/读取器应用层全未用；`content.ts` 的 image/offload/投影机制 ~350 行在 text-only 适配器下永不触发（`adapter.ts:109`）；`projectToolUpdates`/`ToolHistory`/`toolHistory` 全链无生产者（应用从不产生 developer 消息）；`prepareCall`/`registerConfigurableProviders`/`registerModelDiscovery`/`fileRequestText`/`WeakMapWithValues` 均零消费；`runtime-diagnostics` 与 `llm/src/invariant.ts` 配套件服务器从未挂载（apps/ 无引用）。这是"从 deepseek-harness 裁剪内核"没裁完的部分——要么接线，要么删，占着 40% 的公开面。
15. **translate 对 finish 之后的 chunk 不熔断**（`packages/llm/openai/src/translate.ts:171-183`）：`finished = true` 后流若继续来 delta 仍会被处理甚至二次 closeAllBlocks。finish 后直接 break/告警。
16. **shell_exec 超时杀不掉孙进程**（`packages/tools/src/shell.ts:76-82`）：`execFile` 的 timeout 只杀直接子进程，bash 下起的后台/子命令会漏。至少在描述里注明，或 Windows 用 taskkill 树、POSIX 用 detached 进程组。
17. **serialize 可能产生重复 system 消息**（`packages/llm/openai/src/serialize.ts:119-122`）：`options.system` 与历史里自带的 leading system 消息会并存（注释已自知）。协调器目前靠丢弃 system 行规避（`coordinator.ts:66`）；在 serialize 层去重更稳。
18. **余弦相似度假设单位向量且实现复制两份**（`packages/memory/src/embeddings.ts:95-99` 与 `packages/evolve/src/service.ts:364-368`）：provider 不归一化时排名失真；evolve 那份是拷贝。落库时归一化 + 收敛到一处实现。

## 做得好的地方

- **SSE/translate 状态机**（`openai/src/sse.ts`、`translate.ts`）：`[DONE]` 内部消费、idle watchdog 按解码脉冲、退化空响应归类 `EMPTY_RESPONSE`（可安全重试）、tool arguments 先于 id 到达即 `PROTOCOL` 拒绝、choice.index≠0 拒绝、usage 延迟到 block-end 之后 finish 之前、无 finish_reason 时保留已组装内容并以 error finish 收尾——边界都想到了，测试覆盖也好（`tests/translate.test.ts`）。
- **BlockAssembler**（`llm/src/assembler.ts:77-83,135-149`）：first-close-wins 防畸形流二次关闭；max-tokens 截断统一丢 tool-call 且 replay 元数据同步裁剪，两条出口不可能分叉。
- **错误链渲染**（`llm/src/error.ts:117-157`）：hostile accessor/circular cause/AggregateError 都防了，且明确"只用于诊断面，路由走 code"——契约清晰。
- **adapter 错误分类**（`openai/src/adapter.ts:45-78`）：状态码 + provider 文案正则双通道分类（context/quota 识别器在 `error.ts:83-103`），Retry-After 只收纯数字。
- **迁移纪律**：session 的 user_version 单调只追加 + 单事务回滚 + 拒绝降级（`session/src/schema.ts:96-115`）；memory/evolve 共用同一 db 文件时各自用 meta 表自管版本轴（`memory/src/schema.ts:65-95`、`evolve/src/schema.ts:73-97`），干净地绕开了"一个文件两个版本轴"的冲突。
- **群聊 loop-guard**（`group/src/dispatcher.ts:150-158,208-216`）：连续重复 + A-B-A 互踢 + maxTurns 兜底三层，每次终止都写带 reason 的 dispatch 事件，可观测性好。
- **记忆的降级路径**：无 embedding key 自动纯 FTS5（`apps/server/src/app.ts:78-90`）、embed 超时降级（`memory/src/service.ts:156-165`）、recall 预算守卫——"故障不得影响对话"的契约在每个入口都守住了。
- **Curator 的 entryId 校验**（`evolve/src/service.ts:233-243`）：update/deprecate 校验归属 agent 与 active 状态，是这个闭环里最容易被 LLM 幻觉打穿的地方，守住了（也因此反衬出 P1-3）。

## 给维护者的优先级建议

1. 先修 P0-1（补一条"工具轮后第
2. 接线重试（P1-2）或删掉 retry-policy 模块——现状是最差组合。
3. P1-1/P1-3/P1-4 都是一行级修复，顺手带上。
4. 然后做那次大胆的删除（P2-14）：llm 包公开面砍到现在的实际消费集，README 写清"哪些 dsh 能力被刻意裁掉"，比留着死代码更符合 simple & effective。
