# 前端评审报告：apps/desktop/renderer

- 评审日期：2026-10-12
- 范围：`apps/desktop/renderer`（src 下 14 个 ts/tsx + styles.css + index.html，逐文件通读）
- 分级：P0 = 正确性/安全/数据损坏；P1 = 明显性能/健壮性/UX 缺陷；P2 = 简洁性/一致性

## 结论速览

- **P0：0 ｜ P1：10 ｜ P2：14**
- 总体：代码整洁、设计 token 体系完整、XSS 面干净、纯逻辑可测，明显高于一般个人项目水准；但有若干**真实的交互缺陷**（Esc 关不掉补全菜单、旧会话发消息 turn 分组错乱、滚动跟随在流式中途失效、memo 被闭包完全击败），以及 a11y 与断网/断线状态的系统性缺口，离顶级开源项目主要差在这些"边角正确性"与防御性上。

---

## P0 发现

无。

XSS 专项审计：`dangerouslySetInnerHTML` 共 5 处——`Icon.tsx:89`（构建期静态 lucide SVG）、`WelcomeHome.tsx:72`（静态 fluent-emoji SVG）、`Cat.tsx:27`（纯字符串拼接的静态 SVG）、`Avatar.tsx:48` 与 `ContactsPage.tsx:51`（@dicebear 库生成，seed 只进 PRNG 哈希、不原文插值，且 parseAvatarSpec 校验 styleKey 白名单）。消息/记忆/手册等内容全部走 React 文本插值自动转义。**未发现注入路径。** index.html:7-10 的 CSP 把 connect-src 限定到 `127.0.0.1:*`，主进程（electron/main.ts:81）也确实只绑回环，两者吻合。

## P1 发现（正确性/性能/UX 缺陷）

### P1-1 旧会话里发消息，用户气泡与 agent 回复被分到不同 turn 组
- 证据：`ChatView.tsx:144` `store.addUserMessage(text, nextTurnIndex(snapshot.messages))` — `nextTurnIndex` 只统计**流式快照**（ChatView.tsx:276-278），不含 `history`。
- 影响：打开有历史的会话发第一条消息时，本地用户气泡 turnIndex=0（或 live max+1），而服务端 `message-start` 事件携带的 turnIndex 基于全量历史（如 5）。同一轮对话在 UI 上裂成两个 turn 块， RelayChain/时间分隔线错位；刷新后才恢复。
- 修复：`nextTurnIndex([...history, ...snapshot.messages])`。

### P1-2 流式中途滚动跟随失效 + smooth 滚动放大延迟
- 证据：跟随 effect 依赖为 `snapshot.messages.length`（ChatView.tsx:107）；`text-delta` 只追加到已有消息的 parts，`messages.length` 不变 → 长消息流式期间不再跟随。另 `styles.css:226` `.chat-scroll { scroll-behavior: smooth }` 使 `scrollTop = scrollHeight`（ChatView.tsx:105）变成动画，高频更新下持续追赶、明显滞后。
- 修复：effect 依赖改为 `snapshot.messages`（身份比较），程序化滚动用 `node.scrollTo({ top, behavior: 'instant' })` 或仅对"跳至最新"按钮保留 smooth。

### P1-3 @补全菜单 Esc 关不掉，且污染输入文本
- 证据：`ChatInput.tsx:73-75` Escape 分支插入 U+200B（零宽空格）期望使 `mentionQueryAt` 返回 null；但 `store.ts:261` 的判断是 `/[\s@]/`，JS 的 `\s` **不匹配** U+200B（已实测确认）→ 菜单不消失，文本里混入不可见字符并被一起发送。
- 修复：改用显式 dismissed 状态（如 `const [dismissedAt, setDismissedAt] = useState<number | null>(null)`，query 起点在 dismissedAt 之前不弹菜单），不要在文本里塞魔法字符。

