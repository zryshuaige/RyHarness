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
| 源码规模 | ≈61.9 万行（client 17.8万 + experimental 10.5万；scripts 4.7万；生成物 1.8万） | ≈36.9 万行（agent-core-v2 15.6万独大 + TUI 5.9万） | ≈10.3 万行（476 文件）+ vendor 3 包（cordis/cosmokit/schemastery，与 dsh 同款三件套） |
| 测试规模 | ≈75.2 万行，~29,682 用例（test:src≈1.28） | ≈41.3 万行，~15,936 用例（test:src≈1.12） | ≈6.4 万行，~2,176 用例（test:src≈0.62） |

## 二、16 维度对比表

判定符号：✅ 领先 / 🆚 持平 / ⚠️ 落后或真债 / 🔴 P0 级缺口。16 项合计：✅9 / 🆚1 / ⚠️5 / 🔴2。

| 维度 | dsh | kimicode | RyHarness（我们） | 判定 |
|---|---|---|---|---|
| 核心 loop | `ReactLoopAgent` 745 行类，三态相位状态机（idle/maintenance/running），loop 组 6 文件 2,127 行；维护相位与循环解耦 | `AgentLoopService` 2,490 行 DI 服务类（15 服务注入）+ engine 635 + requester 1,028；steer/nudge 双队列、quiescence 计数、9 分支收尾状态机纠缠 | `loop.ts` 1,110 行单文件函数式 + compact/budget 同包；注册表 dispatch | ✅ 结构最简单；缺权限拦截层（见审批行）⚠️ |
| 上下文管理 | compaction 独立插件组 ≈2,858 行（basic/image-offload/tool-result-pruner/command-compact） | fullCompaction 1,261 行：0.85 触发、预留 50k token、5 重试、[0.7,0.5,0.35] 收缩 | budget + 工具结果剪枝 + compactHistory + **spill 溢出文本落盘分页取回（三家独有）** | ✅ spill 是真设计亮点 |
| 工具定义 | `defineTool` + 自研 JSON-Schema DSL + 自写校验器，强制 output schema；35 工具包 100+ 工具 | DI 服务类 + zod → toJSONSchema；15 内置 + Tower 13 | 每域一包自注册（shell/document/browser-use/lsp/ssh…），无统一 schema DSL | ⚠️ 面窄但无 schema 约束，是契约债的一部分 |
| 权限/审批 | interaction/user-approval + permission-presets + sandbox-policy 事件瀑布 | manual/yolo/auto 三模式 + 16 个有序策略文件 + 异步裁决 | guard + dangerous.ts 黑名单；loop 直通，无逐命令审批 | 🔴 P0，两家都有完整防线我们没有 |
| 会话持久化 | append-only 事件日志 + 不可变 generation + 自实现 zstd + 迁移链 v0→v4 | JSONL wire 分支树（fork/undo）+ 5 级迁移 + fs/memory/minidb 三后端 | node:sqlite WAL 单库三句柄（session/memory/evolve），schema v1→v7，FTS | 🆚 持平；sqlite 强在查询、弱在可手救 |
| 记忆/演化 | 无 | 无（AGENTS.md 注入 + skills + compaction handoff） | memory+evolve ≈3.6k 行：抽取/矛盾处理/衰减/importance/休眠归档 | ✅ 三家唯一，产品差异点 |
| 子代理 | 8 包 9.9k 行，6 provider（in-process/acp/claude-code/codex/sdk）+ team 任务板 | 1.7k 基础 + AgentSwarm 2k + Tower 3.2k（git worktree 并行） | in-process 单一实现 | ⚠️ 已知缺口（dsh-parity §9） |
| 配置/契约 | Schemastery 单源 + 19 个 gen-* + 67 个 verify-* 全带 --check | zod 全链 + config/wire/state manifest 同源生成；REST 115 路由 defineRoute→openapi | api.ts 手抄 ~20 接口（drift 已发生：dispatcherAgentId）+ 15 路由手写校验；typert 是运行时反射阉割版（包头自述与上游差距） | 🔴 P0，两家都单源化了 |
| 测试门禁 | per-file 100% 覆盖率 + 150 行豁免清单 + 10 个 vitest 配置 + 32 个 CI workflow + jscpd + casts 棘轮 453 文件 | 无覆盖率阈值 + 5-shard 矩阵 + check-no-comments AST 门 + import 边界门 | per-file 负阈值棘轮（数十条实测+2）+ incompleteRunGuard + 7 道自研门禁 + biome 550 冻结基线；串行 440s | ✅ 门禁密度三家最高；棘轮 bespoke 复杂度 ⚠️；测试量偏薄 ⚠️ |
| 类型卫生 | src `as any`=6 / `as unknown as`=101；非空断言 ~5k | 主 src `as unknown as`=179，全仓 1,894；lint 直接关掉 no-explicit-any / no-non-null-assertion | `as any`=0 / `as unknown as`=6，casts 棘轮只减不增 | ✅ 三家最干净 |
| god 文件 | api-catalog.ts 10,408（生成）、TrajectoryTable 3,607、typert analyzer 3,468、手写 i18n 字典 4×2k+ | kimi-tui.ts 5,463、tower store 3,255、loopService 2,490 | ChatView.tsx 2,396（全仓最大）、app.ts 1,967（组合根埋 670 行 turn 逻辑 + 两套同构事件 switch） | ⚠️ 相对最轻，但这两处是真债 |
| 死代码治理 | 100% 覆盖率门兼做死代码检测（原话："uncovered line is dead code... for deletion"） | 无任何死代码门禁 | 规则 A-D 门禁 + 108 条规则 C 审计已落盘（101 去 export + 7 删） | ✅ 有门有账，只待清 |
| 依赖纪律 | 发布闭包 561（内核薄：dsh-llm 仅 7 个） | 全仓 ~40+（app 层刻意仅 3） | 第三方运行时 ≈10（react/sharp/marked/electron/dicebear 等），其余全是 workspace | ✅ 三家最省 |
| 注释/文档哲学 | 659 个双语 md + i18n 配对门 + 19 个生成文档目录 | 核心两包禁一切注释（AST 门强制）："code, not documentation, is the source of truth" | 强制叙事体中文注释写「为什么」+ dsh-parity.md 自对标 + 审计落盘 | ✅ 自洽且罕见（风险：注释会腐烂，靠 review 挡） |
| 包组织 | 55 组 379 个 package.json；client 77 子包、experimental 61 包 | agent-core-v2 独大（1,143 文件）+ pi-tui vendored | 45 包 + vendor 3 包；src 前 10 大文件全部 ≤2.4k 行 | ✅ 无独大巨包 |
| 复杂度性价比 | 61.9 万行维持的功能面 | 36.9 万行维持的功能面（含 v1/v2 双轨） | 10.3 万行：记忆演化 + 多人格 + 群聊接力 + 桌面端 + spill，两家都没有 | ✅ 功能密度三家最高 |

