# @ryharness/subprocess

全仓库跑起来的每一个子进程——bash 命令、语言服务器、持久 shell、进程外子代理后端——都从这一处
启动、观测、终止。

它只回答三件事：**这个可执行文件在哪儿**、**这个进程怎么起来**、**这个进程怎么被收掉**。
「这个命令是什么意思」不归它管：命令语义、该不该给模型看超时、结果怎么排版，那是 shell 工具、
terminal、lsp 各自的事。混在一起的后果很具体——一条超时说不清是谁的锅，最后谁都不敢超时。

```ts
import { SubprocessService } from '@ryharness/subprocess'

const service = new SubprocessService()

const proc = service.spawn({
  command: 'git',
  args: ['status', '--short'],
  timeoutMs: 10_000,
})
const result = await proc.done

console.log(result.status) // 'completed' | 'failed' | 'timeout' | 'aborted' | 'terminated'
console.log(result.stdout) // 最多 64 KiB，超了会截断并标 truncated
```

## 边界（先看这一节）

| 做什么 | 不做什么 | 为什么 |
|---|---|---|
| 启动、观测、终止子进程 | 不解释命令语义 | 语义归消费方；本包只管进程本身 |
| 找可执行文件 | 不做 shell 语法解析 | `&&`、管道、重定向是 shell 工具的事 |
| 环境清洗 | 不管理凭据 | 凭据放不放进去由调用方点名，本包只负责**不默认带出去** |
| 按父子关系回收进程树 | **不做 Win32 原生绑定** | Job Object、受限令牌要原生代码（FFI / 编译产物），本轮不背这个 |
| 有界的输出捕获 | **不做 spill 落盘** | 上游有 `spill` 家族；本包只截断，不替别的包存文件 |
| 子进程 stdio（pipe） | **不做真正的 PTY** | 伪终端归 `packages/terminal`，本包不碰 |

### 降级披露

provider 做不到什么**必须说出来**，因为宿主要拿这些话决定能不能把「进程树已经收干净」说出口。

本轮的本机 provider：

- **Windows**：`taskkill /T /F` 按父子关系枚举回收。**没有 Job Object**（原生绑定，本轮不做），
  所以「整组原子托管」是模拟的：逐个记着、逐个收。父进程先死、或子进程被挂到别的父进程下时，
  那部分收不到。
- **POSIX**：子进程单独成组，`kill(-pgid)` 一次收掉整组。**没有 cgroup**，子进程自己 `setsid`
  脱离进程组之后就管不到了。

这些说明写在 `provider.capabilities.notes` 上，也会挂到进程范围的 `notes` 上，界面别把它们显示成
同一种强度。

## 四块能力

### 1. 可执行查找

按名字在 **候选目录 → PATH** 里找可执行文件，找不到时给结构化错误（不抛裸异常）。

```ts
const found = resolveExecutable({ name: 'git', candidates: ['C:\\tools\\git\\bin'] })
if (!found.found) console.error(found.message) // 「在 1 个候选目录与 12 个 PATH 目录里都找不到…」
```

- **Windows**：认 `.exe` / `.cmd` / `.bat` / `.ps1`，另外把宿主 `PATHEXT` 里的扩展名一并认上。
- **POSIX**：只认绝对路径与 PATH 里的同名文件，并且要看执行位——没有执行位的文件对 shell 来说
  不是命令。

### 2. 托管 spawn

`spawnManaged`（本机 provider 的便捷入口）或 `SubprocessService.spawn` 启动的进程都受管：

- **输出有界**：stdout / stderr 各自设上限（默认 64 KiB），超了截断并标 `truncated`，
  总字节数照实记在 `stdoutBytes` / `stderrBytes` 上。一个 `cat` 大文件不该把宿主内存吃穿。
- **超时与取消**：接 `AbortSignal`，到点收掉进程，结果是结构化的 `timeout` / `aborted`。
- **进程树回收**：父进程被收时，子进程与孙子进程一起收（Windows `taskkill /T`、POSIX 进程组）。
  收不掉时也有兜底：2 秒后照样把结果交出去，不让调用方无限期地等一个收不掉的进程。

```ts
const controller = new AbortController()
const proc = service.spawn({ command: 'npm', args: ['run', 'dev'], signal: controller.signal })
controller.abort()
const result = await proc.done // status: 'aborted'
```

### 3. 环境清洗

