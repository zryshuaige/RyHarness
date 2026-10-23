# RyHarness

[English](README.md) | 中文

## 这是什么

**定位**：**人格**是第一卖点——四维性格、亲密度、生日与**首次相遇**这些关系养成才是主角，
Agent 内核只是让它们能干活的地基。

RyHarness 不是"一个通用助手 + 一个输入框"。它更像**一群有人格、有记忆、会互相搭话的
助理**：像微信里的联系人那样和你相处，也像工作伙伴一样把东西做出来交给你。

<img src="apps/desktop/docs/capture.png" width="900" alt="RyHarness 聊天界面" />

数据全在本机。会话、文件、记忆、API Key 都落在你的磁盘上；应用只通过回环接口访问模型
供应商，还带一次性 token。

## 开发者预览

RyHarness 还年轻，改动很快。**会有破坏兼容性的变更。** 升级前先备份数据目录。

## 跑起来

### 直接下载（Windows）

发布页给三种版本。便携版 exe 什么都不用装：

| 文件 | 大小 | 你要做的 |
|---|---|---|
| `RyHarness-portable.exe` | 117 MB | 双击就行。不安装、不解压。 |
| `RyHarness-win-x64.zip` | 149 MB | 解压一次，以后双击里面的 `RyHarness.exe`，启动更快。 |
| `RyHarness Setup 0.1.0.exe` | 118 MB | 常规安装包，想要就装。 |

三个都不写注册表、不装服务。数据放在 `%APPDATA%\RyHarness\ryharness-data\`。

### 从源码跑

需要 Node `^22.19` 或 `>=24`（持久化用的是内置的 `node:sqlite`）、pnpm 11。

```sh
git clone https://github.com/zryshuaige/RyHarness.git
cd RyHarness
pnpm install
pnpm build
pnpm --filter @ryharness/desktop start
```

`pnpm --filter @ryharness/desktop dev` 是带热重载的开发模式。

接着配一个模型供应商：首屏会先让你挑一家（SiliconFlow / DeepSeek / Moonshot / 智谱 GLM /
MiniMax / OpenRouter / OpenAI / Ollama），挑完再填那家的 API Key——存进系统密钥库，不写进
任何配置文件。任何 OpenAI 兼容的供应商都行，改数据目录下的 `config/providers.json` 指过去即可。
向量模型是单独一条配置，换供应商时不会偷偷沿用上一个的 embedding。

## 它能做什么

### 有人格的助理

四根滑杆（外向 / 严谨 / 幽默 / 主动）直接编译进系统提示，动一下就能看出这个助理的行为
变了。每位助理还有生日、口头禅、一只会转头的 3D 动物头像，以及一个随真实相处涨落的
亲密度——点赞和点踩都会动它。

### 会互相接力的群聊

`@` 某个助理，需求直接路由给他。不写 `@`，调度员就自己读句子挑人。哪位做完之后发现
下一位更合适，他会说明理由把活交过去。接力链在右栏看得见。

### RyVibe：一句话进，一个能打开的项目出

说清你想要什么。小队挑几件事问你——是选项卡，不是表单——然后写出方案，落成工作区里的
一个项目目录（README、完整方案、任务清单，还有一个能直接打开的首个页面），任务清单同时
进你的待办。

<img src="apps/desktop/docs/capture-project.png" width="900" alt="RyVibe：项目已落盘" />

### 看得见的记忆

抽取出来的事实、关键词与向量混合检索、随时间衰减、还有一本"什么管用什么不管用"的经验
手册。全都在右栏里看得见、改得了。点赞点踩会回流进去。

### 一切皆插件

工具、路由、模型适配器、工作法都是插件。关掉一个，它的工具与接口是真的卸掉，不只是按钮
变灰。写法见 [docs/plugins.md](docs/plugins.md)。

## 代码怎么摆的

```text
apps/desktop      Electron 外壳：窗口、托盘、截图、IPC、打包
apps/server       本地后端：会话、工具、供应商、记忆、vibe
packages/*        session、agent、llm、tools、memory、evolve、group……
vendor/*          cordis、schemastery、cosmokit
```

插件宿主是 [Cordis](https://github.com/cordiverse/cordis)：一个插件就是一个 fiber，可以在
运行时挂上、卸下。

## 开发

```sh
pnpm build                                  # 构建全部包
pnpm --filter @ryharness/desktop dev        # 带热重载的桌面端
pnpm test                                   # 198 个测试文件
pnpm lint                                   # biome，告警数有冻结基线
pnpm verify                                 # 五道发布门禁
```

那五道门禁不是摆设：跨包断言、没声明的依赖、重复代码、lint 预算、NOTICE 里的数字，全部
拿仓库事实核对，对不上就红。

## 文档

- [docs/plugins.md](docs/plugins.md) —— 插件怎么写
- [docs/performance.md](docs/performance.md) —— 时间花在哪
- [CHANGELOG.md](CHANGELOG.md) —— 改了什么，为什么改

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)

第三方许可证见 [NOTICE.md](NOTICE.md)。
