# 类微信 AI 多 Agent 桌面社交应用 — UI 设计规范调研报告

> 调研日期：2026-10-11 ｜ 技术栈：Electron + React ｜ 主题：暖色琥珀（Warm Amber）
> 调研对象：微信 / Telegram / Discord / LINE / ChatGPT / Claude / Kimi / 豆包（2024–2026 版本及设计资料）
> 关键来源汇总见文末「来源清单」。

---

## 0. 竞品结论速览

| 产品 | 导航形态 | 消息列最大宽 | 气泡策略 | 可借鉴点 |
|---|---|---|---|---|
| 微信（桌面） | 左侧栏（手机端为底部 tab：聊天/通讯录/发现/我） | ~全宽 | 绿底白字 vs 白底黑字，方向性圆角 | 信息架构、方向性圆角、九宫格群头像 |
| Telegram Desktop | 三栏（文件夹栏+列表+聊天） | 全宽可选 | 圆角气泡、云背景 | 三栏桌面骨架、圆形头像、在线状态点 |
| Discord | 三栏（server rail + 频道栏 + 内容） | 全宽 | 无边框消息流 + 圆润化改版 | 最左 rail 图标导航、暗色优先 |
| ChatGPT / Claude | 左侧会话栏 + 中央对话列 | **约 768px**（两家一致） | 用户右对齐 / AI 左对齐，弱气泡化 | 对话列限宽、流式渲染、消息状态机 |
| Kimi / 豆包 | 移动：左滑抽屉（Kimi）/ 底部 tab（豆包） | 屏宽 85% | 圆角气泡 + 颜色区分 + 品牌头像 | 品牌拟人形象、语音/悬浮入口 |

