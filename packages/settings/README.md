# @ryharness/settings

插件配置表单：把每个插件自己的配置 schema 变成**能填的表单**，改完热生效。

上游对照：dsh 的 `settings/`（Config 投影与带版本号的表单编辑）。上游的分工是「active
profile 存改动，Loader 负责应用」；本包把三块收在一个服务里：描述符、校验与版本化、
落盘与热生效。

本包**不碰插件宿主**（插件怎么把 schema 交过来、界面怎么接，由宿主决定），也**不碰
密钥**（插件配置里的密钥归宿主那个加密存储管）。

## 一段 schema 推出一组描述符

schema 是自己写的一小份形状，不引 JSON Schema 库：

```ts
import { describeSchema, type SettingsSchema } from '@ryharness/settings'

const schema: SettingsSchema = {
  type: 'object',
  properties: {
    verbose: { type: 'boolean', title: '打印调试日志', default: false },
    timeout: { type: 'number', title: '超时（毫秒）', default: 30_000, minimum: 1, maximum: 600_000 },
    mode: { type: 'select', title: '运行模式', enum: ['fast', 'safe'], default: 'safe' },
    token: { type: 'string', title: '令牌', format: 'password' },
    nested: {
      type: 'object',
      properties: { enabled: { type: 'boolean', title: '嵌套开关' } },
    },
  },
}

describeSchema(schema)
// → [{ key: 'verbose', label: '打印调试日志', type: 'boolean', default: false }, …]
```

- **控件类型**：`boolean` / `string` / `number` / `select` / `password`。
  `type: 'string'` + `format: 'password'` 是口令框；`type: 'string'` + `enum` 当下拉处理。
- **嵌套对象摊平**成点号键路径（`nested.enabled`）：界面上的每个输入框只需要知道自己
  对应配置里的哪一个位置。
- **中文名**取 `title`；没给就用键的最后一段。
- **画不出来的 schema 会当场报错**（`INVALID_SCHEMA`）：下拉没给候选值、对象没给子项。

## 服务：登记、校验、版本化、热生效

```ts
import { SettingsService } from '@ryharness/settings'

const service = new SettingsService({
  store: new FileSettingsStore({ filePath: `${dataDir}/config/plugin-settings.json` }),
  // 把新值应用到活着的插件上（热生效）
  apply: async (pluginId, values) => {
    await plugins.get(pluginId)?.applyConfig(values)
  },
})

service.register('web', schema) // 初值：schema 默认值 → 宿主给的值 → 落盘里的值
service.list() // 全部插件的「描述符 + 当前值 + 版本号」
await service.update('web', { values: { timeout: 5000 }, revision: 0 })
```

### 校验错要说清是哪个字段

```
字段 "timeout" 类型不对：期望 number，实际是 string
字段 "mode" 不在候选里：只能是 fast / safe，收到 "turbo"
字段 "timeout" 太小了：不能小于 1，收到 0
没有这个配置项："timout"
```

改了**不存在的**配置项也要拦：拼错键名时如果放过去，用户会以为改生效了，其实什么
都没改。

### 版本对不上就报冲突，不静默覆盖

每次改完版本号 +1。提交编辑时把看到的版本号带上，对不上说明别人（另一个标签页、
另一台机器）已经改过——这时候报 `CONFLICT`，让界面重新拉一遍，而不是把人家的改动
盖掉。

### 应用失败就回滚

`apply` 回调抛错时值退回原来的，版本号也退回去。否则界面显示新值、插件还跑着旧值，
用户会以为改了没用，于是反复点。

落盘失败同理：值退回去，并尽力把旧值重新应用到活着的插件上。

## 落盘

改动落在一个 JSON 文件里（`FileSettingsStore`），写入走「临时文件 + rename」：崩在写
一半时留下的不是半份 JSON，而是一份完整的旧数据。读的时候坏文件当没有——一份配置
不该挡住启动。

落盘的是**明文的配置值**（超时几秒、要不要开日志），不是密钥。

还没登记的插件，它的落盘状态不会被下一次保存抹掉：插件登记的先后顺序不固定。

## 导出

| 导出 | 一句话 |
|---|---|
| `SettingsService` | 配置表单服务（`register` / `list` / `get` / `update` / `unregister`） |
| `describeSchema` | 从 schema 推出一组描述符 |
| `defaultValues` | schema 里的默认值表 |
| `validateValues` | 按描述符校验一份改动，返回每一处不过的地方 |
| `acceptsValue` | 这个描述符认不认这个值 |
| `SettingsError` | 领域错误（`VALIDATION` / `CONFLICT` / `APPLY_FAILED` / …） |
| `MemorySettingsStore` / `FileSettingsStore` | 配置的存取后端 |
| `SettingsDescriptor` / `SettingsPluginView` / `SettingsUpdate` / `SettingsValues` | 类型 |

## 边界

- 不认识插件、不管插件怎么挂载：宿主把 schema 交过来，本包只管描述符、校验与落盘。
- 不替界面画表单：只给描述符，控件由界面自己选。
- 不管密钥：配置里的密钥归宿主的加密存储管。
