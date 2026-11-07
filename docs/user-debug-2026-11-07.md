# 用户视角整体 debug（2026-11-07，第六波）

> 方法：真实数据目录日志只读巡检 + scratch 数据目录（`RYHARNESS_DATA_DIR`）独立 server + Vite 渲染层纯浏览器实走 J1-J8。供应商用本地 OpenAI 兼容 mock（流式/工具调用/断流可控）。Electron 壳专属路径（托盘新对话、server 起不来弹窗、fuses）未实走，由单测与冒烟脚本覆盖。
>
> 结论先行：**没有发现结构性腐烂**。8 条旅程里 6 条端到端顺畅（错误翻译、亲密度、断线横幅、断口增量补页、记忆面板、设置页信息架构都达到了设计意图）；确认 5 个真 UX bug（全部当波修）+ 1 条元问题 + 一批 P2 打磨项。

## 静态巡检（真实数据，只读）

- boot-trace.log：最近一次启动（11-07 17:14）总耗时 1.39s，各阶段正常。
- localStorage 崩溃日志（`ryharness-crash-log`）：命中 1 条真实生产崩溃——2026-10-28 `TypeError: this.request is not a function`，崩在 `Object.listTodos`（原型方法被解构后 `this` 丢失），ErrorBoundary 接住。**该 bug 已在 v0.2.0（同日 70af480）修复**（api.ts 注释原文记录了坑位，todo 族方法全部改为箭头类属性）。全仓扫过同族风险：仅 RightPanel:270 一处解构，安全。
- **元问题（P2）**：崩溃记录只落在 localStorage，应用内没有任何入口能看到「过去崩过什么」——用户（即开发者本人）发现回归只能靠碰运气。候选：MePage「关于」里展示最近崩溃记录。
- 环境备注：`api-keys.json` 是 Electron safeStorage（DPAPI）密文，独立 server 解不开属**预期安全行为**（凭据绑定桌面应用+系统用户）；跨进程调试要用环境变量 apiKeyEnv。

## 旅程结果

| 旅程 | 结果 |
|---|---|
| J1 零配置首启 | ✅ 配置卡前置、输入框禁用文案、key 保存即用；错 key → INVALID_CREDENTIAL 红条（原因+怎么办+「去我的→模型供应商」按钮）全部到位 |
| J2 首启演示会话 | （Electron-only 路径，未实走；capture 脚本覆盖） |
| J3 单聊一轮 | ✅ 流式渲染、已送达回执、亲密度 10→22→29 带 toast、历史失败轮内联「详情」 |
| J4 群聊接力 | ✅ 建群、调度员前缀（「调度」）；接力链需要模型 @ 下一位（mock 不具备，单测覆盖） |
| J5 工具审批 | ⚠️ 默认档位 Ryen 无 shell_exec（unknown tool 有守护文案「连续第 2 次同参调用」）；审批卡需宽档位 agent，未走到（见 P2 备注） |
| J6 弱网断线 | ✅ 横幅、指数退避重连、`fetchSince` 增量补页、部分文本收口（sealIncomplete）；❌ 长断线触发了 F3 全屏错误页、恢复后横幅僵死（F2） |
| J7 RyVibe | ✅ 页面渲染、Beta 标识、输入框就位 |
| J8 设置与数据 | ✅ 供应商页/用量空态人话/记忆健康度/工作区路径/备份/主题全套 |

## 确认的 bug（当波修）

### F1（P1）工具行永久 running + 同 callId 只标第一个 — `apps/desktop/renderer/src/store.ts`
**现象**：一轮里模型循环调用工具到 MAX_STEPS 后，气泡里 15 个「正在执行命令…」行永远挂着（轮已失败、红条已弹）。重载后历史渲染正确（16 行全 is-error），纯实时路径 bug。
**根因**（两个叠加）：
1. `tool-result` 处理器 `findIndex` 只更新消息里**第一个**匹配 callId 的 part——模型重试/劣质供应商复用同一 callId 时，后续 part 永远 running；
2. `sealInflightPatch`（error/abort/gap 共用的收口）只翻 `message.done`，不碰 running 状态的 tool part——任何轮末失败都留下「还在执行」的假象。
**修**：tool-result 更新全部匹配 part；收口时把 running tool part 一并封为失败态。

