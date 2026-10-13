# 十维度复评任务书（配额恢复后直接执行）

用法：把这 10 条分别作为 `Agent(subagent_type="explore")` 的任务并发执行；每条都要求
"先看 docs/review3/ 下的最新截图与当前代码，不要复述上一轮结论"，拿到结果后我汇总成
第二轮评分表，未达 8/10 的维度进入下一轮修复。

通用前缀（每个任务都带上）：

> 你是世界级 <领域> 专家，对开源项目 RyAgent 做严格复评（只读，不改任何代码）。
> 项目根 F:\AgenticResearch\RyAgent（Electron + React + Node/SQLite 的社交化多 Agent 助理）。
> 最新界面截图：docs/review3/*.png（务必逐张看）。历史对照：docs/review2/shots/。
> 上一轮结论在 docs/review/ 与本文件末尾的"上一轮问题"，**不要复述已有结论**，
> 只给增量判断。输出：总分(1-10) + 分项评分表 + P0/P1/P2 清单（每条带 file:line
> 或截图证据）+ 与顶级产品的差距 + 按性价比排序的改进建议。中文 1200 字内，严格打分。

## 十个维度

1. **产品**：核心闭环（创建→对话→群聊→记忆/进化反馈）成立度、首启体验、差异化表达、半成品功能。
2. **视觉设计**：色彩/留白/圆角阴影边框/字阶/组件一致性（看 styles.css + styles-product.css + 截图）。
3. **交互动效**：进出场完整性、spring 曲线、列表布局动画、骨架屏/空态/错误态、键盘与焦点、prefers-reduced-motion。
4. **品牌图形**：橘猫三视图一致性、头像族收敛（dylan/mascot）、图标尺寸网格、emoji 残留、NOTICE 署名。
5. **内核性能**：首 token 路径（recall‖compile）、工具并行、历史裁剪、群聊 fan-out、取消链路、usage 管道。
6. **前端性能**：store 定点拷贝与 version 比较器、App 退订、分包与缓存、首屏时间、长会话窗口策略。
7. **后端代码简洁性**：三处 dotenv 是否已统一、死代码（llm 包 117 导出）、vendor fork 代价、错误处理一致性、模块边界。
8. **前端代码简洁性**：组件粒度、styles.css 自覆盖是否清完、重复模式、类型质量、hooks 规范。
9. **记忆与进化前沿性**：Curator 是否拿到条目列表（update/deprecate 是否真的生效）、衰减基准、抽取 few-shot、embedding 溯源、检索相关性门控。
10. **工程与开源质量**：测试覆盖与类型、lint、CI、文档与开发者上手、打包分发、许可合规。

## 上一轮问题清单（供增量对照）

- 产品：模板轨假按钮、无 agent 编辑删除、首启必炸、进化不可见
- 视觉：小圆角/满屏边框/泥巴棕暗色主色/徽标对比度 1.6:1/右栏金黄横条/虚线 motif 四处
- 动效：零退场动画、全线性曲线、无 prefers-reduced-motion、气泡 hover 位移、焦点环缺失
- 品牌：四只不同的猫、Fluent Emoji 当图标、6 族头像混搭、Lucide 尺寸不在网格
- 内核：单聊零裁剪、工具串行、recall‖compile 串行、usage 断头、无取消、群聊全串行
- 前端：每 token 全量拷贝、JSON.stringify 比较器、message-done 换 key、App 级订阅、1.27MB 内联单包、无虚拟化
- 后端：写死 SiliconFlow、117 个零消费导出、vendor 纯改名 fork、三处 dotenv、包布局不一致
- 前端代码：styles.css 11 处自覆盖、死样式、Record<string, unknown> 逃逸、TOOL_LABELS 重复
- 记忆进化：Curator 收不到条目、衰减用 updatedAt、抽取过度保守、embedding 无模型溯源、无相关性门控
- 工程：无 CI、无打包分发、上游残留注释、文档滞后

## 本轮已落地（复评时应视为已修，除非发现没修对）

- 内核：工具并行、recall‖compile、AbortSignal 全链路、历史裁剪、群聊 fan-out(并发 3)
- 记忆/进化：Curator 传入条目、衰减改 lastAccessedAt+accessCount、抽取 few-shot+相似度兜底、
  embedding 缓存加 model 溯源、Reflector 相关性门控、教训按相关性注入、归档策略
- 服务端：记忆/进化 LLM 配置驱动（消灭写死）、CORS 预检、cancel 端点、api-key 端点、WS delta 合批
- 前端：store 定点拷贝 + version 比较器、Markdown memo、App 退订、右栏自订阅、error 可清除
- 桌面：渲染层改由回环 HTTP 伺服（index.html 1.35MB → 2.86KB，恢复分包与缓存）、窗口并行启动、
  隐藏原生菜单栏、窗口尺寸适配工作区（含 150% DPI 单位探测）
- 产品：模板轨传参、弹窗可滚动+操作条吸底、agent 编辑/删除、首启 API Key 配置卡、
  停止生成按钮 + 已用时、toast 反馈可见化、供应商行可展开配置、左栏空态引导
- 品牌：统一几何橘猫、头像收敛 2 族 + 懒加载、图标网格、emoji 退场（新增 clipboard-list/mail/calendar-days）