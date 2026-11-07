# 三仓工程质量对比：dsh / kimicode / RyHarness

> 2026-11-07 实测快照。动机：把 RyHarness 放在两个成熟标杆旁边，回答两个问题——我们有没有在做屎山？现在够不够 simple yet effective？本文只记录事实与判定，不排修复任务（修复项全部在遗留路线图与 [dsh-parity](./dsh-parity.md) 里）。下次对比波次重测，口径公式见文末。

对象：
- **dsh** = DeepSeek Harness（`F:\AgenticResearch\deepseek-harness`，v0.2.2-rc.1，MIT）
- **kimicode** = Kimi Code（`F:\AgenticResearch\kimi-code`，月之暗面官方 CLI coding agent）
- **RyHarness** = 本仓库 v0.5.0

## 口径

- src 行数 = git 跟踪的 `*.ts`/`*.tsx`，排除 tests/、`__tests__/`、`*.test.*`、`*.spec.*`、`*.d.ts`、node_modules、dist。测试行数单独算。
- dsh 的 vendor/（Cordis 生态 9 包 7.4k 行）单独标注不计入；kimicode 的 pi-tui（vendored fork 20.4k 行）计在其总量内。
- RyHarness 侧全部数字本机实测；标杆侧来自逐包实测 + 抽查复核（核心 loop 文件行数已交叉验证一致）。

## 一、总览画像

| | dsh | kimicode | RyHarness（我们） |
|---|---|---|---|
| 形态 | CLI + Web + Electron + Python SDK，everything-is-a-plugin（vendored Cordis） | 终端 TUI + 本地 server + ACP/VS Code，单二进制免 Node | Electron 桌面 + server + MCP 暴露，多人格/群聊/记忆 |
| 源码规模 | ≈61.9 万行（client 17.8万 + experimental 10.5万；scripts 4.7万；生成物 1.8万） | ≈36.9 万行（agent-core-v2 15.6万独大 + TUI 5.9万） | ≈11.2 万行（第四波后重测，2026-11-07）+ vendor 3 包（cordis/cosmokit/schemastery，与 dsh 同款三件套） |
| 测试规模 | ≈75.2 万行，~29,682 用例（test:src≈1.28） | ≈41.3 万行，~15,936 用例（test:src≈1.12） | ≈6.6 万行，~4,405 用例（test:src≈0.59；用例数较首轮对比翻倍是并行会话持续补测的结果） |

## 二、16 维度对比表

判定符号：✅ 领先 / 🆚 持平 / ⚠️ 落后或真债 / 🔴 P0 级缺口。第四波落地后 16 项合计：✅11 / 🆚1 / ⚠️4 / 🔴0（原 🔴2 已清）。

