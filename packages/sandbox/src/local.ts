/**
 * 本地围栏后端：把一次进程执行关进模式允许的范围里。
 *
 * 两个后端，强度不同，**别把它们说成一样**：
 * - POSIX（bubblewrap）：内核级隔离。根目录只读挂载，只把工作区挂成可写，私有的
 *   `/tmp` 与 `/proc`、`--unshare-pid` 隔掉进程可见性。没装 bwrap 就退到围栏。
 * - Windows：围栏，不是内核边界。清掉环境（只留系统与代理那几项，模型凭据不在里面）、
 *   工作目录限定在工作区、拦截明显的越界写目标。真正的内核隔离要受限令牌或
 *   AppContainer，那需要原生代码——安装包不背这个，所以这里只说不做。
 *
 * 强度写在 `kernelLevel` 上：界面与日志据此说话，别让「Windows 上的围栏」看起来
 * 和「Linux 上的内核隔离」一样可靠。
 * @module @ryharness/sandbox/local
 */

import { spawnSync } from 'node:child_process'
import { isAbsolute, resolve, sep } from 'node:path'

/** 围栏的输入。 */
export interface ConfinementInput {
  /** 目标模式。 */
  mode: 'read-only' | 'workspace-write' | 'full-access'
  /** 工作区根。 */
  workspaceRoot: string
  /** 要跑的可执行文件。 */
  command: string
  /** 它的参数。 */
  args: readonly string[]
  /** 宿主环境。 */
  env: NodeJS.ProcessEnv
  /** 子进程自己的临时目录（可写）；缺省用系统临时目录。 */
  tempDir?: string
  /** 宿主明确要透传的环境变量（在白名单之外）。 */
  extraEnv?: Readonly<Record<string, string>>
  /** 要不要断网（POSIX 后端用；默认不断——断网会让装依赖类的命令直接失败）。 */
  isolateNetwork?: boolean
}

/** 围栏之后实际要跑的东西。 */
export interface Confinement {
  readonly command: string
  readonly args: string[]
  readonly env: NodeJS.ProcessEnv
  /** 这是不是内核级隔离。 */
  readonly kernelLevel: boolean
  /** 给日志/人看的一句话（强度、为什么退化了）。 */
  readonly notes?: string
}

/**
 * 环境白名单：系统运行要用的那几项。
 *
 * **刻意不含任何凭据**：模型服务的 key 若在环境里，被命令 `echo $KEY` 就读走了。
 * 这正是围栏要挣的第一件事——命令能碰到工作区外的一切。
 */
export const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]

/** 按白名单裁剪环境，并补上宿主明确要透传的。 */
export function scrubEnv(env: NodeJS.ProcessEnv, extraEnv?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of ENV_ALLOWLIST) {
    const value = env[key]
    if (value !== undefined) out[key] = value
  }
  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    out[key] = value
  }
  return out
}

/**
 * bubblewrap 能不能用。
 *
 * 探测要**真的跑一次**而不是看 PATH 里有没有那个文件：装了但跑不起来（容器里缺
 * user namespace）的情况更常见，真跑一次才知道。
 */
export function bubblewrapAvailable(): boolean {
  if (process.platform === 'win32') return false
  try {
    const probe = spawnSync('bwrap', ['--version'], { stdio: 'ignore' })
    return probe.status === 0
  } catch {
    return false
  }
}

/**
 * 给命令套上 bubblewrap。
 *
 * 挂载顺序要紧：先把 `/` 只读挂上，再把工作区挂成可写——后者覆盖前者。
 * @param input - 围栏输入。
 * @returns 套好之后的命令与参数。
 */
