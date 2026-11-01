/**
 * shell 方言的命令写法，以及跨平台的进程工具。
 *
 * 这些是**实测出来的**，不是照着文档推的：
 *
 * - bash 在管道里跑 `this is ) bad ((` 会**直接退出**（退出码 2）；加 `-i` 之后
 *   它会报个语法错然后继续活着。所以 bash 一律带 `-i` 起。
 * - 但 `-i` 的 bash 会把「cannot set terminal process group」写到 stderr，
 *   还会在 stderr 里回显输入。回显是**输入回显**，我们要的是命令的输出，
 *   所以这两样都得处理掉：前者丢弃，后者按「输入回显」剥掉。
 * - pwsh 用 `-NonInteractive -Command -` 从 stdin 读命令，行为干净得多：
 *   不回显输入、语法错也不死。
 * - MSYS 的 bash 里 `pwd` 给的是 POSIX 形式（`/c/Windows`），`pwd -W` 才给
 *   Windows 形式（`C:/Windows`）；pwsh 的 `(Get-Location).Path` 直接给
 *   Windows 形式。两边都得统一成同一种，路径比较才有意义。
 *
 * @module @ryharness/terminal/shell
 */

import { type ChildProcess, spawn } from 'node:child_process'

/** shell 方言的命令写法。 */
export interface ShellDialect {
  /** 方言名。 */
  readonly id: 'bash' | 'pwsh'
  /** 打印一行文本。 */
  echo(text: string): string
  /**
   * 一条「切目录并回报结果」的命令。
   *
   * 成功时打印新目录，失败时打印 `RY_CD_FAILED`。**失败必须能被看出来**——
   * shell 报个错然后继续活着，调用方却以为已经切过去了，这是最坑的一种 bug。
   * @param path - 目标目录。
   * @returns 命令文本。
   */
  cdCommand(path: string): string
  /** 打印当前工作目录。 */
  readonly pwd: () => string
}

/**
 * 单引号包裹，并把内部的单引号转义掉。
 *
 * bash 与 pwsh 的单引号语义一致：`'...'` 里的内容全是字面量，要表示一个单引号
 * 就写 `'\''`（bash）与 `''`（pwsh）——两者不同，所以分开处理。
 * @param value - 原值。
 * @param dialect - 方言。
 * @returns 加好引号的字面量。
 */
