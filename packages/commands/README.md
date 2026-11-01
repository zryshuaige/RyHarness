# @ryharness/commands

斜杠命令：**人**在输入框里敲 `/命令`，直接触发一个动作，不花模型一轮。

`/goal 继续` 不会变成一条发给模型的消息——它跑的是命令自己的逻辑，跑完把结果
给界面看。对话历史里不会多出一轮一问一答，这是它跟「让模型去做」最大的区别。

上游对照：dsh 的 `interaction/commands`。本轮做的是它在 RyHarness 里的最小可用
版本。

## 三块东西

### 注册表（`CommandRegistry`）

```ts
const registry = new CommandRegistry()
registry.register({
  name: 'goal',
  description: '看一眼当前目标',
  aliases: ['g'],
  execute: async (args) => {
    return { text: `当前目标：${args.input}` }
  },
})
```

- 命令名是**斜杠后面那一段**（`/goal` 的 `goal`），只认小写字母数字与连字符、
  下划线，且必须以字母数字开头；
- **重名直接报错**，不静默覆盖：命令是人敲的东西，覆盖掉的后果是「用户敲了 A，
  跑了 B，界面上还一句提示都没有」；
- 别名也算名字：别名撞上别的命令名、或者两个命令用同一个别名，都报错；
- `registry.list()` 给界面补全用（名字 + 说明 + 别名），按名字排好。

### 解析一行输入

```ts
parseCommandLine('/goal 继续') // { name: 'goal', input: '继续', raw: ' 继续' }
parseCommandLine('今天天气不错') // undefined —— 这不是命令
```

语法只有一条规矩：**斜杠必须在第一个字节**，后面紧跟命令名，命令名后面要么到
行尾、要么是空白。剩下的都是参数，归命令自己解释。

认不出来就返回 `undefined`，绝不把普通消息当成命令跑。

### 执行

```ts
const execution = await registry.execute('/goal 继续')
// { ran: true, name: 'goal', text: '当前目标：继续', isError: undefined }
```

结果形状是固定的：**文本 + 是否出错 + 可选的产物**。

| 情况 | `ran` | `text` |
|---|---|---|
| 跑成了 | `true` | 命令自己给的文本 |
| 输入不是命令 | `false` | `这不是命令` |
| 命令不存在 | `false` | `没有这个命令：/xxx` |
| 命令抛错 | `true` | `命令 /xxx 跑失败：…` |

`ran` 这一个字段就能把「命令跑了但失败了」和「压根没跑」分开——这两种给用户的
提示不该一样。

## 接到界面上

服务端插件 `apps/server/src/plugins/commands.ts` 提供两条路由：

- `GET /api/commands` → `{ commands: [{ name, description, aliases }] }`，界面拿它
  做输入框补全；
- `POST /api/commands/execute`，body `{ line: "/goal 继续" }` → 执行结果。

## 边界

**本包不碰模型、不碰会话历史**：命令跑完的结果怎么显示、要不要进历史，都是
宿主的事。

明确没做的：

- **附件**：命令只吃一段文字。要带图片、带文件的命令，得自己把附件接进来。
- **参数的结构化**：只有一段原始文本，`/plan 3 天` 里的「3 天」怎么解释归命令
  自己。
- **按助理分命令**：注册表是全局的，所有助理看到同一份命令清单。
- **撤销与重做**：命令自己做什么就做什么，本包不记录历史。

## 不依赖谁

零 workspace 依赖：本包只用 `node:` 内置模块与自己的代码。
