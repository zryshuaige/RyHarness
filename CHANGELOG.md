# Changelog

本文件记录本项目所有值得注意的变更。格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

本轮是围绕评审 P0 的集成收口：把「界面点得到、链路却没通」的地方补完，
让取消、用量、会话管理、记忆与进化各自自洽，并给发布流程装上可验证的门禁。

### Added

- **会话管理面**：会话可改名、置顶、静音、换群成员（`PATCH /api/conversations/:id`），
  支持会话内全文搜索（`GET /api/search`）；会话列表行尾给出置顶 / 静音 / 删除，
  搜索结果按会话分组，点一下直接跳到那条消息。
- **供应商闭环**：设置页可对单个供应商做连通性探测（`POST /api/providers/:id/verify`，
  返回耗时与失败原因），能看清这个 key 被哪些 agent 与模型引用，也能只移除已存的
  凭据而不动整份配置；「这家到底能不能用」抽成唯一真源，欢迎页与「我的」页不再
  对同一个供应商给出相反结论。
- **运行时可观测**：新增零依赖遥测（`GET /api/telemetry`），记录每轮的首 token 延迟、
  总耗时、记忆召回条数与耗时、结局（正常 / 出错 / 被停止），以及近期请求的计时。
  只记计量数字与标识，**不记消息正文、prompt 与凭据**。进化侧同步埋点（每轮进化与
  巩固的耗时、处理条数、成败），「经验手册」据此显示指标。
- **经验手册可解释**：每条手册条目都能回答「这条是从哪来的」——某一轮对话、一次
  反思、一次 👍/👎 反馈、巩固时关联上的长期记忆，还是冷启动模板；条目新增状态与
  来源证据链表，重复记账不会无限膨胀。
- **常驻桌面能力**：托盘常驻（气泡里带忙碌与未读状态）、开机自启开关、
  首启落种一支小队和一条已经发生过的接力演示会话——打开就能看见「多 agent」
  长什么样，而不是一只猫和一个空输入框。
- **发布流水线**：推 `v*` tag 自动跑 lint/typecheck/test → 解包起停冒烟 →
  NSIS 打包 → 上传 GitHub Release 并附 `SHA256SUMS.txt`；新增 `.github/dependabot.yml`
  周更依赖与 GitHub Actions；根 `package.json` 接入 `version:check` / `version:bump`，
  版本号、20 个工作区包的 `version`、「我的」页展示版本与 CHANGELOG 一次改齐。

### Changed

- **默认不给「执行命令」**：Agent 模板的默认工具白名单移除 `shell_exec`，
  新建或换模板时也不再默认勾选；勾上时有一行明确的风险提示（它能在这台电脑上
  直接跑命令，提示注入可升级成任意代码执行）。
- **内容渲染独立成层**：Markdown 正文与附件预览条抽到独立的样式层，段落保留模型
  给的单换行（清单、诗、命令输出不再在生成结束那一刻整条重排），代码块有了容器
  语义；各层选择器仍由测试对撞，不重画既有样式。
- **输入区在生成期间保持可写可发**：发送进入会话的串行队列，不再把输入静默吞掉；
  首个 token 到达后「正在输入」消失，但这一轮仍在跑，停止按钮不会跟着没。
- **长期记忆的词法通道逐 token 转义**：FTS5 查询串里的 `:`、`"`、`OR` 这类元字符
  会让 `MATCH` 直接抛错，整条长期记忆静默失效；现在 BM25 通道的异常单独降级，
  不牵连每轮都要注入的共享画像。
- **记忆归档不再拖累召回**：归档时同步清出 FTS 行（恢复时重建），召回质量不随
  时间单调退化；纯 FTS5 安装（没配向量模型）在写路径补一层文本近重复判定，
  不靠 embedding 也不丢；active 向量常驻缓存，召回不再每轮全表读 BLOB。
- **群聊 fan-out 改为增量流式**；被取消的群聊会补发已收到的回复——此前用户看得到
  半句话，刷新后消息却消失。