| 维度 | dsh | kimicode | RyHarness（我们） | 判定 |
|---|---|---|---|---|
| 核心 loop | `ReactLoopAgent` 745 行类，三态相位状态机（idle/maintenance/running），loop 组 6 文件 2,127 行；维护相位与循环解耦 | `AgentLoopService` 2,490 行 DI 服务类（15 服务注入）+ engine 635 + requester 1,028；steer/nudge 双队列、quiescence 计数、9 分支收尾状态机纠缠 | `loop.ts` 1,110 行单文件函数式 + compact/budget 同包；注册表 dispatch | ✅ 结构最简单；缺权限拦截层（见审批行）⚠️ |
| 上下文管理 | compaction 独立插件组 ≈2,858 行（basic/image-offload/tool-result-pruner/command-compact） | fullCompaction 1,261 行：0.85 触发、预留 50k token、5 重试、[0.7,0.5,0.35] 收缩 | budget + 工具结果剪枝 + compactHistory + **spill 溢出文本落盘分页取回（三家独有）** | ✅ spill 是真设计亮点 |
| 工具定义 | `defineTool` + 自研 JSON-Schema DSL + 自写校验器，强制 output schema；35 工具包 100+ 工具 | DI 服务类 + zod → toJSONSchema；15 内置 + Tower 13 | 每域一包自注册（shell/document/browser-use/lsp/ssh…），无统一 schema DSL | ⚠️ 面窄但无 schema 约束，是契约债的一部分 |
| 权限/审批 | interaction/user-approval + permission-presets + sandbox-policy 事件瀑布 | manual/yolo/auto 三模式 + 16 个有序策略文件 + 异步裁决 | **门已在且第四波补完覆盖**：ssh_exec 标审批、MCP 工具默认逐条问（显式 false 才放行）、子代理内层 loop 穿透 approver（堵住免批旁路）、无会话上下文 fail-closed、会话级 'never' 覆盖路由（sandbox 先例形状）；仍欠内核级沙箱与 agent 级档位（见差距清单） | ✅ 追平两家主防线 |
| 会话持久化 | append-only 事件日志 + 不可变 generation + 自实现 zstd + 迁移链 v0→v4 | JSONL wire 分支树（fork/undo）+ 5 级迁移 + fs/memory/minidb 三后端 | node:sqlite WAL 单库三句柄（session/memory/evolve），schema v1→v7，FTS | 🆚 持平；sqlite 强在查询、弱在可手救 |
| 记忆/演化 | 无 | 无（AGENTS.md 注入 + skills + compaction handoff） | memory+evolve ≈3.6k 行：抽取/矛盾处理/衰减/importance/休眠归档 | ✅ 三家唯一，产品差异点 |
| 子代理 | 8 包 9.9k 行，6 provider（in-process/acp/claude-code/codex/sdk）+ team 任务板 | 1.7k 基础 + AgentSwarm 2k + Tower 3.2k（git worktree 并行） | in-process 单一实现 | ⚠️ 已知缺口（dsh-parity §9） |
| 配置/契约 | Schemastery 单源 + 19 个 gen-* + 67 个 verify-* 全带 --check | zod 全链 + config/wire/state manifest 同源生成；REST 115 路由 defineRoute→openapi | **第四波单源化落地**：vendor schemastery（与 dsh 同一份上游代码）接线，`route()/withBody()` + `contract/` 17 域文件（dsh 双注解手法），18 路由 34 处手写解析全迁（测试零断言改动）；SDK/renderer 手抄归零到 5 个有意的容错读模型；线上视图下沉 packages/api 唯一真源 | ✅ 追平（剩 typert 注解 schema 派生可选殿后） |
| 测试门禁 | per-file 100% 覆盖率 + 150 行豁免清单 + 10 个 vitest 配置 + 32 个 CI workflow + jscpd + casts 棘轮 453 文件 | 无覆盖率阈值 + 5-shard 矩阵 + check-no-comments AST 门 + import 边界门 | per-file 负阈值棘轮（数十条实测+2）+ incompleteRunGuard + 7 道自研门禁 + biome 550 冻结基线；串行 440s | ✅ 门禁密度三家最高；棘轮 bespoke 复杂度 ⚠️；测试量偏薄 ⚠️ |
| 类型卫生 | src `as any`=6 / `as unknown as`=101；非空断言 ~5k | 主 src `as unknown as`=179，全仓 1,894；lint 直接关掉 no-explicit-any / no-non-null-assertion | `as any`=0 / `as unknown as`=6，casts 棘轮只减不增 | ✅ 三家最干净 |
| god 文件 | api-catalog.ts 10,408（生成）、TrajectoryTable 3,607、typert analyzer 3,468、手写 i18n 字典 4×2k+ | kimi-tui.ts 5,463、tower store 3,255、loopService 2,490 | ChatView.tsx 2,396（全仓最大）、app.ts 1,967（组合根埋 670 行 turn 逻辑 + 两套同构事件 switch） | ⚠️ 相对最轻，但这两处是真债 |
| 死代码治理 | 100% 覆盖率门兼做死代码检测（原话："uncovered line is dead code... for deletion"） | 无任何死代码门禁 | 规则 A-D 门禁 + 108 条规则 C 审计已落盘（101 去 export + 7 删） | ✅ 有门有账，只待清 |
| 依赖纪律 | 发布闭包 561（内核薄：dsh-llm 仅 7 个） | 全仓 ~40+（app 层刻意仅 3） | 第三方运行时 ≈10（react/sharp/marked/electron/dicebear 等），其余全是 workspace | ✅ 三家最省 |
| 注释/文档哲学 | 659 个双语 md + i18n 配对门 + 19 个生成文档目录 | 核心两包禁一切注释（AST 门强制）："code, not documentation, is the source of truth" | 强制叙事体中文注释写「为什么」+ dsh-parity.md 自对标 + 审计落盘 | ✅ 自洽且罕见（风险：注释会腐烂，靠 review 挡） |
| 包组织 | 55 组 379 个 package.json；client 77 子包、experimental 61 包 | agent-core-v2 独大（1,143 文件）+ pi-tui vendored | 45 包 + vendor 3 包；src 前 10 大文件全部 ≤2.4k 行 | ✅ 无独大巨包 |
| 复杂度性价比 | 61.9 万行维持的功能面 | 36.9 万行维持的功能面（含 v1/v2 双轨） | 11.2 万行：记忆演化 + 多人格 + 群聊接力 + 桌面端 + spill，两家都没有 | ✅ 功能密度三家最高 |

