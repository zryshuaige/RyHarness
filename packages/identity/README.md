# @ryharness/identity

一次安装一个匿名 id。

这个 id 只干一件事：让「从同一个安装发出去的东西」能被认出是同一份。
遥测、反馈、请求头都可以挂它。

```ts
import { defaultDataDir, IdentityStore } from '@ryharness/identity'

const store = new IdentityStore({ dataDir: defaultDataDir() })
const { id, createdAt } = store.ensure()
// id 同一个安装一直是同一个；createdAt 是它生成的时间
```

## 不含任何个人信息

id **只**来自系统随机源（`crypto.randomBytes`），24 字节随机，base64url 编码成 32 个字符。

不掺任何别的东西：

- 不取用户名
- 不取机器名
- 不取 MAC 地址
- 不取时间戳、不取路径、不取任何设备信息

掺进来的每一样都会让「这台机器」的信息跟着 id 跑到外面去。机器上换个用户、换张网卡、
改个主机名，它都一样。

字符集只有 `A-Za-z0-9-_`，可以直接放进 URL、查询串、HTTP 头，不用转义。

## 生命周期

| 操作 | 行为 |
|---|---|
| `read()` | 只读。文件不在、读不出来、内容不是一份身份，都给 `undefined`。 |
| `ensure()` | 读不到就生成一个并落盘。**同一个安装反复调拿到的是同一个 id。** |
| `reset()` | 把文件删掉，重新生成一个（当作一次全新安装）。 |

id 文件落在应用数据目录里（`<dataDir>/installation-id.json`），里面只有三样东西：

```json
{
  "version": 1,
  "id": "…",
  "createdAt": 1700000000000
}
```

**删掉那个文件，下一次 `ensure()` 就是一个新的 id。** 这是「重装一次」的效果，
不是 bug。

## 数据目录在哪

按平台惯例找（`defaultDataDir`）：

| 平台 | 位置 |
|---|---|
| Windows | `%APPDATA%\RyHarness` |
| macOS | `~/Library/Application Support/RyHarness` |
| 其它（Linux 等） | `$XDG_DATA_HOME/RyHarness`，没设就用 `~/.local/share/RyHarness` |

找的是「用户自己的数据目录」，不是程序安装目录——安装版里程序目录是只读的，
而 id 这种要写的东西得落在用户手里。

## 边界

- **本包不发任何网络请求**，也不注册工具、不进提示词。挂不挂、挂到哪儿，由宿主决定。
- **id 不是凭据**。它不能登录、不能授权、不能代表任何人。它只是「同一份」的标记。
- **文件坏了就重新生成**。这里放的是关联用的 id，不是要紧的数据——为它拦住整个
  应用启动不划算。旧 id 可能已经发到外面去了，重生成不会让它作废。
- **写入走「临时文件 + rename」**：崩在写一半时留下的是一份完整的旧数据，不是半份 JSON。

## 导出

| 导出 | 一句话 |
|---|---|
| `IdentityStore` | 身份存储：`read()` / `ensure()` / `reset()` |
| `IdentityStoreOptions` | 配置（数据目录、文件名、id 生成器、时钟） |
| `InstallationIdentity` | 这次安装的身份（`id` 与 `createdAt`） |
| `generateAnonymousId` | 生成一个匿名 id（可注入随机源） |
| `isValidAnonymousId` | 这个 id 合不合法 |
| `RandomBytes` | 随机源的形状 |
| `defaultDataDir` | 按平台惯例算应用数据目录 |
| `APP_DIR_NAME` | 数据目录的应用名（`RyHarness`） |
| `IDENTITY_FILE_NAME` / `IDENTITY_FILE_VERSION` | id 文件名与文件结构版本 |
| `ANONYMOUS_ID_BYTES` / `ANONYMOUS_ID_LENGTH` | 随机字节数与 id 长度 |
| `ANONYMOUS_ID_MIN_LENGTH` / `ANONYMOUS_ID_MAX_LENGTH` | 合法 id 的长度区间 |
