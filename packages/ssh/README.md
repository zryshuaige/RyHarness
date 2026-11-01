# @ryharness/ssh

在另一台 POSIX 机器上跑命令、读写文件。分三块：

- **连接契约**（`SshConnection`）：有哪些操作、失败长什么样。宿主可以自己实现。
- **命令行后端**（`CliSshConnection`）：用本机的 `ssh` 可执行文件跑远程命令，不引 ssh2 这类原生模块。
- **边界**：路径默认关在远端根目录里、主机名不许被 ssh 当成选项注入、凭据不进 argv。

上游对照：dsh 的 `ssh` / `fs-ssh` / `subprocess-ssh` / `sandbox-ssh` 四个包（一条 OpenSSH 连接
共用）。本轮合成「一个连接契约 + 一个命令行后端」，沙箱那层退化成路径围栏。

## 怎么用

```ts
import { CliSshConnection } from '@ryharness/ssh'

const connection = new CliSshConnection({
  host: 'deploy@example.com',
  port: 22,
  // 远端根目录：所有文件操作都被关在这里面
  root: '/srv/workspace',
  // 凭据由宿主给；不给就是 ssh-agent / 默认密钥
  credential: { kind: 'key', identityFile: '/home/me/.ssh/id_ed25519' },
  defaultTimeoutMs: 30_000,
})

await connection.exec('ls -la', { cwd: 'reports' })
await connection.writeFile('notes/a.txt', '你好')
const bytes = await connection.readFile('notes/a.txt')
const entries = await connection.list('notes')
await connection.close()
```

命令是**交给远端 shell 解释的字符串**（不是 argv），所以 `&&`、管道、重定向都能用；`--` 之后
的一切都归远端，所以命令里带 `-` 开头的词不会被 ssh 当成自己的选项。

### 密码怎么给

密码**不进 argv**——argv 在 Linux 上是全局可读的（`ps aux` 就看得见），塞进去等于公开。做法是
让 ssh 走 askpass 助手：助手路径进 argv，密码进子进程的环境。

```ts
new CliSshConnection({
  host: 'example.com',
  credential: {
    kind: 'password',
    password: '从宿主自己的凭据存储里取',
    askpass: '/opt/ryharness/askpass.sh', // 宿主自己准备的助手
  },
})
```

助手要做的事很简单：把环境变量 `RY_SSH_PASSWORD`（可用 `passwordEnv` 改名）打到 stdout。
`SSH_ASKPASS_REQUIRE=force` 依赖 OpenSSH ≥ 8.4；更老的版本在没有 tty 时才会用 askpass。

私钥只传**路径**（`-i`），不传密钥内容——路径不是秘密。

## 边界

| 边界 | 口径 |
|---|---|
| 主机名 | 以 `-` 开头、含 `=`、含空白或控制字符的一律拒绝（否则 `-oProxyCommand=...` 就是一条注入路径） |
| 远端路径 | 给了 `root` 之后按 POSIX 规则归一化并检查；`../` 跑不出去，报 `PATH_OUTSIDE_ROOT` |
| 凭据 | 密码走环境 + askpass，私钥只传路径；两者都不进 argv |
| 超时 | 到点杀本地 ssh 的**整棵进程树**，再报 `TIMEOUT`（不等远端自己结束） |
| 取消 | 同超时，报 `CANCELLED` |
| 输出 | stdout / stderr 各自有上限，超了截断并标 `stdoutTruncated` / `stderrTruncated` |
| 环境 | 只给 ssh 客户端自己要用到的那几项（白名单），模型服务的 key 不在里面 |

### 失败分类（机器码）

| 码 | 什么时候 |
|---|---|
| `CONNECT_FAILED` | 连不上（DNS、路由、端口不通），或 ssh 自己以 255 退出且看不出别的原因 |
| `AUTH_FAILED` | 连上了但认证没过 |
| `COMMAND_NOT_FOUND` | 远端没有这个命令（退出码 127） |
| `REMOTE_FAILED` | 命令跑了但退出码非零（可以用 `rejectOnNonZeroExit: false` 放过去） |
| `REMOTE_NOT_FOUND` | 远端目录不存在 |
| `CONNECTION_LOST` | 连接中途断了——**不是**「命令没输出」，是「没跑完」 |
| `CONNECTION_CLOSED` | 连接已经关了 |
| `TIMEOUT` / `CANCELLED` | 到了时限 / 被取消 |
| `PATH_OUTSIDE_ROOT` | 路径越出了远端根目录 |
| `INVALID_HOST` | 主机名不合法 |
| `SSH_CLIENT_MISSING` | 本机没有 ssh 客户端 |
| `INVALID_ARGUMENT` / `IO_FAILED` | 参数不合法 / 本地 IO 失败 |

## 明确不做

| 不做 | 为什么 |
|---|---|
| ssh2 / 任何 SSH 库 | 原生模块：跨平台分发与打包代价太大。走命令行反而更好审计 |
| 密钥管理 | 凭据由宿主给（本包只负责「不把它放进 argv」） |
| 端口转发 | 这一轮不需要 |
| 长连接 | 命令行后端每次操作起一个 ssh 进程；没有「连接悄悄挂死」的问题，但也没有复用 |
| 远端沙箱 | 上游有 `sandbox-ssh`（远端文件效果围栏）；本轮退化成**路径围栏**（`root`） |
| 真 PTY | 交互式终端归 `packages/terminal` |
| 保证远端命令跟着死 | 超时杀的是**本地** ssh 进程树；远端那条命令通常会收到 SIGHUP，但没人保证 |

## 远端要求

- 有 `ssh` 客户端（本机）。
- 远端有 `base64`（文件传输靠它）。macOS 自带的 base64 解码要用 `-D`，可以用
  `base64DecodeFlag: '-D'` 改。
- 列目录用的是一段纯 POSIX 的 shell 脚本，不依赖 `ls -p`、`find -printf` 这些各家不一样的选项。
  已知限制：名字里带制表符或换行的文件会把输出解析乱（极少发生）。

## 导出

| 导出 | 一句话 |
|---|---|
| `SshConnection` | 连接契约：`exec` / `writeFile` / `readFile` / `list` / `close` |
| `CliSshConnection` | 用本机 `ssh` 实现的连接 |
| `SshError` / `isSshError` / `SshErrorCode` | 带机器码的错误与判定 |
| `SshConnectionConfig` 等类型 | 连接配置、凭据、选项、结果 |
| `resolveRemotePath` / `normalizeRemotePath` / `isInsideRoot` | 远端路径归一化与根目录围栏 |
| `validateSshHost` / `buildSshTarget` / `userFromHost` | 主机名校验与目标串拼装 |
| `shellQuote` / `buildReadCommand` / `buildWriteCommand` / `buildListCommand` | 远端命令拼装（引号化、base64 管道、列目录） |
| `parseListOutput` / `decodeBase64Payload` | 远端输出解析 |
| `classifyRemoteFailure` / `errorCode` | 失败分类与错误码读取 |
| `killProcessTree` / `defaultSpawn` | 进程树回收与起进程（可注入，测试用） |
| `SSH_ENV_ALLOWLIST` / `DEFAULT_MAX_OUTPUT_BYTES` | 环境白名单与输出上限默认值 |

## 测试

```sh
npx vitest run packages/ssh
```

测试里用一个**假的 ssh 客户端**（真的进程，不联网）：它把 argv、关键环境变量与 stdin 录下来，
并按剧本输出。所以断言的是外部可见的事实——命令行长什么样、密码在不在 argv 里、退出码对不对、
超时有没有把进程收掉。
