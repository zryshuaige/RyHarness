# RyAgent

从 deepseek-harness（DeepSeek Harness / dsh 上游原版，TypeScript pnpm monorepo，cordis DI）裁剪出的精简内核 + 社交化多 Agent 桌面应用。

![通讯录](apps/desktop/docs/screenshot-contacts.png)

**定位**：类微信的社交化 Agent 桌面应用，但不是微信克隆——过程播报气泡、产物文件卡片、群聊接力链可视化、猫管家吉祥物 Ryen（三态 SVG）。底层是完全自有的精简内核（LLM 服务缝 + 消息/工具循环 + 群聊调度 + SQLite 持久化 + 长期记忆/自我进化闭环），LLM 走 OpenAI 兼容协议的多供应商适配层。

## 架构

```
┌─────────────────────────── apps/desktop（Electron + React）───────────────────────────┐
│  三栏主界面 / 通讯录 / 模板建 Agent / 建群 / 设置面板                                    │
│  REST 客户端 + WS 事件折叠（ChatStore）                                                │
├─────────────────────────── apps/server（@ryagent/server）────────────────────────────┤
│  HTTP API（agents/conversations/messages/providers/files）+ WS 推送 + 事件总线          │
├───────────────────────────── packages（内核，自写 + dsh 裁剪）─────────────────────────┤
│  @ryagent/agent   AgentDefinition + Ryen 模板 + AgentLoop（消息/工具循环）              │
│  @ryagent/group   群聊调度器（@直路由 + 调度员自然语言选路 + loop-guard 护栏）           │
│  @ryagent/session SQLite 持久化（SCHEMA_VERSION=3 单调迁移）+ SessionCoordinator        │
│  @ryagent/tools   fs_read/fs_write/shell_exec/file_produce（产物卡片）                  │
│  @ryagent/memory  长期记忆：异步抽取管线 + embedding/FTS5 混合召回（RRF + 时间衰减）      │
│  @ryagent/evolve  自我进化：ACE playbook + Reflexion 反思 + 反馈闭环 + 巩固调度          │
├───────────────────────────── LLM 层 ─────────────────────────────────────────────────┤
│  @ryagent/llm         dsh-llm 契约：LlmAdapter/LlmRuntime/StreamChunk/BlockAssembler  │
│  @ryagent/llm-openai  OpenAI 兼容适配器（SSE、tool calling、usage、多供应商路由）        │
├───────────────────────────── 地基（dsh vendor 裁剪改名）──────────────────────────────┤
│  @ryagent/cordis + cosmokit + schemastery + typert-protocol + util 小包                │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

裁剪决策与依赖盘点见 [M0-dependency-audit.md](./M0-dependency-audit.md)：不带上游 agent-loop 的 32k LOC 生态（sandbox/ptc/approval），agent 循环与 SQLite 持久化均为自写精简版。

## 快速开始

前置要求：**Node ^22.19 或 >= 24**（持久化依赖内置 `node:sqlite`），**pnpm 11**（根 `package.json` 的 `packageManager` 字段已钉版本，建议经 corepack 启用）。

```sh
pnpm install
pnpm build
```

配置 LLM key（SiliconFlow；也可在设置面板里粘贴，或改数据目录下的
`config/providers.json` 加别的 OpenAI 兼容供应商）：

```powershell
# Windows 用户环境变量（设置后重启应用）
[Environment]::SetEnvironmentVariable('SILICONFLOW_API_KEY', '<你的 key>', 'User')
# 或开发时放在仓库根 .env（已 gitignore），从仓库根启动的脚本会读取
```

换用别的 OpenAI 兼容供应商时，向数据目录下的 `config/providers.json` 增加一条
`providers` 条目即可（数据目录在哪见「本地数据与凭据」）。长期记忆的向量模型是
**另一个模型 id**：默认供应商就是 SiliconFlow 时沿用它的默认向量模型；换成别家后
需要显式指定 `embedding`，否则检索退化为纯 FTS5——不猜模型，避免不同模型的向量被
放在一起算相似度：

```jsonc
{
  "providers": { "siliconflow": { "baseURL": "…", "apiKeyEnv": "…", "models": [{ "id": "…" }] } },
  "embedding": { "providerId": "siliconflow", "model": "Qwen/Qwen3-Embedding-0.6B" }
}
```

启动桌面应用（内嵌后端，数据目录见「本地数据与凭据」）：

```sh
pnpm --filter @ryagent/desktop start        # 生产模式（主进程回环 HTTP 伺服渲染层）
pnpm --filter @ryagent/desktop dev          # 开发模式（Vite HMR + Electron）
```

也可以只跑后端 headless（`pnpm --filter @ryagent/server dev`，127.0.0.1:32100）。

## 功能清单

- **单聊**：流式气泡、agent "正在输入"、过程播报（工具调用进度行）、产物文件卡片（打开/下载）。
- **群聊**：@提及直路由；无 @ 时调度员（默认 Ryen）自然语言选路——生成即路由，回复里的 @ 就是接力信号；接力链可视化（流转提示，loop-guard/max-turns 红色标注）；调度轨迹留在右栏。
- **Agent**：内置 Ryen（猫管家总管）+ 5 个模板（通用/Coding/写作/翻译/文件整理）；fork 模板、改人设/模型/工具白名单；builtin 删除保护。
- **长期记忆**（`@ryagent/memory`）：每轮对话异步抽取记忆（mem0 式管线），召回走 embedding 余弦 + FTS5 BM25（中文 bigram）混合检索、RRF 融合、时间衰减；共享用户画像注入每轮 prompt；「我的」页可见画像列表。
- **自我进化**（`@ryagent/evolve`）：ACE 式经验手册（策略/坑/偏好/工具用法，helpful-harmful 计数驱动升降级）+ Reflexion 确定性反思 + 👍/👎 用户反馈归因 + 定时巩固调度，闭环不烧额外 LLM 调用。
- **持久化**：SQLite（WAL），agents/conversations/messages/dispatch_events 等表单调迁移；未读徽标（seq 比较，本人消息不计）；per-conversation 消息串行队列（排队有 WS 提示）。
- **LLM 层**：`chat/completions` + SSE；流式 tool-call 组装；usage 提取（含 reasoning/cache token）；统一错误码（RATE_LIMIT/QUOTA/CONTEXT_WINDOW_EXCEEDED/…）；配置驱动多供应商路由。

## 本地数据与凭据

所有东西都只写在这台电脑上。对话、长期记忆、经验手册、供应商配置与凭据都在同一个
**数据目录**下，默认是 Electron 的 userData 再加一层 `ryagent-data/`，可用环境变量
`RYAGENT_DATA_DIR` 指到别处（比如放数据盘）：

| 怎么启动 | 数据目录（Windows） |
| --- | --- |
| 安装版（`RyAgent Setup *.exe`） | `%APPDATA%\RyAgent\ryagent-data\` |
| 源码启动（`pnpm --filter @ryagent/desktop start`） | `%APPDATA%\@ryagent\desktop\ryagent-data\` |
| 只跑后端（`pnpm --filter @ryagent/server dev`） | `apps/server\data\` |

（Windows 上 userData = `%APPDATA%` + Electron 解析出的应用名；源码态的应用名取自包名
`@ryagent/desktop`。拿不准就设 `RYAGENT_DATA_DIR`，别去猜路径——两种启动方式都认它。）

目录里有什么：

```
ryagent.db              SQLite：agents / conversations / messages / dispatch_events /
                        长期记忆 / playbook / 反馈……（WAL，删库即彻底重来）
