# 第三方资产许可（RyAgent）

## 图形资源

| 资产 | 来源 | License | 用途 |
|---|---|---|---|
| Lucide 图标（23 个） | [lucide-static](https://lucide.dev) v1.55.0 | **ISC** | UI chrome 全部图标（renderer/src/assets/lucide/，经 scripts/gen-lucide-icons.mjs 拷入） |
| Fluent Emoji（11 个 modern SVG） | [microsoft/fluentui-emoji](https://github.com/microsoft/fluentui-emoji)（经 npm 包 fluentui-emoji 提取） | **MIT**（见 assets/fluent-emoji/FLUENT-EMOJI-LICENSE.txt） | 软件图标主体、欢迎页 chips 图标 |
| DiceBear 头像（6 风格） | [@dicebear/core + @dicebear/collection](https://dicebear.com) v9 | 框架 **MIT**；风格见下 | agent 头像（本地 SVG 生成，无网络） |

### DiceBear 风格许可明细（已核实 @dicebear/collection@9.4.2 各 style meta.license）

| 风格 | License | 署名要求 |
|---|---|---|
| lorelei（洛丽） | CC0 1.0 | 无（公有领域） |
| notionists（文艺） | CC0 1.0 | 无 |
| thumbs（拇指） | CC0 1.0 | 无 |
| adventurer（冒险家） | CC BY 4.0 | 需署名：DiceBear Adventurer by Lisa Wischofsky |
| bigEars（大耳） | CC BY 4.0 | 需署名：DiceBear Big Ears by [licensor]，见 dicebear.com 风格页 |
| funEmoji（趣脸） | CC BY 4.0 | 需署名：DiceBear Fun Emoji by [licensor]，见 dicebear.com 风格页 |

CC BY 4.0 署名的完整文本见 https://creativecommons.org/licenses/by/4.0/ ；分发时随应用附本文件即可满足署名义务。

## 运行时依赖（主要）

见各包 package.json 与 pnpm-lock.yaml。核心：React（MIT）、Electron（MIT）、cordis/cosmokit/schemastery（MIT，vendor 自 deepseek-harness）、node:sqlite（Node 内置）。
