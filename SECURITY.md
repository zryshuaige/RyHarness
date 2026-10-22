# 安全策略

RyHarness 是**单机**桌面应用：后端只监听回环地址，数据落在本机 `%APPDATA%/ryharness-data`，
但它同时持有用户的 LLM API key 与文件系统工具权限，因此安全问题值得认真对待。

## 支持范围

| 版本 | 是否接收漏洞报告 |
|---|---|
| `0.1.x`（当前开发线） | 是 |
| 旧提交 / 无 tag 的快照 | 否，请先切到最新 master 复现 |

## 怎么报告

**请不要开公开 issue。** 公开报告等于在修复发布前把漏洞细节交给所有人。

1. 首选仓库的私密漏洞通道：GitHub 页面 → **Security → Report a vulnerability**
   （仓库发布后生效，会自动生成私密 advisory 线程）。
2. 若该通道未启用：按仓库主页公示的维护者联系方式，**直接私信发送补丁或复现步骤**。

收到报告后的节奏：确认收到 ≤ 3 个工作日；给出修复或缓解方案 ≤ 14 天；
修复发布后再公开细节（给报告者留出披露时间）。

## 报告里请包含

- 受影响版本（commit / tag）与运行环境（Windows 版本、Node、pnpm）。
- 复现步骤或最小复现代码。
- 影响面：是否可越权访问本地文件、泄漏 `userData` 里的会话与记忆、泄漏 API key、
  渲染层注入（XSS）、提权等。
- 你已知的缓解办法。

## 我们承诺

- 确认收到后会把修复提交进 `master`，并在 [CHANGELOG.md](./CHANGELOG.md) 的
  `Security` 小节记录。
- 修复发布后按 CVSS 评估：中高危以上会申请 CVE，并在 advisory 里引用。
- 不公开报告者的身份。

## 本地自查要点

- 别把 `.env`（含 API key）提交进仓库；仓库根 `.env` 已在 `.gitignore`。
- 截图别整屏抓：`scripts/capture-window.ps1` 只截窗口矩形，避免把桌面上的私人信息拍进
  提交与 issue。
- 打包分发时必须随包附 `LICENSE` 与 `NOTICE.md`（`build.extraResources` 已自动处理）。

## 本地攻击面：回环 API 与凭据

桌面版的后端固定监听 `127.0.0.1:32100`（跨启动稳定的 origin 为了 HTTP 缓存），
而工具白名单里含「执行命令」。**回环地址不是鉴权**：同一台机器上的任何进程都能
直接连过来发指令。我们按下面三道闸处理，请你排障时也按这个前提：

1. **一次性 token**：主进程每次启动生成 256 位随机 token，后端在 HTTP 中间件与
   WebSocket upgrade 两处强制校验，缺失或不符一律 401。token 只经启动通道注入
   渲染层，不落盘、不进命令行、不进日志。
2. **Origin 白名单**：跨源页面（浏览器发起的请求）除非来自回环地址否则一律 403；
   WebSocket 握手同样校验。
3. **凭据加密**：`config/api-keys.json` 在桌面端经 Electron `safeStorage`（Windows
   DPAPI / macOS Keychain）加密，文件被拷走也解不开；文件权限仍是 0600。
   没有 Electron 的环境（独立开发进程、CI、测试）**明确降级**为明文 + 0600 并在
   日志里说明，不会静默假装已加密。

> 已知的取舍：独立启动后端（`pnpm --filter @ryharness/server dev`）默认不鉴权——
> 它是开发入口，不随安装包分发。发布版**一定**走上面的 token 通道。给独立进程开鉴权：
> `RYHARNESS_API_TOKEN=<任意串> pnpm --filter @ryharness/server dev`。

## 已知漏洞与缓解措施

| 项 | 状态 | 缓解 |
| --- | --- | --- |
| Electron 37.10.2 — 11 条 high（Chromium 层：沙箱绕过、UAF、协议处理器跨源等） | 已修 | 升级到 44.7.2（当前最新稳定版），`pnpm audit --audit-level=high` 归零 |
| extract-zip 2.0.1 — 2 条 high（符号链接路径穿越导致任意文件写） | 已修 | 随 Electron 升级改用 `@electron-internal/extract-zip`，该包不再出现在依赖图里 |
| `@dicebear/initials`、sprintf-js — moderate | 接受 | 前者只用于渲染层画内置头像（数据来自内置模板，不接受外部输入）；后者是构建期依赖，不进安装包 |

依赖审计是**硬门禁**：`ci.yml` 与 `release.yml` 都执行 `pnpm audit --audit-level=high`
且没有 `continue-on-error`。新引入的 high/critical 会同时挡住 CI 与发版。
发现已发布版本存在未覆盖的漏洞时，请按上面的私密通道报告。
