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
| session-checkpoint | 请求/工具副作用/完成步骤先落盘 | 没有 | **缺** | 崩在工具执行中途时副作用没有记录 | 高 |
| guard | 重复工具调用提醒、tools/execute 超时强制 | 没有 | **缺** | 卡在同一个循环里会一直烧 token | 中 |

## 二、文件系统与执行（上游 fs / shell / sandbox / subprocess 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| fs（读/写/改） | read / write / edit | read / write + **本轮补 glob/grep/edit** | **已有** | `packages/tools`（`fs_glob`/`fs_grep`/`fs_edit`，精确文字替换 + 原子写） | — |
| fs-search | glob / grep | 本轮补上 | **已有** | `packages/tools/src/glob.ts`（自写匹配器，不引外部二进制） | — |
| read-before-edit 策略 | 改前必须先读过 | 用「精确文字匹配」替代 | **部分** | 语义等价性弱一档，但改错地方会被挡住 | 低 |
| shell | bash / pwsh 执行器 | 有 | **已有** | `packages/tools/src/shell.ts`（Git Bash 优先、敏感路径闸、进程树回收） | — |
| subprocess | 统一进程服务 | shell 各自 spawn | **部分** | 没有一处管「所有子进程」的统一服务 | 中 |
| sandbox | read-only / workspace-write / 全权三档 + 提权 | **没有内核级隔离** | **缺** | 现在只有文本敏感路径闸；变量间接、base64 都绕得过 | **最高** |
| terminal | 持久 PTY | 没有 | **缺** | 需要交互式 REPL 时用不了 | 中 |
| ssh | 远程 POSIX 一套 fs/subprocess/sandbox | 没有 | **缺** | 远程机器上的活干不了 | 低 |
| lsp | 跳定义/找引用/hover | 没有 | **缺** | 代码类问题只能 grep | 中 |
| document | Office → PDF | 没有 | **缺** | 交付物不能直接出 PDF | 低 |
| attachment | 内容寻址的附件存储 | 只有类型 | **部分** | 图片/文件落盘与去重没有 | 低 |

## 三、外部世界（上游 web / mcp / browser-use / computer-use 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| web | web_search + web_fetch | 只有 `read_url`（抓指定 URL） | **部分** | **缺搜索**：助理没法「查一下」 | 高 |
| mcp | 连外部 MCP server，把工具接进来 | **本轮补上** | **已有** | `packages/mcp` + `apps/server/src/plugins/mcp.ts`（stdio 连接、工具名 `mcp__<server>__<tool>`） | — |
| browser-use | 浏览器自动化 | 没有 | **缺** | | 中 |
| computer-use | 桌面操作 | 没有 | **缺** | | 低 |
| web-search 后端 | Exa / Perplexity / DeepSeek 三选一 | 没有 | **缺** | 与上面的 web_search 一起做 | 高 |

## 四、编排与自主性（上游 subagent / jobs / workflow / plan / goal / schedule 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| subagent | 委派子代理（进程内 / 跨进程 / ACP） | **本轮在做** | → 已有 | `packages/subagent` | — |
| jobs | 后台长任务，agent 不阻塞 | 没有 | **缺** | 长任务只能同步等 | 中 |
| workflow | 编排脚本 + 扇出 | 没有 | **缺** | | 低 |
| plan | plan 模式 + 计划审批 | 没有 | **缺** | | 中 |
| goal | 跨重启的目标与续跑 | 没有 | **缺** | | 低 |
| schedule | 一次性/每日/每周/cron 提醒 | 只有每日回顾 | **部分** | `apps/server/src/proactive.ts` | 低 |
| group（我们的） | 群聊接力 | 上游没有对应物 | **已有** | `packages/group`（交接工具 + A-B-A 回环检测） | — |
| skill | 技能目录 + 按需加载 + `/name` | 插件自带 skill | **部分** | 没有目录发现与直接调用 | 中 |

## 五、人机协作（上游 interaction 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| 逐条审批 | 敏感操作要人点头 | 有 | **已有** | `apps/server/src/approvals.ts` | — |
| permission presets | 沙箱档位 + 审批策略绑成一档 | 档位已做，但**只管工具面** | **部分** | `@ryharness/agent` 的 `PERMISSION_PRESETS`（只读 / 工作区可写 / 全权）+ `GET /api/permission-presets`；内核级隔离（沙箱）还没有，见 sandbox 行 | 高 |
| commands | 斜杠命令 | 没有 | **缺** | | 中 |
| ask-user | 结构化提问 | 有 | **已有** | `apps/server/src/plugins/ask-user.ts` | — |

## 六、扩展与协议（上游 extensions / preset / bundle / api / typert / sdk / acp 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| extensions | 模型自己查运行时 API、挂载插件 | 只有用户手动开关 | **缺** | | 低 |
| preset | 用 cordis.yml 组合能力 | 我们的人格模板不是能力组合 | **缺** | | 低 |
| bundle | `--profile` 分层装配 | 没有 | **缺** | | 低 |
| typert | 类型图 + 网关 + 生成的客户端 | 只有协议类型 | **部分** | `packages/typert/protocol`（无网关、无客户端） | 低 |
| api | Remote 层（Client 调 Host） | 没有 | **缺** | | 低 |
| sdk | 进程外 JSON-RPC | 没有 | **缺** | | 低 |
| acp | 标准 Agent Client Protocol | 没有 | **缺** | | 低 |

## 七、数据与设置（上游 session-query / settings / credentials / storage / workspace / feedback / telemetry / identity 家族）

| 家族 | 上游做什么 | 我们 | 状态 | 落点 / 缺口 | 优先级 |
|---|---|---|---|---|---|
| session-query | 统一查询 + 关系追踪 + 血缘 + 导出 | 只有 FTS5 搜索 | **部分** | 缺关系追踪/血缘/导出 ZIP | 中 |
| settings | 插件配置表单 | 没有 | **缺** | | 中 |
| credentials | 凭据引用 + 需人授权的取号流 | 明文 api-keys.json | **部分** | 配置里不存明文这一条做到了；授权流没有 | 低 |
| storage | 非会话数据中枢 | 没有 | **缺** | | 低 |
| workspace | 项目分组 | 只有工作区目录 | **部分** | | 低 |
| feedback | 人工反馈 | 有 | **已有** | `POST /api/feedback` | — |
| telemetry | OTel 通道 | 自有遥测 | **部分** | 不是 OTel，但够排障 | 低 |
| identity | 匿名安装 id | 没有 | **缺** | | 低 |

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