## 三、我们做得不好的地方（按伤害排序，均有标杆对照）

1. **契约手抄（P0，性价比最高的债）**——`apps/desktop/renderer/src/api.ts` 手抄 16 个接口 + 18 个路由文件 34 处手写 body 校验，drift 已发生。dsh 用 Schemastery 单源 + 67 个 verify 门；kimicode 用 zod `defineRoute` 一路生成到 openapi，连自家 SDK 都强制走同一契约层「不抄近路」。我们 vendor 里已经躺着 schemastery（与 dsh 3.19.0 同一份上游代码，diff 仅 2 行 import），就差接线。→ 第四波已开工（route() helper + contract/ 目录，见 CHANGELOG）。
2. **审批覆盖面（初测误报为「无审批」，实情是门已在、覆盖不全）**——审批桥 `apps/server/src/approvals.ts` 已端到端（卡片/决议/记住/超时即拒），但 56 个工具里只有 shell_exec 与 terminal_exec 标了审批，ssh_exec、MCP 工具没标；子代理内层 loop 没接 approver（内层命令绕过审批）；无会话上下文的调用是 fail-open。dsh 的裁决序（无答题者 → unavailable → deny）与 fail-closed 是对的方向。→ 第四波已修（ssh_exec/MCP 默认问、approver 穿透子代理、无会话改拒绝、会话级 'never' 覆盖路由）。
3. **app.ts 1,967 行组合根 + ChatView.tsx 2,396 行**——turn 逻辑埋在组合根、两套同构事件 switch。dsh 证明 client 拆 77 子包可行（但也付了协调税）；kimicode 的教训是 loopService 揉到 2,490 行后 steer/nudge/settle 互相纠缠——拆要趁早、拆要有度。→ 路线图遗留 #4。
4. **死导出 108 条**——门禁和审计都齐（dead-code-rule-c-audit.md），只欠清理那一波。kimicode 连死代码门禁都没有，我们领先，只差执行。→ 路线图遗留 #6。
5. **测试量偏薄 + 基建 bespoke**——test:src 0.62（两家 1.1-1.3）；覆盖率棘轮数十条 per-file 负阈值是自造复杂度，dsh 的规则一句话：「per-file 100% 或不合并」。我们的棘轮是增量采纳期的务实选择，长期该往「更少规则」收敛；串行 440s 待 vitest ≥5.0.5 修。→ 路线图遗留 #2/#3。

## 四、两个标杆也不干净（避免光环偏差）

- **dsh**：src 101 处 `as unknown as`、~5k 个 `!` 非空断言；17.8 万行 client 是 100% 覆盖率门的最大豁免来源（150 行豁免清单全带 TODO(gui)）；10,408 行生成目录文件进 review 面；10 个 vitest 配置 + 32 个 CI workflow + 659 个双语文档的维护税极高。
- **kimicode**：主 src 179 处 `as unknown as`（全仓 1,894）、lint 关掉类型安全规则；无覆盖率阈值；核心包禁注释 = 自文档性全押在命名上；v1/v2 双轨 + migration-legacy 4,113 行兼容胶水；自研 minidb 18,980 行 + bash 解析器 3,787 行重轮子；dist-web bundle force-add 入库、flake.nix 手抄列表靠人工同步（AGENTS.md 自己承认绿色 CI 不代表同步）。
- **两家 fetch 工具都没有私网封锁**：dsh 的 web_fetch 与 kimicode 的 FetchURL 都只做 scheme 白名单 + 手动重定向 + 体量上限——dsh 的本地 provider 明说「允许内网」（隔离靠 provider 二分），kimicode 同样只校 scheme。RyHarness 的 read_url（解析逐地址检查 + 钉 IP + 逐跳复核）在同类防护上**强于两家**；这块不是我们抄他们，是他们该抄我们。

