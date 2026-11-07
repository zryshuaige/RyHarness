# 与上游 dsh 的能力对账

上游是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）：55 个能力家族、
约 2500 个源文件、30 个面向模型的工具。本仓从它裁剪改名而来，内核（agent 循环 / 压缩 / token 预算 /
会话迁移 / LLM 服务缝）已经逐条对齐；**产品形态不同**（我们是 Electron 桌面多助理应用，上游是 CLI +
Web GUI），所以「对账」不是逐行比对，而是**按能力家族核销**。

这份清单是「上游有的我们也得有」的进度表：每行一个家族，状态三档——

| 状态 | 意思 | 判定标准 |
|---|---|---|
| **产品可用** | 用户在界面里能用到，模型也调得到 | 有工具名或路由；从产品入口出发**代码可达**（由 `scripts/verify-no-dead-code.mjs` 门禁保证） |
| **部分** | 主干在、边界与上游有差 | 差在哪写清楚 |
| **缺** | 没有 | — |
| **不适用** | 形态不同，不追 | — |

**「产品可用」这一档是硬标准**：代码写好了但没有任何路径能触发它，不算「已有」——
上一轮就栽在这：12 个包建好了却没有一处 import，被这份表标成「已有」，实际是
一万多行死代码。现在那道死代码门禁守着这条线。

口径与纪律：

- 一行只写**我们这边**的真实状态，缺口写清楚差在哪，不写「以后再说」这种没有信息量的话。
- 优先级按「缺了会挡住日常干活」排，不是按上游的包大小排。
- 改完一行就把状态改掉并写上落点（包名/文件），这份表才有账可查。

## 一、运行时与内核（上游 core / llm / session 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| core（agent 循环） | 消息+工具循环、上下文组装 | 同一套语义自写 | **产品可用** | `packages/agent`（16 步上限、有界并发 4、工具白名单每轮现查） | — |
| llm | 适配器 / 流式协议 / 装配 | 自写，语义对齐 | **产品可用** | `packages/llm` + `packages/llm/openai`（含 replayState、tool-addition 原语） | — |
| session | 持久化、迁移、投影 | 自写，迁移规则沿用上游 | **产品可用** | `packages/session`（SCHEMA_VERSION 13，投影层没有） | — |
| compaction | 两段压缩 | 同一套口径 | **产品可用** | `packages/agent/src/compact.ts`（预裁剪 + 摘要，fail-closed） | — |
| context | 指引文件 / @文件 / 时间 / 跨会话快照 | **本轮补上** | **产品可用** | `packages/context`（注入成历史里的 user 消息，不落库） | — |
| token 计量 | 上下文/输出/缓存分别计 | 自写 | **产品可用** | `packages/llm/llm/src/token-estimate.ts` | — |
| session-checkpoint | 请求/工具副作用/完成步骤先落盘 | **本轮补上** | **产品可用** | `packages/guard` 的 `CheckpointJournal`（每会话一份追加式 JSONL，崩在工具中途能读回） | — |
| guard | 重复工具调用提醒、tools/execute 超时强制 | 没有 | **产品可用** | `packages/guard`（重复调用提醒 + 单工具超时 + checkpoint 日志） | 中 |