### P1-4 「加载更早消息」在超过渲染上限后变成假按钮
- 证据：`ChatView.tsx:156` 恒取 `allMessages.slice(-150)`；`ChatView.tsx:188` 的按钮在 `history.length >= historyLimit` 时仍显示。当 `allMessages.length > RENDER_CAP` 时，把 historyLimit 从 150 加到 250，可视区仍是最后 150 条——点击毫无变化，只有"已省略 N 条"的数字变了。
- 修复：可见窗口与 historyLimit 联动，如 `slice(-Math.max(RENDER_CAP, historyLimit))`，或 RENDER_CAP 内直接不显示该按钮。

### P1-5 MessageBubble 的 memo 被父组件闭包完全击败
- 证据：比较器含 `prev.onFeedback === next.onFeedback && prev.fileUrl === next.fileUrl`（MessageBubble.tsx:154-155）；而 ChatView 每渲染都新建这两个闭包（ChatView.tsx:211、215）→ 比较器恒 false → 流式期间（40ms 一次通知）全部可见气泡重渲染并各自跑 `JSON.stringify(parts)`（MessageBubble.tsx:153）。memo 形同虚设。
- 修复：在 ChatView 用 `useCallback` 稳定 `fileUrl`/`onFeedback`（依赖 `api`、`conversation.id`），或从比较器中去掉函数 prop（用 ref 传递回调）。

### P1-6 WS 断线无任何感知与恢复
- 证据：`api.ts:215-221` 只挂 `onmessage`，无 `onclose/onerror`、无重连、无 UI 状态。后端（内嵌 server）重启或休眠后，界面静默卡死，typing 指示可能永久悬挂。
- 修复：ApiClient 暴露连接状态（store 增加 `connection` 字段），`onclose` 指数退避重连（带 jitter），聊天区显示可关闭的"连接已断开，正在重连…"横幅。

### P1-7 启动失败全屏错误没有重试入口
- 证据：`App.tsx:130-138` `loadError` 时渲染静态错误页，唯一出路是重启窗口；但 `refresh` 本就幂等可重试。
- 修复：错误页加「重试」按钮 `onClick={() => { setLoadError(undefined); setListLoading(true); void refresh() }}`，并保留首次加载的骨架屏而非直接跳错误页（减少启动闪断的惊吓）。

### P1-8 会话列表项与气泡操作条不可键盘访问
- 证据：`ConversationList.tsx:71-75` 会话项是 `<div onClick>`，无 `role`/`tabIndex`/键盘事件；`styles.css:267-274` `.bubble-actions` 仅靠 `:hover` 显形（opacity 0 + pointer-events none），键盘 Tab 聚焦到复制/反馈按钮时完全不可见。
- 修复：会话项改 `<button>` 或补 `role="button" tabIndex={0} onKeyDown(Enter/Space)`；CSS 加 `.bubble-row:focus-within .bubble-actions { opacity: 1; pointer-events: auto; }`。

### P1-9 弹窗缺 Esc 关闭 / 初始焦点 / 焦点圈禁
- 证据：`ContactsPage.tsx:326-338`（通用 Modal）、`MemoryPanel.tsx:57-84`、`PlaybookPanel.tsx:46-105` 均只有遮罩 onClick 关闭和一个关闭按钮，无 keydown 处理；打开后焦点留在触发元素，Tab 会逃出遮罩背后的页面。
- 修复：把 Modal 收敛成一个组件，统一实现 Esc 关闭、打开时聚焦第一个可交互元素、简单焦点圈禁（loop Tab）。

### P1-10 agent 回复无 Markdown 渲染，代码块/列表/链接呈原始文本
- 证据：消息文本直接 `<p className="bubble-text">{part.text}</p>`（MessageBubble.tsx:15），`white-space: pre-wrap` 保留换行；styles.css:246-251 定义了 `.bubble-text code/pre/a` 样式但**从未产生对应 DOM**（死样式）。对产品形态（写周报/跑命令/产出文件的 agent）这是与竞品的明显体验差距，长代码块无高亮无横向滚动容器语义。
- 修复：引入 react-markdown（默认转义、禁 raw HTML），代码块接轻量高亮；删除或接上现有的 code/pre CSS。