conversation-state.json 会话界面态：改名、置顶、静音、群成员
config/providers.json   供应商与模型路由（无明文 key）
config/api-keys.json    API key：桌面端经系统密钥库（Electron safeStorage）加密，
                        独立开发进程退回明文，仅本人读写（0600）
workspace/              fs_read / fs_write / file_produce 的根，产物卡片里的文件也在这
```

凭据只有两条来路：环境变量 / 仓库根 `.env`（开发态），或在设置面板里粘贴（落到上面
那个 `config/api-keys.json`）。两者都**不进数据库、不进日志、不随安装包分发**。备份
数据目录前记得先把 `api-keys.json` 单独拿出来——它是可以重新粘贴的，`ryagent.db`
里沉淀的记忆不是。

> 桌面端把 `api-keys.json` 交给 Electron `safeStorage` 加密（密钥由 Windows DPAPI
> / macOS Keychain 持有）：文件被拷走也解不开。代价是**加密后的凭据跟着系统账户走**——
> 换机器、重装系统或换账户后解不开（启动日志会明确提示"N 个已存 API key 无法解密"），
> 在设置面板里重新粘贴一次即可。
>
> 独立启动后端（`pnpm --filter @ryagent/server dev`）、CI 与测试没有 Electron，
> `safeStorage` 不可用时**明确降级**为明文 + 0600 文件，并在日志里打一行说明，不会
> 静默假装已经加密。

> 换机器 / 重装：整个 `ryagent-data` 拷过去即可；只想保留记忆与手册的话，拷
> `ryagent.db` 也够（`config/` 会按默认配置重新生成）。

## 安全边界

### 能力边界：谁能在这台电脑上执行命令

工具白名单里有一项叫「执行命令」（内部标识 `shell_exec`）：它以**你的权限**在
工作区目录里直接跑 shell。改文件、装东西、删东西都做得到；一旦上游内容被注入
（网页、附件、别的 agent 的回复里夹带指令），提示注入就能直接升级成任意代码执行。
RyAgent 因此不做「执行前逐条审批」这种流程，只在两个地方设闸：

- **默认不给。** 5 个模板的默认白名单都不含「执行命令」，新建或换模板时也不勾选
  （`apps/server/src/seed.ts` 的模板目录）。你亲手勾上时，表单里会挂一行说明。
- **随时收回。** 通讯录 → 编辑该 Agent → 工具白名单里取消勾选「执行命令」→ 保存，
  下一轮就只剩读写文件与产出文件。

已知的边界，说在前面：内置的 **Ryen（猫管家总管）** 是系统自带的，它的白名单来自
内置模板并在每次启动时按模板重新对齐，界面上也没有编辑入口（内置 Agent 不可编辑、
不可删除）。也就是说 Ryen 的「执行命令」目前关不掉。如果你不接受这个默认值，可行的
做法是从模板新建一个自己的助理（默认不含执行命令），并在建群时把它选为调度员。

### 未签名安装包：校验和与 SmartScreen

发布流水线（`.github/workflows/release.yml`，推 `v*` tag 触发）产出的
`RyAgent Setup <版本>.exe` **没有代码签名**：NSIS 配置刻意选了 `oneClick: false` +
`perMachine: false`，装进当前用户目录、不需要管理员权限，代价是文件没有发布者签名。
因此下载后请自己核一遍：

```sh
# 1) GitHub Release 页面同时提供 SHA256SUMS.txt，与安装包放同一目录：
sha256sum -c SHA256SUMS.txt          # 输出 OK 才继续

