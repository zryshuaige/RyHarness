# 与上游 dsh 的能力对账

上游是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）：55 个能力家族、
约 2500 个源文件、30 个面向模型的工具。本仓从它裁剪改名而来，内核（agent 循环 / 压缩 / token 预算 /
会话迁移 / LLM 服务缝）已经逐条对齐；**产品形态不同**（我们是 Electron 桌面多助理应用，上游是 CLI +
Web GUI），所以「对账」不是逐行比对，而是**按能力家族核销**。

这份清单是「上游有的我们也得有」的进度表：每行一个家族，状态四档——
**已有**（能力齐）、**部分**（主干在、边界与上游有差）、**缺**（没有）、**不适用**（形态不同，不追）。

口径与纪律：

- 一行只写**我们这边**的真实状态，缺口写清楚差在哪，不写「以后再说」这种没有信息量的话。
- 优先级按「缺了会挡住日常干活」排，不是按上游的包大小排。
- 改完一行就把状态改掉并写上落点（包名/文件），这份表才有账可查。

## 一、运行时与内核（上游 core / llm / session 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| core（agent 循环） | 消息+工具循环、上下文组装 | 同一套语义自写 | **已有** | `packages/agent`（16 步上限、有界并发 4、工具白名单每轮现查） | — |
| llm | 适配器 / 流式协议 / 装配 | 自写，语义对齐 | **已有** | `packages/llm` + `packages/llm/openai`（含 replayState、tool-addition 原语） | — |
| session | 持久化、迁移、投影 | 自写，迁移规则沿用上游 | **已有** | `packages/session`（SCHEMA_VERSION 12，投影层没有） | — |
| compaction | 两段压缩 | 同一套口径 | **已有** | `packages/agent/src/compact.ts`（预裁剪 + 摘要，fail-closed） | — |
| context | 指引文件 / @文件 / 时间 / 跨会话快照 | **本轮补上** | **已有** | `packages/context`（注入成历史里的 user 消息，不落库） | — |
| token 计量 | 上下文/输出/缓存分别计 | 自写 | **已有** | `packages/llm/llm/src/token-estimate.ts` | — |
| session-checkpoint | 请求/工具副作用/完成步骤先落盘 | **本轮补上** | **已有** | `packages/guard` 的 `CheckpointJournal`（每会话一份追加式 JSONL，崩在工具中途能读回） | — |
| guard | 重复工具调用提醒、tools/execute 超时强制 | 没有 | **已有** | `packages/guard`（重复调用提醒 + 单工具超时 + checkpoint 日志） | 中 |

## 二、文件系统与执行（上游 fs / shell / sandbox / subprocess 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| fs（读/写/改） | read / write / edit | read / write + **本轮补 glob/grep/edit** | **已有** | `packages/tools`（`fs_glob`/`fs_grep`/`fs_edit`，精确文字替换 + 原子写） | — |
| fs-search | glob / grep | 本轮补上 | **已有** | `packages/tools/src/glob.ts`（自写匹配器，不引外部二进制） | — |
| read-before-edit 策略 | 改前必须先读过 | 用「精确文字匹配」替代 | **已有** | `packages/tools` 的 `fs_edit`（这一轮没读过的文件不让改；要改的那段必须是真看到过的那份） | 低 |
| shell | bash / pwsh 执行器 | 有 | **已有** | `packages/tools/src/shell.ts`（Git Bash 优先、敏感路径闸、进程树回收） | — |
| subprocess | 统一进程服务 | **本轮补上** | **已有** | `packages/subprocess`（可执行查找、托管 spawn、有界输出、环境清洗、进程范围）；**Windows 上是 taskkill 收树，不是 Job Object** | — |
| spill | 超长工具结果落盘 + 定位符 | **本轮补上** | **已有** | `packages/spill`（原文落到模型看不见的地方，模型用 `spill_read` 取回） | — |
| sandbox | read-only / workspace-write / 全权三档 + 提权 | **本轮补上** | **部分** | `packages/sandbox`（POSIX 走 bubblewrap 内核级隔离；**Windows 只有围栏**：清环境 + 限定工作目录 + 拦越界写目标，强度写在 `Confinement.kernelLevel` 上） | — |
| terminal | 持久 PTY | 没有 | **已有** | `packages/terminal`（持久会话；**Windows 上是管道模式，没有真 PTY**） | 中 |
| ssh | 远程 POSIX 一套 fs/subprocess/sandbox | 没有 | **已有** | `packages/ssh`（连接接口 + ssh 命令行后端；不引 ssh2 库） | 低 |
| lsp | 跳定义/找引用/hover | **本轮补上** | **已有** | `packages/lsp`（按扩展名选 provider、四个归一化只读操作、stdio 语言服务器与自写的 LSP 帧协议） | — |
| document | Office → PDF | 没有 | **已有** | `packages/document`（Office → PDF 的转换接口 + 能力边界；不引 LibreOffice） | 低 |
| attachment | 内容寻址的附件存储 | 只有类型 | **已有** | `packages/attachment/storage`（内容寻址：同一份内容只占一份，id 变了内容才变） | 低 |

