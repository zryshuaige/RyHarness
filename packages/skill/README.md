# @ryharness/skill

技能目录：**可复用的工作法，按需发现、按需加载**。

「这份稿子怎么审」「周报怎么写」「这个项目怎么跑」——这类做法不该每次都重新教
一遍助理，写成一份技能文件放在那儿，它自己会来取。

关键在于**不一股脑塞进系统提示**。十几个技能正文一起进上下文，既贵又读不完，
模型多半挑不出该用哪条。所以这一族分两层：

- **目录**：只有名字和一句话说明，随时可以整份摊给模型看；
- **正文**：模型点名要了才取。

上游对照：dsh 的 `skill/skill`（注册表）、`skill/skill-filesystem`（磁盘发现）、
`skill/tool-skill`（给模型的目录与加载工具）。本轮做的是它们在 RyHarness 里的
最小可用版本。

## 三块东西

### 注册表（`SkillRegistry`）

把多个来源的技能目录合成一份，按名字取全文。

```ts
const registry = new SkillRegistry()
registry.registerProvider(provider) // 来源：磁盘、远程、内存里都行
registry.register({
  name: 'review-draft',
  title: '审稿',
  description: '按三条标准审一份稿子',
  content: '# 审稿\n\n1. …',
  source: 'runtime',
})

const catalog = await registry.list() // 目录：只有名字与说明，没有正文
const skill = await registry.resolve('review-draft') // 全文
```

**同名时谁赢**（一条明规则，不靠运气）：

1. 内嵌技能（`register` 进来的）优先级最高；
2. 其余按 provider 的 `priority` 比，数字小的赢；
3. priority 相同则**先注册的 provider 赢**。

输掉的那一路不会凭空消失，它进 `registry.conflicts()`——界面上能看见「有个技能
被盖住了」，作者不用猜。某个来源整个坏了也不拖垮整份目录，它进
`registry.failures()`。

### 文件系统来源（`FileSystemSkillProvider`）

从磁盘上发现技能。技能文件二选一：

- 一个目录 `<root>/<name>/SKILL.md`；
- 一个平铺文件 `<root>/<name>.md`。

```ts
const provider = new FileSystemSkillProvider({
  roots: defaultSkillRoots({ workspaceRoot: '/ws', dataDir: '/data', customDirs: ['/custom'] }),
})
await provider.refresh() // 扫一遍
await provider.list() // 目录
await provider.resolve('review-draft') // 正文
```

默认根目录与优先级：

| 优先级 | 来源 | 路径 |
|---|---|---|
| 100 | project | `<workspaceRoot>/.skills` |
| 200 | custom | 配置里给的自定义目录 |
| 300 | user | `<dataDir>/skills` |

技能文件开头是一段 `---` 包起来的 yaml 头：

```markdown
---
name: review-draft
title: 审稿
description: 按三条标准审一份稿子
tags:
  - 写作
  - 校对
---

# 审稿

1. 先看事实，再看表达
2. …
```

- `name` 与 `description` **必填**，缺了就跳过这个文件（原因进 `provider.diagnostics()`）；
- `title` 缺省时等于 `name`；
- `tags` 可选；
- 名字只认字母数字、连字符、下划线，且必须以字母数字开头。

正文每次加载都**重新读文件**：改了技能正文不用刷新目录，改了 frontmatter（名字、
说明）才需要。

目录变了能被认出来：`provider.startWatching()` 盯着根目录与每个技能目录，变化会
触发一次刷新；也可以直接调 `provider.refresh()`。

### 给模型的工具（`createSkillTool`）

```ts
const tool = createSkillTool({ registry })
```

工具说明里带的是**目录**，工具结果里给的是**正文**：

```
<skill_content name="review-draft">
<skill_instructions>
…技能正文…
</skill_instructions>
</skill_content>
```

取不到的时候给模型一句能懂的话，而不是空结果：

- `Error: 缺少参数 name（技能名）`
- `Error: 技能名字不合法："…"`
- `Error: 没有这个技能："…"`

## 边界

**本包不含任何技能内容**——它是发现与加载的机制，不是内容本身。

明确没做的：

- **skill-office**（Word / PPT / Excel 的成套工作流）：那是另一族能力，本轮不做。
  真要做，形态是「往注册表里再挂一个 provider」，正文由 skill-office 自己提供。
- **技能正文的版本与失效**：正文取回来就是普通对话历史，之后改了文件不会回头
  改写已经取过的那一份。
- **按助理分技能**：注册表是全局的，一个会话里所有助理看到同一份目录。
- **技能正文大小上限**：目录里的说明会被截断（调用方自己截），正文不会。

## 不依赖谁

本包只依赖 `@ryharness/agent` 的 `Tool` 类型（工具要能注册进 `ctx.tools`），
其余全部自己实现：yaml 头是自写的够用解析器，没有第三方依赖。

上游 dsh 的 `skill/skill` 还有一层「宿主 scope 分层」（全局层与助理层的目录合并、
近的层压远的层），本包是**单层**的：一份全局目录，靠 provider 优先级裁决同名。