## P2 发现（简洁性/一致性）

1. **App 级订阅整棵组件树随流式重渲染**：`App.tsx:55` `useChat(store)` 让 App 每 40ms 重渲染（含 ConversationList、WelcomeHome）。修复：RightPanel 内自行 `useChat`，App 只传 `store`。
2. **绕过 useSyncExternalStore 的直读**：`App.tsx:230` `messages={[...store.getSnapshot().messages]}` 在 render 期命令式读 store（靠上一行的订阅"碰巧"正确）且每次新建数组。修复：直接用 `snapshot.messages`。
3. **错误横幅永不消除**：`store.ts:211-215` 写入 `error` 后没有任何清除路径（切会话 reset 除外）。修复：`message-start`/`queued` 或 send 成功时 `draft.error = undefined`。
4. **dispatch 历史竞态丢事件**：`store.ts:107-118` `setDispatchHistory` 全量覆盖 relays；WS 的 dispatch 若先于 HTTP 历史返回（subscribe 是同步的、HTTP 是异步的，顺序可能颠倒）会被抹掉。修复：合并去重（按 from/to/turnIndex+reason）或仅在 relays 为空时灌入。
5. **Avatar 的 useMemo 恒失效**：`Avatar.tsx:27-32` deps `[spec]` 每渲染都是新对象 → `dicebearSvg`（字符串生成 + 两次正则）每渲染每头像重算。修复：deps 改为 `[avatarKey]`，或直接 `parseAvatarSpec` 内联进第二个 memo。
6. **内联 callback ref 每渲染强制 reflow**：`ChatInput.tsx:114-117` 箭头函数 ref 每渲染触发 null→node，连带 `autoGrow` 读 scrollHeight。修复：用 `useCallback` 稳定 ref 函数，autoGrow 仅在 value 变化时跑（已是 onChange 里调）。
7. **useMemo 依赖恒新数组**：`ChatView.tsx:159-170` `turns` 的 deps `[visibleMessages]` 每渲染新身份，memo 无效。修复：在 useMemo 内基于 `snapshot.messages/history` 计算，或接受去掉 memo。
8. **Playbook 转正阈值双源**：`PlaybookPanel.tsx:59` 标题硬编码 `命中 {2} 次转正`，`:65` 又用 `reflection.hitCount/2`——服务端阈值变更即文案撒谎。修复：由服务端下发阈值，或提取常量 `PROMOTE_THRESHOLD`。
9. **魔法数字未入 token/常量**：`ChatInput.tsx:40` 的 `148` 与 `styles.css:369` 的 `max-height: 148px` 靠注释互相锁定；`MessageBubble.tsx:186` `90ms`、`store.ts:82` `40ms`、ChatView.tsx:44 `100`（有注释出处）；`RightPanel.tsx:150`、ContactsPage.tsx:130 等内联 style 魔法值。修复：进 CSS 变量或具名常量。
10. **语义色重复定义**：`styles.css:717` `.status-dot.ok` 硬编码 `#22C55E`，与 `--success`（:63/:89）并存；`:629` kind-preference 的 `#3B82F6/#60A5FA` 未进 token。修复：统一走 `--success`/`--info` 变量。
11. **数组索引作 key**：`MessageBubble.tsx:184`（relay）、`RightPanel.tsx:213`（relay-list）；`MessageBubble.tsx:101` part 的 `kind-index` 复合 key 在 tool 部件插入时会移位重挂（无本地状态，影响小）。修复：relay 用 `turnIndex:from:to:reason`，part 用 `kind-callId/index` 稳定组合。
12. **store 消息 key 细节**：`store.ts:196` message-done 换 key 用数组下标 `done:...:${index}`（remount 丢复制/反馈高亮瞬态，属可接受代价，但 index 入 key 易碰撞）；`store.ts:226` `user:${Date.now()}` 同毫秒两条消息 key 重复。修复：换 key 用消息内容哈希或单调计数器。
13. **CSP 可再收紧**：`index.html:9` `script-src 'self' 'unsafe-inline'`——Vite 产物为外联 module script，inline script 白名单非必需（style 需要，因 inline style 属性与 splash style）。修复：script-src 去掉 'unsafe-inline'，启动报错再按需回调试。
14. **未读徽标无封顶**：`ConversationList.tsx:85` 直接渲染 `unreadCount`，四位数会撑破徽标。修复：`unreadCount > 99 ? '99+' : unreadCount`。
15. **死代码/不可达表达式**：`ChatView.tsx:37` `text.split(':')[0] ?? 'tool'` 的 `??` 不可达；styles.css:311-318 `.relay-item` 整块无对应 DOM（被 `.relay-flow` 取代）；styles.css:222 `.chat-header-actions`、:597-599 `.provider-status` 无使用方；`ContactsPage.tsx:13-14` 重复 doc 注释行。修复：删掉。

