# @ryharness/desktop

RyHarness 桌面应用：Electron 壳 + Vite + React 渲染层。

**定位**：一个会跟你熟起来的 Agent 伙伴集合（暖色琥珀系 + 猫管家吉祥物 Ryen）。每个 agent 都带**人格**——性格四维、生日、口头禅、形象与称呼，进的是同一段系统提示；每聊一轮**亲密度**就涨一点，跨档时称呼与主动性一起变，**首次相遇**记在资料卡上。养成关系是第一卖点，交互上的差异点是第二件：过程播报气泡、产物文件卡片、群聊接力链可视化。

## 结构

```
electron/main.ts           主进程：内嵌 @ryharness/server（固定端口，占用回退随机）+ BrowserWindow + 应用菜单
electron/preload.ts        contextBridge（openPath 白名单桥；API 地址经主进程推送）
electron/renderer-assets.ts 渲染层静态资源伺服（回环 HTTP，固定端口，占用回退随机，挂载点 /app）
electron/capture.ts        RYHARNESS_CAPTURE=1 的自动截图模式
renderer/                  Vite + React 渲染层
  src/api.ts               REST/WS 客户端（契约对齐 apps/server README）
  src/store.ts             轻量 store（useSyncExternalStore + 订阅者级切片/节流 + 会话桶缓存）+ @补全纯逻辑
  src/components/          App 壳 / ConversationList / ChatView / MessageBubble / ChatInput /
                           RightPanel / ContactsPage / MePage / PlaybookPanel / MemoryPanel /
                           Modal / ToastHost / Skeleton / Markdown / Icon / Cat / avatars/
  src/assets/lucide/       Lucide SVG（构建期静态引入）
assets/                    软件图标位图（由 assets/brand/mark.png 位图母版逐档整幅缩放派生）
scripts/dev.mjs            开发模式一键启动（vite + tsdown + electron）
scripts/gen-icon.mjs       从 assets/brand/mark.png 母版重新生成全套位图图标
scripts/gen-lucide-icons.mjs  从 lucide-static 重新拷入 UI 图标
tests/                     vitest + jsdom 组件/逻辑测试
```

## 启动方式

### 开发

```sh
pnpm install            # 首次；electron 二进制走 github，慢可设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
pnpm --filter @ryharness/desktop dev
```

- `dev` 脚本做三件事：起 Vite dev server（5173）→ tsdown 打包主进程到 `main/` → 以 `RYHARNESS_DEV_SERVER_URL=http://localhost:5173` 启动 Electron。渲染层热更新；改了主进程代码需重启 dev。

### 生产

```sh
pnpm --filter @ryharness/desktop build      # main/ + renderer/dist
pnpm --filter @ryharness/desktop start      # electron .
```

> 渲染层**不走 file://**：主进程在回环端口起一个静态服务伺服 `renderer/dist`
> （挂载点 `/app`），窗口以同源 URL 加载。早期版本用 file:// + 内联单文件 HTML，
> 代价是丢掉并行加载、HTTP 缓存与 code splitting（产物一度涨到 1.3MB 单 chunk）；
> 现在入口 `index.html` 约 3KB，其余按依赖域拆成 vendor-react / vendor-marked /
> vendor-avatar 等分片并行下载。见 `electron/renderer-assets.ts`。

数据目录默认 `app.getPath('userData')/ryharness-data`，可用 `RYHARNESS_DATA_DIR` 覆盖。

## 端口与缓存

| 服务 | 默认端口 | 环境变量 | 端口策略 |
|---|---|---|---|
| 内嵌后端（`@ryharness/server`） | **32100 固定** | `RYHARNESS_PORT`（`0` = 随机） | 固定优先；被占用时回退随机，实际地址推给渲染层 |
| 渲染层静态资源（`renderer-assets.ts`） | **32101 固定**（后端 +1） | — | 固定优先；被占用时回退随机 |

**为什么两个服务都要固定端口**：Chromium 的 HTTP 缓存与 V8 代码缓存都按 URL 索引。端口
每次启动都换 = 每次冷启动换一个 origin，整份缓存归零，渲染层的分片要重新下载、
重新解析、重新编译。固定端口后 `http://127.0.0.1:32100` 与渲染层 `api.ts` 的
`DEFAULT_API_BASE` 一致，浏览器直连开发与桌面内嵌也落在同一个 origin 上。