## 五、判定

**不是屎山。** 屎山的定义是「不敢碰、改不动、说不清」。现状恰好相反：债都有名有址有修法（dsh-parity.md §9 八条缺口、dead-code-rule-c-audit.md 108 条、遗留路线图 12 项），恶化路径全部有门禁在拦（casts/biome 预算/重复代码/死代码四道冻结棘轮只减不增）。

**simple yet effective——两半分开判：**

- **effective：成立，且是三家里功能密度最高的。** 1/6 于 dsh、1/3.6 于 kimicode 的代码量，做到两家都没有的记忆演化、多人格、群聊接力、桌面端、spill 取回，外加 4,405 测试 + 77% 分支覆盖（per-file 棘轮）+ 7 门禁 + 类型卫生三家最干净。
- **simple：包级成立，四处集中不 simple。** 45 包各自小、面窄、依赖 ≈10、叙事注释——都是 simple 的证据。不 simple 的四处：ChatView god 组件、app.ts 组合根埋 turn 逻辑、api.ts 手抄契约、测试基建（棘轮+guard+串行）的 bespoke 复杂度。前两个是「还没拆」，后两个是「为小团队纪律自造的机器」——都是有界债务，不是结构性腐烂。

一句话总评：**我们用 1/6 的代码做到了别人 2-3 倍体量才有的功能面，卫生指标全面好于两个标杆；真正的差距不在「脏」，在「契约层没单源化」（唯一未动的 P0）——而出站请求防护（钉 IP）与工具审批门这两块，我们要么强于标杆（两家 fetch 均无私网封锁与 DNS pin，read_url 都有），要么已经追平（审批桥端到端，缺口只在覆盖面）。**

## 六、第五轮补测（2026-11-07，第四波落地后）：8 个此前未比的维度

三份同口径实测（dsh @ fcc0ad4、kimicode @ eb2035f、RyHarness @ 第四波后）逐项对照。判定符号同上。