## 二、文件系统与执行（上游 fs / shell / sandbox / subprocess 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| fs（读/写/改） | read / write / edit | read / write + **本轮补 glob/grep/edit** | **产品可用** | `packages/tools`（`fs_glob`/`fs_grep`/`fs_edit`，精确文字替换 + 原子写） | — |
| fs-search | glob / grep | 本轮补上 | **产品可用** | `packages/tools/src/glob.ts`（自写匹配器，不引外部二进制） | — |
| read-before-edit 策略 | 改前必须先读过 | 用「精确文字匹配」替代 | **产品可用** | `packages/tools` 的 `fs_edit`（这一轮没读过的文件不让改；要改的那段必须是真看到过的那份） | 低 |
| shell | bash / pwsh 执行器 | 有 | **产品可用** | `packages/tools/src/shell.ts`（Git Bash 优先、敏感路径闸、进程树回收） | — |
| subprocess | 统一进程服务 | **本轮补上** | **产品可用** | `packages/subprocess`（可执行查找、托管 spawn、有界输出、环境清洗、进程范围；**长驻服务**走 `spawnManagedStream`）；lsp / mcp / ptc / terminal / voice-piper 五处起进程都收口到它；**Windows 上是 taskkill 收树，不是 Job Object** | — |
| spill | 超长工具结果落盘 + 定位符 | **本轮补上** | **产品可用** | `packages/spill`（原文落到模型看不见的地方，模型用 `spill_read` 取回） | — |
| sandbox | read-only / workspace-write / 全权三档 + 提权 | **本轮补上** | **部分** | `packages/sandbox`（POSIX 走 bubblewrap 内核级隔离；**Windows 只有围栏**：清环境 + 限定工作目录 + 拦越界写目标，强度写在 `Confinement.kernelLevel` 上） | — |
| terminal | 持久 PTY | 没有 | **产品可用** | `packages/terminal`（持久会话；**Windows 上是管道模式，没有真 PTY**） | 中 |
| ssh | 远程 POSIX 一套 fs/subprocess/sandbox | 没有 | **产品可用** | `packages/ssh`（连接接口 + ssh 命令行后端；不引 ssh2 库）+ `apps/server/src/plugins/ssh.ts`（`ssh_exec` / `ssh_read` / `ssh_write` / `ssh_list`；密码走 askpass 不进 argv，凭据从 `packages/credentials` 取） | 低 |
| lsp | 跳定义/找引用/hover | **本轮补上** | **产品可用** | `packages/lsp`（按扩展名选 provider、四个归一化只读操作、stdio 语言服务器与自写的 LSP 帧协议） | — |
| document | Office → PDF | 没有 | **产品可用** | `packages/document`（`document_convert` 工具 + `GET /api/document/engines`；**Windows 走 Word COM**（系统自带，不引 LibreOffice），装了 LibreOffice 则走 soffice；两个都没装时工具直说该装什么）+ 「我的」页的**文档转换**区块（直接说这台电脑现在用哪个引擎） | 低 |
| attachment | 内容寻址的附件存储 | 只有类型 | **产品可用** | `packages/attachment/storage`（内容寻址：同一份内容只占一份，id 变了内容才变）+ `GET /api/attachments/:id`（按 sha256 取回字节）+ `POST /api/attachments/lookup`（问一份内容存过没有） | 低 |

## 三、外部世界（上游 web / mcp / browser-use / computer-use 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| web | web_search + web_fetch | **本轮补上** | **产品可用** | `packages/web`（搜索 + 抓取；抓取的私网/重定向/钉 IP 口径与 `read_url` 同一套） | — |
| mcp | 连外部 MCP server，把工具接进来 | **本轮补上** | **产品可用** | `packages/mcp` + `apps/server/src/plugins/mcp.ts`（stdio 连接、工具名 `mcp__<server>__<tool>`） | — |
| browser-use | 浏览器自动化 | 没有 | **产品可用** | `packages/browser-use` + `apps/server/src/plugins/browser.ts`（`browser_open` / `browser_act` / `browser_read`；**走 CDP 连本机 Edge / Chrome**，不下载浏览器二进制；默认不去内网、不自动提交表单与下载） | 中 |
| computer-use | 桌面操作 | 没有 | **产品可用** | `packages/computer-use` + `apps/server/src/plugins/computer.ts`（`computer_screenshot` / `computer_click` / `computer_type` / `computer_key` / `computer_scroll`；Windows 走系统自带 PowerShell + .NET；**点击、打字、按键要走已有的审批链**） | 低 |
| web-search 后端 | Exa / Perplexity / DeepSeek 三选一 | **通用后端** | **部分** | `packages/web` 支持可配置的 JSON 接口与 HTML 结果页两种后端；**三家厂商的字段名没有逐个校准** | 低 |