# 2) 或用 PowerShell 取哈希，与上面那行比对：
Get-FileHash -Algorithm SHA256 '.\RyAgent Setup 0.1.0.exe'
```

然后你会看到 Windows 的两个已知提示，都是**未签名程序**的正常表现，不是中毒：

- **SmartScreen**：「Windows 已保护你的电脑」→ 展开「更多信息」→「仍要运行」。
  这个拦截按「发布者签名是否存在」触发，不会校验文件哈希，所以第 1 步的校验和才是
  真正的判据。
- **NSIS 安装器**：「Windows  SmartScreen 已阻止无法识别的应用」或「未知发布者」，
  同样点「更多信息」→「仍要运行」。

长期方案是买一张代码签名证书（OV 起，EV 起更稳）并配 `CSC_LINK` / `CSC_KEY_PASSWORD`
构建；本仓库目前没有签名材料，所以选择把校验步骤写在这里而不是藏起来。

### 本地 API 的一次性 token

桌面版启动时，后端在**固定端口 32100** 上开一套 HTTP + WS API——而工具白名单里
就有「执行命令」。只靠回环地址不够：同一台机器上的任何进程（甚至用户自己装的
小工具）都能直接连过来发指令。所以主进程每次启动生成一枚 256 位随机 token：

- 后端在 **HTTP 中间件与 WebSocket upgrade 两处都校验**，缺失或不符一律 401
  （WS 会回一帧完整的 `HTTP/1.1 401` 再断开，而不是静默掐断）。
- token 只经启动通道注入渲染层（`window.__RYAGENT_API_TOKEN__` /
  `ryagent:api-token` 事件），**不落盘、不进命令行、不进日志**。
- 渲染层请求带 `Authorization: Bearer <token>`，WS 连 `?token=<token>`
  （浏览器 WS 不能自定义请求头）。

用 curl 直接打后端时带上它即可：`curl -H "Authorization: Bearer $TOKEN" …`。
独立启动后端（`pnpm --filter @ryagent/server dev`）默认**不**鉴权（开发态没有渲染层
要对接），需要时设 `RYAGENT_API_TOKEN=<任意串>` 打开；那条路径同样会在日志里喊一声。

### 已知漏洞与缓解措施

| 项 | 状态 | 缓解 |
| --- | --- | --- |
| Electron 37.10.2：11 条 high（Chromium 层：沙箱绕过、UAF、协议处理器跨源…） | **已修** | 升到 **44.7.2**（当前最新稳定版），`pnpm audit --audit-level=high` 归零 |
| extract-zip 2.0.1：2 条 high（符号链接路径穿越，任意文件写） | **已修** | 随 Electron 升级改用 `@electron-internal/extract-zip`，不再进入依赖图 |
| `@dicebear/initials` / `sprintf-js`：moderate | **接受** | DiceBear 只在渲染层画头像（数据来自内置模板，不接受外部输入）；sprintf-js 来自构建期依赖，不进安装包 |

- **审计是硬门禁**：`.github/workflows/ci.yml` 与 `release.yml` 都跑
  `pnpm audit --audit-level=high` 且**没有** `continue-on-error`——新引入的 high/critical
  会让 CI 与发版一起变红。曾经的「软门禁（先报告、不拦截）」已经连同那条 CVE 一起
  结束，不再是待办状态。
- Electron 只跟最新稳定版：上游安全公告修在哪个版本，我们就在下一个发版跟进到
  哪个版本，不长期停留在已停止支持的分支上。

## 测试与构建

```sh
pnpm test          # 内核单测 + mock SSE 适配器 + 真实 HTTP/WS 集成 + jsdom 组件测试（根 vitest 是唯一 runner）
npx vitest run --coverage   # 同上 + v8 覆盖率报告（阈值只报告不拦截）
pnpm typecheck     # 严格模式（先构建 vendor 产物再跑根 tsc，干净 clone 可直接跑）
pnpm lint          # biome check .（格式 + 静态检查）
pnpm -r build      # 全量构建（vendor 用 tsc，packages 用 tsdown，desktop = tsdown + vite）
pnpm demo:agent    # M2 集成：mock 适配器跑 AgentLoop + 落库断言
pnpm demo:group    # M3 三场景：接力链 / @直路由 / loop-guard
pnpm demo:server   # M4a 只读端点冒烟（真实配置）
pnpm smoke:siliconflow  # 真实 API 冒烟（无 key 时打印提示并 exit 0 跳过）
```

### 打包与许可交付

```sh
pnpm --filter @ryagent/desktop package:dir   # 解包目录，先跑这个验证
pnpm --filter @ryagent/desktop package       # Windows NSIS 安装包
```

打包配置见 `apps/desktop/package.json#build`（appId / productName / NSIS 非一键安装）。
**分发物必须自带许可**：`build.extraResources` 已把 `LICENSE` 与 `NOTICE.md`
复制进安装目录的 `resources/`——MIT 法条全文与 DiceBear 的 CC BY 4.0 署名
（Dylan! by Natalia Spivak、Fun Emoji by Davis Uche）因此随包交付。
新增或替换任何第三方资产、依赖时，同步更新 [NOTICE.md](./NOTICE.md) 是发布前的硬性步骤。