export function bubblewrapConfinement(input: ConfinementInput): Confinement {
  const workspace = resolve(input.workspaceRoot)
  const args = [
    '--ro-bind',
    '/',
    '/',
    '--bind',
    workspace,
    workspace,
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--chdir',
    workspace,
    '--unshare-pid',
  ]
  /**
   * 宿主明确给了临时目录的话，把它单独挂成可写。
   *
   * `/tmp` 已经是 tmpfs（可写但一退出就没），宿主给的目录是**跨进程共享**的那份
   * （工具链会在里面铺中间产物，宿主要能事后拿到）——所以两者不能互相替代。
   */
  if (input.tempDir !== undefined) {
    const temp = resolve(input.tempDir)
    // 插在最后一个 '--bind' 之后：bwrap 的参数是「标志 + 若干值」成对出现的，
    // 插错位置会把工作区那对的第二个值吃掉（表现为工作区没挂上、命令在空目录里跑）。
    args.push('--bind', temp, temp)
  }
  if (input.isolateNetwork === true) args.push('--unshare-net')
  args.push('--', input.command, ...input.args)
  return {
    command: 'bwrap',
    args,
    env: scrubEnv(input.env, input.extraEnv),
    kernelLevel: true,
    notes: 'bubblewrap 内核级隔离：根目录只读，工作区可写。',
  }
}

/**
 * Windows 上的围栏（不是内核隔离）。
 *
 * 做三件事：清环境、把工作目录钉在工作区、拦明显的越界写目标。第三件是**启发式**
 * ——命令语言太杂，不可能穷举，所以它挡的是 `>` 重定向与 `copy`/`move` 这类直白写法。
 * @param input - 围栏输入。
 * @returns 套好之后的命令与参数（命令本身不变，拦在别处）。
 */
export function fenceConfinement(input: ConfinementInput): Confinement {
  return {
    command: input.command,
    args: [...input.args],
    env: scrubEnv(input.env, input.extraEnv),
    kernelLevel: false,
    notes: 'Windows 围栏：环境已裁剪、工作目录已限定；内核级隔离需要受限令牌，尚未启用。',
  }
}

/**
 * 挑后端并套围栏。
 *
 * `full-access` 不套围栏（这就是「全权」的意思）。
 * @param input - 围栏输入。
 * @returns 套好之后的执行参数。
 */
export function confine(input: ConfinementInput): Confinement {
  if (input.mode === 'full-access') {
    return {
      command: input.command,
      args: [...input.args],
      env: { ...input.env },
      kernelLevel: false,
      notes: '全权模式：不套围栏。',
    }
  }
  if (process.platform !== 'win32' && bubblewrapAvailable()) {
    return bubblewrapConfinement(input)
  }
  return fenceConfinement(input)
}

/**
 * 命令里有没有「明显越界」的写目标。
 *
 * 判定口径：重定向（`>` / `>>`）后面跟的路径若是绝对路径且不在工作区里，就算越界；
 * `copy` / `move` / `cp` / `mv` 的最后一个参数若是工作区外的绝对路径，同样算。
 *
 * 它是**启发式**：命令语言太杂，穷举不出来。所以它挡的是直白写法，不是绕过。
 * @param command - 命令文本。
 * @param workspaceRoot - 工作区根。
 * @returns 越界的写目标（没有则 undefined）。
 */
export function findOutsideWriteTarget(command: string, workspaceRoot: string): string | undefined {
  const root = resolve(workspaceRoot)
  const segments = command.split(/\s+/)
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] as string
    const isRedirect = segment === '>' || segment === '>>' || segment.endsWith('>')
    const isCopy = /^(copy|move|cp|mv|xcopy|robocopy)$/i.test(segment)
    const next = segments[i + 1]
    if (next === undefined) continue
    const target = isRedirect ? next : isCopy ? segments[segments.length - 1] : undefined
    if (target === undefined) continue
    const cleaned = target.replace(/^["']|["']$/g, '')
    if (!isAbsolute(cleaned)) continue
    const resolved = resolve(cleaned)
    if (resolved === root || resolved.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) continue
    return cleaned
  }
  return undefined
}