| 维度 | dsh | kimicode | RyHarness（我们） | 判定 |
|---|---|---|---|---|
| 流式与事件面 | 每 delta 一帧瞬态帧（attemptId/revision/index 单调），终帧携带持久 seq 回执；客户端折叠器五类决策（publish/settlement/abandonment/transient/rebaseline），断线 replace+baseline 重放活跃 attempt；WS 多路复用逻辑流 | 闭包 splitter 归一四类 delta；**广播侧微任务合帧 + 快照 diff 只发变化字段**（conversationFeed.ts:290-446）；WS 按订阅分级 | 每 delta 透传不合并；seq 缺口→按 `fetchSince(lastSeq)` **增量补页**（ChatView resumeFromGap，非整页重拉——本文初版「重拉历史」的表述在第六波 debug 时勘误）；服务器不重放事件（bus.ts 单调 seq，断线窗口事件即丢）；无瞬态/持久帧之分 | ⚠️ 机制最简但代价真实：断线窗口只能靠 REST 补、无精确补帧；「合帧+快照 diff」「事件重放窗口」仍是两个现成可抄的模式 |
| 请求装配与提示词 | **section 注册表**（system-prompt 698 行：order 排序、重名抛错、变量严格插值）；工具集 diff 记 developer/message；request/header 四态落盘；AGENTS.md 双候选 + 双全局根去重 + watcher | md 模板 raw 导入 + **单一 vars 函数** + 单一 render 入口；**AGENTS.md 双通道**（进 system prompt + 每次工具调用后探测目录链上「未注入的 AGENTS.md」经 reminder 队列补注）；deferred 工具在装配层裁剪 | 四段直拼（loop.ts:596-601）；AGENTS.md 每轮现读（无缓存，天然热更新，8k 截断）；无工具集 diff 事件、无后置提醒通道 | ⚠️ 功能等价、结构最粗：prompt 变更不可审计（没有 header/context 事件）；模板+变量槽与 section 注册表是现成升级路径 |
| LLM 适配层 | seam + 适配器不可变快照（换模型不污染在途请求）；normal/always 两态重试（5 次 500ms→10s cap，jitter 0.1）；cache 用量计量（无主动打点） | **SDK maxRetries=0、重试收归统一 policy**（10 次 500ms×2^n cap 32s + 25% jitter，尊重 Retry-After）；**cache_control 实装**（anthropic annotateCache）+ **cache break 遥测**（对比上次请求用量 + tools/prompt/history 三哈希归因） | retry-policy 同代（3 次 500ms→10s cap，jitter 0.1，Retry-After，**仅重试未产出内容的 attempt**——两家报告均无此细节，可能独有）；budget 三段式注释明说对齐 dsh compaction-basic；**无 cache_control 打点**、仅 usage 记账 | 🆚 结构同代；差距集中在 prompt cache 主动打点与失效遥测（长会话成本直接相关） |
| 沙箱与隔离 | **真内核级**：Linux bwrap→Landlock 链、macOS Seatbelt（探测真收档）、**Windows 受限 token + Job Object（FFI 实装）**；native 模块按平台 optionalDependencies；fs read-before-write 观测策略 | 无内核隔离；安全靠 permissionPolicy + **tree-sitter AST 静态分析**（timeout 500ms/maxNodes 1 万预算，识别 sudo 包装/嵌套深度） | 无内核隔离；ShellGuardPolicy 词面黑名单 + sandboxMode 工具面收窄 + guard；无 AST 级命令分析；进程树清理靠 taskkill | 🆚 与 kimicode 同档、大幅落后 dsh；dsh 的 Windows Job Object 是 FFI 真实现——我们 taskkill 树杀是应用层尽力而为 |
| 性能工程 | **10 个 bench 入口全带硬阈值断言**（session-open 50ms 预算、retainedHeap 内存预算、掩码耗时逐条预算）+ CI 专职 lane + 机器画像缩放报告 | 无跑分门；毫秒级启动靠轻入口分流 + SEA 烘焙半空间参数 + V8 code cache；pi-tui 行级 diff 渲染 + nextTick 合帧 + 节流 | bench.ts 只打数字无断言；perf 用例**有比值断言**（cached<full×0.5、fold<200ms）但仅在夜间 CI continue-on-error，不挡合并；启动无懒加载设计 | ⚠️ 比 kimicode 多了断言意识、比 dsh 差一档：数字没变成门，perf 不挡合并 |
| 发布与 CI 工程 | 6 个桌面 workflow（三平台签名+公证、**两段式灰度发布**：打包 run ID → COS staging_percentage 0-100、preflight 拒调试包）+ python 6 wheel；electron **未用 fuses** | canary-release（select 可跳过）+ **pkg-pr-new 每 PR 预览包** + VS Code 双市场 + **3,637 行自动更新子系统**（CDN manifest、设备分桶灰度、Windows rename 原子换装） | 2 个 workflow（ci + release tag→electron-builder→SHA256→gh release）；bump.mjs 单真值版本；**electronFuses 已设**（runAsNode=false——二轮加固项已被并行会话消化，勘误）；**无签名/公证/自动更新** | ⚠️ 「能发布」vs 两家的「产品级分发」；单人项目阶段签名/灰度可缓，自动更新是首个真实缺口 |
| MCP 深度 | stdio + streamable-http、无 oauth、resources 完整、无 sampling；命名哈希兜底；mcp-manager fleet + 跨连接资源工具 | 四 transport、**oauth 生产级**（845 行：refresh 单飞、按 lifetime/2 提前刷新、scope 双 metadata 并集、本地 callback server）；resources/sampling 不做；命名净化+64 截断+哈希 | **仅 stdio**（自写客户端不用官方 SDK）、无 oauth、**resources list/read 有**（kimicode 没有）、命名 sanitize、失败隔离 ✓、超时补发 cancelled | ⚠️ 覆盖面各有胜负：比 kimicode 多 resources、比 dsh 少 http transport；oauth 是共同缺口方向（dsh 也没有） |
| 技能与扩展生态 | 多源注册表 **rank 决胜**（5 来源）、懒加载两段式（摘要进 prompt + 工具取全文）、plugin-manager 5.5k 行 + market、cordis_inspect 运行时自省 | 目录四根（含通用 ~/.agents/skills）、Project>User 覆盖序、清单冻结进 prompt、XML 块激活、**hooks 20 事件系统**（shell 子进程 + allow/block）、插件 prompt 32KB 上限 + 反提权声明 | 目录型三根（project/custom/user）+ FSWatcher 热更新 + **frontmatter/正文两套生命周期**；commands 层不花模型轮次（两家均无对应物）；extensions 只读目录；**未对接 ~/.agents/skills 通用根**；无 hooks 系统 | 🆚 基本同代；缺口 = hooks 事件系统（外部集成面）与 ~/.agents/skills 通用根（ZCode/agents 生态互通） |

