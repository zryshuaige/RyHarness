# @ryharness/spill

溢出文本：**工具结果太长时，原文落到模型看不见的地方，模型只拿到一段预览加一个定位符。**

一次 `shell_exec` 吐出十万字符，模型的历史就被这一条塞满了——后面每一轮都在为它付钱，窗口还会被它挤掉。溢出做的事很直白：把原文存到本机文件里，给模型回一段「前 N 字预览 + 一个 id」，模型真想看全文时，自己拿着 id 分页取。

本包零 workspace 依赖：它不认识 agent、不认识会话循环、不碰工具表。**存下来**与**取回去**归它，**什么时候该溢出**由宿主在工具执行链路上决定。

## 三块

| 模块 | 做什么 | 关键入口 |
|---|---|---|
| `local.ts` | 本机私有文件存储 | `LocalSpillStore` |
| `policy.ts` | 工具结果策略（纯函数） | `applySpillPolicy` / `SpillPolicy` |
| `tools.ts` | 取回工具 | `createSpillReadTool` |

### 存储

```ts
import { LocalSpillStore } from '@ryharness/spill'

const store = new LocalSpillStore({ dataDir: '/path/to/dataDir' })

const ref = store.store('一万字的工具结果…', { sessionId: 'conv-1', tool: 'shell_exec' })
// ref.id          → 取回用的定位符
// ref.chars       → 原文多长
// ref.retrieval   → 「调用 spill_read，参数 id="…"」
```

落盘长这样：

```
<dataDir>/spills/<会话slug>/<id>.txt          正文
<dataDir>/spills/<会话slug>/<id>.meta.json     元信息（会话、来源工具、时间）
```

会话 slug 是「可读前缀 + 会话 id 的哈希」：前缀方便人排查，哈希保证两个清洗后重名的会话 id 不会落进同一个目录。目录与文件都用 `0700 / 0600` 建（POSIX 上生效）。

**隔离**：取回时按目录核对会话归属。别的会话拿着同一个 id 取不到，调用方没有会话上下文时也取不到归属会话的那部分。没有归属会话（`meta.sessionId` 缺省）的文本落在 `_shared/`，靠 id 本身当钥匙。

**容量**：单条上限 8 MiB、总量上限 64 MiB（都可配）。超了**报错**（`SpillError`，码 `CAPACITY_EXCEEDED`），不悄悄截断——上层据此决定是保留原文还是换预览。

**清理**：`store.cleanup()` 删掉过期（默认 7 天）的；`store.cleanup({ sessionId, olderThanMs: 0 })` 清空某个会话的；`store.remove(ref)` 删一条。清理会返回清掉几条、腾出多少字节。

### 策略

```ts
import { applySpillPolicy } from '@ryharness/spill'

const outcome = applySpillPolicy(
  { text: toolResult.content, tool: 'shell_exec' },
  { store, maxInlineTokens: 2000, sessionId: 'conv-1' },
)

if (outcome.spilled) {
  // 模型看到的是「前 2000 字预览 + 定位符 + 怎么取回」
  modelContent = outcome.content
} else {
  // 没超限，或者压根没溢出成——原样给
  modelContent = outcome.content
}
```

三条口径：

- **阈值内原样返回**：一个字都不改。
- **只对纯文本生效**：看着像 JSON 且真能解析的（`{"a":1}`、`[1,2]`）算结构化结果，不溢出——压掉它的前缀等于把结果改坏了。宿主明确知道结果类型时可以用 `plainText: false` 直接说。
- **存不下就保留原文**：存储抛错时 `content` 原样返回（`failure` 里写原因），`spilled` 为 false。宁可这一轮把上下文撑爆，也不能让模型什么都拿不到。

阈值两个都给时取更小的那个；`maxInlineChars` 直接按字符算；`charsPerToken` 缺省 4。什么都不给时用 2000 token（≈8000 字符）。

### 取回工具

