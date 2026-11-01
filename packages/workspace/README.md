# @ryharness/workspace

多个项目目录，加上会话归属。

一个工作区就是一个**项目目录**：有个名字（界面上的那行字），有个根目录（工具读写文件的地方）。
会话可以归到某个工作区下面，于是「这个会话在哪个项目里跑过的」这件事就有了答案。

```ts
import { WorkspaceRegistry } from '@ryharness/workspace'

const registry = new WorkspaceRegistry({ storePath: '/path/to/data/workspaces.json' })
const workspace = registry.create('我的项目', '/home/me/projects/app')
registry.assignSession('conv-1', workspace.id)
registry.sessionsOf(workspace.id)          // ['conv-1']
registry.resolveSessionPath('conv-1', 'src/a.ts')  // '/home/me/projects/app/src/a.ts'
```

## 为什么是「多个」工作区

`packages/tools` 那边已经有一个 `workspaceRoot`——**单个**工作区。
本包管的是**多个**：同一个应用里同时开着三个项目目录，工具读写文件时落在哪一个，
由这个会话归属的工作区决定。

```ts
registry.resolveSessionPath('conv-1', 'src/a.ts')
// 落在 conv-1 所属的工作区根之内；`..` 越界会被当场拒绝
```

## 工作区

```ts
interface Workspace {
  id: string        // 唯一
  name: string      // 给人看的
  rootPath: string  // 绝对路径，工具读写文件的边界
  createdAt: number // 建立时间（毫秒），列表按它排
}
```

```ts
registry.create(name, rootPath)  // 建一个
registry.get(id)                 // 按 id 取
registry.list()                  // 全部，按建立时间排
registry.rename(id, newName)     // 改名（只动名字，根目录是用户的地盘）
registry.remove(id)              // 移除（只删记录，文件夹与会话都不动）
```

## 会话归属

一个会话最多属于一个工作区；也可以不属于任何工作区（**未分组**）。

```ts
registry.assignSession(sessionId, workspaceId)  // 归到某个工作区
registry.unassignSession(sessionId)             // 摘出来，变成未分组
registry.hideSession(sessionId)                 // 在工作区里藏起来（不显示，不是删除）
registry.showSession(sessionId)                 // 放回来
registry.workspaceOf(sessionId)                 // 它属于哪个工作区
registry.sessionsOf(workspaceId)                // 这个工作区下面有哪些会话
registry.ungroupedSessions()                    // 没挂在任何工作区下面的会话
```

三种算「未分组」：本来就没归过、从工作区里摘出来的、被藏起来的。
它们的共同点是**还在**——用户还找得到，只是界面上不挂在某个项目下面。

## 路径边界

注册一个工作区时，根目录要过四道检查（`assertAllowedRoot`）：

| 检查 | 为什么 |
|---|---|
| 必须是绝对路径 | 相对路径跟着当前目录跑，换台机器就不是同一个地方了 |
| 不能是文件系统根（`/`、`C:\`） | 那样工具的「工作区内」就等于「整台机器」，边界形同虚设 |
| 得在 `allowedRoots` 范围内 | 宿主可以限制「只准用这几个目录下的项目」 |
| 得是真实存在的目录 | 根目录不存在的话，工具读写时会有一堆看不懂的错 |

```ts
new WorkspaceRegistry({ allowedRoots: ['/home/me/projects'] })
```

不给 `allowedRoots` 就是没有范围限制，但「不能是文件系统根」这条照样生效。

往工作区里指路径时（`resolveInWorkspace` / `resolveSessionPath`），逃出根目录的路径会被当场拒绝。

**这里只做词法判断**（`..`、绝对路径、跨盘符）。符号链接与 Windows junction 的真实路径校验在
`@ryharness/tools` 的 `resolveTarget` 里——那一层才知道读写动作真正落在哪个文件上，
本包不把那份判断抄一遍。

## 落盘

一个 JSON 文件装全部工作区与会话归属：

```json
{
  "version": 1,
  "workspaces": [{ "id": "w1", "name": "我的项目", "rootPath": "/home/me/projects/app", "createdAt": 1700 }],
  "sessions": { "conv-1": { "workspaceId": "w1", "hidden": false } }
}
```

- 写入走「临时文件 + rename」：崩在写一半时留下的是一份完整的旧数据，不是半份 JSON。
- 不给 `storePath` 就只在内存里（测试与一次性脚本用）。
- 文件坏掉时**不当成空列表**：抛 `WorkspaceStoreError`。工作区列表是用户攒下来的东西，
  悄悄当成空的等于把他们的项目全弄没了——得让人先看一眼现场。
- 坏掉的**单条**记录会被丢掉，好的那些还在。

## 边界

- **本包不管会话本身**。会话的正文归 `packages/session`，这里只记「它属于哪个工作区」。
- **删工作区不删文件夹，也不删会话**。删的只是这条记录。
- **不暴露给模型**：不注册工具、不进提示词、不产生会话事件。

## 导出

| 导出 | 一句话 |
|---|---|
| `WorkspaceRegistry` | 注册表本体：建、取、列、改名、移除、归属、解析路径 |
| `WorkspaceRegistryOptions` | 配置（存储路径、允许的根范围、时钟、id 生成器） |
| `Workspace` | 一个工作区的形状 |
| `SessionPlacement` | 一个会话的归属（工作区 id + 是不是藏着） |
| `assertAllowedRoot` | 检查一个根目录能不能当工作区根 |
| `isInsideRoot` | 目标是不是落在根目录之下 |
| `isFilesystemRoot` | 这个路径是不是文件系统根 |
| `resolveInWorkspace` | 把一条路径解析到某个工作区之内 |
| `WorkspaceStore` | 落盘的那一份 JSON |
| `WorkspaceFile` / `WORKSPACE_FILE_VERSION` | 文件里的结构与版本 |
| `WorkspacePathError` | 路径不合法（带路径） |
| `WorkspaceNotFoundError` | 工作区不存在（带 id） |
| `WorkspaceStoreError` | 落盘的记录读不出来（带路径） |
