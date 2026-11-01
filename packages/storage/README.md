# @ryharness/storage

跨重启的应用数据中枢。放的是**非会话数据**：工作区记录、配置片段、用户偏好这类——进程退了还得在的东西。

会话数据不在这里：会话有单写者模型和自己的 schema 迁移（`packages/session`），和这里的通用键值存储不是一回事，混在一起两边都难管。

三块拼起来：

- **契约**：`StorageRecord`（记录长什么样）、`StorageBackend`（后端要会什么）。
- **服务**：`StorageService` —— 分组、形状校验、变更通知都在这一层。
- **后端**：`JsonBackend`（一条记录一个文件，人能打开看）、`SqliteBackend`（一条记录一行，适合点改多）。

这一族**不暴露给模型**：不注册工具、不进提示词。模型通过工具间接用上它就够了。

```ts
import { JsonBackend, StorageService } from '@ryharness/storage'

const service = new StorageService({ backends: [new JsonBackend({ root: '/path/to/data' })] })
service.domain<{ name: string; rootPath: string }>('workspace', {
  fields: { name: { type: 'string' }, rootPath: { type: 'string' } },
})

const record = service.put('workspace', 'w1', { name: '我的项目', rootPath: '/home/me/proj' })
service.subscribe((event) => console.log(event.type, event.kind, event.id))
```

## 记录与分组

一条记录是 `{ id, kind, data, createdAt, updatedAt }`：

- `kind` 是分组名（工作区记录、配置片段各占一个），`id` 在同一个 kind 内唯一。
- `createdAt` / `updatedAt` 是毫秒时间戳。**覆盖写时 `createdAt` 不动**——「什么时候建的」和「什么时候改的」是两件事，混成一个就答不上来。
- `data` 必须能 JSON 序列化。

```ts
service.put('workspace', 'w1', data)   // 写一条
service.get('workspace', 'w1')          // 取一条，没有就是 undefined
service.list('workspace')               // 列这个 kind 下的全部记录（按创建时间、再按 id 排）
service.remove('workspace', 'w1')       // 删一条，本来就没有也算成功（幂等）
service.kinds()                         // 列当前存着的全部分组
```

## 形状校验：存进去的东西自己知道该长什么样

给某个 kind 声明形状，之后**所有**写向它的入口都受管着——校验放在服务这一层而不是视图里，绕过视图写进去也照样被拦。

两条规矩：

1. **声明了的字段**：缺了要报错（除非标 `required: false`），类型不对要报错，报错时说得清是哪个字段、实际是什么类型。
2. **没声明的字段**：也要报错。形状是**白名单**而不是黑名单——拼错的字段名悄悄存进去，几个月后没人知道它为什么不对。

```ts
service.domain<WorkspaceData>('workspace', {
  fields: {
    name: { type: 'string' },
    rootPath: { type: 'string' },
    sessions: { type: 'array', required: false },   // 可选字段
  },
})

service.put('workspace', 'w1', { name: '项目' })
// StorageValidationError: kind「workspace」的字段「rootPath」缺少必填字段
```

需要自己看全部问题时用 `checkShape`（返回问题清单，不抛错）；`assertShape` 是「不合格就抛」的版本。

## 变更通知

写入与删除之后通知订阅者，宿主据此刷新界面：

```ts
const unsubscribe = service.subscribe((event) => {
  // event.type: 'created' | 'updated' | 'deleted'
  // event.kind / event.id / event.record（删除时没有 record）
})
unsubscribe()
```

事件在**落盘之后**发出。删一条本来不存在的记录不发事件。

## 两种后端怎么选

| | `JsonBackend` | `SqliteBackend` |
|---|---|---|
| 落盘形状 | `<根目录>/<kind>/<id>.json`，一条记录一个文件 | 一个数据库文件，记录是一行 |
| 写入方式 | 临时文件 + rename（原子） | 单条 `INSERT ... ON CONFLICT` 事务 |
| 并发 | 靠原子写：读的人不会看见半条记录 | WAL：读写不互相阻塞；`busy_timeout` 让写锁被占时等一会儿 |
| 适合 | 记录少、要能手工打开看/改 | 记录多、以「点改单条」为主 |
| 依赖 | 无 | Node 22.13+ 内置的 `node:sqlite`，不引外部依赖 |

**默认选 JSON**：记录量是「配置 + 工作区」这个量级，人能直接打开看比性能重要。记录多到几千条、或者写入频繁时再换 SQLite。

两个后端行为一致（同一串增删改给出同样的结果），所以换后端不用改业务代码。

路由：多后端时按 kind 指给某一个，没指过的走第一个注册的后端。

```ts
const service = new StorageService({
  backends: [new JsonBackend({ root: '/data' }), new SqliteBackend({ file: '/data/records.db' })],
  routes: { workspace: 'sqlite' },
})
```

## 边界

- **本包不碰会话数据**。会话归 `packages/session`。
- **不暴露给模型**。不注册工具、不进提示词、不产生会话事件。
- **同步接口**。后端都是同步的（文件与 SQLite 的同步 API），异步只会让调用方多 `await` 一次。真要接远端 KV，包装成 `StorageBackend` 实现即可，业务层不用动。
- **JSON 后端的文件名是编码过的**：kind 与 id 里除字母数字、`-`、`_` 以外的字符按 UTF-8 字节百分号编码，前面加 `_` 前缀（躲开 Windows 的 `CON`/`NUL` 这类保留名）。`encodeSegment` / `decodeSegment` 可逆，从目录名能反推回 kind。
- **写坏了不静默**。落盘的东西读不出来时抛 `StorageCorruptError`（带路径），不自动丢弃——重写会把现场抹掉，得让人先看一眼现场。形状不对抛 `StorageValidationError`（带 kind 与字段名），那是调用方的 bug，改数据重写就行。
- **两种错误不要混**：一个是「你写错了」，一个是「盘上的东西坏了」。

## 导出

| 导出 | 一句话 |
|---|---|
| `StorageService` | 服务本体：分组、形状校验、变更通知、后端路由 |
| `StorageServiceOptions` | 服务的配置（后端清单、路由表、时钟） |
| `StorageChangeListener` | 变更订阅者的类型 |
| `StorageDomain` | 某个 kind 的带类型视图（把 `TData` 固定下来） |
| `JsonBackend` / `JSON_BACKEND_NAME` | JSON 文件后端 / 它的名字 |
| `JsonBackendOptions` | JSON 后端的配置（根目录） |
| `SqliteBackend` / `SQLITE_BACKEND_NAME` | SQLite 后端 / 它的名字 |
| `SqliteBackendOptions` | SQLite 后端的配置（数据库文件，`:memory:` 是内存库） |
| `encodeSegment` / `decodeSegment` | 文件名片段的可逆编码 |
| `checkShape` | 按形状检查一份数据，返回全部问题 |
| `assertShape` | 按形状检查，不合格就抛 `StorageValidationError` |
| `matchesType` | 一个值是否符合声明的类型 |
| `describeType` | 值的类型名（错误文案用） |
| `isPlainObject` | 是不是普通对象（不是数组、不是 null） |
| `StorageValidationError` | 写进去的数据不符合形状（带 kind、字段名、原因） |
| `StorageCorruptError` | 落盘的东西读不出来（带路径） |
| `StorageRecord` | 一条记录的形状 |
| `StorageBackend` | 后端契约 |
| `DomainShape` / `DomainField` / `DomainFieldType` | 形状声明 |
| `StorageChangeEvent` / `StorageChangeType` | 变更事件 |