端口被占用（开发态同时开着另一个实例、机器上正好有别的程序）时，主进程先探测再
绑定，占用则回退随机端口——`RyHarnessServer.create` 内部的 `listen` 失败不会 reject，
直接撞端口会让主进程带未捕获异常闪退。回退后**实际地址照常推给渲染层**
（`window.__RYHARNESS_API_BASE__` + `ryharness:api-base` 事件），渲染层不需要知道
配置值。

静态资源的条件请求也已在位：`renderer-assets.ts` 按内容算 ETag（内容寻址的分片地址
不变即内容不变），`If-None-Match` 命中就回 304 不传 body，gzip 变体单列一个 ETag
（编码不同即不同实体）。固定 origin + 304，冷启动不必重新下载整份分片。

**还没做的一件事**（文件不在本轮改动范围内）：`apps/server/src/app.ts` 的 `/api/*`
仍没有 ETag / 条件请求，Electron 侧的资源服务已经补齐、后端这侧还没有。

## 启动计时

从进程冷启动到首屏，各阶段耗时记在主进程的 `BootTrace` 里：

- 阶段：`process-start → app-ready → assets-ready → window-created → backend-ready →
  api-base-pushed → dom-ready → loaded → renderer:module → renderer:first-paint`。
- 渲染层自己记的部分挂在 `window.__RYHARNESS_BOOT__`（`renderer/src/lib/boot-trace.ts`），
  主进程在 `did-finish-load` 之后用 `executeJavaScript` 读走、按 `loadURL` 时刻换算
  到主进程时钟上——不经 preload，也没有网络。
- 查询三选一：控制台一行 `[ryharness] 启动 N 段：…`；`userData/boot-trace.log`
  （每次启动覆盖写一份 JSON）；渲染层经 preload 调 `ryharness:boot-trace` IPC 拿快照。
- 首屏「可交互」由 `markFirstInteractive()` 打点，`App.tsx` 拿到首份会话列表后调它
  即可（幂等）；不调也不影响其余阶段。

### 打包（electron-builder）

```sh
pnpm --filter @ryharness/desktop package:dir   # 解包目录（release/win-unpacked），先跑这个验证
pnpm --filter @ryharness/desktop package       # NSIS 安装包（release/RyHarness Setup 0.1.0.exe）
```

> **打包前先把正在运行的 RyHarness 关掉。** 打包出来的应用在运行时**会锁住自己的
> `app.asar`**（Electron 直接读 asar 里的文件，句柄不释放）。于是下一次打包覆盖
> `win-unpacked` 时会卡在 `EBUSY: resource busy or locked, unlink … app.asar`——
> 表现为打包进程 CPU 占用为 0、目录半天不冒出来、**且不报任何错**。删目录同样删不掉
> （回收站接口对它报 "The system call level is not correct"，删除动作又不允许绕过
> 回收站）。确认没有 `RyHarness.exe` 在跑（`Get-Process RyHarness`）再打包即可。
>
> 万一还是撞上（旧目录残留的锁），换个输出目录出包：
> `node_modules/.bin/electron-builder --projectDir apps/desktop --win --dir
>  --config.directories.output=release-fresh`

- 配置在 `package.json#build`：appId `com.ryharness.desktop`、productName `RyHarness`、
  Windows 目标 NSIS、**非一键安装**（可自选安装目录、默认装到当前用户目录，
  未签名包因此不需要管理员权限）、图标取 `assets/icon.ico`。
- `files` 白名单只放 `main/`、`renderer/dist/`、`assets/`、`package.json`；
  生产依赖由 electron-builder 按依赖图收集（`@ryharness/*` 在 tsdown 里是 external，
  运行时经 node_modules 解析，所以这一步不能省）。
