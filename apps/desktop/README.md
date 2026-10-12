# @ryagent/desktop

RyAgent 桌面应用：Electron 壳 + Vite + React 渲染层。类微信的社交化 Agent 桌面应用（暖色琥珀系 + 猫管家吉祥物 Ryen），但交互上做了自己的创新：过程播报气泡、产物文件卡片、群聊接力链可视化。

## 结构

```
electron/main.ts       主进程：内嵌 @ryagent/server（随机端口）+ BrowserWindow
electron/preload.ts    contextBridge（当前仅占位，API 地址经 URL query 传递）
renderer/              Vite + React 渲染层
  src/api.ts           REST/WS 客户端（契约对齐 apps/server README）
  src/store.ts         轻量 store（useSyncExternalStore）+ @补全纯逻辑
  src/components/      Cat / ConversationList / ChatView / MessageBubble /
                       ChatInput / RightPanel / ContactsPage(含三个弹窗)
tests/                 vitest + jsdom 组件测试
scripts/dev.mjs        开发模式一键启动（vite + tsdown + electron）
```

## 启动方式

### 开发

```sh
pnpm install            # 首次；electron 二进制走 github，慢可设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
pnpm --filter @ryagent/desktop dev
```

- `dev` 脚本做三件事：起 Vite dev server（5173）→ tsdown 打包主进程到 `main/` → 以 `RYAGENT_DEV_SERVER_URL=http://localhost:5173` 启动 Electron。渲染层热更新；改了主进程代码需重启 dev。

> 实现说明：生产构建后 `scripts/inline-dist.mjs` 会把 JS/CSS 内联进
> `renderer/dist/index.html`——Electron 以 file:// 加载时外部 module script
> 会被 CORS 拦截，内联 script 则正常执行（单文件 ~300KB）。

### 生产

```sh
pnpm --filter @ryagent/desktop build      # main/ + renderer/dist
pnpm --filter @ryagent/desktop start      # electron .（file:// 加载 renderer/dist）
```

数据目录默认 `app.getPath('userData')/ryagent-data`，可用 `RYAGENT_DATA_DIR` 覆盖；端口默认随机，可设 `RYAGENT_PORT` 固定。

## 使用要点

- **无 key 不崩**：设置面板会显示"⚠️ SiliconFlow：未配置 key——设置 SILICONFLOW_API_KEY 环境变量后重启"；发消息后的报错以错误横幅显示（来自 WS error 事件）。
- **@提及**：群聊输入框输入 `@` 弹出成员补全（↑↓ 选择、Enter/点击插入、Esc 取消）。
- **接力链**：dispatch 事件渲染为成员头像间的流转提示（如 `Ryen → @CodeBot · 转交`），护栏事件（loop-guard/max-turns）红色显示；右栏"调度轨迹"保留全部历史。
- **产物卡片**：produce-card 事件 → 文件卡片（文件名/大小/MIME），"打开"走 `/api/files/:name`。
- **Ryen 状态**：顶栏小猫在任意 agent 生成时转 thinking（星星旋转），全部完成时 happy 一下回 idle。

## 图标系统

`renderer/src/components/Icon.tsx`：22 个内联 SVG 图标（stroke 风格 1.8px、圆角线帽、
24 viewBox、currentColor），替代全部 emoji chrome（Windows 上 emoji 渲染成不一致
色块是界面最脏的元素）。覆盖：chat-bubble/users/cat-face/sun/moon/gear/search/send/
brain/plus/x/chevron-right/left/panel-right/copy/check/file/thumbs-up/down/at-sign/
group/pencil/alert。尺寸节奏：rail 22px、按钮 15-16px、输入区 16px。

## 测试

渲染层组件测试在 `tests/`（`@vitest-environment jsdom` pragma）：Cat 三态、头像注册表（≥12 个预置 SVG + key 唯一 + 兜底色块）、群聊九宫格布局（2/3/4/5/9 人规则）、主题切换、消息气泡/工具行/文件卡片/接力链渲染、@补全纯逻辑、ChatStore 事件折叠。由仓库根 `pnpm test` 统一跑。

## 设计系统

设计 token（暖琥珀浅色 + 暖黑暗色两套、4px 基栅、阴影 3 级、圆角/字号阶梯）与交互参数依据 `docs/research/warm-amber-chat-ui-design-spec.md`：`styles.css` 内 `:root[data-theme='light'|'dark']` 切换，「我的」页或 rail 底部按钮切换并持久化到 localStorage。

- **头像体系**：`renderer/src/components/avatars/` 预置 13 个同风格 SVG 头像（橘猫 Ryen/柴犬/狐狸/熊猫/兔子/猫头鹰/企鹅/仓鼠/考拉/机器人/龙/鹿/鲸鱼），Agent 的 `avatar` 字段存 avatarKey；未知 key 回退首字符暖色块；群聊为成员九宫格拼图（CSS Grid，微信规则）。
- **软件图标**：`assets/icon-master.svg`（squircle + 琥珀渐变 + 领结猫）经 `pnpm --filter @ryagent/desktop gen:icon`（sharp + png-to-ico）导出 16–1024 PNG 与 icon.ico；BrowserWindow 与 rail logo 均使用。
- **微交互**：hover 120ms、按压 scale(.97)、消息进入 fade+slide、typing 三点错峰、流式 40ms 批量重绘、距底 <100px 才自动跟随（否则浮出「跳至最新」）、骨架屏 shimmer、右栏展开/收起 200ms 过渡。

## 实测截图（逐页真机截取，docs/redesign-*.png）

- `redesign-01-chats.png`：聊天列表（群九宫格头像、未读徽标、猫管家口吻空态）。
- `redesign-01b-chats-dark.png`：暗色聊天列表（主题持久化生效）。
- `redesign-02-dm.png`：单聊（琥珀渐变气泡 + 方向直角、工具行、连续消息收紧、右栏资料卡 + 装饰环头像）。
- `redesign-03-group.png`：群聊浅色（接力链、成员网格、调度轨迹）。
- `redesign-04-contacts.png`：通讯录（SVG 头像卡片 + 模板区）。
- `redesign-05-me.png`：我的（主题切换、供应商 key 状态）。
- `redesign-06-dark.png`：暗色群聊（tonal elevation、降明度气泡暖白字、历史调度时间线）。
