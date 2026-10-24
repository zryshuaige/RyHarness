/**
 * shell_exec：在工作区根目录下执行 shell 命令。
 *
 * Windows 上优先使用 Git Bash（本开发/部署环境的 shell），找不到时退回
 * cmd.exe；POSIX 上使用 /bin/sh。用 execFile 直接.spawn 解释器（不经
 * cmd 字符串拼接），避免 Windows 路径空格引号问题；输出按字符数截断。
 * 超时与取消由本模块自己接管（不再交给 execFile 的 signal/timeout）：
 * 中断发生时先按进程树把 shell 及其子孙一起收掉、确认收干净了再返回，
 * 顺序与"确认过再返回"都是硬要求，见 {@link terminateProcessTree}。
 *
 * 安全闸：命令命中 `.env` / `.ssh/` / `.aws/` / `.git/config` / api-keys.json
 * 以及凭据类文件名时直接报错且**不执行**（见 {@link findSensitiveInCommand}）。
 * 闸默认开着，只能由宿主用 {@link setShellGuardPolicy} 显式放开。
 * @module @ryharness/tools/shell
 */

import type { ChildProcess } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { type Tool, throwIfAborted } from '@ryharness/agent'
import { truncateOutput } from './workspace.ts'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_CHARS = 32_000
const MAX_BUFFER_BYTES = 4 * 1024 * 1024

/** 各平台的默认 shell 与单命令标志；Windows 优先 Git Bash。 */
function defaultShell(): { shell: string; args: (command: string) => string[] } {
  if (process.platform === 'win32') {
    const candidates = [
      process.env.GIT_BASH_PATH,
      'C:/Program Files/Git/bin/bash.exe',
      'C:/Program Files (x86)/Git/bin/bash.exe',
    ].filter((path): path is string => {
      return typeof path === 'string' && path.length > 0
    })
    for (const candidate of candidates) {
      if (existsSync(candidate))
        return {
          shell: candidate,
          args: (command) => {
            return ['-c', command]
          },
        }
    }
    return {
      shell: process.env.ComSpec ?? 'cmd.exe',
      args: (command) => {
        return ['/d', '/s', '/c', `"${command}"`]
      },
    }
  }
  return {
    shell: '/bin/sh',
    args: (command) => {
      return ['-c', command]
    },
  }
}

function argString(args: unknown, key: string, fallback?: string): string {
  if (typeof args === 'object' && args !== null && key in args) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  if (fallback !== undefined) return fallback
  throw new Error(`shell_exec: missing string argument "${key}"`)
}

function argNumber(args: unknown, key: string, fallback: number): number {
  if (typeof args === 'object' && args !== null && key in args) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
    if (typeof value === 'string' && value.length > 0 && Number.isFinite(Number(value))) return Number(value)
  }
  return fallback
}

/**
 * shell 安全闸策略（进程级；只能由宿主在启动配置时改，模型自己改不了）。
 * @module @ryharness/tools/shell/guard
 */

/** shell_exec 的安全闸配置。 */
export interface ShellGuardPolicy {
  /** true（默认）= 命令命中敏感路径就报错且不执行。 */
  blockSensitivePaths: boolean
  /** 额外的敏感片段（小写比较）：命令里出现即拒绝，按环境自定义。 */
  extraSensitivePatterns: readonly string[]
}

/** 命令里命中的敏感点。 */
export interface SensitiveHit {
  /** 命中的规则，用于报错信息。 */
  rule: string
  /** 命令里的原始片段。 */
  fragment: string
}

const DEFAULT_GUARD_POLICY: ShellGuardPolicy = { blockSensitivePaths: true, extraSensitivePatterns: [] }

let guardPolicy: ShellGuardPolicy = DEFAULT_GUARD_POLICY

/** 读当前安全闸策略（只读快照）。 */
export function shellGuardPolicy(): Readonly<ShellGuardPolicy> {
  return { ...guardPolicy }
}

/**
 * 覆盖安全闸策略（整体替换，不是增量合并）。
 *
 * 放开必须由宿主显式调用——工具入参里刻意没有"跳过检查"的开关：模型能改的开关
 * 等于没有闸，一句"先 allowSensitivePaths 再读"就绕过去了。
 * @param policy - 新策略；缺省项回到默认值（闸开、无自定义片段）。
 */