- **随分发物交付许可**：`build.extraResources` 把仓库根的 `LICENSE` 与 `NOTICE.md` 复制进
  安装目录的 `resources/`；Electron 自带的 `LICENSE.electron.txt` 与
  `LICENSES.chromium.html`（Chromium / V8 / Node.js 的许可汇总）由 electron-builder
  留在应用目录。四份文件随包交付，MIT 法条与 DiceBear CC BY 4.0 署名因此都在包里。
  完整清单（哪些必须署名、哪些只是构建期工具、哪些是运行时依赖）与核对命令见根
  [NOTICE.md](../../NOTICE.md)；改动资产或依赖后请同步更新它。
- `release/` 是产物目录，已在根 `.gitignore` 里忽略，别提交进去。

> 首次打包要下载 ~110MB 的 Electron 发行包（`@electron/get` 缓存目录
> `%LOCALAPPDATA%/electron/Cache`，之后就不重复下载了）。网络不通或极慢时可以：
> 设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，或在 `build` 里临时加
> `"electronDist": "<本地 electron 发行包 zip 或解包目录>"`（例如 `node_modules/electron/dist`）
> 直接复用已装好的 Electron；后者是本机路径，用完记得从 package.json 里删掉再提交。

## 使用要点

- **首屏先要凭据**：一个能用的模型来源都没有时，「先填一个 API Key」排在能打字之前，且输入框与发送键是禁用的——不假装能聊。免 key 的本地服务（Ollama）也算可用来源，不催人填 key。
- **选模型看得见上下文长度**：新建/编辑 agent 的模型下拉按厂商前缀分组，显示 `128K 上下文` 这样的读数；供应商没报长度就明写「上下文未知」，绝不按模型名猜。可在「我的 → 模型供应商 → 编辑」里逐个补长度，值只落本机（renderer 的 localStorage 覆盖层，服务端 PATCH 的 models 白名单只收 id）。
- **亲密度外显**：单聊头部一直有一枚关系徽标（档位 · 分数），跨档时弹一句话；徽标 0 时不显示，群聊也不显示（好几位挤一行等于没有）。
- **无 key 不崩**：供应商卡片上标「（未配置 key）」而不是崩掉；发消息后的失败以错误横幅显示（来自 WS error 事件）——内核错误码被翻成「出了什么事 + 下一步点哪里」，例如「这家模型服务还没配 API Key」配一个直接跳「我的 → 模型供应商」的按钮。桌面端不提示去设环境变量：那里根本没有环境变量可设，key 是在设置面板里填的。
- **@提及**：群聊输入框输入 `@` 弹出成员补全（↑↓ 选择、Enter/点击插入、Esc 取消）。
- **断线续接**：WS 重连后按 `lastSeq` 只补缺口（不重拉整页），断口那条没写完的气泡就地
  收口；横幅「连接已断开，正在重连…」可手动关掉，收到事件后自动收起。切会话保留草稿、滚动位置与
  已加载历史（见「渲染性能」的分桶缓存）。
- **接力链**：dispatch 事件渲染为成员头像间的流转提示（如 `Ryen → @CodeBot · 转交`），护栏事件（loop-guard/max-turns）红色显示；右栏"调度轨迹"保留全部历史。
- **产物卡片**：produce-card 事件 → 文件卡片（文件名/大小/MIME），主动作是「预览」——在应用内开预览框（图片 `<img>`、PDF `<iframe>` 交给 Chromium 阅读器、Markdown 走现有 Markdown 渲染器、代码/文本进 `<pre>`；docx/xlsx 等没有前端渲染器，明确说不能内嵌并给出「用系统程序打开 / 下载 / 复制路径」），「下载」是并列的显式动作（`<a download>` 走 `/api/files/:name`）。
- **Ryen 状态**：徽标是单一静态位图（无三态）；agent 正在生成时，「正在思考」由打字三点动画（`TypingDots`）表达。
- **菜单**：Windows/Linux 按 `Alt` 唤出应用菜单（关于 / 编辑 / 视图 / 窗口）；macOS 常驻。
  「关于」里的产品名与版本运行时读 `package.json`（打包后从 asar 内读），与安装版一致。

## 图形资源

许可、来源与署名见根 [NOTICE.md](../../NOTICE.md)，这里只讲「现在实际是什么」。

