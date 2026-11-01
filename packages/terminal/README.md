# @ryharness/terminal

让助理能**保持一个交互式 shell 活着**，跨多次工具调用接着用：工作目录、环境变量、已经起着的子进程都还在。

一次性命令和持久会话是两回事。`shell_exec` 跑完就退出，`cd` 的结果、`export` 的变量、还在跑的后台进程全没了；要装依赖、起 dev server、反复调一个 REPL，就得有一个**活着的** shell。

这一族分两层：

- **`TerminalService`**：会话归谁、别人能不能碰、关的时候有没有等干净。
- **`TerminalBackend`**（本包自带 `LocalShellBackend`）：怎么把 shell 起来、怎么知道它真的就绪了、怎么把输出读出来。

上游 dsh 把这两层分成 `terminal` 与 `terminal-bash` 两个包；这里合成一个，公共面从同一个文件导出。

## 快速上手

```ts
import { LocalShellBackend, TerminalService } from '@ryharness/terminal'

const service = new TerminalService({ backends: [new LocalShellBackend({ dialect: 'pwsh' })] })

const session = await service.open('agent-1', { cwd: 'C:/work' })
await service.send('agent-1', session.id, 'npm install')

// 读是增量的：读一次拿一段新输出，不是「剩下的全部」。
let output = ''
for (;;) {
  const chunk = await service.read('agent-1', session.id, { waitMs: 500 })
  output += chunk.text
  if (!chunk.truncated && chunk.remainingBytes === 0) break
}

await service.close('agent-1', session.id)
```

只想发一条命令、不需要会话归属，直接用后端也行：

```ts
const backend = new LocalShellBackend({ dialect: 'bash' })
const shell = await backend.open({ sessionId: 'scratch' })
await shell.send('echo hello')
const out = await shell.read({ waitMs: 1000 })
await shell.close()
```

## 边界（先看这一节）

**Windows 上没有真 PTY。** node-pty 是原生模块，本项目不引，所以本地后端走**管道模式**：shell 的 stdin/stdout 用普通管道接着。能力声明里写死了这一条：

```ts
backend.capabilities.realPty // false
backend.capabilities.fullScreenInteractive // false
```

管道模式能做的：

- 跨多次调用保留工作目录与环境变量（`cd`、`export` 都留在那个 shell 里）。
- 逐条执行命令、读回增量输出。
- 用一条探针命令确认 shell 真的就绪了（不是「发完就算 ready」）。

管道模式做不到的，**每一条都是实测出来的**：

| 想干的事 | 实际结果 | 正确的做法 |
|---|---|---|
| 写 `\x03` 打断正在跑的命令 | **没用**。管道没有 tty 的行规程，`\x03` 只是被 shell 当输入收下，前台命令照跑不误 | 调 `interrupt()`：终止前台那个命令进程 |
| 写 `\x04` 表示 EOF | **不是 EOF**。shell 还活着，而且这个字节会留在 shell 的输入行里，把紧接着的那条命令弄坏（实测：下一条命令不报错，但也不执行） | 调 `closeInput()`：关掉 stdin，那才是真 EOF |
| 跑 `vim`、`top` 这类全屏程序 | **跑不了**。没有真 PTY，程序会等一个永远不会来的 tty | 换非交互写法（`vim -c 'cmd' -c 'q'` 之类），或换真 PTY 后端 |
| 在管道里发一条语法错的 bash 命令 | **不带 `-i` 的 bash 会直接退出**（实测退出码 2），会话当场没了 | 本包一律带 `-i` 起 bash：它报完语法错还活着 |

### 中断到底怎么杀

管道模式下没有作业控制，shell 不会告诉你「现在前台跑的是哪个 pid」。本包的做法是**去进程树上找**：

1. 列出 shell 的整棵后代树（Windows 用 PowerShell 的 CIM 查询，`wmic` 在新系统上已被移除；POSIX 用 `ps`）。
2. **只杀最深的那一层**（叶子）。
3. **控制台宿主不算命令**：`conhost.exe` 也是 shell 的子进程、也是叶子，但杀掉它 shell 自己会跟着没。

