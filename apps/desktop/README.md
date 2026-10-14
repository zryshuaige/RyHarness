# @ryagent/desktop

RyAgent 桌面应用：Electron 壳 + Vite + React 渲染层。类微信的社交化 Agent 桌面应用（暖色琥珀系 + 猫管家吉祥物 Ryen），但交互上做了自己的创新：过程播报气泡、产物文件卡片、群聊接力链可视化。

## 结构

```
electron/main.ts           主进程：内嵌 @ryagent/server（随机端口）+ BrowserWindow + 应用菜单
electron/preload.ts        contextBridge（openPath 白名单桥；API 地址经主进程推送）
electron/renderer-assets.ts 渲染层静态资源伺服（回环 HTTP，随机端口，挂载点 /app）
electron/capture.ts        RYAGENT_CAPTURE=1 的自动截图模式
renderer/                  Vite + React 渲染层
  src/api.ts               REST/WS 客户端（契约对齐 apps/server README）
  src/store.ts             轻量 store（useSyncExternalStore）+ @补全纯逻辑
  src/components/          App 壳 / ConversationList / ChatView / MessageBubble / ChatInput /
                           RightPanel / ContactsPage / MePage / PlaybookPanel / MemoryPanel /
                           Modal / ToastHost / Skeleton / Markdown / Icon / Cat / avatars/
  src/assets/lucide/       Lucide SVG（构建期静态引入）
assets/                    软件图标位图（由 assets/brand/ 的矢量派生）
scripts/dev.mjs            开发模式一键启动（vite + tsdown + electron）
scripts/gen-icon.mjs       从 assets/brand/ 重新生成全套位图图标
scripts/gen-lucide-icons.mjs  从 lucide-static 重新拷入 UI 图标
tests/                     vitest + jsdom 组件/逻辑测试
```

## 启动方式

### 开发

```sh
pnpm install            # 首次；electron 二进制走 github，慢可设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
pnpm --filter @ryagent/desktop dev
```

- `dev` 脚本做三件事：起 Vite dev server（5173）→ tsdown 打包主进程到 `main/` → 以 `RYAGENT_DEV_SERVER_URL=http://localhost:5173` 启动 Electron。渲染层热更新；改了主进程代码需重启 dev。

### 生产

```sh
pnpm --filter @ryagent/desktop build      # main/ + renderer/dist
pnpm --filter @ryagent/desktop start      # electron .
```

> 渲染层**不走 file://**：主进程在回环随机端口起一个静态服务伺服 `renderer/dist`
> （挂载点 `/app`），窗口以同源 URL 加载。早期版本用 file:// + 内联单文件 HTML，
> 代价是丢掉并行加载、HTTP 缓存与 code splitting（产物一度涨到 1.3MB 单 chunk）；
> 现在入口 `index.html` 约 3KB，其余按依赖域拆成 vendor-react / vendor-marked /
> vendor-avatar 等分片并行下载。见 `electron/renderer-assets.ts`。

数据目录默认 `app.getPath('userData')/ryagent-data`，可用 `RYAGENT_DATA_DIR` 覆盖；端口默认随机，可设 `RYAGENT_PORT` 固定。

### 打包（electron-builder）

```sh
pnpm --filter @ryagent/desktop package:dir   # 解包目录（release/win-unpacked），先跑这个验证
pnpm --filter @ryagent/desktop package       # NSIS 安装包（release/RyAgent Setup 0.1.0.exe）
```

- 配置在 `package.json#build`：appId `com.ryagent.desktop`、productName `RyAgent`、
  Windows 目标 NSIS、**非一键安装**（可自选安装目录、默认装到当前用户目录，
  未签名包因此不需要管理员权限）、图标取 `assets/icon.ico`。
- `files` 白名单只放 `main/`、`renderer/dist/`、`assets/`、`package.json`；
  生产依赖由 electron-builder 按依赖图收集（`@ryagent/*` 在 tsdown 里是 external，
  运行时经 node_modules 解析，所以这一步不能省）。
- **随分发物交付许可**：`build.extraResources` 已把仓库根的 `LICENSE` 与 `NOTICE.md`
  复制进安装目录的 `resources/`，MIT 法条与 DiceBear CC BY 4.0 署名因此随包交付，
  不需要打包者手工追加。改动资产或依赖后请同步更新根 `NOTICE.md`。
- `release/` 是产物目录，已在根 `.gitignore` 里忽略，别提交进去。

> 首次打包要下载 ~110MB 的 Electron 发行包（`@electron/get` 缓存目录
> `%LOCALAPPDATA%/electron/Cache`，之后就不重复下载了）。网络不通或极慢时可以：
> 设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，或在 `build` 里临时加
> `"electronDist": "<本地 electron 发行包 zip 或解包目录>"`（例如 `node_modules/electron/dist`）
> 直接复用已装好的 Electron；后者是本机路径，用完记得从 package.json 里删掉再提交。