核心共识（[wangjianqi/AppStore《构建AI对话界面》](https://github.com/wangjianqi/AppStore/blob/main/02-AI%E9%A9%B1%E5%8A%A8%E5%BC%80%E5%8F%91/%E6%9E%84%E5%BB%BAAI%E5%AF%B9%E8%AF%9D%E7%95%8C%E9%9D%A2.md)、[Setproduct AI chat UI 指南](https://www.setproduct.com/blog/ai-chat-interface-ui-design)）：**AI 居左、用户居右、底部输入框、流式输出** 已是用户心理模型，应遵循；AI 对话列需限宽（长文本超过 ~768px 不可读）。

---

## 1. 布局骨架建议

### 1.1 取舍：底部导航 vs 侧边栏

**结论：桌面端一律侧边栏，不做底部 tab。** 依据：

- 所有桌面 IM/AI 产品（Telegram Desktop、微信桌面版、Discord、ChatGPT/Claude/DeepSeek 桌面端）均为左侧导航或左列表+右内容的双栏/三栏结构；底部 tab 是移动端模式（微信手机端四 tab、豆包底部 tab），在宽屏上浪费纵向空间且与「会话列表+对话窗」双栏模式冲突（[IntuitionLabs 2025 对比](https://intuitionlabs.ai/articles/conversational-ai-ui-comparison-2025)、[Discord 2025 改版分析](https://whop.com/blog/discord-new-design/)）。
- 微信的信息架构（聊天/通讯录/我）在桌面上应映射为**最左垂直 icon rail**，而不是底部横排——这是 Discord 的 guild rail 与微信桌面版左侧图标的共同做法。

### 1.2 推荐三栏骨架（像素级）

```
┌────────┬──────────────┬──────────────────────────────────┐
│ 72px   │ 300–320px    │  自适应，消息列内部限宽 768px      │
│ icon   │ 会话列表 /    │  ┌────────────────────────────┐  │
│ rail   │ 通讯录 / 我的 │  │ 消息流（max-width: 768px）  │  │
│        │ （可切换）    │  └────────────────────────────┘  │
│ 聊天💬  │              │  底部输入区（吸底，随内容增高）     │
│ 通讯录👥│              │                                │
│ 我的🐱  │              │                                │
└────────┴──────────────┴──────────────────────────────────┘
```

- **栏 1（rail，72px）**：微信三大 tab 的桌面映射 = 聊天 / 通讯录 / 我的 + 底部设置。入口用 24px 图标 + 12px 文字，激活态 = 琥珀主色 + 左侧 3px 指示条。
- **栏 2（列表栏，300–320px）**：随栏 1 切换内容（会话列表 / 通讯录分组 / 个人中心摘要）。支持折叠到 0px（ChatGPT 式可折叠侧栏，[IntuitionLabs](https://intuitionlabs.ai/articles/conversational-ai-ui-comparison-2025)）。
- **栏 3（内容区）**：消息流列居中并限宽 `max-width: 768px`（ChatGPT 与 Claude.ai 均约 768px，[Setproduct](https://www.setproduct.com/blog/ai-chat-interface-ui-design)）；输入区吸底，多行 textarea 自动增高到 6 行后内部滚动。
- **响应式降级**：窗口宽 < 900px 时隐藏 rail，栏 2 以抽屉形式浮出；< 720px 时才允许出现底部 tab（手机窗口场景）。
- **三栏参照 Telegram Desktop** 的「文件夹栏 + 会话列表 + 聊天」三栏（[Telegram-iOS bubbles 源码解析](https://itnext.io/source-code-walkthrough-of-telegram-ios-part-6-bubbles-836b61759bdf) 佐证其气泡/列表数据模型设计）。

### 1.3 信息架构数据结构

```ts
type NavSection = 'chats' | 'contacts' | 'me';

interface Conversation {
  id: string;
  kind: 'dm' | 'group' | 'agent';       // agent = AI Agent 会话
  title: string;
  avatarUrl: string | null;             // null → 走九宫格/首字符生成
  memberIds: string[];                  // kind === 'group' 时用于拼图
  lastMessage?: { text: string; at: number; senderName?: string };
  unreadCount: number;
  pinned: boolean;
  muted: boolean;
  agentState?: 'idle' | 'thinking' | 'streaming' | 'error'; // AI 特有
}

interface Contact {
  id: string; name: string; avatarUrl: string | null;
  online: boolean; kind: 'human' | 'agent';
  agentPersona?: { emoji: string; model: string; capabilities: string[] };
}
```

---

## 2. 色彩系统（暖琥珀）

### 2.1 色板（可直接落为 CSS Token）

主色阶梯采用 Tailwind/Radix 的 amber 步阶（[Figma Amber](https://www.figma.com/colors/amber/)、[Radix Colors 步阶说明](https://colorvio.com/radix-colors)）：

| Token | 色值 | 用途 |
|---|---|---|
| `--amber-50` | `#FFFBEB` | 高亮底色、选中行浅底 |
| `--amber-100` | `#FEF3C7` | hover 底色、标签底 |
| `--amber-200` | `#FDE68A` | 边框强调、disabled 主按钮 |
| `--amber-300` | `#FCD34D` | 深色模式主色（提亮保对比） |
| `--amber-400` | `#FBBF24` | 浅色模式渐变起点 |
| `--amber-500` | `#F59E0B` | **主色**：激活 tab、发送按钮、链接 |
| `--amber-600` | `#D97706` | hover/pressed、渐变终点 |
| `--amber-700` | `#B45309` | 主色上的文字、focus ring |

### 2.2 浅色模式背景层次

| Token | 色值 | 用途 |
|---|---|---|
| `--bg-app` | `#FAF7F2` | 窗口底色（暖白，避免纯白刺眼） |
| `--bg-surface` | `#FFFFFF` | 列表栏、卡片、对方气泡 |
| `--bg-subtle` | `#F3EFE7` | 分组标题底、嵌入区块 |
| `--bubble-self` | 渐变 `135deg #FBBF24 → #F59E0B` | 自己/Agent 主动方气泡（文字 `#3D2E12` 深棕，不用纯白，暖色上白字对比不足） |
| `--bubble-peer` | `#FFFFFF` | 对方气泡（边框 `1px #EDE7DB`） |
| `--text-primary` | `#292524` | 正文（warm stone-800） |
| `--text-secondary` | `#78716C` | 时间戳/副文本 |
| `--border-subtle` | `#E7E0D3` | 分割线 |

依据：[Bricx Labs 16 条聊天 UI 模式](https://bricxlabs.com/blogs/message-screen-ui-deisgn) 建议暗灰蓝气泡 + 白字的高可读组合、非纯白底色；[ihatecolors 暖土色系板](https://ihatecolors.com/palette/burnt-sienna)（`#FFF8F0` 底 + `#CC5500` 强调）验证暖底+深棕文字的舒适性；微信自用绿 `#95EC69` 深字 `#000`（[美图设计室对微信气泡观察](https://www.designkit.cn/article/wxltbjzmhghk20250624)）说明**彩底配深字**是成熟做法。

### 2.3 暗色模式策略（Material 高度叠加法，不用纯黑）

参照 [Uxcel 12 条暗色原则](https://uxcel.com/blog/12-principles-of-dark-mode-design-627) 与 [Material 暗色指南](https://paletacolorpro.com/en/dark-mode-guide)：

| Token | 色值 | 推导 |
|---|---|---|
| `--bg-app` | `#171310` | 暖调近黑（`#121212` 基础上加暖） |
| `--bg-surface-1` | `#FFFFFF` 叠 5% → `#221E1A` | 列表栏 |
| `--bg-surface-2` | 叠 8% → `#2A2521` | 气泡、卡片 |
| `--bg-surface-3` | 叠 12% → `#332D28` | 悬浮面板、输入框 |
| `--amber-primary` | `#FCD34D`（amber-300） | 深底上 amber-500 对比度不足，按 Material 规范提亮一档 |
| `--text-primary` | 白 87% → `#E8E4DF` | 纯白在深底出现光晕 |
| `--text-secondary` | 白 60% / 38% | 次级/禁用 |
| `--bubble-peer` | `#2A2521` | 对方气泡用 surface-2 |
| `--bubble-self` | 渐变 `#B45309 → #92400E` 或纯色 `#D97706` + 白字 | 暗色下主色气泡降明度 |

规则：阴影在暗色下失效，层级全靠**表面明度递进（tonal elevation）**表达（[Material 3 做法](https://www.skillsdirectory.com/skills/intense-visions-design-elevation-shadow-e842c850)）；语义色：成功 `#4ADE80`、错误 `#F87171`、在线 `#22C55E`。所有正文对比度 ≥ 4.5:1（WCAG AA，[Bricx Labs](https://bricxlabs.com/blogs/message-screen-ui-deisgn)）。

### 2.4 Token 文件形状（CSS Variables）

```css
:root[data-theme='light'] { --bg-app: #FAF7F2; --amber-primary: #F59E0B; /* … */ }
:root[data-theme='dark']  { --bg-app: #171310; --amber-primary: #FCD34D; /* … */ }
```

主题切换用 `data-theme` 属性 + CSS 变量，跟随系统（`prefers-color-scheme`）并可手动覆盖（[深色模式跟随系统实践](http://www.wsjz.net/news/1299.html)）。

---

## 3. 字体与排版规范

### 3.1 字体栈

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI",
             "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
--font-mono: "JetBrains Mono", "SF Mono", Consolas, monospace;
```

### 3.2 字号阶梯（桌面 @1x）

| 级别 | px | 行高 | 用途 |
|---|---|---|---|
| `text-xs` | 12 | 16 | 时间戳、未读徽标内文字、在线状态 |
| `text-sm` | 13 | 18 | 列表副标题、消息状态（已读/发送中） |
| `text-base` | 14 | 20 | UI 基准：按钮、菜单、输入框 |
| `text-body` | 15 | 24 (1.6) | **消息正文**（中文长文行高 1.6–1.7 更透气） |
| `text-md` | 16 | 22 | 列表主标题（会话名、联系人名） |
| `text-title` | 20 | 26 | 聊天标题栏、分组标题 |
| `text-display` | 24 | 30 | 「我的」页用户名等 |

依据：聊天正文 15px/1.6 是微信/Telegram 桌面实际观感；[Freshdesk 字号规范](https://help-shopcircle.freshdesk.com/support/solutions/articles/19000171336-typography-spacing)（base 14px、小字 12px）；行高分级 [Coder Carl 设计 token](https://codercarl.dev/blog/design-system/utility-tokens)。

### 3.3 消息气泡几何

| 属性 | 值 | 说明 |
|---|---|---|
| 气泡最大宽（IM 场景） | 用户 75%、对方 75%（纯人对人）；AI 消息 85% | [wangjianqi 对比表](https://github.com/wangjianqi/AppStore/blob/main/02-AI%E9%A9%B1%E5%8A%A8%E5%BC%80%E5%8F%91/%E6%9E%84%E5%BB%BAAI%E5%AF%B9%E8%AF%9D%E7%95%8C%E9%9D%A2.md)；内容列整体再限 768px |
| 气泡圆角 | 16px，**方向性直角**：自己=右下 4px，对方=左下 4px | 微信式方向圆角逻辑（[淘宝江湖气泡对齐规则](https://jianghu.taobao.com/detail/47729_77179010)、[纯 CSS 圆角气泡实现](https://www.cnblogs.com/web1/p/9325070.html)） |
| 气泡内边距 | `10px 14px` | Bricx 建议上下 20/15 偏大方，聊天场景收敛为 10/14 |
| 连续消息 | 同 sender 相邻气泡间隙 2px，首个气泡上间距 12px | 微信/Telegram 连续气泡收紧规则 |
| 气泡与头像间距 | 8px；头像 40px | 见第 4 节 |
| 消息行间距 | 同组 4px，异组 16px | — |
| 输入框圆角 | 12px，min-height 40px，max-height 6 行 |  |

### 3.4 间距节奏

4px 基栅：`--space-1:4 / 2:8 / 3:12 / 4:16 / 5:20 / 6:24 / 8:32`。卡片内边距 16/20，列表项高度 64（48px 头像 + 16 上下留白），分隔线 1px `--border-subtle`。

---

## 4. 头像体系设计

### 4.1 尺寸与形状

| 场景 | 尺寸 | 形状 |
|---|---|---|
| 消息流内 | 40×40 | 圆形（Telegram/Discord/ChatGPT 惯例） |
| 会话/联系人列表 | 48×48 | 圆形 |
| 通讯录分组页 | 40×40 | 圆形 |
| 「我的」页 | 64×64（展开 80） | 圆形 + 2px 装饰环 |
| 设置页/关于 | 96×96 | 圆角矩形 20px（与 App icon 同形） |

微信用圆角矩形、Telegram/Discord 用纯圆——**圆润亲和的「猫管家」气质选纯圆**，设置页回归圆角矩形呼应品牌。

### 4.2 在线状态点

- 位置：头像右下；直径 = `clamp(10px, 0.25 × avatar, 14px)`；**2px 底色描边**与头像分离。
- 颜色：在线 `#22C55E`，忙碌 `#F59E0B`，离线 `#9CA3AF`（或头像降 40% 饱和度表达，桌面常省略离线点）。
- 可访问性：颜色 + 形状双编码（在线=实心圆点，忙碌=实心琥珀点，离线=空心环），符合状态指示需多重要素的 WCAG 要求（[Bricx Labs 状态指示模式](https://bricxlabs.com/blogs/message-screen-ui-deisgn)）。

### 4.3 群聊九宫格拼图（实现算法）

微信规则：2 人=左右各半；3 人=品字形（上一居中、下二）；4 人=2×2；5–9 人=3×3 取前 N 格；>9 取前 9。

```tsx
// GroupAvatar.tsx — React + CSS Grid 实现，免 canvas
const LAYOUT: Record<number, string[]> = {
  1: ['1 / 1 / 2 / 2'],
  2: ['1 / 1 / 2 / 2', '1 / 2 / 2 / 3'],
  3: ['1 / 1 / 2 / 3', '2 / 1 / 3 / 2', '2 / 2 / 3 / 3'], // 品字
  4: ['1/1/2/2', '1/2/2/3', '2/1/3/2', '2/2/3/3'],
  // 5..9: 3×3 grid，前 N 格按微信对角优先顺序填充
};
function GroupAvatar({ members, size = 48 }: { members: Contact[]; size?: number }) {
  const n = Math.min(members.length, 9);
  const grid = LAYOUT[n] ?? grid9(n);
  return (
    <div style={{ display: 'grid', width: size, height: size, gap: 2,
                  background: 'var(--bg-subtle)',
                  borderRadius: '50%', overflow: 'hidden' }}>
      {members.slice(0, 9).map((m, i) => (
        <img key={m.id} src={m.avatarUrl ?? fallbackChar(m.name)}
             style={{ gridArea: grid[i], width: '100%', height: '100%',
                      objectFit: 'cover' }} />
      ))}
    </div>
  );
}
```

- 用 `gap: 2px` + `background: var(--bg-subtle)` 产生拼图缝隙。
- 无头像成员用首字符色块兜底（`name.charCodeAt(0) → 12 色暖色环`），与单聊生成式头像逻辑复用。
- 依据：[Atlassian Avatar Group](https://atlassian.design/components/avatar-group)（网格最多 11 个）、[Preline facepile](https://preline.co/docs/components/avatar-group.html)。

### 4.4 头像数据结构

```ts
interface AvatarSpec {
  url: string | null;          // null → 生成式首字符头像
  fallbackSeed: string;        // name 或 id，决定字符与颜色
  presence?: 'online' | 'busy' | 'offline';
  composite?: string[];        // 群聊：成员 avatar url 列表（前 9）
}
```

---

## 5. 微交互清单

| 交互 | 规格 | 出处 |
|---|---|---|
| 列表项 hover | bg → `--amber-50`（暗色 `--bg-surface-2`），transition 120ms ease-out | 通用模式 |
| 按钮按压 | `whileTap={{ scale: 0.97 }}`，弹簧 `stiffness: 400, damping: 17`（framer-motion） | [Framer Motion 实践](https://ui-incubator.com/en/blog/framer-motion-landing-page) |
| 消息进入 | 新消息 `opacity 0→1 + translateY(8px→0)`，200ms；自己刚发的气泡加 `scale 0.95→1` 150ms | 通用；动画只动 transform/opacity（GPU 合成） |
| 消息操作条 | hover 气泡浮现复制/重生成/分支按钮；移动端常显 | [Setproduct](https://www.setproduct.com/blog/ai-chat-interface-ui-design) |
| Typing 指示器 | 三点跳动（`scale 0.6→1` 错峰 300ms 循环）；typing 事件 2 秒节流，停止输入 3s 后自动清除 | [Bricx Labs](https://bricxlabs.com/blogs/message-screen-ui-deisgn)、[Conferbot](https://www.conferbot.com/glossary/term/typing-indicator)、[Supademo 20 例](https://supademo.com/blog/micro-interaction-examples) |
| 骨架屏 | 会话列表 6 行 shimmer（1.5s 渐变平移）；AI 排队态用**脉冲单点/单 shimmer 行**，禁止假进度条 | [Setproduct 消息状态机](https://www.setproduct.com/blog/ai-chat-interface-ui-design) |
| 流式渲染 | token 30–60ms 批量重绘；增量 Markdown，代码块闭合前按纯文本渲染、闭合后二遍语法高亮；流式中 auto-scroll 仅当视口距底 <100px，用户上滑即锁定位并浮出「跳至最新」 | [Setproduct 流式深潜](https://www.setproduct.com/blog/ai-chat-interface-ui-design) |
| 页面转场 | 栏 2 的列表切换 fade 150ms；聊天切换 slide-x 200ms + fade；用 `AnimatePresence` 处理卸载 | [Framer Motion 指南](https://refine.dev/blog/framer-motion/) |
| 列表重排 | 新消息顶置用 framer-motion `layout` 动画，禁止生硬跳变 | [Framer Motion layout 动画](https://thewebdev.info/2020/10/24/framer-motion%E2%80%8A-%E2%80%8Aanimation-sequence-and-layout-animations/) |
| 消息状态机 UI | `queued(脉冲点) → thinking(可折叠思考区) → streaming(caret 闪烁) → complete(显示操作+时间) → error(具体原因+单恢复动作) → stopped(标记中断+继续/重生成)` | [Setproduct](https://www.setproduct.com/blog/ai-chat-interface-ui-design) |

---

## 6. 现代感的具体来源（及 Electron 实现成本）

1. **玻璃拟态（毛玻璃）**：`backdrop-filter: blur(16px) saturate(160%) brightness(105%)` + `background: rgba(255,255,255,0.12)` + 1px 半透明描边（[Mironsoft backdrop-filter 实践](https://www.mironsoft.de/en/blog/css-backdrop-filter-frosted-glass-effects)）。
   - **成本**：`backdrop-filter` 走 GPU 合成，静态使用开销低（[designmonks Liquid Glass 分析](https://www.designmonks.co/blog/liquid-glass-vs-glassmorphism)）；**禁止在玻璃层上做位移动画**——模糊重绘昂贵（[uxpilot 12 条 Glassmorphism 准则](https://uxpilot.ai/blogs/glassmorphism-ui)）。
   - **必须背后有视觉内容**才出效果——平背景上玻璃是隐形的（[miguelacm 玻璃拟态误区](https://miguelacm.es/en/blog/glassmorphism-css-backdrop-filter)）。建议只在**标题栏、悬浮「跳至最新」按钮、Agent 卡片弹层**三处使用。
   - **Electron 落地**：Chromium 完整支持 `backdrop-filter`；Windows 下大面积模糊 + 滚动有掉帧风险，聊天长列表**不要用玻璃容器包裹滚动区**。macOS 追求原生感可用 `BrowserWindow` 的 `vibrancy: 'sidebar'`；Windows 纯 CSS 即可。2026 趋势是「液态玻璃」（[TRAE 社区 Electron 案例](https://forum.trae.cn/t/topic/45301)、[locionic 2026 指南](https://www.locionic.com/en/blog/modern-css-glassmorphism-tailwind-guide)），但桌面端建议克制，避免廉价感。
2. **渐变**：仅两处——主按钮/自己气泡（`135deg #FBBF24→#F59E0B`）与登录/空状态插画。全屏大渐变已过时，且与「类微信」的克制气质冲突。
3. **阴影层级**（浅色模式 3 级 token）：
   ```css
   --shadow-1: 0 1px 2px rgba(69,42,6,.06), 0 1px 3px rgba(69,42,6,.10); /* 卡片 */
   --shadow-2: 0 4px 8px rgba(69,42,6,.08), 0 2px 4px rgba(69,42,6,.06); /* 悬浮按钮/Popover */
   --shadow-3: 0 12px 24px rgba(69,42,6,.12), 0 4px 8px rgba(69,42,6,.08); /* 模态/抽屉 */
   ```
   暗色模式阴影不可见，层级改用表面明度递进（tonal elevation，见 2.3）。
4. **圆润化**：Discord 2025 改版整体加大圆角与对比度，是「现代感」最直接的来源（[Whop 改版分析](https://whop.com/blog/discord-new-design/)）；WhatsApp 2026 也在把气泡改圆、去边框化（[WABetaInfo](https://wabetainfo.com/whatsapp-brings-modern-design-to-message-bubbles-on-ios/)）。建议气泡 16px、卡片 12–16px、窗口圆角 12px（Electron `roundedCorners: true`）。

---

## 7. 软件图标设计建议（猫管家主题）

- **方向**：Big Sur 式 squircle 圆角矩形底板（macOS/iOS 已统一 squircle，[Apple HIG App Icons](https://developer.apple.com/design/human-interface-guidelines/app-icons)），内部「戴管家领结的猫」半身剪影——琥珀渐变底（`135deg #FBBF24 → #D97706`）+ 白色猫形 + 深棕 `#3D2E12` 领结/眼睛细节；Windows/托盘 16–32px 小尺寸另备剪影优先的圆形简化版。
- **落地规格**：母版 1024×1024 PNG，关键元素收在 90% 安全区；导出 `.ico`（Windows 16–256）、`.icns`（macOS）、256/512 PNG（Linux/About 页）。注意：**只有 iOS 会自动裁圆角**；桌面端图标不会被系统裁切，想要圆角矩形必须自己画进源图（[iconikai Electron 图标指南](https://www.iconikai.com/blog/electron-app-icon-generator-guide)、[Setapp 图标制作](https://setapp.com/how-to/change-app-icons)）。
- **检查**：16×16、32×32 下猫的耳朵与领结必须仍可辨识——小尺寸剪影优先，细节（胡须、领结纹路）只留大版本（[macOS 图标经验](https://www.quora.com/How-can-I-make-icons-in-Photoshop-for-OS-X)、[PTGConnect 图标准则](https://ptgconnect.com/icon-guidelines)）。
- **加分项**：AI Agent 的「正在思考」状态可投射到托盘图标（琥珀色呼吸点），与应用内在线状态体系呼应（参照豆包桌面悬浮球作为服务状态可视化投射的思路，[CSDN 豆包悬浮球分析](https://codearts.csdn.net/6a9118f43bda720d4b343463.html)）。

---

## 8. 来源清单

1. [Setproduct — Designing AI chat interfaces: Anatomy, patterns, pitfalls](https://www.setproduct.com/blog/ai-chat-interface-ui-design)（消息状态机、768px 限宽、流式规则、auto-scroll 100px 规则）
2. [IntuitionLabs — Comparing Conversational AI Tool UIs 2025](https://intuitionlabs.ai/articles/conversational-ai-ui-comparison-2025)（ChatGPT/Gemini/Claude/Poe/DeepSeek 布局与侧栏）
3. [wangjianqi/AppStore — 构建 AI 对话界面](https://github.com/wangjianqi/AppStore/blob/main/02-AI%E9%A9%B1%E5%8A%A8%E5%BC%80%E5%8F%91/%E6%9E%84%E5%BB%BAAI%E5%AF%B9%E8%AF%9D%E7%95%8C%E9%9D%A2.md)（ChatGPT/Claude/豆包/Kimi 模式对比表、气泡 75%/85%、方向性直角）
4. [Bricx Labs — 16 Chat UI Design Patterns](https://bricxlabs.com/blogs/message-screen-ui-deisgn)（暗色对比度、typing 2s 节流、状态指示 WCAG）
5. [Whop — Discord 2025 新设计](https://whop.com/blog/discord-new-design/) / [nexu-io Discord DESIGN.md](https://github.com/nexu-io/open-design/blob/main/design-systems/discord/DESIGN.md)（三栏、暗色优先、圆润化）
6. [ITNEXT — Telegram-iOS Bubbles 源码解析](https://itnext.io/source-code-walkthrough-of-telegram-ios-part-6-bubbles-836b61759bdf)（气泡数据模型）
7. [Sketch App Sources — iOS WeChat UI Kit](https://www.sketchappsources.com/free-source/1933-wechat-ui-kit-sketch-freebie-resource.html?source=post_page---------------------------)（微信四 tab 信息架构）
8. [企业微信深色模式色值表](https://developer.work.weixin.qq.com/document/path/94594)（官方暗色 token 先例）
9. [Uxcel — 12 Principles of Dark Mode Design](https://uxcel.com/blog/12-principles-of-dark-mode-design-627) / [Paletacolorpro Dark Mode Guide](https://paletacolorpro.com/en/dark-mode-guide)（12% 叠加、87% 文字、#121212）
10. [Figma Colors — Amber](https://www.figma.com/colors/amber/) / [ColorVio — Radix Colors](https://colorvio.com/radix-colors) / [Media.io Amber Palette](https://www.media.io/color-palette/amber-color-palette.html)（琥珀色值）
11. [Mironsoft — backdrop-filter 实践](https://www.mironsoft.de/en/blog/css-backdrop-filter-frosted-glass-effects) / [uxpilot Glassmorphism](https://uxpilot.ai/blogs/glassmorphism-ui) / [miguelacm 玻璃拟态误区](https://miguelacm.es/en/blog/glassmorphism-css-backdrop-filter) / [designmonks Liquid Glass](https://www.designmonks.co/blog/liquid-glass-vs-glassmorphism) / [TRAE 社区 Electron 液态玻璃案例](https://forum.trae.cn/t/topic/45301)
12. [Atlassian Avatar Group](https://atlassian.design/components/avatar-group) / [Preline Avatar Group](https://preline.co/docs/components/avatar-group.html)（群头像网格）
13. [Conferbot — Typing Indicator](https://www.conferbot.com/glossary/term/typing-indicator) / [Supademo — 20 Micro-interactions](https://supademo.com/blog/micro-interaction-examples)
14. [Framer Motion 指南 refine.dev](https://refine.dev/blog/framer-motion/) / [ui-incubator Framer Motion 实践（stiffness 400, damping 17）](https://ui-incubator.com/en/blog/framer-motion-landing-page) / [Framer Motion layout 动画](https://thewebdev.info/2020/10/24/framer-motion%E2%80%8A-%E2%80%8Aanimation-sequence-and-layout-animations/)
15. [Apple HIG — App Icons](https://developer.apple.com/design/human-interface-guidelines/app-icons) / [iconikai Electron 图标指南](https://www.iconikai.com/blog/electron-app-icon-generator-guide) / [PTGConnect 图标准则](https://ptgconnect.com/icon-guidelines) / [Setapp 图标制作](https://setapp.com/how-to/change-app-icons)
16. [Muzli — Chat UI 灵感 2026](https://muz.li/inspiration/chat-ui/) / [Mobbin Web Chat 设计](https://mobbin.com/explore/web/screens/chat-detail) / [Medium — How to Design a Modern Chat App UI](https://medium.com/@abubakrranao43/how-to-design-a-modern-chat-app-ui-e5316ffc60d8)（底部导航适用场景）
17. [WABetaInfo — WhatsApp 气泡现代化](https://wabetainfo.com/whatsapp-brings-modern-design-to-message-bubbles-on-ios/)（圆润无边框趋势）
18. [人人都是产品经理 — Kimi/豆包插件体验报告](https://www.woshipm.com/evaluating/6084791.html) / [mysecretrainbow — AI 对话产品分析](https://www.mysecretrainbow.com/report/32501.html) / [CSDN — 豆包桌面悬浮球分析](https://codearts.csdn.net/6a9118f43bda720d4b343463.html)（豆包底部 tab、输入区、悬浮球）
