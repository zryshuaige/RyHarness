# Changelog

本文件记录本项目所有值得注意的变更。格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

暂无。

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
