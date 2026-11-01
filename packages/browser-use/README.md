# `@ryharness/browser-use`

让助理能**开网页、点东西、读内容**。

这个包给的是「怎么驱动一个浏览器」的**接口与流程**：驱动接口、会话管理、安全边界、三个模型工具。

## 它不自带浏览器

**这个包里没有 Playwright、没有 puppeteer、没有任何原生模块。** 原因很直接：

- Playwright 要拖几百 MB 的浏览器二进制。装成包依赖，等于每个用这个包的人都付这份代价，而实际用得上的场景（本机装、容器装、接远端 CDP）又各不相同；
- 上游 dsh 的 `browser-use` 也是同样的选择——它自己只有 2 个源文件、2KB，内容是**接口声明**，真正的后端由用户自己接（上游把它叫 provider）。

所以分工是：**驱动归宿主，契约归包**。宿主接上自己的驱动实现 `BrowserDriver`，这个包负责归属、边界、生命周期。

## 装上

```bash
pnpm add @ryharness/browser-use
```

零 workspace 依赖，可以单独装、单独测。

## 用起来

### 1. 接一个驱动

```ts
import type { BrowserDriver } from '@ryharness/browser-use'

const driver: BrowserDriver = {
  name: 'playwright',
  async open(url) { /* 打开这一页 */ },
  async click(selector) { /* 点元素 */ },
  async type(text) { /* 打字 */ },
  async screenshot() { return { bytes, mimeType: 'image/png' } },
  async readText() { return '页面正文' },
  async close() { /* 关掉这一页 */ },
}
```

**一个驱动实例对应一个标签页。** 驱动接口里的 `open(url)` 是「把这一页导航到某个地址」，没有「第几个标签页」这层意思——多个标签页就是多个驱动实例。这样切分之后，上层不用认识 Playwright 的 Page / Context / Browser 三层结构。

### 2. 起一个会话服务

```ts
import { BrowserSessionService } from '@ryharness/browser-use'

const service = new BrowserSessionService({
  driverFactory: () => createDriver(),
  policy: { allowFormSubmit: false, allowDownload: false, allowPrivateNetwork: false },
})

const session = await service.open('agent-1', 'https://example.com/')
await service.act('agent-1', session.id, { kind: 'click', selector: '#more' })
const page = await service.read('agent-1', session.id, 'text')
```

### 3. 注册模型工具

```ts
import { createBrowserTools } from '@ryharness/browser-use'

for (const tool of createBrowserTools(service)) ctx.tools.register(tool)
```

三个工具：

| 工具 | 干什么 |
|---|---|
| `browser_open` | 开一个网页，返回会话 id |
| `browser_act` | 做一件事：`click` / `type` / `submit` / `download` |
| `browser_read` | 读当前页面正文，或截当前页面的图 |

## 安全边界

判定全在服务层，模型工具与宿主直调走同一条路——同一个地址在两条路上必须得到同一个答案。

| 边界 | 默认 | 放行开关 |
|---|---|---|
| 只允许 http/https | 开 | 无（`file:` / `ftp:` / `data:` 一律拒） |
| 不访问本机与内网 | 开 | `allowPrivateNetwork` |
| 不自动提交表单 | 开 | `allowFormSubmit` |
| 不自动下载文件 | 开 | `allowDownload` |

**默认关着不是保守，是让「谁放开的」留在配置里可查。**

### 哪些动作危险

| 动作 | 为什么危险 |
|---|---|
| `submit` 提交表单 | 提交等于替用户按下那个按钮——发出去的消息、提交的订单都算 |
| `download` 下载文件 | 下载会往磁盘上写东西，写到哪儿、叫什么名字不由模型定 |

被拦下时模型拿到的是结构化错误 `ACTION_NOT_ALLOWED`，消息里写清了要放行哪个开关。

### 私网口径

判定口径与 `packages/web` 一致（同一份私网段位清单、同一套协议白名单）：环回、10/8、172.16/12、192.168/16、169.254/16、::1、::、IPv4-mapped 形式全部挡掉。

**但为什么自己写一份而不用 `packages/web` 的？** 那个包的闸是为「自己抓 HTTP」设计的——它把校验放行的 IP 钉在连接上、每跳重定向重来一遍。而这里驱动的是**别人写的浏览器**：连接发生在浏览器进程里，我们既钉不住 IP，也看不见重定向。能做的只有「动手之前先看一眼这个地址安不安全」——这是一道**前置闸**，不是连接级闸。混用会给出「已经防住了」的错觉。

