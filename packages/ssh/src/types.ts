/**
 * 远程 POSIX 能力的类型契约。
 *
 * 这一族回答一个问题：**怎么在远程 POSIX 机器上跑命令、读写文件，并且不把边界丢了**。
 *
 * 三个角色分得清清楚楚：
 * - **连接**（{@link SshConnection}）：一组远程操作的契约。宿主可以自己实现（真 SSH 库、
 *   容器 exec、跳板机都行），本包只规定「有哪些操作、失败长什么样」。
 * - **命令行后端**（{@link CliSshConnection}）：本包自带的实现，用本机的 `ssh` 可执行文件
 *   跑远程命令。不引 ssh2 这类原生模块（原生模块在打包与跨平台分发上代价太大）。
 * - **边界**：路径默认关在远端某个根目录里、主机名要校验、凭据绝不进 argv。
 *
 * 与上游 dsh 的差别写在 README：上游用四个包（ssh / fs-ssh / subprocess-ssh / sandbox-ssh）
 * 共用一条 OpenSSH 连接，我们这一轮合成「一个连接契约 + 一个命令行后端」。
 * @module @ryharness/ssh/types
 */

/** 一次远程命令的执行选项。 */
export interface SshCommandOptions {
  /** 单次执行的时限（毫秒）；不给就沿用连接上的默认值，再没有就不限时。 */
  readonly timeoutMs?: number
  /** 取消信号：调用方中断了这一步，命令要立刻收掉。 */
  readonly signal?: AbortSignal
  /** 远端工作目录。给了根目录时按根目录解析，没给根目录就当远端绝对路径用。 */
  readonly cwd?: string
  /** 送给远端命令的 stdin 内容（文件传输就靠它）。 */
  readonly stdin?: string
  /** stdout / stderr 各自的捕获上限（字节）；超出的部分丢掉并标记截断。 */
  readonly maxOutputBytes?: number
  /**
   * 远端非零退出时要不要抛错。
   *
   * 缺省 `true`：非零退出是**失败**，错误码 `REMOTE_FAILED`。调用方想自己看退出码
   * （比如 `grep` 没匹配到也算正常）就显式关掉。
   */
  readonly rejectOnNonZeroExit?: boolean
}

/** 读文件的选项。 */
export interface SshReadOptions {
  /** 时限（毫秒）。 */
  readonly timeoutMs?: number
  /** 取消信号。 */
  readonly signal?: AbortSignal
  /** 最多读多少字节（超过就当失败，不给就按连接上的输出上限）。 */
  readonly maxBytes?: number
}

/** 写文件的选项。 */
export interface SshWriteOptions {
  /** 时限（毫秒）。 */
  readonly timeoutMs?: number
  /** 取消信号。 */
  readonly signal?: AbortSignal
  /** 远端文件权限（八进制，例如 `0o600`）；不给就用远端默认。 */
  readonly mode?: number
}

/** 一次远程命令跑完的结果。 */
export interface SshExecResult {
  /** 远端命令的退出码。 */
  readonly exitCode: number
  /** stdout（按上限截断过）。 */
  readonly stdout: string
  /** stderr（按上限截断过）。 */
  readonly stderr: string
  /** stdout 是不是被截断了。 */
  readonly stdoutTruncated: boolean
  /** stderr 是不是被截断了。 */
  readonly stderrTruncated: boolean
  /** 跑了多久（毫秒）。 */
  readonly durationMs: number
}

/** 远端目录里的一个条目。 */
export interface SshFileEntry {
  /** 条目名（不含目录）。 */
  readonly name: string
  /** 条目的完整远端路径。 */
  readonly path: string
  /** 条目是什么。 */
  readonly kind: 'file' | 'directory' | 'symlink' | 'other'
  /** 字节数；只有普通文件才有（其它类型是 undefined，不是 0）。 */
  readonly size?: number
}

/**
 * 一条远程连接。
 *
 * 宿主提供实现（{@link CliSshConnection} 是本包自带的一个），本包所有其它部分都只
 * 对着这个接口说话。
 */
