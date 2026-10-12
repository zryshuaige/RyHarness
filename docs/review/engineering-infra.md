# 工程基建评审：根目录构建/工具链/CI 就绪度 + apps/desktop/electron + scripts/

评审日期：2026-10-12 · 范围：根 package.json / pnpm-workspace.yaml / tsconfig* / vitest.config.ts / .gitignore / apps/desktop/electron|scripts / scripts/ · 方法：逐文件真读 + 实际执行验证（依赖解析、文件存在性）

## 结论速览

| 级别 | 数量 |
|---|---|
| P0 | 0 |
| P1 | 5 |
| P2 | 9 |

Electron 安全基线（contextIsolation/nodeIntegration/CSP/内网 connect-src）和 monorepo 基本盘（workspace 拓扑构建、统一 tsdown 配置、装饰器插件、冒烟跳过策略）是扎实的。差距集中在三处：**没有任何 CI 与 lint/format 护栏**、**typecheck 双轨依赖未提交的 vendor 构建产物**、**scripts/ 里有两个会真实报错的入口（e2e-driver 缺依赖、capture npm script 指向不存在的文件）**。

---

## P1（明显的性能/健壮性/UX 缺陷）

### P1-1 仓库无任何 CI 配置
- 证据：仓库根目录无 `.github/`、`.gitlab-ci.yml` 等任何 CI 配置；根 `package.json:10-18` 的 scripts 只能在开发者本机手工执行。
- 影响：139 个测试、"typecheck 绿"、"build 绿" 都是本机状态，无权威复现。`scripts/smoke-siliconflow.ts:41-45` 无 key 时 `exit(0)` 跳过，这种"静默通过"的冒烟恰恰最需要 CI 上有 key 的 job 兜底。
- 修复：加一个最小 GitHub Actions workflow（setup-node + pnpm cache → `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build`）。

### P1-2 `typecheck` 依赖 gitignore 掉的 vendor 构建产物，干净克隆直接失败
- 证据：`tsconfig.typecheck.json:7-15` 把 `@ryagent/cordis/cosmokit/schemastery` 映射到 `./vendor/*/lib/index.d.ts`；而 `.gitignore:2` 忽略 `lib/`（已核实 `git ls-files vendor | grep -c lib` = 0，vendor 的 `lib/` 全是本机构建产物，由 vendor 包 `package.json` 的 `"build": "tsc -p tsconfig.json"` 生成）。
- 影响：新人 clone 后按直觉跑 `pnpm typecheck`（根 `package.json:11` 未声明前置构建）会报 "Cannot find module ... lib/index.d.ts"。且即便构建过，`lib d.ts` 与 `vendor/*/src` 可能过期漂移——typecheck 检的是旧类型，测试（`vitest.config.ts:44` 走 `tsconfig.json` 的 src 路径）跑的却是新源码。
- 修复：二选一——(a) 把根脚本改为 `"typecheck": "pnpm -r --filter './vendor/**' run build && tsc -p tsconfig.typecheck.json"`；(b) 更彻底：vendor 也走 tsdown/lib-in-git 之外，typecheck 统一映射到 src，消除双轨（见 P2-1）。

### P1-3 Electron 主进程无单实例锁，双开产生两个 server 写同一个 SQLite
- 证据：`apps/desktop/electron/main.ts:75-105` 整个 `main()` 无 `app.requestSingleInstanceLock()` / `second-instance` 处理；每次启动都 `RyAgentServer.create`（`main.ts:78-83`），默认 dataDir 同为 `join(app.getPath('userData'), 'ryagent-data')`（`main.ts:82`）。
- 影响：用户双开图标（或崩溃残留进程）→ 两个内嵌 server、两个随机端口、两个窗口，共同读写同一 SQLite 文件；WAL 模式下虽不致损坏，但 `SQLITE_BUSY`、数据互相不可见（各自内存态）是真实的 UX 缺陷。顶级 Electron 应用无一例外加单实例锁。
- 修复：`main()` 开头加 `if (!app.requestSingleInstanceLock()) app.exit(0)`，并 `app.on('second-instance', () => 聚焦已有窗口)`。

