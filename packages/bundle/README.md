# @ryharness/bundle

分层装配：一个 bundle 由若干层叠成，每层决定「装哪些插件、给它们什么配置」。

## 做什么

- 层（`BundleLayer`）= `{ id, plugins: [{ id, enabled, config? }] }`。
- `resolveBundle(bundle)`：把层从底到顶叠起来。**后一层覆盖前一层**（覆盖的是「启用与否」
  与「配置」）。
- 结果里的插件按 id 排——叠的结果与层里写的顺序无关，这样「叠」才是可预期的。
- 被覆盖的决定会记下来（谁盖了谁），出问题时能看出是哪一层改的。
- `resolveBundles(bundles)`：叠几个 bundle（基础 bundle + 用户自己那份）。
- `BundleRegistry`：按名字存一份，取出来就能叠。

## 边界

- **空层不装**：一层一个插件都没决定，多半是写错了，直接报错。
- 只管「叠」这一件事：真去装插件是插件宿主的事（这一包不碰 cordis）。
- 不做插件依赖的自动求解（那是 `packages/extensions` 的 `ExtensionRegistry` 的活）。

## 与上游 dsh 的差别

| 上游 | 我们 | 为什么 |
|---|---|---|
| 每个包声明一份 `dsh.bundle.patch`，启动器叠这些补丁装出 profile | 层是**数据**（不是包） | 同一套装配逻辑既能用于内置层，也能用于用户自己写的层 |
| profile：`base` / `web` / `headless` / `acp` / `sdk` / `sdk-minimal` | 由宿主提供层；这一包只管叠 | 具体有哪些 profile 是应用的事 |
| 补丁文档有它自己的 DSL | 纯 JSON 形状 | 不引依赖、不引 DSL 解析器 |

## 用法

```ts
import { resolveBundle } from '@ryharness/bundle'

const resolved = resolveBundle({
  name: 'base+web',
  layers: [
    { id: 'core', plugins: [{ id: 'core-tools', enabled: true }, { id: 'web', enabled: false }] },
    { id: 'web-layer', plugins: [{ id: 'web', enabled: true, config: { backend: 'api' } }] },
  ],
})

resolved.plugins.find((p) => p.id === 'web')?.enabled // → true
resolved.overridden // → [{ id: 'web', byLayer: 'web-layer' }]
```
