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

## 测试

渲染层组件测试在 `tests/`（`@vitest-environment jsdom` pragma）：Cat 三态、消息气泡/工具行/文件卡片/接力链渲染、@补全纯逻辑、ChatStore 事件折叠。由仓库根 `pnpm test` 统一跑。

## 实测截图（M4b 验证时真机截取）

- `docs/screenshot-main.png`：三栏主界面（空状态，暖色琥珀系）。
- `docs/screenshot-contacts.png`：通讯录页（Ryen 卡片，猫 SVG 头像渲染正常，建群/新建 Agent 入口）。
