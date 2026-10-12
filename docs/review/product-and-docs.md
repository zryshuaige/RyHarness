# 评审报告：产品与文档体系（README / NOTICE / docs / git 历史 / 入库卫生）

> 评审日期：2026-10-12 · 评审视角：新贡献者 10 分钟跑起来、产品叙事、开源合规、仓库体积
> 证据均来自实际读取文件与 git 历史，行号为当时版本。

## 结论速览

| 级别 | 数量 |
|---|---|
| P0 | 0 |
| P1 | 4 |
| P2 | 10 |

---

## P1（明显的 UX/合规缺陷，maintainer 会 blocking）

### P1-1 全仓没有 LICENSE 文件，各 package.json 也无 license 字段
- 证据：根目录 `ls LICENSE*` 无结果；`grep '"license"' vendor/*/package.json packages/**/package.json apps/*/package.json` 全空（package.json:1-27 根文件无 license 字段）。
- 影响：未声明许可 = 默认"保留所有权利"，任何人（包括同事）从 GitHub clone 后法律上无权使用/修改/分发；与"开源项目"定位直接矛盾。vendor 三件（cordis/cosmokit/schemastery，上游 MIT）经"裁剪改名"（vendor/cordis/README.md:1-3）而**未保留上游版权文本**，MIT 条件未满足。
- 修复：根目录加 LICENSE（MIT 或 Apache-2.0，与上游一致选 MIT），所有 package.json 补 `"license": "MIT"`，vendor 各目录补上游 LICENSE 文本。