### P1-4 `scripts/e2e-driver.mjs` 从仓库根运行必挂：`ws` 不在根依赖里
- 证据：`scripts/e2e-driver.mjs:2` `import WebSocket from 'ws'`；根 `package.json:19-26` devDependencies 无 `ws`（`ws` 是 `apps/server/package.json` 的依赖）；已实测 `node --input-type=module -e "import('ws')"` 从根解析 `ERR_MODULE_NOT_FOUND`（pnpm 不提升非直接依赖）。
- 影响：这个"真实 E2E 驱动"在仓库根目录按自然方式运行直接 MODULE_NOT_FOUND；且全仓库无任何文档或 npm script 引用它（`e2e-driver` 在代码库中 0 引用），等于既跑不起来也没人知道怎么跑。另外 `:5` 调试端口 9333 硬编码、`:6-7` `targets.find(...)` 无空值守卫，electron 未起时抛难懂的 TypeError。
- 修复：根 `package.json` 加 `ws` devDependency（或把驱动挪进 `apps/desktop` 复用其依赖图）；`find` 结果判空给出明确报错；把启动命令写进 README 或包成 npm script。

### P1-5 `pnpm capture` 指向不存在的文件
- 证据：`apps/desktop/package.json:13` `"capture": "node scripts/capture.mjs"`，但 `apps/desktop/scripts/` 实际只有 `dev.mjs / gen-icon.mjs / gen-lucide-icons.mjs / inline-dist.mjs`，`capture.mjs` 不存在（已核实）。
- 影响：用户按 package.json 契约执行必然 `Cannot find module ... capture.mjs`。截图功能本身是通过 `RYAGENT_CAPTURE=1` 环境变量在 `electron/main.ts:87-91` 触发的，npm script 是孤儿残留。
- 修复：删除该 script 行，或改为 `node -e "process.env.RYAGENT_CAPTURE='1'"` 式的等价封装 / `electron .` 前置 env 的跨平台封装。

---

## P2（简洁性/一致性/文档）

### P2-1 tsconfig 双轨（src paths vs lib d.ts）是同一张路径表的两份手工拷贝
- 证据：`tsconfig.base.json:21-85` 与 `tsconfig.typecheck.json:6-70` 是同一份 `@ryagent/*` 映射的两份逐行拷贝，仅 3 个 vendor 条目不同。
- 影响：加一个新包要同步改两处，漏改一处 = 测试和 typecheck 走不同源码（这正是 P1-2 漂移问题的结构根源）。
- 修复：让 `tsconfig.typecheck.json` 仅 `extends` base 并覆盖 vendor 三条（它现在就是这么做的，但把整张表又抄了一遍）；或统一指向 src 后彻底删掉 typecheck 专表。

### P2-2 构建产物 `apps/desktop/main/*.mjs` 被提交进 git，`.gitignore` 未覆盖
- 证据：`git ls-files` 显示 `apps/desktop/main/main.mjs`、`apps/desktop/preload.mjs`（实为 `main/preload.mjs`）已被跟踪；`.gitignore:1-9` 无 `main/` 条目。
- 影响：`electron/main.ts` 改了但忘了 `build:main`，仓库里的 main.mjs 就是过期主进程；review diff 里混入生成代码噪音。
- 修复：`.gitignore` 加 `apps/desktop/main/`，CI 里构建。

### P2-3 无 lint / format / .editorconfig，风格靠人肉
- 证据：全仓库无 eslint/prettier/biome 配置；无 `.editorconfig`；根 `package.json:10-18` 无 lint/format 脚本。
- 影响：19 个包 300+ 文件靠 reviewer 盯风格（本次评审已见 `scripts/` 内三份 `loadDotEnv` 拷贝的轻微不一致）。
- 修复：biome 一条命令即可覆盖 lint+format，加 `"lint": "biome check"` 即可，成本最低收益最高。

### P2-4 根 `package.json` 未声明 `packageManager`，pnpm 版本不受控
- 证据：`package.json:1-27` 无 `packageManager` 字段（仅 `engines.node`）；本机实际用 pnpm 11.7.0，`pnpm-workspace.yaml:7-9` 用了 pnpm 11 专有键 `allowBuilds`（该键本身写法正确，已核对 pnpm 11 文档）。
- 影响：pnpm 10 用户 clone 后 `allowBuilds` 被静默忽略 → sharp/electron 构建脚本被拦，装机即踩坑。
- 修复：加 `"packageManager": "pnpm@11.7.0"`（corepack 会直接锁版本）。

