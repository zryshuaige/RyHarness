# 贡献指南

感谢参与 RyAgent。本文覆盖环境、复现步骤与代码约定；提交前请逐条走「提交前检查」。

## 环境（Windows-first）

RyAgent 是 Windows 桌面应用，**请在 Windows 10/11 上开发与验证**（主进程、截图脚本、
NSIS 打包都以 Windows 为基准）。跨平台改动请在 PR 里说明你在哪个平台验证过。

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | `^22.19 \|\| >=24` | 持久化用内置 `node:sqlite`，更低版本没有该模块 |
| pnpm | `11`（根 `package.json#packageManager` 已钉） | 建议 `corepack enable` 后由 corepack 接管版本 |
| Git | 任意近期版本 | 主线分支是 **master** |

首次安装若 Electron 二进制下载卡住，可设镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

## 从零复现

```sh
corepack enable
pnpm install
pnpm -r build        # vendor 用 tsc，packages 用 tsdown，desktop = tsdown + vite
pnpm typecheck       # 先构建 vendor 再跑根 tsc，严格模式
npx vitest run       # 根 vitest.config.ts 是唯一 runner（包级没有 test 脚本）
pnpm --filter @ryagent/desktop dev   # 起桌面应用（Vite HMR + Electron）
```

需要配置 LLM key 才有完整对话链路：把 `SILICONFLOW_API_KEY` 放进用户环境变量，
或放在仓库根 `.env`（已 gitignore，从仓库根启动的脚本会读）。**不要**把 key 写进代码、
测试夹具或截图。

## 代码约定

- **格式与静态检查**：biome（`biome.json`，行宽 120、单引号、分号 asNeeded、尾逗号 all）。
  不要手改格式，`npx biome check --write <文件>` 让工具来。
- **类型**：TypeScript 严格模式。渲染层/主进程/内核共用 `tsconfig.base.json`；
  新增类型导出前先想清楚它是不是公共 API。
- **注释写「为什么」，不写「做了什么」**：解释取舍、边界与历史坑（例如 150% DPI 下
  `workAreaSize` 返回物理像素这类踩过的雷），不复述代码本身。
- **命名**：文件 kebab-case、组件 PascalCase、常量 UPPER_SNAKE；
  中英混排处中文用全角标点，代码标识符一律英文。
- **测试**：新功能与 bugfix 都要有测试，放对应包的 `tests/`；组件测试用
  `// @vitest-environment jsdom` pragma。不要为了让测试变绿去改断言的语义。
- **依赖**：新增运行时依赖前先确认能不能自写；确需引入第三方资产时，
  **必须同步更新根 `NOTICE.md`**（来源、许可、署名要求）——这是发布前的硬性检查。
- **不要提交**：本机截图、`.env`、`release/`、构建产物（`main/`、`dist/`）。

## 提交前检查

```sh
npx biome check .
pnpm typecheck
npx vitest run
```

三项全绿再提 PR。PR 描述请写清：改了什么、为什么、怎么验证的（贴命令与结果），
涉及 UI 的附上**窗口内**截图（用 `scripts/capture-window.ps1`，不要整屏截图）。

## 行为准则

参与即同意 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。安全问题请按
[SECURITY.md](./SECURITY.md) 私密报告，不要开公开 issue。