- **头像 = DiceBear 本地 SVG**（`@dicebear/core` + `@dicebear/collection`，无网络请求）：
  收敛为 **2 个家族**——`dylan`（人物）与 `mascot`（吉祥物），均为 CC BY 4.0；
  渲染器数据经 `styles-avatar.ts` **动态 import** 成独立 chunk，头像出现时才加载
  （首包因此不含 40 个风格的 SVG path 数据）。`agent.avatar` 编码 `db:{style}:{seed}`，
  另有 `cat` 指向品牌橘猫；未知 key 回退首字符饱和色块。会话列表/气泡/通讯录/九宫格全生效。
- **UI 图标 = Lucide**（lucide-static，ISC）：整套 SVG 经 `scripts/gen-lucide-icons.mjs`
  拷入 `src/assets/lucide/`，由 `Icon.tsx` 静态注册。
- **软件图标 = 位图橘猫**（本仓库原创）：唯一母版是 `assets/brand/mark.png`
  （953×953、RGBA、四角抠圆角），`pnpm --filter @ryharness/desktop gen:icon` 用 sharp +
  png-to-ico **逐档独立缩放 + 同一个 0.245 圆角遮罩**派生 16–1024 PNG 与 `icon.ico`
  ——不是从大图降采样。**九档（含 favicon）一律整幅**：早先 24/32/48 裁到脸且不扣圆角，
  结果同一枚托盘图标在非 HiDPI 下圆角、HiDPI 下直角；统一外轮廓后实测发现「裁脸 +
  圆角」在几何上做不到（圆角只保住裁窗顶边中间 51% 宽，而两耳尖跨度 474px，需要
  S ≥ 929 而母版只有 953），详见 `apps/desktop/docs/brand/icon.md`。档位表、圆角与
  接线文件名登记在 `assets/brand/tiers.json`，主进程与测试读同一份契约。BrowserWindow
  图标、任务栏、托盘、favicon 与 rail logo 均取自这份产物。
- 应用内徽标 `<Cat>` 是同一份母版的 256 档（`renderer/public/cat.png`），走 `<img>` +
  public/ 静态资源（不进 bundle、可缓存）。**没有三态**：位图换不了眼形与嘴形，
  「正在思考」改由 `TypingDots` 的打字动画表达。此前的几何矢量母版（`cat-face*.svg`）
  与「内嵌 base64 的假矢量」包装法一并作废，仓里不再有 `.svg` 图标。
- 历史引入的 Fluent Emoji（微软彩色贴纸）与 13 个手绘 SVG 头像**已全部清退**，
  仓库里不再保留任何第三方 emoji 位图。

## 图标系统

`renderer/src/components/Icon.tsx`：Lucide 注册表（stroke 2px、圆角线帽、24 viewBox、
currentColor），`<Icon name="send" size={18} />`。尺寸节奏：rail 22px、按钮 15-16px、
输入区 16px。

## 测试

渲染层与逻辑测试在 `tests/`（`@vitest-environment jsdom` pragma）：Cat 单徽标与品牌资产同源、头像注册表
（家族白名单 + key 唯一 + 兜底色块 + 懒加载）、群聊九宫格布局（2/3/4/5/9 人规则）、
主题切换、消息气泡/工具行/文件卡片/接力链/Markdown 渲染、@补全纯逻辑、弹窗、
Toast、骨架屏、ChatStore 事件折叠、REST/WS 客户端。由**仓库根** `npx vitest run` 统一跑
（本包没有 test 脚本）；`npx vitest run --coverage` 附 v8 覆盖率报告。

## 设计系统

设计 token（暖琥珀浅色 + 暖黑暗色两套、4px 基栅、阴影 3 级、圆角/字号阶梯）的依据是 `docs/research/warm-amber-chat-ui-design-spec.md`。**具体数值以 `styles.css` 为准**：调研稿给的是一套参数，实现过程中调过几处（例如 hover 过渡调研稿写 120ms，实现取 `--dur-hover: 140ms`），两份对不上时信代码。主题切换靠 `styles.css` 内 `:root[data-theme='light'|'dark']`，「我的」页或 rail 底部按钮切换并持久化到 localStorage。