第 2、3 条都是被实测逼出来的：

| 杀掉什么 | pwsh | Git Bash |
|---|---|---|
| 最深的叶子（`PING.EXE`） | shell 活着，下一条命令正常执行 | shell 活着，下一条命令正常执行 |
| 中间那层（Git Bash 为每条命令 fork 的 `bash.exe`） | —— | **shell 直接死掉**（带 `/T` 和不带 `/T` 都一样） |
| 控制台宿主 `conhost.exe` | **shell 直接退出**，连下一条命令的输出都收不到 | 进程还在，但变成一个收不到任何输出的空壳 |

所以「只杀叶子、且跳过控制台宿主」是唯一在两个方言上都成立的规则。代价是：命令自己 fork 出来的中间进程不会被一起杀掉（只杀最深的那个）。

### 方言差异

同一个后端要同时伺候 bash 与 pwsh，它们的命令行语法并不一样。这些差异收在 `ShellDialect` 里，上层看不见，但**写命令的人得知道**：

| | bash | pwsh |
|---|---|---|
| 环境变量 | `export FOO=bar`、`echo $FOO` | `$env:FOO='bar'`、`Write-Output $env:FOO` |
| 当前目录 | `pwd`（MSYS 给 POSIX 形式，如 `/c/Windows`）；`pwd -W` 给 Windows 形式（`C:/Windows`） | `(Get-Location).Path` 给 Windows 形式（`C:\Windows`） |
| 切目录 | `cd X && pwd \|\| echo RY_CD_FAILED` | `Test-Path` + `Set-Location` |
| 语法错 | 报完继续活着（因为带 `-i`） | 报 `ParserError`，继续活着 |
| 输入回显 | `bash -i` 会把敲进去的命令原样写回 stderr（已滤掉） | 不回显 |

路径比较用 `normalizeShellPath()` 归一：斜杠统一、去掉末尾斜杠、Windows 上忽略大小写。

## 归属与围栏

会话服务这一层只管归属与生命周期，不管 shell 怎么跑。

- **不透明 id**：随机十六进制串，不含 owner、不含时间戳、不含序号。从 id 看不出「这是谁的会话」。
- **精确 owner 围栏**：逐字比对。`"agent-1"`、`"agent-1 "`、`"Agent-1"` 是三个不同的 owner——不做 trim、不做大小写折叠、不做前缀匹配。拿不准就当不是同一个。
- **不泄露存在性**：`get()` 一个不存在的 id 与一个别人的 id，报同一个错（`NO_SESSION`），免得变成探测 id 是否存在的侧信道。
- **等待式清理**：`close()` 要等进程**真的退出**才返回；`disposeAll()` 把所有会话收干净。返回时进程还在，就是没关干净。
- **不跨重启存活**：会话活在内存里，进程重启就没了。

## 输出是有界的

输出是无界的（一条 `yes` 就能刷出无限字节），所以：

- 缓冲区最多留 256 KiB，超了丢最旧的。
- 一次 `read()` 最多返回 64 KiB。
- 每次读都报 `remainingBytes`（还剩多少没读）与 `droppedBytes`（因为总量上限丢了多少）。

不说清楚，调用方就会把截断过的输出当成完整输出——这是最常见的误用。

## 上游对照

上游 dsh 的 `terminal/` 是一个能力家族：`terminal/`（会话服务，`ctx.terminals`）与 `terminal-bash/`（shell 后端）。