## 做得好的地方

- **store 架构干净**：`ChatStore`（store.ts）是纯 TS 类，UI 通过 `useSyncExternalStore` 订阅，mutate 的浅拷贝语义清晰；`notify` 40ms 节流合并流式 token；@补全逻辑抽成纯函数（`mentionQueryAt`/`filterMentions`）且确实有测试覆盖（tests/mentions.test.tsx）。
- **XSS 面控制得好**：全部用户/服务端内容走 React 转义，innerHTML 仅限构建期静态资产与受白名单约束的库生成 SVG；CSP 限定回环地址且与主进程行为一致。
- **CSS token 体系完整**（色阶/间距 4px 基栅/圆角/字阶/动效时长），暗色模式用同一组变量覆盖、shadow 换明度递进并注释了方法论；19 个演进区块收尾一致，无明显暗色漏网（骨架 shimmer 有专门暗色覆盖 :560-562）。
- **UX 状态覆盖在国产同类项目里算全**：骨架屏、空态（猫管家口吻）、typing 指示、排队提示、跳至最新、加载更早、错误横幅、未读徽标都有；GroupAvatar 用纯 CSS Grid 实现微信式拼图头像，免 canvas。
- **effect 清理规范**：ChatView 的加载/订阅 effect（ChatView.tsx:77-99）有 cancelled 标志 + WS 退订；cat  mood 定时器有 clearTimeout（ChatView.tsx:127-135）；主题持久化有隐私模式 try/catch（App.tsx:20-28）。
- **memo 自定义比较器、RENDER_CAP 渲染上限、自动跟随阈值**等性能设计意图明确（尽管 P1-5 破坏了前者）。

## 与顶级开源项目的差距（总评）

1. **边角正确性**：turnIndex、Esc、加载更早、滚动跟随这 4 个 P1 都是"happy path 测试绿、真实使用必踩"的缺陷——顶级项目靠的不只是架构漂亮，而是这些边界都被显式处理。建议把 `nextTurnIndex`、`visibleMessages` 窗口计算、mention dismissed 状态抽成纯函数补测试（项目已有 vitest 基建，成本很低）。
2. **防御性**：WS 断线、启动失败重试、error 清除这类"坏天气"路径目前全部缺席；桌面应用长驻进程，断线重连应该是 P1 优先级。
3. **可访问性**：div-onClick、hover-only 操作、无 Esc/焦点管理的弹窗——需要一次系统性的 a11y pass（改动量都不大）。
4. **渲染富文本**：不渲染 Markdown 对 LLM 聊天产品是硬伤；接入 react-markdown 时保持"默认转义"即可延续现有 XSS 记录。
