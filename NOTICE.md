# 第三方资产许可（RyHarness）

本文件是 RyHarness 的**资产归属与署名总账**：仓库内入库的每一份非原创资产、以及安装包里
每一份会被用户拿到的第三方代码，都在下表出现。应用内「我的 → 关于」弹窗是与本文件同源
的精简版，二者冲突时以本文件为准。

**这份文件的每个数都由机器核对。** 凡是会随仓库变动的值（图标数、随包交付的工作区包、
版本号、许可证）都写在 `<!-- notice:键名 -->…<!-- /notice -->` 之间，取值来自
`scripts/notice-audit.mjs` 对真实目录与已安装包树的扫描；`node scripts/verify-notice.mjs`
重算一遍并逐字节比对，对不上即非 0 退出（已接入 CI 的「Guardrails」步骤）。改动资产或
依赖后跑一次 `node scripts/verify-notice.mjs --write` 即可让数字跟上事实；删掉标记也会让
门禁变红——那等于把某个数退回手维护，正是这份文件此前漂移的原因。

读这份文件只需要分清三件事，三类的义务完全不同：

| 类别 | 会进安装包吗 | 我方义务 | 见哪节 |
|---|---|---|---|
| **必须署名**的第三方资产 | 是（图像/字体数据进 bundle） | 在应用内展示署名，且随包交付本文件 | [第三方图形资源](#第三方图形资源) |
| 运行时依赖 | 是（代码进 bundle 或 node_modules） | 保留版权声明与许可声明；本文件列全清单 | [运行时依赖](#运行时依赖随安装包分发) |
| 构建期工具 | **否**，只在开发机上跑 | 无须署名（本文件仍记录来源与许可，便于审计） | [构建期工具](#构建期工具不随安装包分发) |

Electron 自带的 Chromium / V8 / Node.js 属于第四类：**我方没有选它们的权利，也没有
重新分发它们**，但它们的许可文本必须随包交付——见 [平台运行时](#平台运行时electron-自带)。

## 本项目原创资产

| 资产 | 来源 | License | 用途 |
|---|---|---|---|
| 橘猫位图母版（品牌主角） | 本项目原创（用户选定的应用程序图标素材），`apps/desktop/assets/brand/mark.png` | MIT（随本项目） | 应用图标、favicon、托盘、启动屏、头像 'cat'、Ryen 品牌徽标 |
| 软件图标位图 | 由 `apps/desktop/scripts/gen-icon.mjs`（sharp + png-to-ico）从上述母版**逐档整幅缩放 + 同一个圆角遮罩**生成（九档无裁窗、无「扣不扣圆角」分支） | MIT（随本项目） | `assets/icon-*.png`、`icon.ico`、`favicon-*`、`cat.png`、`renderer/public/` 副本 |

母版与逐档策略见 `apps/desktop/docs/brand/icon.md`。构建可重复：
`pnpm --filter @ryharness/desktop gen:icon`（完全离线）。仓库内不保存任何来源不明的二进制
图像，位图全部是上面那份母版的派生物。

## 第三方图形资源

| 资产 | 来源 | License | 用途 |
|---|---|---|---|
| 供应商品牌标识（<!-- notice:providerLogos.count -->13<!-- /notice --> 个） | [Simple Icons](https://simpleicons.org)（CC0，单色 path）11 个 + [LobeHub Icons](https://lobehub.com/icons)（MIT）2 个；硅基流动取自其官网 favicon（彩色） | **CC0-1.0** / **MIT** | 设置页「先挑一家」网格与供应商列表里的品牌标识（`apps/desktop/assets/providers/`，构建前光栅化成 256px PNG） |
| Lucide 图标（<!-- notice:icons.count -->36<!-- /notice --> 个） | [lucide-static](https://lucide.dev) v<!-- notice:icons.version -->1.55.0<!-- /notice --> | <!-- notice:license.lucideStatic -->**ISC**<!-- /notice --> | UI chrome 全部图标（`renderer/src/assets/lucide/`，经 `scripts/gen-lucide-icons.mjs` 从 npm 包拷入并入库） |
| DiceBear 头像（<!-- notice:avatars.styles -->2<!-- /notice --> 个家族） | [@dicebear/core + @dicebear/collection](https://dicebear.com) v9 | 框架 **MIT**；风格许可见下 | agent 头像（本地 SVG 生成，无网络请求） |

### 供应商品牌标识（13 个）

| 标识 | 来源 | License |
|---|---|---|
| SiliconFlow | 官网 favicon（彩色透明底，不套品牌底） | 商标归其所有者 |
| DeepSeek、Moonshot、Kimi、MiniMax、OpenRouter、Ollama、Anthropic、Google、Hugging Face、Qwen | [Simple Icons](https://simpleicons.org) 单色 path | **CC0-1.0**（图形整理） |
| OpenAI、智谱 GLM（Zhipu） | [LobeHub Icons](https://lobehub.com/icons) 单色变体 | **MIT** |

这些标识只用于**指明用户正在配置哪家的服务**（指示性使用），不表示任何关联或背书。
各品牌的商标权仍归其所有者；CC0 / MIT 只覆盖图形的整理与再分发。
（OpenAI 那个是官方的六瓣结标识，智谱是分子节点标识——此前前者是"绿底 + 白 O"的首
字母方块、后者用的根本不是智谱的标识，一屏排开认不出是哪家。）

入库图标（`renderer/src/assets/lucide/` 目录下逐个扫描，缺一个就说明登记表与目录脱节）：
<!-- notice:icons.list -->alert、arrow-up、arrow-up-right、at-sign、blocks、brain、calendar-days、chat-bubble、check、chevron-left、chevron-right、clipboard-list、copy、crown、dices、ellipsis、file、gear、group、mail、moon、panel-right、pencil、plus、search、send、sparkles、speaker、square、sun、thumbs-down、thumbs-up、user、users、volume-2、x<!-- /notice -->

全站只有 Lucide 这一套线性图标库（24 网格、线宽 2、圆角线帽、`currentColor`，
尺寸只有 16 / 20 / 24 三档），登记表在 `renderer/src/components/Icon.tsx`，资产与
登记表一一对应。界面 chrome 里不出现 emoji 或字体符号——菜单、箭头、外链、状态标记
一律走这套图标。品牌橘猫是填充的例外，与线性图标并排时取更小一档，避免两者互撞。

> Lucide 的 SVG 不是构建期产物：`gen-lucide-icons.mjs` 把它们拷进 `src/assets/lucide/`
> 随源码入库，因此它们是**分发物的一部分**，必须署名（ISC 只要求保留版权与许可声明）。

### DiceBear 风格许可明细（已核实 `@dicebear/collection@9.4.2` 内各 style 包 meta）

头像体系已收敛为 2 族（同屏不再出现黑白线稿与彩色卡通混排），当前入库并随应用
分发的只有下面两种，两族均为 **CC BY 4.0**，强制署名：

| 风格 | 仓库键名 | License | 完整署名（须随应用展示） |
|---|---|---|---|
| Dylan!（人物，扁平插画） | `dylan` | CC BY 4.0 | DiceBear Dylan! by **Natalia Spivak** |
| Fun Emoji（吉祥物 / 表情脸） | `mascot` | CC BY 4.0 | DiceBear Fun Emoji by **Davis Uche** |

`agent.avatar` 编码 `db:{style}:{seed}`；另有 `cat` 键指向本项目原创橘猫。
渲染器数据经 `renderer/src/components/avatars/styles-avatar.ts` 动态 import，
按需加载一个独立 chunk，不静态 import 整个 collection。

实际接进界面的风格键（扫 `LAZY_RENDERERS` 登记表；登记表里多一个键就多一份 CC BY
署名义务，所以这个数也是机器核对的）：
<!-- notice:avatars.stylesList -->dylan、mascot<!-- /notice -->

已停用（代码中不再引用，也不再随应用分发，故无需署名）：lorelei、notionists、thumbs
（原 CC0 1.0）、adventurer、bigEars（CC BY 4.0）。它们的 style 包仍在 node_modules 中，
是 pnpm 依赖树的残留，不构成分发物。

CC BY 4.0 的完整法条见 https://creativecommons.org/licenses/by/4.0/ ；
许可总表见 https://dicebear.com/licenses 。

## 运行时依赖（随安装包分发）

判定标准只有一条：**这段代码会出现在用户拿到的安装包里**。渲染层由 Vite 打进
`renderer/dist/assets/vendor-*.js` 的算，主进程经 `node_modules` 解析、由
electron-builder 按依赖图收集的也算。

| 组件 | 解析版本 | License | 出现在哪 / 为什么必须列 |
|---|---|---|---|
| React + React DOM | <!-- notice:runtime.react -->19.3.0<!-- /notice --> / <!-- notice:runtime.reactDom -->19.3.0<!-- /notice --> | MIT | `vendor-react-*.js`（渲染层 UI） |
| scheduler | <!-- notice:runtime.scheduler -->0.28.0<!-- /notice --> | MIT | react-dom 的传递依赖，随同一分片打包 |
| **marked** | <!-- notice:runtime.marked -->18.1.0<!-- /notice --> | <!-- notice:license.marked -->**MIT**<!-- /notice --> | `vendor-marked-*.js`：渲染层只用它的 `lexer` 解析 Markdown 成 token 树，HTML 由自写渲染器映射成 React 元素（不过 marked 的 HTML 通道）。此前漏列——它打进 bundle 就是分发物，MIT 要求保留版权与许可声明 |
| @dicebear/core | <!-- notice:runtime.dicebearCore -->9.4.3<!-- /notice --> | MIT | `vendor-avatar-*.js`：头像 SVG 生成器 |
| @dicebear/collection | <!-- notice:runtime.dicebearCollection -->9.4.2<!-- /notice --> | MIT（框架） | 同上；其中 dylan / mascot 两族风格另受 CC BY 4.0 约束，见上一节 |
| ws | <!-- notice:runtime.ws -->8.22.0<!-- /notice --> | MIT | 主进程订阅后端 WS（`@ryharness/server` 的生产依赖，electron-builder 一并收集） |
| @ryharness/*（<!-- notice:runtime.workspaceNonVendorCount -->17<!-- /notice --> 个非 vendor 工作区包） | <!-- notice:runtime.workspaceVersion -->0.2.0<!-- /notice --> | <!-- notice:runtime.workspaceLicense -->MIT<!-- /notice -->（本项目） | 主进程以 `external` 引入、运行时经 node_modules 解析；许可同本项目根 LICENSE |
| 我方重命名的 vendor（<!-- notice:runtime.vendorShipped -->@ryharness/cordis · @ryharness/cosmokit<!-- /notice -->） | <!-- notice:runtime.workspaceVersion -->0.2.0<!-- /notice --> | <!-- notice:runtime.workspaceLicense -->MIT<!-- /notice -->（本项目重命名自 dsh vendor） | 内核地基（DI / 工具库）。上游作者 Shigma 的 MIT 法条随包保留在各 vendor 目录的 `LICENSE` 里 |
| `node:sqlite` | 随 Node 22.19+/24 | MIT | 会话持久化；Node 内置模块，其许可随 Electron 交付（见下节） |

随包交付的工作区包是**依赖闭包**，不是「packages 目录下有几个」：桌面应用声明的工作区
运行期依赖只有 `@ryharness/server` 一个，真正的清单是它的传递闭包
（<!-- notice:runtime.workspaceCount -->19<!-- /notice --> 个，含上面那两件 vendor）。
闭包里的全部成员：

<!-- notice:runtime.workspaceList -->@ryharness/agent（`packages/agent`）、@ryharness/attachment（`packages/attachment/types`）、@ryharness/brand（`packages/util/brand`）、@ryharness/cordis（`vendor/cordis`）、@ryharness/cosmokit（`vendor/cosmokit`）、@ryharness/evolve（`packages/evolve`）、@ryharness/group（`packages/group`）、@ryharness/llm（`packages/llm/llm`）、@ryharness/llm-openai（`packages/llm/openai`）、@ryharness/memory（`packages/memory`）、@ryharness/server（`apps/server`）、@ryharness/session（`packages/session`）、@ryharness/timeout（`packages/util/timeout`）、@ryharness/tools（`packages/tools`）、@ryharness/typert-protocol（`packages/typert/protocol`）、@ryharness/util-crypto（`packages/util/crypto`）、@ryharness/util-llm-json（`packages/util/llm-json`）、@ryharness/util-values（`packages/util/values`）、@ryharness/voice（`packages/voice`）<!-- /notice -->

其中 `<!-- notice:runtime.vendorUnshipped -->@ryharness/schemastery<!-- /notice -->` 目前**没有**任何包依赖它，
因此它不构成分发物（源码里也没有对它的 import），不进上一张表；等真有包用上它时，
本文件的扫描会把它自动挪进来——「列了但不进包」和「进包却没列」同样是错误。

上表第一行那条的成员（不含 vendor）：

<!-- notice:runtime.workspaceNonVendorList -->@ryharness/agent（`packages/agent`）、@ryharness/attachment（`packages/attachment/types`）、@ryharness/brand（`packages/util/brand`）、@ryharness/evolve（`packages/evolve`）、@ryharness/group（`packages/group`）、@ryharness/llm（`packages/llm/llm`）、@ryharness/llm-openai（`packages/llm/openai`）、@ryharness/memory（`packages/memory`）、@ryharness/server（`apps/server`）、@ryharness/session（`packages/session`）、@ryharness/timeout（`packages/util/timeout`）、@ryharness/tools（`packages/tools`）、@ryharness/typert-protocol（`packages/typert/protocol`）、@ryharness/util-crypto（`packages/util/crypto`）、@ryharness/util-llm-json（`packages/util/llm-json`）、@ryharness/util-values（`packages/util/values`）、@ryharness/voice（`packages/voice`）<!-- /notice -->

各组件的**精确版本与完整许可全文**以 `node_modules/<pkg>/package.json` 与 `LICENSE` 为准——
本表是索引，不是替代品。本文件里写的版本号取自实际会被打进安装包的那棵树（而不是
`pnpm-lock.yaml` 的文本），所以它与产物一致；若二者冲突，以包自带的 LICENSE 为准，并回来
跑 `node scripts/verify-notice.mjs --write` 修这张表。

## 平台运行时（Electron 自带）

| 组件 | 版本 | License | 许可文本在安装包的哪 |
|---|---|---|---|
| Electron | <!-- notice:platform.electron -->44.9.1<!-- /notice -->（钉版，见 `apps/desktop/package.json`） | MIT | `$INSTDIR\LICENSE.electron.txt` |
| Chromium / Blink / V8 / ANGLE / Node.js 等第三方部分 | 随 Electron <!-- notice:platform.electron -->44.9.1<!-- /notice --> | 以各上游为准（Chromium、V8、Node.js 为 BSD-3-Clause / MIT 系） | `$INSTDIR\LICENSES.chromium.html`（Chromium 第三方许可汇总，含 V8 与 Node.js 条目） |

这两份文件不是我方 `extraResources` 投的，是 electron-builder 自己保留的。已核对
`app-builder-lib@26.17.0 out/electron/ElectronFramework.js`（`cleanupAfterUnpack` →
`retainElectronLicenseFiles`）的实际行为，而不是照着文档转述：

- `LICENSE` → `LICENSE.electron.txt`，**全平台**都做（解包后就在应用目录里，被改名留下）；
- `LICENSES.chromium.html` **只在 macOS** 被搬进 `.app/Contents/Resources`——因为只有 macOS
  把它放在了 `.app` 外面、打包时会被漏掉；Windows / Linux 上它本来就与可执行文件同级，
  原样留在应用目录。函数里 `...(isMac ? [move("LICENSES.chromium.html")] : [])` 就是这个分支。

> `$INSTDIR\LICENSE.electron.txt`（Electron 的）与 `$INSTDIR\resources\LICENSE`（本项目的）
> 是两份不同的文件，不冲突、不覆盖。

## 构建期工具（不随安装包分发）

以下包只在开发机上执行构建，产物（PNG / ICO / JS / CSS）由它们的输出构成，
它们**本身的可执行代码不进安装包**，因此不产生随包署名义务；列在这里是为了让
「我方用了什么」有完整答案，也是将来若改变分发方式时的检查表。

| 工具 | 版本 | License | 用途 |
|---|---|---|---|
| sharp | <!-- notice:build.sharp -->0.35.5<!-- /notice --> | <!-- notice:license.sharp -->**Apache-2.0**<!-- /notice --> | `gen:icon.mjs` 的栅格化（缩放、圆角遮罩、PNG 编码） |
| png-to-ico | <!-- notice:build.pngToIco -->3.0.2<!-- /notice --> | <!-- notice:license.pngToIco -->**MIT**<!-- /notice --> | `gen-icon.mjs` 合成 Windows 多尺寸 `icon.ico` |
| lucide-static | <!-- notice:icons.version -->1.55.0<!-- /notice --> | <!-- notice:license.lucideStatic -->**ISC**<!-- /notice --> | 拷出 <!-- notice:icons.count -->36<!-- /notice --> 个 SVG 入库（产物进分发物，署名见「第三方图形资源」） |
| vite · @vitejs/plugin-react | <!-- notice:build.vite -->6.4.4<!-- /notice --> / <!-- notice:build.pluginReact -->5.2.0<!-- /notice --> | MIT | 渲染层构建 |
| tsdown · typescript | <!-- notice:build.tsdown -->0.22.14<!-- /notice --> / <!-- notice:build.typescript -->6.0.3<!-- /notice --> | MIT / <!-- notice:license.typescript -->**Apache-2.0**<!-- /notice --> | 主进程与工作区包构建 |
| electron-builder | <!-- notice:build.electronBuilder -->26.17.0<!-- /notice --> | <!-- notice:license.electronBuilder -->**MIT**<!-- /notice --> | 打包 |
| vitest · @vitest/coverage-v8 · jsdom · @biomejs/biome | vitest <!-- notice:build.vitest -->4.1.11<!-- /notice -->，其余见 `package.json` | MIT | 测试、lint |

> sharp 是 Apache-2.0（不是 MIT），typescript 同理——两者都由已安装包的 `license` 字段
> 核对，不是手写记忆。当前它们只在构建期运行、无随包分发义务；若将来改成把预编译二进制
> 打进安装包，必须同时附上它们的 `LICENSE` 与 `NOTICE` 文件。

## 分发要求

以二进制形式分发（`pnpm --filter @ryharness/desktop package` 产出的 NSIS 安装包）时，
下列文件必须与程序一起交付，且必须在包里实际存在：

| 文件 | 来源 | 谁负责放进包里 |
|---|---|---|
| `$INSTDIR\resources\LICENSE` | 仓库根 `LICENSE`（MIT 法条全文） | `package.json#build.extraResources` |
| `$INSTDIR\resources\NOTICE.md` | 本文件 | `package.json#build.extraResources` |
| 安装向导的许可页 | 同一份 `LICENSE` | `package.json#build.nsis.license`（安装时展示） |
| `$INSTDIR\LICENSE.electron.txt` | Electron 发行包 | electron-builder（`retainElectronLicenseFiles`，全平台） |
| `$INSTDIR\LICENSES.chromium.html` | Electron 发行包 | electron-builder（Windows / Linux 原样留在应用目录；macOS 搬进 `Contents/Resources`） |

前两项由 `extraResources` 保证，后两项由 electron-builder 保证，都不需要打包者手工处理。
应用内「我的 → 关于」另需展示 DiceBear 的两条 CC BY 4.0 署名（见「第三方图形资源」）。

### 核对方法

**日常（改资产或依赖后）：**

```sh
node scripts/verify-notice.mjs --write   # 让文档里的数跟上仓库事实
node scripts/verify-notice.mjs           # 校验；不一致即非 0 退出
```

它核的是「文档说的」与「仓库里真实存在的」是否一致——图标目录、已安装包的版本与
license、工作区依赖闭包。几百毫秒，不需要打包。

**发布前（确认产物里真的有这些文件）：**

```sh
pnpm --filter @ryharness/desktop package:dir    # 先出解包目录，比安装包快
ls release/win-unpacked/resources/LICENSE release/win-unpacked/resources/NOTICE.md \
   release/win-unpacked/LICENSE.electron.txt release/win-unpacked/LICENSES.chromium.html
```

这一步验的是自动核对**验不到**的那一半：文件有没有真的落进产物。前一半每提交跑一次，
后一半发布前跑一次。
