# @ryharness/web

模型的「查一下」与「打开看看」：两个能力，两份边界。

- **web_search**：在互联网上搜，返回若干条结果（标题、链接、摘要）。后端可插拔——可配置的 JSON 接口，或匿名抓一个搜索结果页；两条路给模型的形状一样。
- **web_fetch**：抓一个 URL，转成正文文字。协议白名单、私网拒绝、逐跳重定向复核、连接钉在已校验的地址上、响应体与正文都有上限、默认 10 秒超时。

这一包是**纯函数 + 配置**：不注册工具、不认识 cordis。宿主拿 `createWebSearchTool` / `createWebFetchTool` 造出工具，注册进自己的工具表即可。工具的形状与 `@ryharness/agent` 的 `Tool` 结构兼容，`ctx.tools.register(tool)` 直接能收。

## 怎么配

配置是纯数据（`WebConfig`），可以直接进 JSON 配置文件：

```jsonc
{
  "search": {
    "backend": "api", // 'api' | 'html'
    "api": {
      "endpoint": "https://api.example.com/search?q={{query}}",
      "headers": { "Authorization": "Bearer <key>" },
      "method": "POST",
      "bodyTemplate": { "query": "{{query}}", "top_k": 5 },
      "resultPath": "data.results" // 结果数组在回包里的位置
    },
    "timeoutMs": 10000,
    "maxResults": 5
  },
  "fetch": {
    "timeoutMs": 10000,
    "maxBytes": 2097152,
    "maxChars": 20000
  }
}
```

**接口后端（`backend: 'api'`）**：`endpoint` 写 `{{query}}` 占位就替换成搜索词，不写就把搜索词放进 `queryParam`（默认 `q`）。给了 `bodyTemplate` 却不写 `method` 时按 POST 走，模板里的 `{{query}}` 会被替换。`resultPath` 不填就按常见形状依次找：`data`、`results`、`items`、`webPages`、`organic_results`、`value`、`hits`。一条结果里的标题、链接、摘要分别按候选字段名找（标题：`title`/`name`/`heading`/`label`；链接：`url`/`link`/`href`/`source_url`/`displayUrl`；摘要：`snippet`/`description`/`content`/`summary`/`abstract`/`text`/`body`/`passage`），链接写成对象（`{ href }`）也认。

**结果页后端（`backend: 'html'`）**：匿名抓一个搜索结果页，从 `<a href>` 里取链接与标题：

```jsonc
{
  "search": {
    "backend": "html",
    "html": { "endpoint": "https://html.duckduckgo.com/html/?q={{query}}" }
  }
}
```

结果页那一侧**没有摘要**：各家的排版没有共同约定，摘要放在标题旁边、下一段还是 data 属性里都有，猜错一种就会把导航链接也当成结果。所以只有标题与链接，包着的跳转链接（例如 `//duckduckgo.com/l/?uddg=…`）会被解开。

## 边界

与 apps/server 的 `read_url` 插件同一套口径：

- **协议**：只允许 http/https。file:/ftp:/javascript: 一律拒。
- **私网**：字面地址与 DNS 解析结果都必须落在公网。127/8、10/8、172.16/12、192.168/16、169.254/16、0/8、::1、::、fc00::/7、fe80::/10 与 IPv4-mapped 形式全部挡掉。`localhost` 与 `*.localhost` 不查 DNS 就拒。解析结果里**只要有一个**落在内网，整条就拒——让 DNS 挑就等于把选择权交给攻击者。
- **逐跳复核**：重定向自己跟，不用 `redirect: 'follow'`。只有自己跟，才能在**发出下一跳之前**复核目标，而不是等请求已经打到 127.0.0.1 之后再回头看最终 URL。每一跳都重新校验、重新钉地址，最多 5 跳。
- **钉 IP**：校验放行的那次解析结果就是连接目标。连接时写的是字面 IP（net 层对字面地址不做 DNS），TLS 的 SNI 与 Host 头仍按原域名走（否则虚拟主机与 CDN 认不出请求）。就算哪一层又把域名拿回来解析，交出去的地址也仍然只有已校验的那一个——这就是 DNS rebinding 堵住的地方。
- **限额**：默认 2MB 响应体、20000 字正文、10 秒超时（整条抓取共用一个计时器，不是每跳各算一遍）。超了会截断，并在正文末尾写明截断了多少，模型才知道自己看到的不是全文。
- **错误**：全部是中文。协议不对、私网、解析失败、HTTP 状态不对、超时各有各的一句话；底层冒出来的意外异常（socket hang up 之类）只回一句中文摘要，原始异常留在 `cause` 里给宿主记日志——模型不需要看到英文异常，也省得它把报错当成网页内容继续推理。

私网判定与逐跳复核都有测试钉住，含「域名解析到私网要被拒」与「重定向到私网要在下一跳之前被拦」两个用例。

## 为什么是重写的一份，不是直接依赖 `apps/server` 的 web-read

那份是服务端插件（`apps/server/src/plugins/web-read.ts`），import 它会让这个包反过来依赖 apps/server，依赖方向反了；而且它的判定会跟着服务端插件一起改，这里要的是一份能被单独测试、单独复用的判定。

两边的**规则一样，实现不同**：那边把地址折成四段数字再逐条 if 判断，这边先折成 32 位数比区间，IPv6 走自己展开 `::` 的解析（于是 `::ffff:127.0.0.1` 这种压缩写法也能判准）。判定口径必须一致——同一台机器上「read_url 放行、web_fetch 拒绝」这种事没法排查。

## 与上游 dsh 的差别

**做了**：搜索/抓取服务层该有的东西——选后端、统一的结果形状、统一的中文错误；`web_fetch-http` 那条匿名抓取；`tool-web` 那两个模型可见工具（做成工厂，注册归宿主）。

**没做**：

- **具体厂商的接入**（Exa / Perplexity / DeepSeek Search+Fetch）。取而代之的是那个「可配置的通用 JSON 接口」：厂商的字段名候选是**按常见写法猜的列表**，没有逐个厂商对着回包校准过。接某个具体厂商时，字段名可能要往候选里补。
- **cordis 服务（`ctx.web`）与插件注册**。这里是函数式的：选后端靠配置，注册靠宿主。
- **按 URL 的策略**（比如按站点定制规则、按模型返回不同粒度）。上游 dsh 自己也声明这一族「不用于交互式浏览、内容抽取、按 URL 的策略执行」，我们这轮也没做。
- **供应商级的配额与可用性判断**（某个 key 今天的额度、某个后端是不是挂了）。本包只负责把后端换掉，额度归宿主管。

## 用法

```ts
import { createWebFetchTool, createWebSearchTool } from '@ryharness/web'

const config = { search: { backend: 'api', api: { endpoint: 'https://api.example.com/search' } } }

ctx.tools.register(createWebSearchTool(config))
ctx.tools.register(createWebFetchTool(config))
```

也可以只用纯函数：`webSearch(config.search, '关键词')` 与 `webFetch('https://example.com/a')`。两个函数抛的是 `WebError`，消息就是给模型看的中文。
