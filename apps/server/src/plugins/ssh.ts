/**
 * 内置插件：远程 POSIX 机器（ssh）。
 *
 * 四件工具：
 * - `ssh_exec`：在远端跑一条命令；
 * - `ssh_read`：读一个远端文件；
 * - `ssh_write`：写一个远端文件；
 * - `ssh_list`：列一个远端目录。
 *
 * **后端是本机的 `ssh` 可执行文件**（Windows 10+ 自带 OpenSSH，Linux/macOS 本来
 * 就有），不引 ssh2 那种原生模块——命令行反而更好审计：跑什么、传什么一眼看得见。
 *
 * **凭据不进 argv**：密码走 ssh 的 askpass 助手（助手路径进 argv，密码进子进程
 * 的环境），私钥只传**路径**。密钥本身从 `@ryharness/credentials` 取——配置里
 * 只存引用，真要用要人点头（走它自己的审批流）。
 *
 * **路径默认关在远端根目录里**：宿主配了 `root`，`../` 就跑不出去。
 *
 * **主机清单在 `<dataDir>/config/ssh.json`**：哪些机器、什么凭据、关在哪个目录。
 * 没有配置就没有可连的机器，工具会直说。
 * @module @ryharness/server/plugins/ssh
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Tool, ToolContext, ToolResult } from '@ryharness/agent'
import type { Context } from '@ryharness/cordis'
import type { CredentialRegistry } from '@ryharness/credentials'
import { CliSshConnection, type SshConnection, type SshConnectionConfig, type SshCredential } from '@ryharness/ssh'
import { json } from '../router.ts'
import type { PluginEntry } from './host.ts'

export const SSH_PLUGIN_ID = 'ssh'

/** ssh 插件的依赖。 */
export interface SshPluginDeps {
  /** 数据目录：主机清单在 `<dataDir>/config/ssh.json`。 */
  readonly dataDir: string
  /** 凭据注册表：密码与私钥从这儿取。 */
  readonly credentials: CredentialRegistry
}

/** 配置文件里的一台机器。 */
export interface SshHostConfig {
  /** 这台机器的 id（模型用它指代）。 */
  readonly id: string
  /** 主机名（可以带 `user@`）。 */
  readonly host: string
  /** 端口。 */
  readonly port?: number
  /** 用户名。 */
  readonly user?: string
  /** 远端根目录：所有文件操作关在这里。 */
  readonly root?: string
  /** 凭据引用 id（对应 `@ryharness/credentials` 里的登记）。 */
  readonly credentialId?: string
  /** 凭据的种类。 */
  readonly credentialKind?: 'agent' | 'key' | 'password'
  /** 私钥路径（`credentialKind` 为 `key` 时用；路径本身不是机密）。 */
  readonly identityFile?: string
  /** 主机密钥策略。 */
  readonly hostKeyPolicy?: 'strict' | 'accept-new'
  /** 单次执行时限（毫秒）。 */
  readonly timeoutMs?: number
}

/** 配置文件整体。 */
export interface SshConfigFile {
  /** 可连的机器清单。 */
  readonly hosts?: SshHostConfig[]
}

/**
 * 读 ssh 配置。
 *
 * 读不出来就是「没配」：插件照样装上（工具在），调用时给一句清楚的话。
 * @param dataDir - 数据目录。
 * @returns ssh 配置。
 */
export function readSshConfig(dataDir: string): SshConfigFile {
  const path = join(dataDir, 'config', 'ssh.json')
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as SshConfigFile
  } catch {
    return {}
  }
}