export function shellQuote(value: string, dialect: 'bash' | 'pwsh'): string {
  if (dialect === 'pwsh') {
    // pwsh 里单引号字符串内部的单引号要写成两个。
    return `'${value.replace(/'/g, "''")}'`
  }
  // bash：单引号串内部只能靠 '\'' 断开再续上。
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * bash 查当前目录的命令。
 *
 * `pwd -W` 是 MSYS/Git-Bash 的扩展（给 Windows 形式 `C:/Windows`）；普通 Linux 的
 * coreutils 没有这个选项（会报 `invalid option -- 'W'`），那边用裸 `pwd`。
 */
function bashPwd(): string {
  return process.platform === 'win32' ? 'pwd -W' : 'pwd'
}

/** bash 方言。 */
export const BASH_DIALECT: ShellDialect = {
  id: 'bash',
  echo: (text) => `echo ${shellQuote(text, 'bash')}`,
  // `cd X && pwd` 成功时给新目录；`||` 兜住失败，给一个能认出来的标记。
  cdCommand: (path) => `cd ${shellQuote(path, 'bash')} && ${bashPwd()} || echo ${CD_FAILED_MARKER}`,
  pwd: () => bashPwd(),
}

/** pwsh 方言。 */
export const PWSH_DIALECT: ShellDialect = {
  id: 'pwsh',
  echo: (text) => `Write-Output ${shellQuote(text, 'pwsh')}`,
  // pwsh 没有 `&&`（5.1 上没有，7 上有），用 if/else 更稳。
  cdCommand: (path) =>
    `if (Test-Path -LiteralPath ${shellQuote(path, 'pwsh')}) { Set-Location -LiteralPath ${shellQuote(path, 'pwsh')}; (Get-Location).Path } else { Write-Output ${CD_FAILED_MARKER} }`,
  pwd: () => 'Write-Output (Get-Location).Path',
}

/** 目录切换失败时 shell 打印的标记。 */
export const CD_FAILED_MARKER = 'RY_CD_FAILED'

/** 按名字取方言。 */
export function dialectOf(id: 'bash' | 'pwsh'): ShellDialect {
  return id === 'pwsh' ? PWSH_DIALECT : BASH_DIALECT
}

/**
 * 归一化 shell 报出来的目录，让两个方言能比。
 *
 * bash 的 `pwd -W` 给 `C:/Windows`，pwsh 给 `C:\Windows`——指的是同一个目录，
 * 但字符串不同。比较前先统一：斜杠统一成 `/`、去掉末尾斜杠、Windows 上忽略大小写。
 * @param raw - shell 报出来的路径。
 * @returns 可比较的路径。
 */
export function normalizeShellPath(raw: string): string {
  let value = raw.trim().replace(/\\/g, '/')
  // UNC 前缀（//server/share）不能把双斜杠压掉。
  const unc = value.startsWith('//')
  value = value.replace(/\/{2,}/g, '/')
  if (unc) value = `/${value}`
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1)
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/**
 * 剥掉 bash 交互模式下的**输入回显**。
 *
 * 管道里跑的 `bash -i` 会把敲进去的命令原样写回 stderr（没有 tty，它不知道
 * 屏幕上已经显示了）。那是「你敲了什么」，不是「命令输出了什么」，混在一起会
 * 让调用方读到重复的文本。
 *
 * 判定办法是逐行对照：这一行去掉 ANSI 之后，如果等于我们最近发出去的一条命令，
 * 就当回显丢掉。
 * @param line - 一行 stderr 文本。
 * @param sent - 最近发出去的命令（按发送顺序）。
 * @returns true 表示这行是回显，应当丢掉。
 */
export function isInputEcho(line: string, sent: readonly string[]): boolean {
  const cleaned = stripAnsi(line).trim()
  if (cleaned.length === 0) return false
  for (const command of sent) {
    if (command.trim() === cleaned) return true
  }
  return false
}

/**
 * bash 交互模式在 stderr 上吐的固定噪声。
 *
 * 没有 tty 时 bash 会抱怨两声：一是没法设置终端进程组，二是没有作业控制。
 * 这两句跟会话内容无关，每次启动都会出现，滤掉它们。
 * @param line - 一行 stderr 文本。
 * @returns true 表示这行是噪声，应当丢掉。
 */
export function isBashStartupNoise(line: string): boolean {
  const cleaned = stripAnsi(line).trim()
  return (
    cleaned.startsWith('bash: cannot set terminal process group') ||
    cleaned.startsWith('bash: no job control in this shell')
  )
}

/**
 * 去掉 ANSI 转义序列。
 *
 * pwsh 5.1 的错误信息带颜色（`\u001b[31;1m` 之类），bash 的提示符也带。
 * 不剥掉的话，读回来的文本里全是看不见的控制字符。
 * @param text - 原始文本。
 * @returns 剥掉 ANSI 之后的文本。
 */
export function stripAnsi(text: string): string {
  // ANSI 转义序列以 ESC（0x1B）开头。这里写成 `\u001b` 而不是把控制字符直接
  // 打进源码：源码里躺着不可见字符，diff 与 review 都看不出来。
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI 转义序列必须匹配 ESC 本身
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/** 一个进程树。 */
export interface ProcessTree {
  /** 树上所有后代（不含根）。 */
  readonly all: readonly number[]
  /**
   * 最深的那一层（叶子）。
   *
   * 中断前台命令时**只杀叶子**：Git Bash 会为每条命令再 fork 一层 `bash.exe`，
   * 杀掉中间那层会把 shell 自己也带走（实测 shell 直接退出）。
   */
  readonly leaves: readonly number[]
  /**
   * 每个后代的可执行名（按 pid 索引）。
   *
   * 中断时要靠它认出控制台宿主（见 {@link isConsoleHost}）：`conhost.exe` 也是
   * 叶子，但它不是命令。
   */
  readonly names: ReadonlyMap<number, string>
}

/**
 * 找出 shell 进程的整棵后代树。
 *
 * Windows 上没有 `ps --ppid`，用 PowerShell 的 CIM 查询（`wmic` 在新系统上已被移除）。
 * POSIX 上用 `ps`。
 * @param pid - 根进程 pid。
 * @returns 进程树。
 */
export async function findDescendantPids(pid: number): Promise<ProcessTree> {
  const all: number[] = []
  const names = new Map<number, string>()
  const seen = new Set<number>([pid])
  // 每个进程查一次自己的子进程，记下来；叶子就是「查不到子进程」的那些。
  const childMap = new Map<number, number[]>()
  let frontier: number[] = [pid]
  while (frontier.length > 0) {
    const next: number[] = []
    for (const parent of frontier) {
      const kids = await childProcessesOf(parent)
      childMap.set(
        parent,
        kids.map((kid) => kid.pid),
      )
      for (const kid of kids) {
        names.set(kid.pid, kid.name)
        if (seen.has(kid.pid)) continue
        seen.add(kid.pid)
        all.push(kid.pid)
        next.push(kid.pid)
      }
    }
    frontier = next
  }
  const leaves = all.filter((candidate) => (childMap.get(candidate) ?? []).length === 0)
  return { all, leaves, names }
}

/**
 * 是不是控制台宿主进程。
 *
 * Windows 上每个控制台进程旁边都跟着一个控制台宿主（Windows 10/11 叫
 * `conhost.exe`，更新的系统叫 `openconsole.exe`）。它是 shell 的**子进程**，
 * 但它**不是命令**：
 *
 * - 杀掉它，pwsh 会**直接退出**（实测连 `echo` 都收不到）；
 * - 杀掉它，Git Bash 会变成一个收不到任何输出的空壳（进程还在，命令没反应）。
 *
 * 所以中断时只杀命令进程，不动控制台宿主。
 * @param name - 可执行名（`conhost.exe` 这种）。
 * @returns 是控制台宿主则 true。
 */
export function isConsoleHost(name: string): boolean {
  const cleaned = name.trim().toLowerCase()
  if (cleaned.length === 0) return false
  const file = cleaned.split(/[\\/]/).pop() ?? cleaned
  return file === 'conhost.exe' || file === 'openconsole.exe'
}

/** 一个直接子进程：pid 与可执行名。 */
interface ChildProcessInfo {
  /** 进程 pid。 */
  readonly pid: number
  /** 可执行名（`conhost.exe` 这种，可能带路径）。 */
  readonly name: string
}

/**
 * 列出某个进程的直接子进程。
 * @param pid - 父进程 pid。
 * @returns 子进程列表。
 */
async function childProcessesOf(pid: number): Promise<ChildProcessInfo[]> {
  if (process.platform === 'win32') {
    const script = `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" -ErrorAction SilentlyContinue) | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`
    const out = await runCapture('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
    return parseChildLines(out)
  }
  const out = await runCapture('ps', ['-o', 'pid=,comm=', '--ppid', String(pid)])
  return parseChildLines(out)
}

/**
 * 把「一行一个 pid + 名字」的输出解析成结构。
 * @param out - 命令的标准输出。
 * @returns 子进程列表。
 */
function parseChildLines(out: string): ChildProcessInfo[] {
  const infos: ChildProcessInfo[] = []
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const [pidText, ...nameParts] = trimmed.split(/\s+/)
    const value = Number.parseInt(pidText ?? '', 10)
    if (!Number.isFinite(value) || value <= 0) continue
    infos.push({ pid: value, name: nameParts.join(' ') })
  }
  return infos
}

/**
 * 跑一条命令并把它的标准输出收回来。
 * @param file - 可执行文件。
 * @param args - 参数。
 * @returns 标准输出文本。
 */
export async function runCapture(file: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      resolve('')
      return
    }
    let out = ''
    const stdout = child.stdout
    if (stdout !== null) {
      stdout.setEncoding('utf8')
      stdout.on('data', (chunk: string) => {
        out += chunk
      })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(out)
    }, 5_000)
    child.once('error', () => {
      clearTimeout(timer)
      resolve(out)
    })
    child.once('close', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}