export interface SshConnection {
  /** 这条连接的标识（给人看日志用）。 */
  readonly id: string
  /**
   * 在远端跑一条命令。
   *
   * 命令是**交给远端 shell 解释**的字符串（不是 argv），所以 `&&`、管道、重定向都能用。
   * @param command - 命令文本。
   * @param options - 执行选项。
   * @returns 执行结果。
   */
  exec(command: string, options?: SshCommandOptions): Promise<SshExecResult>
  /**
   * 写一个远端文件（内容会被覆盖）。
   * @param path - 远端路径。
   * @param data - 文件内容。
   * @param options - 写入选项。
   */
  writeFile(path: string, data: Uint8Array | string, options?: SshWriteOptions): Promise<void>
  /**
   * 读一个远端文件。
   * @param path - 远端路径。
   * @param options - 读取选项。
   * @returns 文件内容。
   */
  readFile(path: string, options?: SshReadOptions): Promise<Uint8Array>
  /**
   * 列一个远端目录（不含 `.` 与 `..`）。
   * @param path - 远端目录路径。
   * @param options - 执行选项（超时、取消）。
   * @returns 目录里的条目。
   */
  list(path: string, options?: SshCommandOptions): Promise<SshFileEntry[]>
  /** 关掉这条连接。关过之后再调用别的操作会报错。 */
  close(): Promise<void>
}

/** 用 ssh-agent 或默认密钥认证（不传密码）。 */
export interface SshAgentCredential {
  readonly kind: 'agent'
}

/** 用指定的私钥文件认证。 */
export interface SshKeyCredential {
  readonly kind: 'key'
  /**
   * 私钥文件路径。
   *
   * **路径会出现在 argv 里**（`-i`），但私钥本身不会：argv 在 Linux 上是全局可读的，
   * 所以这条路只传路径，不传密钥内容。
   */
  readonly identityFile: string
}

/**
 * 用密码认证。
 *
 * 密码**绝不进 argv**（`ps` 看得见整条命令行）。做法是让 ssh 通过 askpass 助手问密码：
 * 助手从环境变量里拿，我们把密码放进子进程的环境（Linux 上 `/proc/<pid>/environ` 只有
 * 属主能读），argv 里只有助手路径。
 */
export interface SshPasswordCredential {
  readonly kind: 'password'
  /** 密码本身。 */
  readonly password: string
  /** 宿主提供的 askpass 助手（可执行文件路径）：ssh 通过它问密码。 */
  readonly askpass: string
  /** 密码传给助手时用的环境变量名（缺省 `RY_SSH_PASSWORD`）。 */
  readonly passwordEnv?: string
}

/** 凭据：连接怎么证明自己是谁。 */
export type SshCredential = SshAgentCredential | SshKeyCredential | SshPasswordCredential

/** 主机密钥策略。 */
export type SshHostKeyPolicy =
  /** 严格：主机密钥对不上就失败（默认）。 */
  | 'strict'
  /** 第一次见到这台主机时记下来（`StrictHostKeyChecking=accept-new`）。 */
  | 'accept-new'

/** 一条连接的配置。 */
export interface SshConnectionConfig {
  /**
   * 目标主机。
   *
   * 可以写 `host`、`user@host`、`[::1]`。**会校验**：以 `-` 开头、含 `=`、含空白或控制
   * 字符的一律拒绝——否则 `-oProxyCommand=...` 这种东西会被 ssh 当成选项执行。
   */
  readonly host: string
  /** 端口（不给就用 ssh 的默认 22）。 */
  readonly port?: number
  /** 用户名；不给就用 `host` 里的 `user@` 部分，再没有就用本机用户名。 */
  readonly user?: string
  /** 凭据；不给就是 ssh-agent / 默认密钥。 */
  readonly credential?: SshCredential
  /**
   * 远端根目录：所有文件操作都被关在这个目录里。
   *
   * 不给就没有围栏（调用方自己保证路径可信）。给了之后，`../` 之类越界的路径会被
   * {@link resolveRemotePath} 挡下来并报 `PATH_OUTSIDE_ROOT`。
   */
  readonly root?: string
  /** ssh 可执行文件（缺省 `ssh`，即 PATH 里那个）。 */
  readonly sshPath?: string
  /** 主机密钥策略（缺省 `strict`）。 */
  readonly hostKeyPolicy?: SshHostKeyPolicy
  /** 连接的默认时限（毫秒）；单次调用可以覆盖。 */
  readonly defaultTimeoutMs?: number
  /** 输出的默认上限（字节）。 */
  readonly maxOutputBytes?: number
}