### 差距清单（按性价比排序，全部有现成可抄的实现）

> 第六波（2026-11-07 用户视角 debug，`docs/user-debug-2026-11-07.md`）落地后更新状态：
> #8 性能预算门（perf gate 升为挡合并）与 #9 `~/.agents/skills` 通用根已落地；
> #10 签名/公证/自动更新经用户裁定**不做**。其余按四档排期记在第六波方案里。

1. **流式广播的合帧 + 快照 diff**（kimicode conversationFeed）：弱网/长会话的带宽与渲染抖动，一次改造全端受益。
2. **prompt cache 主动打点 + 失效遥测**（kimicode annotateCache + cache_break_detected）：长会话成本直接相关；我们已有 usage 记账，缺最后一步。
3. **AGENTS.md 后置提醒通道**（kimicode agentsMdReminder）：子目录指令「碰到才生效」，不改 system prompt 结构就能拿到。
4. **事件重放或瞬态帧**（dsh attempt/rebaseline）：重连体验从「REST 增量补页」升级为「精确补帧」。
5. **Windows Job Object 硬隔离**（dsh sandbox-windows-acl FFI）：把 taskkill 树杀升级为内核级约束。
6. **MCP streamable-http transport**（两家都有）：接远端 MCP server 的前置。
7. **hooks 事件系统**（kimicode 20 事件）：外部集成的标准面，也是 shell 审批策略的外挂点。
8. ~~**性能预算门**~~（✅ 第六波落地：build-test 增设 Perf gate 挡合并，夜间通道留档）。
9. ~~**~/.agents/skills 通用根**~~（✅ 第六波落地：defaultSkillRoots 优先级 250，目录存在才收根）。
10. ~~**签名/公证/自动更新**~~（用户裁定不做）。

### 我们领先、两家没有的（保持别丢）

记忆/演化系统、群聊多人格接力、spill 溢出分页取回、per-file 负阈值覆盖率棘轮（比 dsh 的 100%+豁免清单更适合渐进采纳）、FTS 臂上界、commands 层不花模型轮次、MCP resources 支持（kimicode 没有）、重试「仅未产出内容的 attempt」、中文叙事注释写「为什么」。

### simple yet effective 复判

两个 🔴 清零后，**effective 判定不变且更强**（11.2 万行 vs 两家 36.9/61.9 万，功能密度仍最高）；**simple 的四处集中债清掉一处（契约）**，剩 god 组件、组合根、测试基建 bespoke 三处，全部有界有账。新补的 8 维度没有发现结构性腐烂——差距全部是「产品化/规模化」级别（分发、弱网、成本、外部集成），而不是「代码脏」。追平路径也全部是「抄现成实现」而非自研，与既定方针一致。

## 附：复测口径

```
src 文件数：  git ls-files '*.ts' '*.tsx' | grep -vE '(^|/)(tests?|__tests__)/|\.test\.|\.spec\.|\.d\.ts$' | wc -l
top 大文件：  同上过滤 | wc -l（按文件）| sort -rn
casts：      git grep -o 'as unknown as'（同过滤）| wc -l；'as any' 同
TODO 密度：  git grep -oE 'TODO|FIXME|HACK'
依赖：       各 package.json dependencies 去掉 workspace:* 与 @ryharness/* 后去重
```
