# 第三方资产许可（RyAgent）

本文件是 RyAgent 的**资产归属与署名总账**：仓库内入库的每一份非原创资产都在下表出现，
表中的许可与署名要求随分发物一并交付（见文末「分发要求」）。应用内「我的 → 关于」
弹窗是与本文件同源的精简版，二者冲突时以本文件为准。

## 本项目原创资产

| 资产 | 来源 | License | 用途 |
|---|---|---|---|
| 几何橘猫（品牌主角） | 本仓库原创，`apps/desktop/assets/brand/cat-face*.svg`、`icon.svg`、`favicon.svg` | MIT（随本项目） | 应用图标、favicon、单色剪影、头像 'cat'、Ryen 吉祥物三态 |
| 软件图标位图 | 由 `apps/desktop/scripts/gen-icon.mjs`（sharp + png-to-ico）从上述矢量生成 | MIT（随本项目） | `assets/icon-*.png`、`icon.ico`、`favicon-*`、`icon-mono-*` |

构建可重复：`pnpm --filter @ryagent/desktop gen:icon`。仓库内不保存任何来源不明的二进制图像，
位图全部是上面那份矢量的派生物。

## 第三方图形资源

| 资产 | 来源 | License | 用途 |
|---|---|---|---|
| Lucide 图标（27 个） | [lucide-static](https://lucide.dev) v1.55.0 | **ISC** | UI chrome 全部图标（`renderer/src/assets/lucide/`，经 `scripts/gen-lucide-icons.mjs` 从 npm 包拷入） |
| DiceBear 头像（2 个家族） | [@dicebear/core + @dicebear/collection](https://dicebear.com) v9 | 框架 **MIT**；风格许可见下 | agent 头像（本地 SVG 生成，无网络请求） |

### DiceBear 风格许可明细（已核实 `@dicebear/collection@9.4.2` 内各 style 包 meta）

头像体系已从 6 族收敛为 2 族（同屏不再出现黑白线稿与彩色卡通混排），当前入库并随应用
分发的只有下面两种，两族均为 **CC BY 4.0**，强制署名：

| 风格 | 仓库键名 | License | 完整署名（须随应用展示） |
|---|---|---|---|
| Dylan!（人物，扁平插画） | `dylan` | CC BY 4.0 | DiceBear Dylan! by **Natalia Spivak** |
| Fun Emoji（吉祥物 / 表情脸） | `mascot` | CC BY 4.0 | DiceBear Fun Emoji by **Davis Uche** |

`agent.avatar` 编码 `db:{style}:{seed}`；另有 `cat` 键指向本项目原创橘猫。
渲染器数据经 `renderer/src/components/avatars/styles-avatar.ts` 动态 import，
按需加载一个独立 chunk，不静态 import 整个 collection。

已停用（代码中不再引用，也不再随应用分发，故无需署名）：lorelei、notionists、thumbs
（原 CC0 1.0）、adventurer、bigEars（CC BY 4.0）。它们的 style 包仍在 node_modules 中，
是 pnpm 依赖树的残留，不构成分发物。

CC BY 4.0 的完整法条见 https://creativecommons.org/licenses/by/4.0/ ；
许可总表见 https://dicebear.com/licenses 。

## 运行时依赖（主要）

见各包 package.json 与 pnpm-lock.yaml。核心：React（MIT）、Electron（MIT）、
cordis / cosmokit / schemastery（MIT，vendor 自 deepseek-harness）、
`node:sqlite`（Node 内置）。

## 分发要求

以二进制形式分发（`pnpm --filter @ryagent/desktop package` 产出的 NSIS 安装包）时，
必须同时交付：

1. **LICENSE**（MIT 法条全文）——`package.json#build.extraResources` 已把它复制到
   安装目录的 `resources/LICENSE`；
2. **本文件 NOTICE.md**——同上复制到 `resources/NOTICE.md`，其中包含上表全部
   CC BY 4.0 署名（DiceBear Dylan! by Natalia Spivak、DiceBear Fun Emoji by
   Davis Uche）。

两项已由 electron-builder 配置保证，不需要打包者手工处理；改动资产或依赖后请同步更新本文件。