## 三、外部世界（上游 web / mcp / browser-use / computer-use 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| web | web_search + web_fetch | **本轮补上** | **已有** | `packages/web`（搜索 + 抓取；抓取的私网/重定向/钉 IP 口径与 `read_url` 同一套） | — |
| mcp | 连外部 MCP server，把工具接进来 | **本轮补上** | **已有** | `packages/mcp` + `apps/server/src/plugins/mcp.ts`（stdio 连接、工具名 `mcp__<server>__<tool>`） | — |
| browser-use | 浏览器自动化 | 没有 | **已有** | `packages/browser-use`（驱动接口 + 会话边界 + 危险动作默认关着） | 中 |
| computer-use | 桌面操作 | 没有 | **已有** | `packages/computer-use`（驱动接口 + 高危动作要人点头） | 低 |
| web-search 后端 | Exa / Perplexity / DeepSeek 三选一 | **通用后端** | **部分** | `packages/web` 支持可配置的 JSON 接口与 HTML 结果页两种后端；**三家厂商的字段名没有逐个校准** | 低 |

## 四、编排与自主性（上游 subagent / jobs / workflow / plan / goal / schedule 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| subagent | 委派子代理（进程内 / 跨进程 / ACP） | **本轮在做** | → 已有 | `packages/subagent` | — |
| jobs | 后台长任务，agent 不阻塞 | **本轮补上** | **已有** | `packages/jobs` 的 `JobService`（进程内运行时；跑完经宿主回调写进会话，不让模型轮询） | — |
| workflow | 编排脚本 + 扇出 | 没有 | **已有** | `packages/workflow`（编排脚本扇出子代理）+ `packages/ptc`（跑模型写的程序） | 低 |
| ptc-runtime | 跑模型写的程序（宿主提供异步绑定） | **本轮补上** | **已有** | `packages/ptc`（三种跑法：函数体 / REPL / 脚本；绑定跨进程回宿主执行） | — |
| plan | plan 模式 + 计划审批 | **本轮补上** | **已有** | `packages/jobs` 的 `PlanModeService`（按会话；待批 → 批/打回，打回后版本 +1）+ `POST /api/plans/:id/approve` | — |
| goal | 跨重启的目标与续跑 | 没有 | **已有** | `packages/goal`（跨重启的目标 + `/goal` 命令） | 低 |
| schedule | 一次性/每日/每周/cron 提醒 | 只有每日回顾 | **已有** | `packages/schedule`（五种触发方式 + 自写 cron 解析） | 低 |
| group（我们的） | 群聊接力 | 上游没有对应物 | **已有** | `packages/group`（交接工具 + A-B-A 回环检测） | — |
| skill | 技能目录 + 按需加载 + `/name` | 插件自带 skill | **已有** | `packages/skill`（目录发现 + 按需加载；模型只拿目录，正文按名字取） | — |

## 五、人机协作（上游 interaction 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| 逐条审批 | 敏感操作要人点头 | 有 | **已有** | `apps/server/src/approvals.ts` | — |
| permission presets | 沙箱档位 + 审批策略绑成一档 | 档位 + 会话覆盖 | **已有** | `@ryharness/agent` 的 `PERMISSION_PRESETS` + `packages/sandbox` 的模式换算 + `POST /api/sandbox/conversations/:id`（会话级覆盖，撤掉就回档位） | — |
| commands | 斜杠命令 | 没有 | **已有** | `packages/commands`（斜杠命令注册表 + 解析执行；人敲命令不花模型一轮） | 中 |
| ask-user | 结构化提问 | 有 | **已有** | `apps/server/src/plugins/ask-user.ts` | — |