## 四、编排与自主性（上游 subagent / jobs / workflow / plan / goal / schedule 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| subagent | 委派子代理（进程内 / 跨进程 / ACP） | **本轮补上** | **产品可用** | `packages/subagent`（契约支持 provider；目前只有 `in-process` 一种实现，跨进程与 ACP 后端待写） | — |
| jobs | 后台长任务，agent 不阻塞 | **本轮补上** | **产品可用** | `packages/jobs` 的 `JobService`（进程内运行时；跑完经宿主回调写进会话，不让模型轮询） | — |
| workflow | 编排脚本 + 扇出 | 没有 | **产品可用** | `packages/workflow`（编排脚本扇出子代理）+ `packages/ptc`（跑模型写的程序） | 低 |
| ptc-runtime | 跑模型写的程序（宿主提供异步绑定） | **本轮补上** | **产品可用** | `packages/ptc`（三种跑法：函数体 / REPL / 脚本；绑定跨进程回宿主执行） | — |
| plan | plan 模式 + 计划审批 | **本轮补上** | **产品可用** | `packages/jobs` 的 `PlanModeService`（按会话；待批 → 批/打回，打回后版本 +1）+ `POST /api/plans/:id/approve` | — |
| goal | 跨重启的目标与续跑 | 没有 | **产品可用** | `packages/goal`（跨重启的目标 + `/goal` 命令） | 低 |
| schedule | 一次性/每日/每周/cron 提醒 | 只有每日回顾 | **产品可用** | `packages/schedule`（五种触发方式 + 自写 cron 解析） | 低 |
| group（我们的） | 群聊接力 | 上游没有对应物 | **产品可用** | `packages/group`（交接工具 + A-B-A 回环检测） | — |
| skill | 技能目录 + 按需加载 + `/name` | 插件自带 skill | **产品可用** | `packages/skill`（目录发现 + 按需加载；模型只拿目录，正文按名字取） | — |

## 五、人机协作（上游 interaction 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| 逐条审批 | 敏感操作要人点头 | 有 | **产品可用** | `apps/server/src/approvals.ts` | — |
| permission presets | 沙箱档位 + 审批策略绑成一档 | 档位 + 会话覆盖 | **产品可用** | `@ryharness/agent` 的 `PERMISSION_PRESETS` + `packages/sandbox` 的模式换算 + `POST /api/sandbox/conversations/:id`（会话级覆盖，撤掉就回档位） | — |
| commands | 斜杠命令 | 没有 | **产品可用** | `packages/commands`（斜杠命令注册表 + 解析执行；人敲命令不花模型一轮） | 中 |
| ask-user | 结构化提问 | 有 | **产品可用** | `apps/server/src/plugins/ask-user.ts` | — |

## 六、扩展与协议（上游 extensions / preset / bundle / api / typert / sdk / acp 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| extensions | 模型自己查运行时 API、挂载插件 | 只有用户手动开关 | **产品可用** | `packages/extensions`（运行时能力目录：助理能查这个运行时有什么；**不提供让模型自己挂插件的口子**） | 低 |
| preset | 用 cordis.yml 组合能力 | 我们的人格模板不是能力组合 | **产品可用** | `packages/preset`（助理能力预设：选中即定一版，旧版留着能回看） | 低 |
| bundle | `--profile` 分层装配 | 没有 | **产品可用** | `packages/bundle`（分层装配：后一层盖前一层，被覆盖的记下来） | 低 |
| typert | 类型图 + 网关 + 生成的客户端 | 只有协议类型 | **产品可用** | `packages/typert/gateway`（类型图 + 网关 + 生成的客户端）——经 `packages/api` 的 Remote 层被 `apps/server/src/rpc/endpoint.ts` 挂到 stdio 端点上 | 低 |
| api | Remote 层（Client 调 Host） | 没有 | **产品可用** | `packages/api`（Remote 层：Client 调 Host）+ `apps/server/src/rpc/service.ts`（`ryharness.listConversations` / `listMessages` / `listTools` / `recallMemory` / `writeSetting`；`recallMemory` 返回**记忆条目数组** `string[]`——`row.content` 原文，不是拼好的注入文本，分数/时间等元数据不带，要带是将来的 v2 方法） | 低 |
| sdk | 进程外 JSON-RPC | 没有 | **产品可用** | `packages/sdk`（`RyHarnessClient`：起一个 `--rpc` 子进程，一行连上、一行调用）+ `GET /api/rpc/selfcheck`（服务端把同一套远程服务挂上内存管道、用 SDK 连自己：取类型图 + **真发一次** `listConversations`；「外部程序拉起本进程」那一段由 `apps/server/tests/rpc.test.ts` 真起子进程兜底） | 低 |
| acp | 标准 Agent Client Protocol | 没有 | **产品可用** | `packages/acp`（客户端 + **服务端侧** `AcpAgentServer`：编辑器把 RyHarness 当 agent 驱动；`--acp` 开关开在同一条 stdio 上） | 低 |