```ts
import { createSpillReadTool } from '@ryharness/spill'

const tool = createSpillReadTool({ store, maxChars: 4000 })
// tool.name === 'spill_read'
```

模型拿着定位符调用它取回原文：

```json
{ "id": "sp_l3k2j_9f8c1a2b3c4d", "offset": 4000, "limit": 4000 }
```

一次只给一段（缺省 4000 字符），页脚写清「第几页 / 共几页 / 接着取的 offset」——不给下一步的起点，模型就只会取一次。会话归属由存储层核对，工具自己不鉴权。

## 服务端接线

插件文件在 `apps/server/src/plugins/spill.ts`，它注册：

- 工具 `spill_read`（模型自己取回原文）；
- 路由 `GET /api/spills/:id`（界面按定位符读原文，回 JSON：`{ id, chars, createdAt, text }`）。

依赖由宿主注入：

```ts
spillPlugin({
  store,                       // 组合根创建的那一份存储
  resolveSessionId: (req) => ...,  // 从请求里解析会话 id；不给就只有 _shared 里的能读
  maxReadChars: 4000,
})
```

## 边界（这一包不做什么）

- **不做压缩**：上游 dsh 用 zstd 压溢出的文本。我们不压——溢出文本要能被人直接打开看，压缩让排查变麻烦。
- **不做代际文件轮转**：上游按代次换目录，我们只有一层。
- **不做启动时清理**：上游有「启动清理旧溢出文件」这一步。我们提供 `cleanup()`，什么时候调由宿主决定。
- **不做 retention 模块**：上游把「留多久、怎么清」单独拆成一层。我们把它并进了存储的 `cleanup()`。
- **不做多模态结果的溢出与恢复**：上游对图片/二进制结果有单独的路径与恢复机制。我们只认「纯文本 / 不是纯文本」，不是纯文本的一律不溢出（也不给预览）。
- **不认识 agent 与会话循环**：本包不 import `@ryharness/agent`，也不决定工具结果从哪来。策略是纯函数，由宿主接到工具执行链路上。

## 与上游 dsh 的差距（逐条）

上游 dsh 把它拆成三个包：`spill/`（存储服务）、`spill-local/`（本机文件后端）、`spill-policy/`（工具结果策略）。我们合成一个包、三个模块，职责对齐：

| 上游 | 本包 | 差在哪 |
|---|---|---|
| `spill/` 存储服务（`SaveTextSpill` / `SpillRef`） | `SpillStore` / `SpillRef` | 语义对齐：存下超长文本、返回定位符与取回指引。少了上游那种「注册成 cordis 服务（`ctx.spillStore`）」的装配方式——本包是普通类，宿主创建并注入。 |
| `spill-local/` 本机文件后端 | `LocalSpillStore` | 会话私有目录、总量/单条上限都有。**少了 zstd 压缩**、**少了代际文件轮转**、**少了启动时自动清理**。 |
| `spill-policy/` 工具结果策略 | `applySpillPolicy` / `SpillPolicy` | 「超 `maxInlineTokens` 就换预览 + 定位符」「存失败保留原文」「只对纯文本生效」三条都做了。**少了独立的多模态溢出/恢复路径**（我们直接把非纯文本结果判为不溢出），**少了单独的 retention 模块**。 |
| `context/session-reference` 直接复用存储 | 没做 | 上游把截断的会话记录也交给同一套存储处理（自己的一套预览与失败提示）。我们这轮没接——`packages/context` 是别的 lane 在写的，接线归主控。 |

## 用法小结

```ts
// 组合根
const store = new LocalSpillStore({ dataDir })

// 工具执行链路上（宿主接）
const outcome = applySpillPolicy(
  { text: result.content, tool: result.toolName },
  { store, maxInlineTokens: 2000, sessionId: ctx.conversationId },
)

// 服务端插件
spillPlugin({ store, resolveSessionId: (req) => req.query.get('session') ?? undefined })
```
