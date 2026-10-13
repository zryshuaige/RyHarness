# 第三方资产许可（RyAgent）

## 本项目原创资产

| 资产 | 来源 | License | 用途 |
|---|---|---|---|
| 几何橘猫（品牌主角） | 本仓库原创，`apps/desktop/assets/brand/cat-face*.svg` | MIT（随本项目） | 应用图标、favicon、单色剪影、头像 'cat'、Ryen 吉祥物三态 |
| 软件图标位图 | 由 `apps/desktop/scripts/gen-icon.mjs`（sharp + png-to-ico）从上述矢量生成 | MIT（随本项目） | `assets/icon-*.png`、`icon.ico`、`favicon-*`、`icon-mono-*` |

构建可重复：`pnpm --filter @ryagent/desktop gen:icon`。仓库内不保存任何来源不明的二进制图像，位图全部是上面那份矢量的派生物。

## 第三方图形资源

| 资产 | 来源 | License | 用途 |
|---|---|---|---|
| Lucide 图标（23 个） | [lucide-static](https://lucide.dev) v1.55.0 | **ISC** | UI chrome 全部图标（renderer/src/assets/lucide/，经 scripts/gen-lucide-icons.mjs 拷入） |
| Fluent Emoji（modern SVG） | [microsoft/fluentui-emoji](https://github.com/microsoft/fluentui-emoji)（经 npm 包 fluentui-emoji 提取） | **MIT**（见 assets/fluent-emoji/FLUENT-EMOJI-LICENSE.txt） | 欢迎页 chips 图标（calendar / envelope / memo / open-file-folder） |
| DiceBear 头像（2 个家族） | [@dicebear/core + @dicebear/collection](https://dicebear.com) v9 | 框架 **MIT**；风格见下 | agent 头像（本地 SVG 生成，无网络） |

### DiceBear 风格许可明细（已核实 `@dicebear/collection@9.4.2` 内各 style 包 meta）

头像体系已从 6 族收敛为 2 族（同屏不再出现黑白线稿与彩色卡通混排）：

| 风格 | 仓库键名 | License | 署名要求 |
|---|---|---|---|
| Dylan!（人物，扁平插画） | `dylan` | CC BY 4.0 | 需署名：DiceBear Dylan! by Natalia Spivak |
| Fun Emoji（吉祥物/表情脸） | `mascot` | CC BY 4.0 | 需署名：DiceBear Fun Emoji by Davis Uche |

已停用（代码中不再引用，风格包仍在 node_modules 里）：lorelei、notionists、thumbs（CC0 1.0）、adventurer、bigEars（CC BY 4.0，Attribution 见 [DiceBear 许可页](https://dicebear.com/licenses)）。

CC BY 4.0 署名的完整文本见 https://creativecommons.org/licenses/by/4.0/ ；分发时随应用附本文件即可满足署名义务。

## 运行时依赖（主要）

见各包 package.json 与 pnpm-lock.yaml。核心：React（MIT）、Electron（MIT）、cordis/cosmokit/schemastery（MIT，vendor 自 deepseek-harness）、node:sqlite（Node 内置）。