**已知边界**：前置判定挡不住 DNS rebinding。浏览器自己会解析 DNS，中间仍可能换成内网地址。要彻底防住需要浏览器侧配合（比如让驱动只连已校验的 IP），那是宿主接驱动时的事。

## 会话

- **owner 隔离**：逐字比对，`"a"`、`"a "`、`"A"` 是三个不同的 owner。不存在的会话与别人的会话对外是同一句「没有这个会话」——不泄露 id 是否存在。
- **有界**：一个会话最多 4 个标签页，一个 owner 最多 8 个会话。不设上限的话，模型可以在一个会话里开出一堆标签页把内存吃光。
- **每步超时**：默认 15 秒。超时按结构化错误报回去，模型看得见「这一步没成」。
- **用完能收干净**：`close()` 关掉所有标签页的驱动；`disposeAll()` 把所有会话收掉，一个失败不影响别的。

## 没装驱动时的行为

调用会得到结构化错误 `NO_DRIVER`，**不会假装操作成功**。

```ts
import { createUnavailableBrowserDriver } from '@ryharness/browser-use'

const driver = createUnavailableBrowserDriver()
// driver.open(...) → BrowserUseError { code: 'NO_DRIVER' }
```

理由：宿主还没接驱动是**常态**，不是异常。常态就该有一条明确的路径。如果这时候返回空截图、空白正文，模型会拿着空白页继续推理，把「没驱动」误当成「页面是空的」——那比直接报错糟得多。

## 公开 API

| 导出 | 一句话 |
|---|---|
| `BrowserSessionService` | 会话服务：owner 隔离、有界、超时、结构化失败、收尾 |
| `createBrowserTools` | 造齐三个模型工具 |
| `createBrowserOpenTool` | 造 `browser_open` |
| `createBrowserActTool` | 造 `browser_act` |
| `createBrowserReadTool` | 造 `browser_read` |
| `createUnavailableBrowserDriver` | 降级驱动：每个方法都报 `NO_DRIVER` |
| `emptyBrowserScreenshot` | 空截图（空字节 + 明确 mime） |
| `assertNavigableUrl` | 校验一个地址能不能用（协议 + 私网） |
| `judgeHost` | 判定一个主机名能不能去（public / private / unknown） |
| `isPrivateAddress` | 这个地址是不是本机或内网 |
| `defaultResolveHost` | 默认主机名解析器（node:dns） |
| `BrowserUseError` / `isBrowserUseError` | 错误类型与码判定 |

类型：`BrowserDriver`、`BrowserFormSubmitter`、`BrowserDownloader`、`BrowserDriverFactory`、`BrowserOwner`、`BrowserPolicy`、`BrowserAction`、`BrowserActionKind`、`BrowserSessionView`、`BrowserTabView`、`BrowserScreenshot`、`BrowserReadResult`、`BrowserTextResult`、`BrowserImageResult`、`BrowserTool`、`BrowserToolContext`、`BrowserToolResult`、`BrowserToolsOptions`、`BrowserSessionServiceOptions`、`BrowserUseErrorCode`、`HostResolver`、`HostVerdict`。

## 错误码

`NO_DRIVER`、`NO_SESSION`、`SESSION_CLOSED`、`TAB_LIMIT`、`SESSION_LIMIT`、`TIMEOUT`、`DRIVER_FAILED`、`UNSAFE_URL`、`PRIVATE_ADDRESS`、`ACTION_NOT_ALLOWED`、`UNSUPPORTED_ACTION`、`INVALID_ARGUMENT`、`CLEANUP_FAILED`。

码是稳定的，宿主按码分流，不去匹配文案（文案会改，码不会）。

## 测试

```bash
npx vitest run packages/browser-use
```

61 条用例，覆盖：协议白名单、私网拦截（含 IPv6 与 IPv4-mapped）、解析失败按不许处理、owner 隔离与围栏逐字比对、标签页与会话上限、超时、危险动作被拦、放行后动作真的执行、驱动不支持时报 `UNSUPPORTED_ACTION`、没装驱动如实报错、收尾与关不掉时的 `CLEANUP_FAILED`、降级驱动的每个方法都失败。