### 发版

版本号只在一处改：根 `package.json` 是唯一真值来源，20 个工作区包的 `version`、
「我的」页展示版本与 CHANGELOG 头部由脚本一次对齐。

```sh
pnpm version:check              # 只读校验（CI 与发版前跑）
pnpm version:check --tag v1.2.3 # 额外校验 tag 存在且与版本号一致
pnpm version:bump 1.1.0         # 改全部位置，并把 [Unreleased] 承接成 [1.1.0] 小节
pnpm version:bump 1.1.0 --dry-run   # 只打印会动哪些文件
```

发版流程：`pnpm version:bump <版本>` → 提交 → `git tag v<版本> && git push --tags` →
推 tag 触发 `.github/workflows/release.yml`：lint/typecheck/test → `electron-builder --win --dir`
起停冒烟 → `--win nsis` → 上传 GitHub Release 并附 `SHA256SUMS.txt`。
依赖与 GitHub Actions 由 `.github/dependabot.yml` 每周更一次。
安装包的校验步骤见「未签名安装包：校验和与 SmartScreen」。

## 目录结构

```
apps/
  server/      @ryagent/server   本地后端（HTTP + WS；API/事件契约见其 README）
  desktop/     @ryagent/desktop  Electron + React 桌面（启动与打包见其 README）
packages/
  llm/llm/     @ryagent/llm      LLM 服务缝（dsh-llm 裁剪）
  llm/openai/  @ryagent/llm-openai  OpenAI 兼容适配器
  agent/ group/ tools/ session/  自写运行时
  memory/ evolve/                长期记忆与自我进化闭环
  typert/protocol/ attachment/types/ util/{brand,crypto,timeout,values,llm-json}/  地基与 stub
vendor/        cordis / cosmokit / schemastery（dsh vendor 改名，各附上游 MIT LICENSE）
scripts/       demo-*.ts 冒烟与集成脚本、bump.mjs（版本号单一真值）、e2e-driver.mjs（CDP 驱动）、capture-window.ps1（只截窗口矩形）
.github/       workflows/ci.yml（master 触发：lint → build → typecheck → test → coverage → audit）
               workflows/release.yml（v* tag 触发：校验 → 解包冒烟 → NSIS → Release + SHA256SUMS）
               dependabot.yml（依赖与 GitHub Actions 周更）
docs（各包 README）· M0-dependency-audit.md · LICENSE · NOTICE.md
CONTRIBUTING.md · CODE_OF_CONDUCT.md · SECURITY.md · CHANGELOG.md
```

## 参与与治理

- [CONTRIBUTING.md](./CONTRIBUTING.md)：Windows-first 的环境、复现步骤、代码风格与提交前检查。
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)：Contributor Covenant 2.1。
- [SECURITY.md](./SECURITY.md)：漏洞与依赖问题怎么报告。
- [CHANGELOG.md](./CHANGELOG.md)：Keep a Changelog 格式的变更记录。

## 许可

MIT（见 [LICENSE](./LICENSE)）。第三方资产署名与许可明细见 [NOTICE.md](./NOTICE.md)；
分发二进制时必须随包附上这两份文件（打包配置已自动处理，见「打包与许可交付」）。