### P2-5 核心 LLM 包 `packages/llm/llm` 零测试，覆盖率无配置
- 证据：`packages/llm/llm/` 下无 `tests/` 目录（同目录的 `llm/openai` 有）；`vitest.config.ts:46-48` 无 `coverage` 配置，根 scripts 无 coverage 命令。vendor 包、util 小包同样无测试。
- 影响：流式 chunk 聚合这类最易出边界 bug 的层恰恰是盲区；"139 测试绿"无法量化保护了什么。
- 修复：给 `llm` 包补流式聚合/中断/usage 的单测；vitest 开 `--coverage` + 一个宽松的阈值（如 50% lines）防止继续退化。

### P2-6 `vite-tsconfig-paths` 是死依赖
- 证据：`package.json:24` 声明了它，但全仓库无 import（`vitest.config.ts:44` 用的是 vitest 4 原生 `resolve.tsconfigPaths: true`）。
- 修复：卸载。

### P2-7 `capture.ts` 中 `dataDir` 是死变量
- 证据：`apps/desktop/electron/capture.ts:12` 构造 `dataDir`，`:31` `rmSync(dataDir, ...)`，但中间从未使用该路径（server 的 dataDir 由 `main.ts:82` 决定）。
- 影响：`rmSync` 对一个从不存在的目录空转，读者会误以为截图用了独立数据目录。
- 修复：删掉这两行。

### P2-8 `before-quit` 不等待 server 关闭
- 证据：`apps/desktop/electron/main.ts:102-104` `app.on('before-quit', () => { void server.close() })`，`void` 掉 Promise。
- 影响：进程在 close 完成前就可能退出；当前 SQLite 写多为同步、风险低，但属于"看起来关了其实没关"的隐患，server 若加异步 flush 即升级为 P1。
- 修复：`app.on('before-quit', (e) => { e.preventDefault(); server.close().finally(() => app.exit(0)) })`。

### P2-9 三个 `.env` 解析器各写一份 + 仓库无 LICENSE
- 证据：`.env` 解析逻辑在 `apps/desktop/electron/main.ts:21-41`、`scripts/smoke-siliconflow.ts:23-37`、`scripts/check-embedding.ts:10-24` 各有一份近似拷贝（正则细节略有出入）；根目录只有 `NOTICE.md` 无 `LICENSE` 文件（已核实）。
- 修复：抽到 `scripts/lib/env.mjs` 一处；补 LICENSE（vendor 的 cordis/schemastery 上游均有许可证要求，NOTICE 不能替代）。

---

## 做得好的地方

- **Electron 安全基线教科书级**：`main.ts:55-61` `contextIsolation: true` + `nodeIntegration: false` + 按 show/offscreen 拆分；`renderer/index.html:7-10` 有收紧到回环地址的 CSP（`connect-src http://127.0.0.1:* ws://127.0.0.1:*`），对内嵌随机端口 server 的场景是对的做法；preload（`preload.ts`）最小暴露，API 地址走 URL query 而非全局变量，注释里写明理由。
- **装饰器降级插件思路干净且与构建/测试两处复用**：`scripts/tsdown-decorators.mjs` 与 `vitest.config.ts:12-33` 同思路，正则误判（如 JSDoc 里的 `@param`）只会多 transpile 不会出错，属于合理的 simple & effective。
- **冒烟/基准脚本的可复跑性好**：`smoke-siliconflow.ts:41-45` 无 key 时明确提示并以 0 跳过；`bench.ts`、`demo-server.ts` 一律 `mkdtemp` 临时目录 + finally 清理，不污染开发库。
- **pnpm 11 前沿配置正确**：`allowBuilds`（pnpm-workspace.yaml:7-9）是 pnpm 11 的正确新键，不是旧 `onlyBuiltDependencies`。
- **vendor 内联 + 双 workspace glob**（`pnpm-workspace.yaml:1-5`）让 fork 的 cordis/cosmokit 可整体替换命名空间，比 patch-package 干净。

## 离顶级开源项目还差什么

一句话：**"本机能跑"和"任何人 clone 下来都能跑"之间还差一层护栏**。按优先级：① 最小 CI（install→typecheck→test→build 一条流水线）；② 修掉 typecheck 对未提交产物的隐式依赖（P1-2）和 scripts 的两个坏入口（P1-4/5）；③ Electron 单实例锁（P1-3）；④ biome + `packageManager` 锁版本 + coverage 阈值。做完这四件事，这套基建就从"个人项目的精良作坊"跨到"可被外部贡献者安全进入的开源项目"。
