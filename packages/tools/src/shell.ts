/**
 * shell_exec：在工作区根目录下执行 shell 命令。
 *
 * Windows 上优先使用 Git Bash（本开发/部署环境的 shell），找不到时退回
 * cmd.exe；POSIX 上使用 /bin/sh。用 execFile 直接.spawn 解释器（不经
 * cmd 字符串拼接），避免 Windows 路径空格引号问题；输出按字符数截断，
 * 超时强杀进程。取消时把 `ToolContext.signal` 交给 spawn：等待立刻中断，
 * 并按进程树把 shell 及其子孙一起收掉。
 *
 * 安全闸：命令命中 `.env` / `.ssh/` / `.aws/` / `.git/config` / api-keys.json
 * 以及凭据类文件名时直接报错且**不执行**（见 {@link findSensitiveInCommand}）。
 * 闸默认开着，只能由宿主用 {@link setShellGuardPolicy} 显式放开。
 * @module @ryagent/tools/shell
 */

import type { ChildProcess } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { type Tool, throwIfAborted } from '@ryagent/agent'
import { truncateOutput } from './workspace.ts'

const execFileAsync = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_CHARS = 32_000

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
 * @module @ryagent/tools/shell/guard
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
    const running = execFileAsync(shell, shellArgs(command), {
      cwd: ctx.workspaceRoot,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    })
    try {
      const { stdout, stderr } = await running
      const combined = stderr.length > 0 ? `${stdout}\n[stderr]\n${stderr}` : stdout
      return { content: truncateOutput(combined.trimEnd(), MAX_OUTPUT_CHARS) }
    } catch (error) {
      // 取消不是命令失败：结果无意义，由循环在边界抛 AbortedError 收尾。
      if (ctx.signal?.aborted === true) {
        killProcessTree(running.child)
        return { content: 'command aborted', isError: true }
      }
      const failed = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean }
      const output = [failed.stdout, failed.stderr]
        .filter((part): part is string => {
          return typeof part === 'string' && part.length > 0
        })
        .join('\n')
      const reason = failed.killed === true ? `timed out after ${timeoutMs}ms` : (failed.message ?? 'command failed')
      return {
        content: output.length > 0 ? `${reason}\n${truncateOutput(output.trimEnd(), MAX_OUTPUT_CHARS)}` : reason,
        isError: true,
      }
    }
  },
}

/**
 * 按进程树收尾。Windows 上杀掉 shell 并不会自动带走它启动的子进程：
 * Git Bash 走 MSYS2，信号会顺着进程组传下去，但退化到 cmd.exe（或任何
 * 不做信号传播的 shell）时，`npm install` / `python x.py` 里真正干活的进程
 * 会继续跑几分钟并占着工作区。taskkill /T 才是按树清理。
 */
function killProcessTree(child: ChildProcess): void {
  if (process.platform !== 'win32' || child.pid === undefined) return
  try {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref()
  } catch {
    // 进程可能已经退出；杀不掉不该改变工具结果。
  }
}