- 内核修正 top-N 比较器回归；`.env` 解析统一到标准库；品牌猫图标收敛到单一来源；
  锁文件与 CI 合规（CI 纠正为 `master` 触发并补 permissions/concurrency/timeout，
  另加 `pnpm audit --audit-level=high`）。

### 性能

- **跨启动稳定的 origin**：内嵌后端从随机端口改为固定 32100（`RYAGENT_PORT` 可配，
  设为 `0` 仍要随机），端口被占用时先探测再回退随机端口，实际地址照常推给渲染层。
  端口每次启动都换会让 Chromium 的 HTTP 缓存与 V8 代码缓存整体归零：渲染层的
  vendor 分片要重新下载、重新解析、重新编译。端口探测是必需的——后端 `listen`
  失败不会 reject，撞端口会变成主进程的未捕获异常。
- **长列表/长会话有上界**：新增 `renderer/src/lib/windowed.ts`（只渲染可视区 +
  上下哨兵，另有 `MAX_RENDERED_ROWS` 硬上界，不引第三方虚拟列表库）；store 的
  `liveKeys`/`callIndex` 索引加上界，几千轮之后内存不再随会话长度线性增长。
- **时间格式化不再每格重建 Intl**：`formatTime` 的 `Intl.DateTimeFormat` 按
  locale + options 提到模块级缓存，一次启动最多构造两个实例。
- **SQLite 语句复用**：`SessionStore` 按 SQL 文本缓存预编译语句（上限 64），
  分页取消息这一热路径实测 1.73×（5000 次 × 50 行：678ms → 391ms）；顺带修掉
  `rowToMessage` 对 usage 重复 `JSON.parse` 的问题。
- **启动埋点**：进程冷启动到首屏的各阶段耗时记进 `BootTrace`，渲染层那半段挂在
  `window.__RYAGENT_BOOT__` 由主进程读走合并；控制台一行摘要 +
  `userData/boot-trace.log` + `ryagent:boot-trace` IPC，不依赖遥测服务。

### Fixed

- 停止生成时的「已中止」不再当失败展示；停止失败会如实回滚界面状态，而不是让
  用户以为已经停了、模型其实还在烧 token。
- usage 完整落库并可按会话查（此前循环消费到的 usage 没有随消息存下来）。
- 首条消息的竞态、建群时调度员必须属于成员的校验、toast 层级与定位。
- 记忆归档可见、可恢复，并可重建向量索引；未闭合的尾块在流式期也走同一套渲染。

## [0.1.0] - 2026-10-13

首个可安装版本：从 deepseek-harness 裁剪的精简内核 + 社交化多 Agent 桌面应用。

### Added

- **桌面应用**（`@ryagent/desktop`）：Electron 37 + React 19 + Vite 6；三栏主界面、
  单聊 / 群聊 / 通讯录 / 「我的」页、过程播报气泡、产物文件卡片、群聊接力链可视化。
- **运行时内核**：Agent 消息/工具循环、群聊调度（@直路由 + 调度员自然语言选路 +
  loop-guard）、SQLite 持久化（WAL，单调迁移）、长期记忆（embedding + FTS5 混合召回
  与 RRF 融合）、自我进化闭环（ACE playbook + Reflexion + 反馈归因）。
- **LLM 服务缝**：`chat/completions` + SSE、流式 tool-call 组装、usage 提取
  （含 reasoning / cache token）、统一错误码、多供应商配置化路由。
- **打包发布**：electron-builder 的 Windows NSIS 目标（非一键安装、可自选安装目录），
  `package:dir` 用于解包验证；CI 工作流改为在 `master` 上触发。

### Changed

- 渲染层改由主进程的回环 HTTP server 伺服（原 file:// + 内联单文件 HTML），
  恢复并行加载、HTTP 缓存与 code splitting。
- 头像体系从 6 族收敛为 `dylan` + `mascot` 两族并按需懒加载；软件图标统一为本仓库原创的
  几何橘猫，清退全部第三方 emoji 图形。

### Security

- 渲染层 CSP 与主进程回环绑定收紧；用户 API key 只经环境变量 / `.env` 注入进程，
  不落库、不进日志。
- 截图脚本改为只抓窗口矩形并做废帧检测，避免开发者桌面隐私随图片进入版本库。