export function setShellGuardPolicy(policy: Partial<ShellGuardPolicy> = {}): Readonly<ShellGuardPolicy> {
  guardPolicy = {
    blockSensitivePaths: policy.blockSensitivePaths ?? DEFAULT_GUARD_POLICY.blockSensitivePaths,
    extraSensitivePatterns: [...(policy.extraSensitivePatterns ?? DEFAULT_GUARD_POLICY.extraSensitivePatterns)],
  }
  return shellGuardPolicy()
}

/** 裸文件名命中即敏感：这些名字本身就是凭据文件（`cat credentials` 也算）。 */
const SENSITIVE_LEAF_NAMES: ReadonlySet<string> = new Set([
  '.env',
  'api-keys.json',
  'credentials',
  'credentials.json',
  'secrets.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.htpasswd',
  '.git-credentials',
])

/** 路径段命中即敏感：整段都是凭据面。 */
const SENSITIVE_SEGMENTS: ReadonlySet<string> = new Set(['.ssh', '.aws'])

/** `.git/` 下只有 config 是凭据面（其余是对象库，不拦）。 */
const SENSITIVE_GIT_FILES: ReadonlySet<string> = new Set(['config'])

/** 文件名主干命中即敏感（prod-secret.json / my.token 之类）。 */
const CREDENTIAL_STEMS: readonly string[] = [
  'credential',
  'credentials',
  'secret',
  'secrets',
  'password',
  'passwords',
  'passwd',
  'token',
  'tokens',
  'apikey',
  'api-key',
  'api_key',
  'accesskey',
  'access-key',
  'access_key',
  'privatekey',
  'private-key',
  'private_key',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'htpasswd',
  'netrc',
  'npmrc',
  'pgpass',
  'keystore',
]

/** 扩展名命中即敏感：私钥与密钥容器。 */
const CREDENTIAL_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.ppk',
])

/** `.env.example` 这类模板文件不含真凭据，放行。 */
const ENV_TEMPLATE_SUFFIX = /\.(?:example|sample|template)$/

