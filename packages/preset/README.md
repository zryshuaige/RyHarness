# @ryharness/preset

助理能力预设：一份「这位助理能用什么」的命名说法。

## 做什么

- 预设 = `{ id, name, description, tools, prompt?, skills? }`。
- `PresetRegistry.register(preset)`：登记。id 要合法（`[a-z0-9][a-z0-9-_]*`），不能重名。
- `select(agentId, presetId)`：给某位助理**定一版**。版本号单调递增，**旧版留着**——
  「它刚才是什么样」要能回看，出问题时才查得动。
- `current(agentId)`：当前这一版。
- `effective(agentId)`：此刻生效的能力（工具 + 提示 + 技能）。没选过预设就报
  `no-selection`，**不默默给一份空的能力**——那等于把助理的本事悄悄清零。

## 为什么要有「版本」

上游（`agent-preset`）的口径是：宿主共用同一个 Agent 循环，但每位助理看到的是它
**选中那一版**的工具、提示与技能。我们照这个口径做：预设管「有哪些能力组合」，版本管
「这位助理现在用的是哪一版」。

## 与上游 dsh 的差别

| 上游 | 我们 | 为什么 |
|---|---|---|
| `agent-preset-registry`：选择、版本留存、档案编辑 | 选择与版本留存 | 「档案编辑」在我们这边是助理编辑页的事，不在这一包里 |
| `agent-preset`：声明式的子插件与元数据 | 预设是**纯数据** | 我们的预设不自己挂插件，它描述「这一版放哪些工具、提示、技能」 |
| `persona`：可组合的人格 | **不做** | 人格已经有独立的实现（`packages/session` 的人格模型），不在这里重做一份 |

## 用法

```ts
import { PresetRegistry } from '@ryharness/preset'

const presets = new PresetRegistry()
presets.register({ id: 'reader', name: '只读', description: '只能看', tools: ['fs_read', 'fs_glob'] })
presets.register({ id: 'builder', name: '能改', description: '能读能写', tools: ['fs_read', 'fs_write'] })

presets.select('a1', 'reader')  // → revision 1
presets.select('a1', 'builder') // → revision 2（旧版还在）
presets.current('a1')?.presetId // → 'builder'
```