## 七、数据与设置（上游 session-query / settings / credentials / storage / workspace / feedback / telemetry / identity 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| session-query | 统一查询 + 关系追踪 + 血缘 + 导出 | 只有 FTS5 搜索 | **产品可用** | `packages/session-query`（统一查询 + 关系追踪 + 血缘 + 导出 ZIP；搜出来的与模型看到的是同一份） | 中 |
| settings | 插件配置表单 | 没有 | **产品可用** | `packages/settings`（schema 推出的表单 + 版本化编辑 + 改完热生效） | 中 |
| credentials | 凭据引用 + 需人授权的取号流 | 明文 api-keys.json | **产品可用** | `packages/credentials`（只存引用 + 要人点头的取号流 + 审计） | 低 |
| storage | 非会话数据中枢 | 没有 | **产品可用** | `packages/storage`（非会话数据中枢：JSON 与 SQLite 两种后端 + 带校验的领域类型 + 键值表视图）+ `packages/settings` 的 `StorageSettingsStore`（**插件配置落进统一后端**，老文件自动搬过来） | 低 |
| workspace | 项目分组 | 只有工作区目录 | **产品可用** | `packages/workspace` + `apps/server/src/routes/workspaces.ts`（`GET/POST /api/workspaces` + `PATCH /api/conversations/:id/workspace`；**会话归的工作区决定工具读写文件的边界**——经 `turn-engine.ts` 的 `resolveWorkspaceRoot` 接进 agent loop 的核心文件工具；document/lsp/mcp/skill 这些挂载期插件拿的还是静态默认根，见 `app.ts` 的插件装配） | 低 |
| feedback | 人工反馈 | 有 | **产品可用** | `POST /api/feedback` | — |
| telemetry | OTel 通道 | 自有遥测 | **产品可用** | 本地环形缓冲 + `packages/otel` 的 OTLP/HTTP 导出（配了 `config/telemetry.json` 就往外送） | 低 |
| identity | 匿名安装 id | 没有 | **产品可用** | `packages/identity`（匿名安装 id，不含任何个人信息） | 低 |

## 八、我们自己的、上游没有的

这些是产品差异，不要为了「对齐」而删掉：

- **人格与形象**：性格四维、生日、口头禅、3D 动物形象、亲密度档位（上游只有能力，没有性格）。
- **群聊接力**：同伴之间交接任务（上游的 subagent 是父子委派，不是同伴交接）。
- **长期记忆**：mem0 式抽取 + 混合检索 + 时间衰减（上游的 session-query 是「查历史」，不是「记住用户」）。
- **自我进化**：playbook / Reflexion / Curator 闭环（上游无对应）。
- **RyVibe**：一句话 → 盘问 → 落盘 → 验收 → 快照 → 回滚（上游的 deliverables 只有 present 与 git 变更记录）。
- **桌面应用**：Electron 外壳、托盘、离线语音、四位助理的启动小队。