/** 读参数：字符串字段。 */
function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>)[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * 按主机 id 找配置。
 * @param config - ssh 配置。
 * @param id - 主机 id。
 * @returns 找到的配置；没找到是 undefined。
 */
export function findSshHost(config: SshConfigFile, id: string): SshHostConfig | undefined {
  return config.hosts?.find((host) => host.id === id)
}

/**
 * 找 askpass 助手。
 *
 * **不按 cwd 找**：服务端的 cwd 随调用方变（桌面端内嵌时是用户的工作目录），
 * 按 cwd 找会找到别的地方去。用本文件的位置向上找 `assets/askpass.mjs`——
 * 开发时是 `apps/server/src/plugins/` 往上两级，打包后是 `apps/server/lib/`
 * 往上一级，两种布局都能找到。
 * @returns 助手的路径；没找到是 undefined。
 */
function findAskpassHelper(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(dir, 'assets', 'askpass.mjs')
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * 造一条连接。
 *
 * 凭据的取法分三种：**agent**（ssh-agent 或默认密钥）与 **key**（私钥路径）
 * 不需要秘密，只有 **password** 要从凭据注册表取——取的时候要人点头。
 * @param host - 主机配置。
 * @param credentials - 凭据注册表。
 * @param requester - 谁要（审计用）。
 * @returns 连接配置（不含凭据秘密时是空凭据）。
 */
async function buildConnectionConfig(
  host: SshHostConfig,
  credentials: CredentialRegistry,
  requester: string,
): Promise<SshConnectionConfig> {
  const base: SshConnectionConfig = {
    host: host.host,
    ...(host.port === undefined ? {} : { port: host.port }),
    ...(host.user === undefined ? {} : { user: host.user }),
    ...(host.root === undefined ? {} : { root: host.root }),
    ...(host.hostKeyPolicy === undefined ? {} : { hostKeyPolicy: host.hostKeyPolicy }),
    ...(host.timeoutMs === undefined ? {} : { defaultTimeoutMs: host.timeoutMs }),
  }
  const kind = host.credentialKind ?? 'agent'
  if (kind === 'agent') return base
  if (kind === 'key') {
    if (host.identityFile === undefined) {
      throw new Error(`ssh：主机 ${host.id} 用的是私钥认证，但没给私钥路径。`)
    }
    const credential: SshCredential = { kind: 'key', identityFile: host.identityFile }
    return { ...base, credential }
  }
  if (host.credentialId === undefined) {
    throw new Error(`ssh：主机 ${host.id} 用的是密码认证，但没给凭据引用。`)
  }
  const askpass = findAskpassHelper()
  if (askpass === undefined) {
    throw new Error('ssh：找不到 askpass 助手（assets/askpass.mjs），密码认证用不了。')
  }
  const password = await credentials.use({
    credentialId: host.credentialId,
    purpose: `连接远程机器 ${host.id}（${host.host}）`,
    requester,
  })
  // 密码**不进 argv**：走 askpass 助手，密码只在子进程的环境里。
  const credential: SshCredential = {
    kind: 'password',
    password,
    askpass,
  }
  return { ...base, credential }
}

/**
 * 造连接。
 * @param host - 主机配置。
 * @param credentials - 凭据注册表。
 * @param requester - 谁要。
 * @returns 连接。
 */
async function connect(
  host: SshHostConfig,
  credentials: CredentialRegistry,
  requester: string,
): Promise<SshConnection> {
  const config = await buildConnectionConfig(host, credentials, requester)
  return new CliSshConnection(config)
}

/** 把异常整成给模型看的错误结果。 */
function toErrorResult(error: unknown): ToolResult {
  if (error instanceof Error) return { content: `ssh：${error.message}`, isError: true }
  return { content: 'ssh：操作失败：内部错误', isError: true }
}

/**
 * 读出主机 id 与目标主机配置。
 * @param args - 工具参数。
 * @param config - ssh 配置。
 * @returns 主机 id 与配置。
 */
function resolveHost(args: unknown, config: SshConfigFile): { id: string; host: SshHostConfig } | { error: string } {
  const id = stringArg(args, 'host')
  if (id === undefined) {
    const names = (config.hosts ?? []).map((host) => host.id)
    return {
      error:
        names.length === 0
          ? 'ssh：还没有配置任何远程机器（在 config/ssh.json 里加）。'
          : `ssh：缺少 host 参数。可用的机器：${names.join('、')}。`,
    }
  }
  const host = findSshHost(config, id)
  if (host === undefined) {
    const names = (config.hosts ?? []).map((item) => item.id)
    return { error: `ssh：没有这台机器（${id}）。可用的机器：${names.join('、')}。` }
  }
  return { id, host }
}

/** ssh 插件入口：四件工具，随插件 fiber 装卸。 */
export function sshPlugin(deps: SshPluginDeps): PluginEntry {
  return {
    id: SSH_PLUGIN_ID,
    name: '远程机器',
    description:
      '让助理在另一台 POSIX 机器上跑命令、读写文件。用本机的 ssh 客户端（不装原生模块）；可连的机器在 config/ssh.json 里配，路径默认关在远端根目录里。',
    group: 'feature',
    capabilities: {
      tools: ['ssh_exec', 'ssh_read', 'ssh_write', 'ssh_list'],
      routes: ['GET /api/ssh/hosts'],
    },
    impact: '关闭后助理不能再操作远程机器；本机 ssh 客户端与远端机器上的东西都不受影响。',
    inject: ['tools', 'routes'],
    apply: (ctx: Context) => {
      const config = readSshConfig(deps.dataDir)

      /** 造 `ssh_exec`。 */
      const execTool: Tool = {
        name: 'ssh_exec',
        description: '在远程 POSIX 机器上跑一条命令（交给远端 shell 解释，管道与重定向都能用），返回退出码与输出。',
        // 远端命令交给远端 shell 解释，能做的事跟 shell_exec 一样多——只是换了台
        // 机器。每条命令同样要经用户批准（见 approvals.ts）。
        requiresApproval: true,
        parameters: {
          type: 'object',
          properties: {
            host: { type: 'string', description: '机器 id（在 config/ssh.json 里配的那些）。' },
            command: { type: 'string', description: '要跑的���令文本。' },
            cwd: { type: 'string', description: '远端工作目录（相对路径按远端根目录解析）。' },
          },
          required: ['host', 'command'],
        },
        async execute(args, toolCtx: ToolContext): Promise<ToolResult> {
          const resolved = resolveHost(args, config)
          if ('error' in resolved) return { content: resolved.error, isError: true }
          const command = stringArg(args, 'command')
          if (command === undefined) return { content: 'ssh：缺少 command 参数。', isError: true }
          const cwd = stringArg(args, 'cwd')
          try {
            const connection = await connect(resolved.host, deps.credentials, toolCtx.agentId ?? 'local')
            try {
              const result = await connection.exec(command, {
                ...(cwd === undefined ? {} : { cwd }),
                ...(toolCtx.signal === undefined ? {} : { signal: toolCtx.signal }),
                // 远端非零退出不当作失败：`grep` 没匹配到也是 1，模型要自己看输出。
                rejectOnNonZeroExit: false,
              })
              return {
                content: JSON.stringify({
                  exitCode: result.exitCode,
                  stdout: result.stdout,
                  stderr: result.stderr,
                  stdoutTruncated: result.stdoutTruncated,
                  durationMs: result.durationMs,
                }),
              }
            } finally {
              await connection.close()
            }
          } catch (error) {
            return toErrorResult(error)
          }
        },
      }

      /** 造 `ssh_read`。 */
      const readTool: Tool = {
        name: 'ssh_read',
        description: '读远程机器上的一个文件，返回内容。路径默认关在远端根目录里。',
        parameters: {
          type: 'object',
          properties: {
            host: { type: 'string', description: '机器 id。' },
            path: { type: 'string', description: '远端文件路径。' },
          },
          required: ['host', 'path'],
        },
        async execute(args, toolCtx: ToolContext): Promise<ToolResult> {
          const resolved = resolveHost(args, config)
          if ('error' in resolved) return { content: resolved.error, isError: true }
          const path = stringArg(args, 'path')
          if (path === undefined) return { content: 'ssh：缺少 path 参数。', isError: true }
          try {
            const connection = await connect(resolved.host, deps.credentials, toolCtx.agentId ?? 'local')
            try {
              const bytes = await connection.readFile(path, {
                ...(toolCtx.signal === undefined ? {} : { signal: toolCtx.signal }),
              })
              return {
                content: JSON.stringify({ path, bytes: bytes.byteLength, text: Buffer.from(bytes).toString('utf8') }),
              }
            } finally {
              await connection.close()
            }
          } catch (error) {
            return toErrorResult(error)
          }
        },
      }

      /** 造 `ssh_write`。 */
      const writeTool: Tool = {
        name: 'ssh_write',
        description: '写远程机器上的一个文件（内容会被覆盖）。路径默认关在远端根目录里。',
        parameters: {
          type: 'object',
          properties: {
            host: { type: 'string', description: '机器 id。' },
            path: { type: 'string', description: '远端文件路径。' },
            content: { type: 'string', description: '要写入的文本内容。' },
          },
          required: ['host', 'path', 'content'],
        },
        async execute(args, toolCtx: ToolContext): Promise<ToolResult> {
          const resolved = resolveHost(args, config)
          if ('error' in resolved) return { content: resolved.error, isError: true }
          const path = stringArg(args, 'path')
          if (path === undefined) return { content: 'ssh：缺少 path 参数。', isError: true }
          const content =
            typeof args === 'object' && args !== null ? (args as Record<string, unknown>).content : undefined
          if (typeof content !== 'string') return { content: 'ssh：缺少 content 参数。', isError: true }
          try {
            const connection = await connect(resolved.host, deps.credentials, toolCtx.agentId ?? 'local')
            try {
              await connection.writeFile(path, content, {
                ...(toolCtx.signal === undefined ? {} : { signal: toolCtx.signal }),
              })
              return { content: JSON.stringify({ ok: true, path, bytes: Buffer.byteLength(content) }) }
            } finally {
              await connection.close()
            }
          } catch (error) {
            return toErrorResult(error)
          }
        },
      }

      /** 造 `ssh_list`。 */
      const listTool: Tool = {
        name: 'ssh_list',
        description: '列远程机器上某个目录的内容。路径默认关在远端根目录里。',
        parameters: {
          type: 'object',
          properties: {
            host: { type: 'string', description: '机器 id。' },
            path: { type: 'string', description: '远端目录路径。' },
          },
          required: ['host'],
        },
        async execute(args, toolCtx: ToolContext): Promise<ToolResult> {
          const resolved = resolveHost(args, config)
          if ('error' in resolved) return { content: resolved.error, isError: true }
          const path = stringArg(args, 'path') ?? '.'
          try {
            const connection = await connect(resolved.host, deps.credentials, toolCtx.agentId ?? 'local')
            try {
              const entries = await connection.list(path, {
                ...(toolCtx.signal === undefined ? {} : { signal: toolCtx.signal }),
              })
              return { content: JSON.stringify({ path, entries }) }
            } finally {
              await connection.close()
            }
          } catch (error) {
            return toErrorResult(error)
          }
        },
      }

      ctx.tools.register(execTool)
      ctx.tools.register(readTool)
      ctx.tools.register(writeTool)
      ctx.tools.register(listTool)
      // 主机清单：界面上要能看见「有哪些机器可连」，而不是让人猜 host 该填什么。
      ctx.routes.register('GET', '/api/ssh/hosts', async (_req, res) => {
        const hosts = (config.hosts ?? []).map((host) => ({
          id: host.id,
          host: host.host,
          port: host.port,
          root: host.root,
          credentialKind: host.credentialKind ?? 'agent',
        }))
        json(res, 200, { hosts })
      })
    },
  }
}