## 三、我们做得不好的地方（按伤害排序，均有标杆对照）

1. **契约手抄（P0，性价比最高的债）**——`apps/server/src/api.ts` 手抄 ~20 接口 + 15 路由手写校验，drift 已发生。dsh 用 Schemastery 单源 + 67 个 verify 门；kimicode 用 zod `defineRoute` 一路生成到 openapi，连自家 SDK 都强制走同一契约层「不抄近路」。我们 vendor 里已经躺着 schemastery，就差接线。→ 路线图遗留 #3。
2. **shell 无审批（P0，安全）**——kimicode 三模式 + 16 个有序策略文件；dsh user-approval 事件瀑布 + sandbox-policy。我们 `packages/agent/src/loop.ts` 直接 `tool.execute`。→ 路线图遗留 #1。注意别学 kimicode 的 16 层策略（过度工程）：在 loop 里加一个 beforeExecute 拦截点就能挡住大部分伤害。
3. **app.ts 1,967 行组合根 + ChatView.tsx 2,396 行**——turn 逻辑埋在组合根、两套同构事件 switch。dsh 证明 client 拆 77 子包可行（但也付了协调税）；kimicode 的教训是 loopService 揉到 2,490 行后 steer/nudge/settle 互相纠缠——拆要趁早、拆要有度。→ 路线图遗留 #4。
4. **死导出 108 条**——门禁和审计都齐（dead-code-rule-c-audit.md），只欠清理那一波。kimicode 连死代码门禁都没有，我们领先，只差执行。→ 路线图遗留 #6。
5. **测试量偏薄 + 基建 bespoke**——test:src 0.62（两家 1.1-1.3）；覆盖率棘轮数十条 per-file 负阈值是自造复杂度，dsh 的规则一句话：「per-file 100% 或不合并」。我们的棘轮是增量采纳期的务实选择，长期该往「更少规则」收敛；串行 440s 待 vitest ≥5.0.5 修。→ 路线图遗留 #2/#3。