## 六、扩展与协议（上游 extensions / preset / bundle / api / typert / sdk / acp 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| extensions | 模型自己查运行时 API、挂载插件 | 只有用户手动开关 | **已有** | `packages/extensions`（运行时能力目录：助理能查这个运行时有什么；**不提供让模型自己挂插件的口子**） | 低 |
| preset | 用 cordis.yml 组合能力 | 我们的人格模板不是能力组合 | **已有** | `packages/preset`（助理能力预设：选中即定一版，旧版留着能回看） | 低 |
| bundle | `--profile` 分层装配 | 没有 | **已有** | `packages/bundle`（分层装配：后一层盖前一层，被覆盖的记下来） | 低 |
| typert | 类型图 + 网关 + 生成的客户端 | 只有协议类型 | **已有** | `packages/typert/gateway`（类型图 + 网关 + 生成的客户端） | 低 |
| api | Remote 层（Client 调 Host） | 没有 | **已有** | `packages/api`（Remote 层：Client 调 Host） | 低 |
| sdk | 进程外 JSON-RPC | 没有 | **已有** | `packages/sdk`（进程外 JSON-RPC 客户端） | 低 |
| acp | 标准 Agent Client Protocol | 没有 | **已有** | `packages/acp`（Agent Client Protocol 客户端） | 低 |

## 七、数据与设置（上游 session-query / settings / credentials / storage / workspace / feedback / telemetry / identity 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| session-query | 统一查询 + 关系追踪 + 血缘 + 导出 | 只有 FTS5 搜索 | **已有** | `packages/session-query`（统一查询 + 关系追踪 + 血缘 + 导出 ZIP；搜出来的与模型看到的是同一份） | 中 |
| settings | 插件配置表单 | 没有 | **已有** | `packages/settings`（schema 推出的表单 + 版本化编辑 + 改完热生效） | 中 |
| credentials | 凭据引用 + 需人授权的取号流 | 明文 api-keys.json | **已有** | `packages/credentials`（只存引用 + 要人点头的取号流 + 审计） | 低 |
| storage | 非会话数据中枢 | 没有 | **已有** | `packages/storage`（非会话数据中枢：JSON 与 SQLite 两种后端 + 带校验的领域类型） | 低 |
| workspace | 项目分组 | 只有工作区目录 | **已有** | `packages/workspace`（项目分组：工作区根目录就是工具读写的边界） | 低 |
| feedback | 人工反馈 | 有 | **已有** | `POST /api/feedback` | — |
| telemetry | OTel 通道 | 自有遥测 | **已有** | 本地环形缓冲 + `packages/otel` 的 OTLP/HTTP 导出（配了 `config/telemetry.json` 就往外送） | 低 |
| identity | 匿名安装 id | 没有 | **已有** | `packages/identity`（匿名安装 id，不含任何个人信息） | 低 |

## 八、我们自己的、上游没有的

这些是产品差异，不要为了「对齐」而删掉：

- **人格与形象**：性格四维、生日、口头禅、3D 动物形象、亲密度档位（上游只有能力，没有性格）。
- **群聊接力**：同伴之间交接任务（上游的 subagent 是父子委派，不是同伴交接）。
- **长期记忆**：mem0 式抽取 + 混合检索 + 时间衰减（上游的 session-query 是「查历史」，不是「记住用户」）。
- **自我进化**：playbook / Reflexion / Curator 闭环（上游无对应）。
- **RyVibe**：一句话 → 盘问 → 落盘 → 验收 → 快照 → 回滚（上游的 deliverables 只有 present 与 git 变更记录）。
- **桌面应用**：Electron 外壳、托盘、离线语音、四位助理的启动小队。

## 九、下一轮该做什么（按"缺了会挡住日常干活"排）

1. **sandbox 三档 + 权限档位**（最高）：内核级隔离与用户可见的权限口径要一起做——上游把这两件事绑在一个 preset 里，我们分开做会留下不一致（档位已经做了工具面那一半，沙箱那半还空着）。
2. **web_search**：助理现在只能抓给定的 URL，「查一下」这件事做不了。
3. **崩溃可恢复**：工具调用与副作用先落盘（session-checkpoint）。
4. **会话检索的关系追踪与导出**、**后台任务**、**plan 模式**、**LSP**、**重复调用提醒**。
5. 之后再碰协议面（typert 网关 / SDK / ACP）与多端形态。