### F2（P1）WS 首连不发 'open' → 连接横幅僵死 — `apps/desktop/renderer/src/api.ts:1044-1048`
**现象**：断线恢复（伴随重挂载/切会话）后，「连接已断开，正在重连…」横幅永远挂着，点关闭也没用；与此同时流式事件正常到达（连接实际是好的）。
**根因**：`setReconnecting` 只在本地标志**翻转**时发事件，而新订阅的标志初始为 false——`onopen` 里 `setReconnecting(false)` 是 no-op，永远不发 'open'。桶视图的 `conn` 是跨挂载持久的，旧态 'reconnecting' 没人清。
**修**：onopen 无条件发 'open'（本地守卫只留给 'reconnecting' 防重）。

### F3（P1）后台刷新全失败误触全屏错误页 — `apps/desktop/renderer/src/App.tsx:569-585`
**现象**：会话进行中 server 停机 ~12s，应用从「聊天视图+重连横幅」直接翻成全屏「连不上 RyHarness 的本机服务」——横幅与自动重连机制就是为此设计的，REST 刷新却把界面整个收走；恢复后要手动点重试。
**根因**：refresh 完成处理器里「agents+templates 双失败 → setLoadError」没有区分首屏与后台刷新——设计意图是「首屏一份数据都没拿到才全屏错」，但同一段代码在会话中途的刷新也会触发。
**修**：只有首屏（还没加载到过任何数据）才升级 loadError；后台刷新失败一律 toast，靠 WS 横幅表达断线。

### F4（P1）窗口内没有「新对话」入口 — `apps/desktop/renderer/src/components/ConversationList.tsx`
**现象**：会话打开后，回到欢迎页/开新对话的唯一入口是 Electron 托盘菜单（`NEW_CHAT_EVENT`）；浏览器态是死路，窗口里也没有任何按钮。
**修**：会话列表头部加「新对话」按钮，派发同一事件（`window.dispatchEvent(new Event(NEW_CHAT_EVENT))` 或提取共用函数）。

### F5（P1）重载/重启后不恢复上次会话 — `apps/desktop/renderer/src/App.tsx`
**现象**：F5 刷新或重启应用，选中态丢失，落在欢迎页——聊天应用的基本期待是回到上次正在聊的会话。
**修**：activeId 持久化（localStorage，沿用 lib/storage.ts 既有模式），boot 时恢复；会话已删除时静默忽略。

## 记录在案、不当波修（P2 backlog）

1. **崩溃史无应用内入口**（静态巡检元问题）——MePage「关于」展示最近渲染崩溃。
2. 失败/空回复的助手气泡也显示「有帮助/哪里不对」——给报错打分语义不通。
3. 流中断（对端 reset）的错误文案「连不上模型服务。检查网络或本机代理」——连接成功后的中途断开被说成「连不上」，误导排障方向。
4. 供应商被移除后 agent 绑定不迁移，发送时才报 NO_ADAPTER（文案本身是人话）；候选：通讯录对绑定失效的 agent 打标。
5. 欢迎页目标选择按钮与任务卡区域偶发点击不可达（role 定位超时一次，需干净复现）。
6. 窄窗断点常量两处手写（App.tsx:296-298 vs styles.css @media）——注释里自认「迟早对不上」。

## 复测口径

- mock 供应商：`%TEMP%\ryharness-udebug\mock-openai.mjs`（「跑条命令」→ tool_call、「断流」→ 中途 destroy、「慢速」→ 300ms/片），独立 server 无 token + 浏览器直连 5173。
- 坑位记录：`pnpm dev`/后台任务 TaskStop 不杀 node 孙进程（按端口 taskkill）；第一个 mock 子进程存活导致所有「慢速」实测变 60ms——测流中行为前先 `curl -w '%{time_total}'` 校准流速。