## 四、两个标杆也不干净（避免光环偏差）

- **dsh**：src 101 处 `as unknown as`、~5k 个 `!` 非空断言；17.8 万行 client 是 100% 覆盖率门的最大豁免来源（150 行豁免清单全带 TODO(gui)）；10,408 行生成目录文件进 review 面；10 个 vitest 配置 + 32 个 CI workflow + 659 个双语文档的维护税极高。
- **kimicode**：主 src 179 处 `as unknown as`（全仓 1,894）、lint 关掉类型安全规则；无覆盖率阈值；核心包禁注释 = 自文档性全押在命名上；v1/v2 双轨 + migration-legacy 4,113 行兼容胶水；自研 minidb 18,980 行 + bash 解析器 3,787 行重轮子；dist-web bundle force-add 入库、flake.nix 手抄列表靠人工同步（AGENTS.md 自己承认绿色 CI 不代表同步）。

## 五、判定

**不是屎山。** 屎山的定义是「不敢碰、改不动、说不清」。现状恰好相反：债都有名有址有修法（dsh-parity.md §9 八条缺口、dead-code-rule-c-audit.md 108 条、遗留路线图 12 项），恶化路径全部有门禁在拦（casts/biome 预算/重复代码/死代码四道冻结棘轮只减不增）。

**simple yet effective——两半分开判：**

- **effective：成立，且是三家里功能密度最高的。** 1/6 于 dsh、1/3.6 于 kimicode 的代码量，做到两家都没有的记忆演化、多人格、群聊接力、桌面端、spill 取回，外加 2,176 测试 + 77% 分支覆盖（per-file 棘轮）+ 7 门禁 + 类型卫生三家最干净。
- **simple：包级成立，四处集中不 simple。** 45 包各自小、面窄、依赖 ≈10、叙事注释——都是 simple 的证据。不 simple 的四处：ChatView god 组件、app.ts 组合根埋 turn 逻辑、api.ts 手抄契约、测试基建（棘轮+guard+串行）的 bespoke 复杂度。前两个是「还没拆」，后两个是「为小团队纪律自造的机器」——都是有界债务，不是结构性腐烂。

一句话总评：**我们用 1/6 的代码做到了别人 2-3 倍体量才有的功能面，卫生指标全面好于两个标杆；真正的差距不在「脏」，在「契约层没单源化」和「执行权限没有拦截层」这两个两家都有而我们没有的防线上。**

## 附：复测口径

```
src 文件数：  git ls-files '*.ts' '*.tsx' | grep -vE '(^|/)(tests?|__tests__)/|\.test\.|\.spec\.|\.d\.ts$' | wc -l
top 大文件：  同上过滤 | wc -l（按文件）| sort -rn
casts：      git grep -o 'as unknown as'（同过滤）| wc -l；'as any' 同
TODO 密度：  git grep -oE 'TODO|FIXME|HACK'
依赖：       各 package.json dependencies 去掉 workspace:* 与 @ryharness/* 后去重
```