/** `git config ...` 直接读仓库本地配置（可能内嵌 token），不依赖路径写法。 */
const GIT_CONFIG_COMMAND = /(?:^|[\s;&|(])git\b[^;&|]*\bconfig\b/

/** 把命令切成候选片段：空白与引号分隔，再剥掉重定向/子 shell 的标点。 */
function commandFragments(command: string): string[] {
  return command
    .split(/[\s"'`]+/)
    .map((fragment) => {
      return fragment.replace(/^[(<]+|[)>;,]+$/g, '')
    })
    .filter((fragment) => {
      return fragment.length > 0
    })
}

/** 叶子文件名是否敏感。裸词（无扩展名）按搜词放行：`grep secret src` 不是取凭据。 */
function isSensitiveLeaf(leaf: string, bare: boolean): boolean {
  if (SENSITIVE_LEAF_NAMES.has(leaf)) return true
  if (leaf.startsWith('.env.') && !ENV_TEMPLATE_SUFFIX.test(leaf)) return true
  // 私钥/密钥容器的扩展名没有歧义，裸文件名也照拦。
  if (CREDENTIAL_EXTENSIONS.has(leaf.slice(leaf.lastIndexOf('.')))) return true
  if (bare && !leaf.includes('.')) return false
  // 按点分段逐段比：prod-secret.json / my.private_key / foo.token 都命中，
  // tokenizer.ts 这类只是词根相近的正常文件名不命中。
  return leaf.split('.').some((part) => {
    return (
      CREDENTIAL_STEMS.includes(part) ||
      CREDENTIAL_STEMS.some((candidate) => {
        return part.endsWith(`-${candidate}`) || part.endsWith(`_${candidate}`)
      })
    )
  })
}

/** 单个片段的判定；`~` / `$HOME` 之类前缀不影响分段。 */
function sensitiveFragment(fragment: string): SensitiveHit | undefined {
  const normalized = fragment.replace(/\\/g, '/')
  const bare = !normalized.includes('/')
  const segments = normalized.split('/').filter((segment) => {
    return segment.length > 0 && segment !== '.'
  })
  if (segments.length === 0) return undefined
  for (const [index, segment] of segments.entries()) {
    const value = segment.toLowerCase()
    if (SENSITIVE_SEGMENTS.has(value)) return { rule: `${value}/`, fragment }
    if (value === '.git' && SENSITIVE_GIT_FILES.has((segments[index + 1] ?? '').toLowerCase())) {
      return { rule: '.git/config', fragment }
    }
  }
  const leaf = (segments[segments.length - 1] as string).toLowerCase()
  return isSensitiveLeaf(leaf, bare) ? { rule: leaf, fragment } : undefined
}

/**
 * 在命令里找敏感路径。
 *
 * 纯文本匹配，不解析 shell：它挡的是"模型顺手 cat 了 ~/.ssh/id_rsa"这类
 * 直白动作，绕过（变量间接、base64、find -name）不在射程内——真正的边界是
 * 工作区限定与配额，不是这条闸。
 * @param command - 待执行命令。
 * @param extraPatterns - 额外敏感片段（宿主自定义）。
 * @returns 第一个命中点；没有命中返回 undefined。
 */
export function findSensitiveInCommand(
  command: string,
  extraPatterns: readonly string[] = [],
): SensitiveHit | undefined {
  const fragments = commandFragments(command)
  for (const pattern of extraPatterns) {
    if (pattern.length === 0) continue
    const hit = fragments.find((fragment) => {
      return fragment.toLowerCase().includes(pattern.toLowerCase())
    })
    if (hit !== undefined) return { rule: '宿主自定义规则', fragment: hit }
  }
  if (GIT_CONFIG_COMMAND.test(command.replace(/\\/g, '/').toLowerCase())) {
    return { rule: 'git config', fragment: 'git config' }
  }
  for (const fragment of fragments) {
    const hit = sensitiveFragment(fragment)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 在工作区根目录执行命令，返回合并截断的输出。 */
export const shellExec: Tool = {
  name: 'shell_exec',
  description:
    '在工作区根目录执行 shell 命令（有超时与输出长度限制；命中 .env/.ssh/.aws 等敏感路径直接拒绝），返回 stdout/stderr。',
  // 命令会改工作区（rm / npm install / 构建脚本都可能动同一批路径），并发执行
  // 互相踩踏且输出交错；声明 sequential 让 AgentLoop 把整批工具调用退回串行。
  executionMode: 'sequential',
  // 黑名单挡不住拼接过载与外发（curl|bash、读数据目录整库外发都过得了词面
  // 检查），shell 对宿主没有真实边界——每条命令必须经用户批准后才能执行。
  requiresApproval: true,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeoutMs: { type: 'number', description: `超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}）` },
    },
    required: ['command'],
  },
  async execute(args, ctx) {
    throwIfAborted(ctx.signal)
    const command = argString(args, 'command')
    const policy = guardPolicy
    if (policy.blockSensitivePaths) {
      const hit = findSensitiveInCommand(command, policy.extraSensitivePatterns)
      if (hit !== undefined) {
        return {
          content: `shell_exec blocked: command touches sensitive path "${hit.fragment}" (rule: ${hit.rule}); 如确需执行，由宿主显式放开 shell 安全闸后重试`,
          isError: true,
        }
      }
    }
    const timeoutMs = argNumber(args, 'timeoutMs', DEFAULT_TIMEOUT_MS)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return { content: `invalid timeoutMs: ${String(timeoutMs)}`, isError: true }
    }
    const { shell, args: shellArgs } = defaultShell()
    const { child, done } = runShell(shell, shellArgs(command), ctx.workspaceRoot)
    const settled = await raceInterruption(done, timeoutMs, ctx.signal)
    if (settled === 'abort' || settled === 'timeout') {
      await terminateProcessTree(child)
      return {
        content: settled === 'abort' ? 'command aborted' : `timed out after ${timeoutMs}ms`,
        isError: true,
      }
    }
    const { stdout, stderr, error } = settled
    if (error === null) {
      const combined = stderr.length > 0 ? `${stdout}\n[stderr]\n${stderr}` : stdout
      return { content: truncateOutput(combined.trimEnd(), MAX_OUTPUT_CHARS) }
    }
    const output = [error.stdout, error.stderr]
      .filter((part): part is string => {
        return typeof part === 'string' && part.length > 0
      })
      .join('\n')
    const reason = error.killed === true ? `timed out after ${timeoutMs}ms` : (error.message ?? 'command failed')
    return {
      content: output.length > 0 ? `${reason}\n${truncateOutput(output.trimEnd(), MAX_OUTPUT_CHARS)}` : reason,
      isError: true,
    }
  },
}

/** 一次 shell 调用的结果：命令输出，加上（若有）失败原因。 */
interface ShellOutcome {
  stdout: string
  stderr: string
  /** execFile 只用回调报错，不 reject：工具层统一按 isError 结果返回，不抛。 */
  error: ExecFailure | null
}

/** execFile 的失败对象：除了 message 还带着已捕获的输出与"是不是被杀"。 */
interface ExecFailure {
  stdout?: string
  stderr?: string
  message?: string
  killed?: boolean
}

/**
 * 起一条命令并把句柄同步交出来。
 *
 * 用回调形式而不是 `promisify(execFile)`：中断收尾必须赶在 execFile 自己的
 * signal/timeout 杀掉直接子进程**之前**拿到句柄去按树枚举，否则树就拼不出来了。
 */
function runShell(file: string, args: string[], cwd: string): { child: ChildProcess; done: Promise<ShellOutcome> } {
  let settle: (outcome: ShellOutcome) => void = () => {}
  const done = new Promise<ShellOutcome>((resolve) => {
    settle = resolve
  })
  const child = execFile(
    file,
    args,
    {
      cwd,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
    },
    (error, stdout, stderr) => {
      settle({ stdout, stderr, error })
    },
  )
  return { child, done }
}

/** 谁先到谁算数：命令跑完、超时、还是被 signal 取消。 */
function raceInterruption(
  done: Promise<ShellOutcome>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ShellOutcome | 'timeout' | 'abort'> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (value: ShellOutcome | 'timeout' | 'abort'): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = (): void => {
      settle('abort')
    }
    timer = setTimeout(() => {
      settle('timeout')
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    void done.then(settle)
  })
}

/**
 * 按进程树收尾，并等它真的收完再返回。
 *
 * 顺序与"确认过再返回"都是硬要求：
 * - Windows 的 taskkill /T 是从父进程往下枚举的。父进程一旦先死（execFile 自己的
 *   signal/timeout handler 就是这么干的），这棵树就再也拼不出来，里面的孙进程会以
 *   无主孤儿的形式继续跑——用户机器 CPU 被 `while true; do :; done` 吃满就是这么来的。
 *   所以这里先 taskkill 整树，失败才退回只杀直接子进程。
 * - 必须 await。`spawn(...).unref()` 那种"发射完就不管"的写法在杀不掉时等于没杀，
 *   而这正是测试漏掉它的原因：断言只等 promise settle，看不见进程还在跑。
 *
 * 平台差异是显式的：win32 有 taskkill /T 这条按父子关系枚举的路；POSIX 没有对应接口，
 * 而 execFile 又没有 detached 选项（shell 拿不到自己的进程组），所以那边只能保证直接
 * 子进程被 SIGKILL——仍然比原实现的"整个函数直接 return、什么都不杀"强。
 */
async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    // 顺序是硬要求：taskkill /T 必须先跑，且跑的时候父进程必须还活着——它是从父进程
    // 往下枚举的，父进程一死树就拼不出来，孙进程全部漏掉。父进程一死还有个更隐蔽的
    // 坑：继承 stdout 管道的孙进程会拿着管道不放，child 的 'close' 永远不触发，连
    // "等 close 再 taskkill" 这种写法都会原地挂死。所以先 taskkill 整树，失败才退回
    // SIGKILL 只杀直接子进程，最后带超时地等 'close' 落袋（不等它：任务时限已到）。
    const treeKilled = await taskkillTree(pid)
    if (!treeKilled) child.kill('SIGKILL')
    await waitForClose(child)
    return
  }
  child.kill('SIGKILL')
}

/** 等 'close'，但只等到时限：进程杀不掉时收尾不能无限期挂着。 */
function waitForClose(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(undefined)
    }, timeoutMs)
    child.once('close', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
}

/** taskkill /T /F：按父子关系枚举并强杀整棵树。进程已不在、taskkill 自己卡住，都算失败。 */
function taskkillTree(pid: number, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    let killer: ChildProcess
    try {
      killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      killer.kill('SIGKILL')
      resolve(false)
    }, timeoutMs)
    killer.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    killer.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}