- **头像体系**：agent 头像统一走 DiceBear 两族 + 品牌橘猫（见「图形资源」），
  不再另备一套手绘 SVG 头像库；未知 key 回退首字符暖色块；群聊为成员九宫格拼图
  （CSS Grid，微信规则）。
- **软件图标**：`assets/brand/mark.png` 位图母版 → `gen:icon` 逐档独立缩放 + 同一个圆角遮罩，导出 16–1024 PNG 与 icon.ico（九档一律整幅，无裁窗）。
- **微交互**：hover 140ms（`--dur-hover`）、按压 scale(.97)（`--press-scale`）、消息进入 fade+slide、typing 三点错峰、流式 40ms 批量重绘（右栏另有自己的 200ms 窗口，见「渲染性能」）、距底 <100px 才自动跟随（否则浮出「跳至最新」）、骨架屏 shimmer、右栏展开/收起 220ms 宽度过渡（收起成 44px 窄边，不是 0 宽——`overflow: hidden` 下宽度归零会把展开键一起裁掉）。

## 渲染性能

`store.ts` 里的重绘契约（详见该文件头部注释）：

- **基础窗口 40ms**：连续流式事件在窗口内合并成一次重绘（≈25fps），store 只在最前沿刷一次。
- **订阅者级窗口**（`subscribeThrottled` / `useChatSlice(store, select, ms)`）：40ms 是**下限不是上限**。
  消息区（`ChatView`）要在这 25fps 里出字；右栏（`RightPanel`）只订阅自己用到的
  切片（接力链 + 产物，`panelSliceOf`）并把窗口调到 200ms——它展示的东西在流式期间
  一个 token 都不变，跟着 25Hz 重绘纯属白花。切片按字段身份稳定化，右栏在纯流式期间
  一次都不重渲染。
- **切会话分桶缓存**（`ConversationCache` / `ConversationBucket`）：同一个 conversationId
  永远拿到同一个桶，切会话只是换订阅对象——草稿、滚动位置、已加载历史、流式快照原样
  还在，聊天区不再 `key={id}` 整体重建。缓存上界 5 个会话，有草稿的桶最后才被逐出。

## 实测截图（逐页真机截取，docs/*.png）

均为 redesign4 一版真机截取（暗色主题、含左侧 rail 的现行布局）。

- `redesign4-01-welcome.png`：欢迎页（chips 快速入口、最近会话）。
- `redesign4-01-feedback.png`：消息反馈（agent 气泡 👍/👎，归因进自我进化闭环）。
- `redesign4-02-contacts.png`：通讯录（SVG 头像卡片 + 模板区）。
- `redesign4-02-playbook.png`：经验手册（ACE playbook 条目、helpful/harmful 计数）。
- `redesign4-03-create-agent.png`：模板建 Agent（人设/模型/工具白名单）。
- `redesign4-04-group.png`：群聊（接力链、成员网格、调度轨迹，根 README 头图取本页）。
- `capture-contacts.png`：通讯录（**照片级 3D 渲染的动物形象**——球面光照 + 厚度，鼠标移上去会跟着转头）。
- `capture-chat.png`：**真正有对话的那一屏**（气泡、工具行、输入区）——此前 docs 里只有首页，
  聊起来是什么样一直没有像素证据。
- `capture-me.png`：「我的」页（用户自己的立体形象 + 动物 × 毛色定制面板）。
- `capture-providers.png`：模型供应商的「先挑一家」网格（厂商由用户挑，不替他定）。
- `capture-plugins.png`：插件页（分组、内置插件的说明、开关与展开详情）。
- `review-studio.png`：「我的形象」定制面板全貌（动物 × 毛色两个选择器；巡检模式 `RYHARNESS_REVIEW=1` 拍的）。
- `dark-capture-contacts.png` / `dark-capture-me.png` / `dark-capture-plugins.png` / `dark-capture-chat.png`：上面几页的暗色版。

重新截取请用 `scripts/capture-window.ps1`（只截窗口矩形，抓到纯色废帧会 exit 1），
或 `pnpm --filter @ryharness/desktop capture`（Electron 内部 `capturePage`，窗口内画面）。
**不要整屏截图**：桌面上的一切都会入镜。
