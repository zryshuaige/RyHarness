# 安全策略

RyAgent 是**单机**桌面应用：后端只监听回环地址，数据落在本机 `%APPDATA%/ryagent-data`，
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