## 九、还差什么（按"缺了会挡住日常干活"排）

上一版这一节列的五件事（sandbox 三档、web_search、崩溃可恢复、会话检索与后台任务、协议面）
**都已在本轮做完**，留着会变成一份假的待办清单——和上一轮把死代码标成「已有」是同一类毛病。
下面是现在真实剩下的：

1. **Windows 上的沙箱只有围栏，没有内核级隔离**（最高）：`packages/sandbox` 在 POSIX 上走
   bubblewrap，Windows 上只有「清环境 + 限定工作目录 + 拦越界写目标」，强度写在
   `Confinement.kernelLevel` 上。绕过的办法是**改工具实现**，不是绕过一个策略——要内核级得
   接 Job Object 或 AppContainer。
2. **web_search 的厂商字段没逐个校准**：`packages/web/src/search.ts` 是通用后端（可配 JSON
   接口 / HTML 结果页），Exa / Perplexity / DeepSeek 三家的字段名没有对过一遍，扣分项
   （price / score 之类）在不同厂商下可能取不到。
3. **terminal 在 Windows 上不是真 PTY**：`packages/terminal` 走管道模式（不引 node-pty 这个
   原生模块），所以跑不了 vim / top 这类全屏交互程序。
4. **subagent 只有进程内一种实现**：`packages/subagent` 的契约支持 provider（`in-process`），
   跨进程与 ACP 委派的后端还没写。
5. **session 没有投影层**：能存能查，没有「同一份会话的另一套视图」。
6. **进程外与查询面摸不到 workspace**：`RemoteConversationView`（`rpc/service.ts`）没有
   workspaceId，五个 RPC 方法里没有任何 workspace 方法——本项目分组，外部程序既看
   不到归属也不能改归属；`packages/session-query` 同样没有 workspace 维度，「按项目
   查会话」在统一查询层不存在。
7. **workspace 只有建与归属，没有改名/换根/删除**：`routes/workspaces.ts` 只有三组
   接口；根目录挪走后 `rootExists=false` 的死工作区没有清理口。
8. **recallMemory 只回条目正文**：wire 上把 `hybridRecall` 行上的分数/时间/来源元数据
   全部丢掉，外部程序要按相关度排序或展示出处，得等 v2 方法。

这八条都**不是**「建好了但触发不到」——每一件都写明了落点与边界。

## 十、哪些接口只有模型与程序走，界面不碰

有几组接口**故意没有界面入口**——它们是中间态或面向程序的操作，硬造一个界面入口反而添乱：

| 接口 | 为什么没有界面入口 |
|---|---|
| `GET /api/plans/:id`、`POST /api/plans/:id/approve`、`POST /api/plans/:id/reject` | 计划审批是**模型与人之间**的一轮往返：助理交计划、人在会话里批。界面再开一个「计划」页，等于把同一件事摆两处。 |
| `GET /api/spills/:id` | 溢出文本的定位符是给**模型**取回长结果用的，人看不到也不需要看。 |
| `GET /api/questions`、`POST /api/questions/:id/answer` | 问答是**助理在会话里问**、人在会话里答；单独的列表页没有意义。 |
| `GET /api/commands`、`POST /api/commands/execute` | 界面的斜杠命令是**本地命令表**（每条要拿到应用级动作），服务端这份是给程序与模型用的同一套注册表。 |
| `GET /api/computer/sessions` | 桌面会话是**助理自己在用**的连接（助理开了几个屏幕会话、归在谁名下）。人不会主动去翻「我的桌面会话列表」——要收掉一个会话，助理自己会收。 |
| `GET /api/attachments/:id`、`POST /api/attachments/lookup` | 按内容寻址存取，**给程序用**：id 就是字节的 sha256，客户端自己算得出来。界面拿附件走的是工作区里那份（带文件名的），界面上显示的就是那个文件名与大小。 |

**判据**：一个接口要有界面入口，得先说清「人在什么时候会主动去看它」。上面这四组都答不上来——它们的触发时机全在会话内部。