### P1-2 NOTICE.md 的 CC BY 4.0 署名留了未填写的 `[licensor]` 占位符
- 证据：NOTICE.md:19 `bigEars … by [licensor]`、NOTICE.md:20 `funEmoji … by [licensor]`。
- 影响：CC BY 4.0 的法定义务是"appropriate credit + license link"，占位符意味着署名义务**未履行**；且 NOTICE.md:22 声称"随应用附本文件即可满足署名义务"不成立——CC BY 还要求署名"以合理方式"出现在用户可见处（如应用关于页），桌面应用里没有任何 UI 展示署名。
- 修复：bigEars 作者 = The Visual Team，funEmoji 作者 = Davis Uche（已对照 [dicebear.com/licenses](https://www.dicebear.com/licenses/) 与 [dicebear/styles LICENSE.md](https://github.com/dicebear/styles/blob/main/LICENSE.md) 核实）；并在应用「我的/关于」页或设置页加一行 DiceBear 署名。

### P1-3 根 README 的产品叙事缺失两大 headline 功能（记忆 + 自我进化）
- 证据：README.md:11-28 架构图无 `@ryagent/memory`/`@ryagent/evolve`；README.md:56-62 功能清单无记忆/进化条目；README.md:79-89 目录结构同样缺失。而 apps/server/README.md:42-52 已把 "Memories & 进化" 列为一级 API，`packages/evolve/README.md:1-83`、`packages/memory/README.md:1-61` 均存在且是后期大里程碑（git log 的 32d4f27、bf7a631 两个提交）。
- 影响："这是什么/为谁/为什么不同"的答案里少了最能差异化的两点；README 与产品实际能力脱节，是叙事层面最大的洞。
- 修复：架构图 packages 行加 memory/evolve；功能清单加"长期记忆（mem0 式抽取+混合检索）"与"自我进化（ACE playbook + Reflexion + 反馈闭环）"两条。

### P1-4 快速开始缺前置条件声明，"10 分钟跑起来"在旧 Node 上必炸
- 证据：根 package.json:7-9 `"engines": { "node": "^22.19 || >=24" }`（`packages/session/README.md:5` 说明依赖 Node 内置 `node:sqlite`），但 README.md:32-54 快速开始只写 `pnpm install` / `pnpm build`，未提 Node 版本和 pnpm 版本要求；也未说明 `pnpm --filter` 依赖 pnpm。Node 20 用户 install 成功、运行时因 `node:sqlite` 不存在而挂，报错不直观。
- 修复：快速开始第一段加"前置：Node ≥22.19（推荐 24+，依赖 node:sqlite）+ pnpm 11（workspace 用了 pnpm 11 的 `allowBuilds`，见 pnpm-workspace.yaml:5-7）"。

---

## P2（一致性/文档/仓库卫生）

| # | 发现 | 证据 | 修复 |
|---|---|---|---|
| P2-1 | 测试计数过时：README 写"83 个测试"，实际 142（`npx vitest list` 实测 142；最近提交 bd99c1b 正文也写 142/142） | README.md:67 | 改为真实数字，或去掉具体数字只写覆盖范围 |
| P2-2 | server README 说 unreadCount"占位，恒 0，未读体系 M4b 后定"，与根 README"未读徽标（seq 比较）"已实现矛盾 | apps/server/README.md:33 vs README.md:61 | 更新 server README 该行 |
| P2-3 | memory README 自述"自我进化是后续里程碑，本次不做"——evolve 已完成且接线 | packages/memory/README.md:3 | 删去过时半句 |
| P2-4 | 根 package.json description 停留在 M1："M1：monorepo + LLM 层 + OpenAI 兼容适配器" | package.json:6 | 改成当前产品描述 |
| P2-5 | 根 README 用仓库外相对链接 `[deepseek-harness](../deepseek-harness)`，clone 到独立路径或 GitHub 上是死链 | README.md:3 | 改文字描述或绝对链接 |
| P2-6 | tsdown 构建产物已入库：`apps/desktop/main/main.mjs`、`preload.mjs` 被 git track（README.md 自述 dev 脚本会重新生成到 `main/`）；`.gitignore` 只有 9 行，缺 `apps/desktop/main/`、`coverage/`、`*.tsbuildinfo` 等 | git ls-files 实测；.gitignore:1-9 | `git rm --cached` 两个产物并补 gitignore 条目 |
| P2-7 | `.zcode/seed.transformed.mjs` 是被 git track 的 Vite 转换临时产物（内含 `/@id/__vite-browser-external` 运行时路径），不属于可复跑的分析脚本 | .zcode/seed.transformed.mjs:1-5 | 删除该文件（depscan.mjs/srcclosure.mjs 等可复跑脚本保留是合理的） |
| P2-8 | 截图体积：33 张 PNG ≈6MB 入库；其中 `apps/desktop/docs/redesign-01*`~`redesign3-*` 共 16 张（约 2.5MB）已被 `redesign4-*` 迭代取代，属于过程稿 | `du` 实测：apps/desktop/docs 4.8MB（29 张）、docs 1.1MB（4 张） | 只保留最新一轮产品截图，历史迭代移出仓库或压到单张 collage |
| P2-9 | 根 package.json 无 `packageManager` 字段固定 pnpm 版本；而 `pnpm-workspace.yaml:5-7` 用了 pnpm 11 才有的 `allowBuilds` 语法，pnpm 10 用户行为不同（electron postinstall 被拦） | pnpm-workspace.yaml:5-7 | 根 package.json 加 `"packageManager": "pnpm@<lockfile 版本>"` |
| P2-10 | 快速开始完全 Windows 视角（PowerShell `[Environment]::SetEnvironmentVariable`、`%APPDATA%`），Electron 应用可跨平台但无 macOS/Linux 数据路径/环境变量写法 | README.md:41-47 | 补一行非 Windows 等价说明，或显式声明"当前仅在 Windows 验证" |

---

## 做得好的地方

- **git 历史质量高**：13 个提交线性推进，M0→M5 里程碑命名清晰，提交正文详尽（测试计数、验证证据、真机截图清单，如 bd99c1b/bf7a631 正文）；全历史零 fixup/merge 噪音。
- **入库卫生整体干净**：`.env`（含真实 API key）从未入库（git log --all -- .env 为空）、`data/` 已 gitignore、全仓 grep 无密钥/token 痕迹、无 SQLite 数据文件或二进制产物入库（除 P2-6/P2-7 两处）。
- **NOTICE.md 体系完整且诚实**：逐项核实到 style 级别，DiceBear 六风格逐一标注 CC0/CC BY 与署名要求，Lucide 23 个、Fluent Emoji 11 个的计数与实际文件数完全吻合（已抽查 `src/assets/lucide/` 23 个、`assets/fluent-emoji/` 12 项含 LICENSE.txt）。
- **契约文档是亮点**：apps/server/README.md 的 HTTP API + WS 事件序列表（:15-76）精确到字段级别，"一轮的典型顺序"示例对前后端协作极有价值；desktop README 对生产构建 file:// CORS 内联方案的说明（:30-32）是难得的真实踩坑记录。
- **docs/performance.md 带实测数字与复现命令**（`pnpm tsx scripts/bench.ts`），比常见的"性能很好"式文档强一个量级。
- **M0-dependency-audit.md 可复跑**：每个结论附带 LOC 数字、耦合性质判断和复跑脚本路径（.zcode/depscan.mjs），裁剪决策留痕完整，是"为什么这样设计"的好范本。
- **包 README 短小、含真实设计决策**：如 session README 对 `node:sqlite` vs better-sqlite3 的取舍论证（:5）——一句话说清选型理由、代价和回退条件。

---

## 总体判断：离顶级开源项目还差什么

骨架已经是"认真维护的个人旗舰"水准——契约文档、性能基线、裁剪留痕、提交纪律都超过多数同类项目。差距集中在三处，全部是一天以内能修完的：

1. **合规底座缺失**（P1-1/P1-2）：没有 LICENSE = 法律上这不是开源项目；CC BY 署名占位符未填是实打实的许可证违约风险。这是"能不能公开发布"的问题，不是"好不好"的问题。
2. **门面文档落后于代码**（P1-3/P1-4/P2-1~P2-5）：README 是最便宜的广告位，但目前漏掉了记忆与自我进化两个最有差异化的特性，还留着 M1 时代的描述和错误的测试计数。代码跑了 12 个里程碑，README 停在了第 5 个。
3. **入库卫生最后一公里**（P2-6~P2-9）：构建产物、Vite 临时文件、6MB 过程截图进了 git。单看都是小事，合起来是"仓库主人还没准备好接受陌生人 PR"的信号。

修完这三类，这个仓库的产品与文档面就达到可以公开 attract contributors 的状态。