子进程**只**拿到白名单里的那几项（`PATH` / `HOME` / `TEMP` / `LANG` / `SystemRoot` …），
其余一律不传——模型服务的 key 若在宿主环境里，被 `echo $KEY` 就读走了。

```ts
const { env, inherited, blocked } = scrubEnvironment({
  base: process.env,
  extra: { RY_TRACE: 'on' }, // 调用方明确要追加的，原样传
})
```

- 白名单里但**名字像密钥**的（`*_API_KEY`、`*_TOKEN` …）也不传，并且记进 `blocked`——被拦下来
  这件事要能被看见，不然调用方会以为「传了呀」。
- `extra` 是显式意图，原样传下去。

### 4. 进程范围

一组进程归谁管：整体查活、整体终止。

```ts
const range = service.createRange('这一轮的任务')
const proc = service.spawn({ command: 'node', args: ['server.js'], rangeId: range.id })
await range.terminate('这一轮结束了') // 组里还活着的进程一起收
```

范围上的 `support` 字段说明托管档位：`native`（原生托管）/ `emulated`（模拟）/ `none`（管不了）。
本机 provider 现在是 `emulated`。

## provider 抽象

换宿主（容器、远端）时实现同一个接口就行：

```ts
interface SubprocessProvider {
  readonly id: string
  readonly capabilities: SubprocessCapabilities
  resolveExecutable(options: ResolveExecutableOptions): ExecutableResolution
  spawn(options: SubprocessSpawnOptions): ManagedProcess
}
```

`capabilities` 里除了能力位，还有 `notes`（降级说明）。服务把降级原样透给调用方与进程范围。

## 上游对照

上游 dsh 的 `subprocess` 是一个能力家族：`subprocess`（服务契约）、`subprocess-local`（本机
provider）、`win32-process`（Win32 原生绑定）。本包对应的是前两个合起来的那部分：

| 上游 | 本包 | 说明 |
|---|---|---|
| `subprocess` 服务契约 | `@ryharness/subprocess` | 契约 + 本机 provider 放在一个包里（上游拆两个包，这里零依赖优先） |
| `subprocess-local` 本机 provider | `LocalSubprocessProvider` | 同一套职责：找可执行、spawn、进程树回收、降级披露 |
| `win32-process` 原生绑定 | **不做** | Job Object / 受限令牌要原生代码，本轮不背 |
| 真实终端会话（PTY） | **不做** | 归 `packages/terminal` |
| spill 落盘（超限输出存文件） | **不做** | 归上游 `spill` 家族；本包只截断 |

## 导出

| 导出 | 一句话 |
|---|---|
| `SubprocessService` | 服务门面：默认值、进程登记、下线统一收尾 |
| `SubprocessProvider` | provider 契约（找可执行 / spawn / 能力与降级说明） |
| `LocalSubprocessProvider` | 本机 provider，默认实现 |
| `localProvider` | 本机 provider 的默认实例 |
| `localCapabilities` | 本机 provider 在某个平台上的能力与降级说明 |
| `spawnManaged` | 用默认本机 provider 托管启动一个进程 |
| `resolveExecutable` | 按名字找可执行文件（候选目录 → PATH） |
| `scrubEnvironment` | 按白名单裁剪环境，附继承/被拦下的变量名清单 |
| `DEFAULT_ENV_ALLOWLIST` | 默认环境白名单 |
| `DEFAULT_SECRET_NAME_PATTERN` | 「这名字像密钥」的默认判据 |
| `createProcessRange` | 建一个进程范围 |
| `WINDOWS_EXECUTABLE_EXTENSIONS` | Windows 上认的扩展名 |
| `DEFAULT_MAX_OUTPUT_BYTES` | 输出捕获的默认上限（64 KiB） |
| `KILL_GRACE_MS` | 收不掉时的兜底时限（2 秒） |
| 类型：`SubprocessResult` / `SubprocessSpawnOptions` / `ManagedProcess` / `SubprocessError` / `SubprocessCapabilities` / `ExecutableResolution` / `ProcessRange` / `ScrubbedEnvironment` | 契约 |

## 已知边界

- Windows 上 `.cmd` / `.bat` 走 `cmd.exe /d /s /c`，参数自己加引号；带 `&`、`|`、`^` 的参数
  会被 cmd 解释，复杂参数建议直接给 `.exe` 或包一层脚本。
- POSIX 上子进程是独立进程组（`detached`），它自己 `setsid` 就脱离回收范围。
- 输出截断是**按字节**切的，落在多字节字符中间的字节会被解成替换字符。