| 上游 | 本包 | 说明 |
|---|---|---|
| `terminal/` 会话服务 | `TerminalService` | 同样是不透明 id + 精确 owner 围栏 + 等待式清理。上游挂在 cordis 的 `ctx.terminals` 上，本包是零依赖的普通类，由宿主接线 |
| `terminal-bash/` shell 后端 | `LocalShellBackend` | 同样有就绪探测与有界输出。上游用真 PTY，本包是**管道模式**（node-pty 是原生模块，本项目不引） |
| 后端跑在**沙箱策略**下 | **不做** | 本包只管终端会话，不带沙箱围栏；沙箱归 `packages/sandbox` |
| `terminal-bash/src/sanitize.ts`（命令清洗） | **不做** | 本包不解析也不改写命令，只负责把文本送进 shell |
| `terminal-bash/src/config.ts`（后端配置） | `LocalShellBackendOptions` | 本包用构造参数，不读配置文件 |
| 真 PTY（`@xterm/headless` + node-pty） | **不做** | 原生模块，本轮不背；能力位如实报 `realPty: false` |
| 多语言 locale 文件（`locale/*.json`） | **不做** | 本包不产出面向用户的文案 |

## 导出

| 导出 | 一句话 |
|---|---|
| `TerminalService` | 会话服务：归属、围栏、不透明 id、等待式清理 |
| `LocalShellBackend` | 本地 shell 后端（管道模式） |
| `TerminalBuffer` | 有界输出缓冲：总量上限、单次上限、截断说明 |
| `TerminalError` / `isTerminalError` | 带稳定错误码的终端错误（`NO_SESSION`、`CLEANUP_FAILED` …） |
| `BASH_DIALECT` / `PWSH_DIALECT` / `dialectOf` | 两个方言的命令写法 |
| `shellQuote` | 按方言给值加引号 |
| `normalizeShellPath` | 把两个方言报的路径归一成可比较的 |
| `stripAnsi` | 去掉 ANSI 转义序列 |
| `isInputEcho` / `isBashStartupNoise` | 认 stderr 里的输入回显与 bash 启动噪声 |
| `isConsoleHost` | 认控制台宿主（`conhost.exe` / `openconsole.exe`）：它不是命令 |
| `findDescendantPids` | 列进程树：所有后代、最深的叶子、每个后代的名字 |
| `runCapture` | 跑一条命令把标准输出收回来 |
| `PIPE_MODE_CAPABILITIES` | 管道模式的能力声明 |
| `shellCandidates` | 某个方言下可用的 shell 候选（按优先级） |
| `DEFAULT_BUFFER_MAX_BYTES` / `DEFAULT_MAX_READ_BYTES` | 缓冲与单次读取的默认上限 |
| 类型：`TerminalBackend` / `TerminalBackendSession` / `TerminalBackendCapabilities` / `TerminalBackendSpec` / `TerminalSession` / `TerminalSessionState` / `TerminalCreateRequest` / `TerminalOwner` / `TerminalReadResult` / `TerminalTruncationReason` / `TerminalShellDialect` / `TerminalErrorCode` / `TerminalBufferOptions` / `LocalShellBackendOptions` / `TerminalServiceOptions` / `ShellDialect` / `ProcessTree` | 契约 |

## 已知边界

- **没有真 PTY**：跑不了 `vim`、`top`；Ctrl-C / Ctrl-D 都不能用控制字符表达。
- **中断只杀最深叶子**：命令自己 fork 出来的中间进程会留下（只杀最深的那个）。
- **一条会话同时只允许一次发送**：两次并发写进同一条 stdin，输出会交错，谁是谁的就分不清了（`SEND_ACTIVE`）。
- **`send()` 不追加标记**：管道模式下 shell 从 stdin 逐行读命令，往里塞标记会混进 REPL（比如 python）的输入，把会话弄坏。要确认「跑完了」就用 `read()` 读输出。
- **会话不跨重启存活**：进程重启就没了。
- **切目录失败会报错**：目录不存在时 shell 报个错但会话还活着，调用方必须知道到底成没成，所以失败时 `changeDirectory()` 直接 reject，不假装切过去了。
- **stdout 与 stderr 合并**：管道模式下两条流汇到同一个缓冲，顺序以到达为准。
- **`\x04` 会污染下一条命令**：想发 EOF 就用 `closeInput()`，别写 `\x04`。
