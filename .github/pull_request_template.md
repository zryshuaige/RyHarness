<!--
改了什么、为什么、怎么验证，三件事都要有。CI 会在 Windows 上跑：lint → build → typecheck →
test → coverage → audit → guardrails，模板里留的勾选项就是那些步骤。
-->

## 改了什么

<!-- 一两句写清这组改动想解决什么问题。 -->

## 为什么

<!-- 链接到 issue，或说明这是评审结论 / 缺陷修复的哪一条。 -->

## 怎么验证

- [ ] `npx biome check .`（0 error）
- [ ] `pnpm typecheck`
- [ ] `npx vitest run`
- [ ] `pnpm verify`（类型逃逸 / 包依赖 / 重复代码 / lint 棘轮四条自研门禁）
- [ ] 涉及 UI：附上**窗口内**截图（`scripts/capture-window.ps1`，不要整屏截图）

<!-- 上面勾选的命令请把实际输出贴进 PR 正文，绿勾不算证据。 -->

## 风险与回滚

<!-- 改了什么默认行为、数据迁移、打包配置、依赖树；能一键回滚吗？ -->

## 截图

<!-- 贴这里。确认画面里没有 API key、token、通知、聊天工具等私人信息。 -->