## 使用要点

- **无 key 不崩**：设置面板会显示"⚠️ SiliconFlow：未配置 key——设置 SILICONFLOW_API_KEY 环境变量后重启"；发消息后的报错以错误横幅显示（来自 WS error 事件）。
- **@提及**：群聊输入框输入 `@` 弹出成员补全（↑↓ 选择、Enter/点击插入、Esc 取消）。
- **接力链**：dispatch 事件渲染为成员头像间的流转提示（如 `Ryen → @CodeBot · 转交`），护栏事件（loop-guard/max-turns）红色显示；右栏"调度轨迹"保留全部历史。
- **产物卡片**：produce-card 事件 → 文件卡片（文件名/大小/MIME），"打开"走 `/api/files/:name`。
- **Ryen 状态**：顶栏小猫在任意 agent 生成时转 thinking（星星旋转），全部完成时 happy 一下回 idle。
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
- **软件图标 = 几何橘猫**（本仓库原创）：`assets/brand/` 下的矢量母版
  （`icon.svg` 彩色 / `icon-mono.svg` 单色剪影 / `favicon.svg` / 吉祥物三态），
  `pnpm --filter @ryagent/desktop gen:icon` 用 sharp + png-to-ico 派生 16–1024 PNG 与
  `icon.ico`，BrowserWindow 图标与 rail logo 均取自这份。
- 历史引入的 Fluent Emoji（微软彩色贴纸）与 13 个手绘 SVG 头像**已全部清退**，
  仓库里不再保留任何第三方 emoji 位图。

## 图标系统

`renderer/src/components/Icon.tsx`：Lucide 注册表（stroke 2px、圆角线帽、24 viewBox、
currentColor），`<Icon name="send" size={18} />`。尺寸节奏：rail 22px、按钮 15-16px、
输入区 16px。

## 测试

渲染层与逻辑测试在 `tests/`（`@vitest-environment jsdom` pragma）：Cat 三态、头像注册表
（家族白名单 + key 唯一 + 兜底色块 + 懒加载）、群聊九宫格布局（2/3/4/5/9 人规则）、
主题切换、消息气泡/工具行/文件卡片/接力链/Markdown 渲染、@补全纯逻辑、弹窗、
Toast、骨架屏、ChatStore 事件折叠、REST/WS 客户端。由**仓库根** `npx vitest run` 统一跑
（本包没有 test 脚本）；`npx vitest run --coverage` 附 v8 覆盖率报告。

## 设计系统

设计 token（暖琥珀浅色 + 暖黑暗色两套、4px 基栅、阴影 3 级、圆角/字号阶梯）与交互参数依据 `docs/research/warm-amber-chat-ui-design-spec.md`：`styles.css` 内 `:root[data-theme='light'|'dark']` 切换，「我的」页或 rail 底部按钮切换并持久化到 localStorage。

- **头像体系**：agent 头像统一走 DiceBear 两族 + 品牌橘猫（见「图形资源」），
  不再另备一套手绘 SVG 头像库；未知 key 回退首字符暖色块；群聊为成员九宫格拼图
  （CSS Grid，微信规则）。
- **软件图标**：`assets/brand/` 的矢量母版 → `gen:icon` 导出 16–1024 PNG 与 icon.ico。
- **微交互**：hover 120ms、按压 scale(.97)、消息进入 fade+slide、typing 三点错峰、流式 40ms 批量重绘、距底 <100px 才自动跟随（否则浮出「跳至最新」）、骨架屏 shimmer、右栏展开/收起 200ms 过渡。

## 实测截图（逐页真机截取，docs/*.png）

- `redesign4-01-welcome.png`：欢迎页（chips 快速入口、最近会话）。
- `redesign4-01-feedback.png`：消息反馈（agent 气泡 👍/👎，归因进自我进化闭环）。
- `redesign4-02-contacts.png` / `screenshot-contacts.png`：通讯录（SVG 头像卡片 + 模板区）。
- `redesign4-02-playbook.png`：经验手册（ACE playbook 条目、helpful/harmful 计数）。
- `redesign4-03-create-agent.png`：模板建 Agent（人设/模型/工具白名单）。
- `redesign4-04-group.png`：群聊（接力链、成员网格、调度轨迹）。

重新截取请用 `scripts/capture-window.ps1`（只截窗口矩形，抓到纯色废帧会 exit 1），
或 `pnpm --filter @ryagent/desktop capture`（Electron 内部 `capturePage`，窗口内画面）。
**不要整屏截图**：桌面上的一切都会入镜。
