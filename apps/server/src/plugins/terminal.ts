/**
 * 内置插件：持久终端会话。
 *
 * 一次性命令和持久会话是两回事。`shell_exec` 跑完就退出，目录、环境变量、还在跑
 * 的后台进程全没了；装依赖、起 dev server、反复调一个 REPL，都需要一条**一直活着**
 * 的 shell。这个插件把那种 shell 接给助理：
 *
 * - `terminal_open`：开一个会话，给回会话 id；
 * - `terminal_exec`：在会话里跑一条命令，读回输出；
 * - `terminal_cd`：切工作目录，并且确认真的切过去了；
 * - `terminal_read`：读走还没读的输出（后台命令、上一条命令没跑完时用）；
 * - `terminal_interrupt`：中断正在跑的那条命令；
 * - `terminal_close`：关掉会话，进程树一起收掉。
 *
 * **边界先说清楚**（模型也该知道，不然会一直踩）：Windows 上没有真 PTY，走的是
 * 管道模式——跑不了 `vim`/`top`，Ctrl-C 写进去也没用（管道没有 tty 的行规程），
 * 要停一条命令只能用 `terminal_interrupt`。完整口径见 `@ryharness/terminal` 的 README。
 *
 * 会话按助理 id 归属：另一个助理拿同一个会话 id 也碰不到它。
 * @module @ryharness/server/plugins/terminal
 */

import type { Tool, ToolContext, ToolResult } from '@ryharness/agent'
import type { Context } from '@ryharness/cordis'
import { LocalShellBackend, TerminalService, type TerminalShellDialect } from '@ryharness/terminal'
import type { PluginEntry } from './host.ts'

export const TERMINAL_PLUGIN_ID = 'terminal'

/** 开会话的工具名。 */
export const TERMINAL_OPEN_TOOL = 'terminal_open'
/** 跑命令的工具名。 */
export const TERMINAL_EXEC_TOOL = 'terminal_exec'
/** 切工作目录的工具名。 */
export const TERMINAL_CD_TOOL = 'terminal_cd'
/** 读输出的工具名。 */
export const TERMINAL_READ_TOOL = 'terminal_read'
/** 中断命令的工具名。 */
export const TERMINAL_INTERRUPT_TOOL = 'terminal_interrupt'
/** 关会话的工具名。 */
export const TERMINAL_CLOSE_TOOL = 'terminal_close'

/** 终端插件的依赖。 */
export interface TerminalPluginOptions {
  /**
   * 用哪个方言起 shell。
   *
   * 不给就按平台挑：Windows 用 pwsh（从 stdin 读命令时行为干净），其余用 bash。
   */
  readonly dialect?: TerminalShellDialect
}

/** 一条命令最多等多久（毫秒）。 */
const DEFAULT_WAIT_MS = 15_000
/** 单次等待的上限（毫秒）。 */
const MAX_WAIT_MS = 60_000
/** 「安静窗口」：这么久没有新输出就当命令跑完了。 */
const QUIET_MS = 1_000

/**
 * 会话归属者。
 *
 * 按助理 id 分：同一个助理的多次调用共用一条会话，另一个助理拿同一个 id 也碰不到它。
 * @param ctx - 工具上下文。
 * @returns owner。
 */
function ownerOf(ctx: ToolContext): string {
  return ctx.agentId ?? ctx.conversationId ?? 'local'
}

/** 取一个必填的字符串参数。 */
function argString(args: unknown, key: string): string {
  const value = optionalString(args, key)
  if (value === undefined) throw new Error(`terminal 工具：缺少参数 "${key}"`)
  return value
}

/** 取一个可选的字符串参数。 */
function optionalString(args: unknown, key: string): string | undefined {
  if (typeof args === 'object' && args !== null && key in args) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** 取一个数字参数（不给就用缺省值）。 */
function argNumber(args: unknown, key: string, fallback: number): number {
  if (typeof args === 'object' && args !== null && key in args) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return fallback
}

/** 把异常映射成错误结果，而不是抛给循环。 */
async function guard(operation: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await operation()
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true }
  }
}

/**
 * 读到安静为止。
 *
 * 管道模式没有「命令跑完了」这个信号，只能等：一段时间里没有新输出就当它跑完了。
 * 安静窗口取 1 秒——`npm install` 这类构建脚本中间会停顿几百毫秒，窗口太短会切在半截。
 * @param service - 会话服务。
 * @param owner - 会话归属者。
 * @param sessionId - 会话 id。
 * @param waitMs - 总预算（毫秒）。
 * @returns 读到的输出。
 */
async function readUntilQuiet(
  service: TerminalService,
  owner: string,
  sessionId: string,
  waitMs: number,
): Promise<string> {
  const deadline = Date.now() + waitMs
  let text = ''
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const chunk = await service.read(owner, sessionId, { waitMs: Math.min(QUIET_MS, remaining) })
    // 读空说明安静窗口过去了：这会儿没有新输出，命令大概跑完了。
    if (chunk.text.length === 0) break
    text += chunk.text
  }
  return text
}

/** 开会话的工具。 */
function createOpenTool(service: TerminalService): Tool {
  return {
    name: TERMINAL_OPEN_TOOL,
    description: '开一个一直活着的终端会话，返回会话 id。目录、环境变量、后台进程都留在里面，跨多次调用保留。',
    // 会话是有状态的：同一批里「关掉 A 再开 B」这类顺序不能乱。
    executionMode: 'sequential',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '初始工作目录；不给就用工作区根目录' },
      },
    },
    async execute(args, ctx) {
      return guard(async () => {
        const cwd = optionalString(args, 'cwd') ?? ctx.workspaceRoot
        const session = await service.open(ownerOf(ctx), { cwd })
        const lines = [
          `会话 id：${session.id}`,
          `方言：${session.dialect}`,
          `工作目录：${session.cwd}`,
          `进程 pid：${session.pid ?? '未知'}`,
          '这是管道模式（不是真 PTY）：跑不了 vim/top；Ctrl-C 写不进去，要停一条命令请用 terminal_interrupt。',
        ]
        return { content: lines.join('\n') }
      })
    },
  }
}

/** 跑命令的工具。 */
function createExecTool(service: TerminalService): Tool {
  return {
    name: TERMINAL_EXEC_TOOL,
    description: '在终端会话里跑一条命令并读回输出。同一个会话里的命令共享一个 shell：目录、环境变量、后台进程都留着。',
    executionMode: 'sequential',
    // 管道模式对宿主没有真实边界：一条命令能做的事跟 shell_exec 一样多，
    // 所以每条命令都得经用户批准。
    requiresApproval: true,
    timeoutMs: 120_000,
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id（terminal_open 给的）' },
        command: { type: 'string', description: '要执行的命令' },
        waitMs: { type: 'number', description: `最多等多久（毫秒，默认 ${DEFAULT_WAIT_MS}）` },
      },
      required: ['sessionId', 'command'],
    },
    async execute(args, ctx) {
      return guard(async () => {
        const owner = ownerOf(ctx)
        const sessionId = argString(args, 'sessionId')
        const command = argString(args, 'command')
        const waitMs = Math.min(Math.max(argNumber(args, 'waitMs', DEFAULT_WAIT_MS), 0), MAX_WAIT_MS)
        await service.send(owner, sessionId, command)
        const text = await readUntilQuiet(service, owner, sessionId, waitMs)
        // 命令还没跑完就再读一次：输出可能还在路上。
        return { content: text.length === 0 ? '（这条命令暂时没有输出；命令还在跑就再调一次 terminal_read）' : text }
      })
    },
  }
}

/**
 * 切工作目录的工具。
 *
 * 走的是「切完读回来确认」那条路：目录不存在时 shell 报个错但会话还活着，
 * 这里必须让调用方看见失败，而不是让它以为已经切过去了。
 */
function createCdTool(service: TerminalService): Tool {
  return {
    name: TERMINAL_CD_TOOL,
    description: '切终端会话的工作目录，并确认真的切过去了。目录不存在会明确报错。',
    executionMode: 'sequential',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id（terminal_open 给的）' },
        path: { type: 'string', description: '要切到的目录' },
      },
      required: ['sessionId', 'path'],
    },
    async execute(args, ctx) {
      return guard(async () => {
        const owner = ownerOf(ctx)
        const sessionId = argString(args, 'sessionId')
        const path = argString(args, 'path')
        const cwd = await service.changeDirectory(owner, sessionId, path)
        return { content: `当前工作目录：${cwd}` }
      })
    },
  }
}

/** 读输出的工具。 */
function createReadTool(service: TerminalService): Tool {
  return {
    name: TERMINAL_READ_TOOL,
    description: '读终端会话里还没读走的输出。后台命令、或者上一条命令没跑完时用它接着读。',
    executionMode: 'sequential',
    timeoutMs: 120_000,
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id（terminal_open 给的）' },
        waitMs: { type: 'number', description: `最多等多久（毫秒，默认 ${DEFAULT_WAIT_MS}）` },
      },
      required: ['sessionId'],
    },
    async execute(args, ctx) {
      return guard(async () => {
        const owner = ownerOf(ctx)
        const sessionId = argString(args, 'sessionId')
        const waitMs = Math.min(Math.max(argNumber(args, 'waitMs', DEFAULT_WAIT_MS), 0), MAX_WAIT_MS)
        const chunk = await service.read(owner, sessionId, { waitMs })
        const suffix = chunk.truncated ? '\n（输出被截断了，剩下的用 terminal_read 接着读）' : ''
        return { content: chunk.text.length === 0 ? '（没有新的输出）' : `${chunk.text}${suffix}` }
      })
    },
  }
}

/** 中断命令的工具。 */
function createInterruptTool(service: TerminalService): Tool {
  return {
    name: TERMINAL_INTERRUPT_TOOL,
    description: '中断终端会话里正在跑的那条命令。会话本身还在，可以接着发命令。管道模式写 Ctrl-C 没用，只能这样停。',
    executionMode: 'sequential',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id（terminal_open 给的）' },
      },
      required: ['sessionId'],
    },
    async execute(args, ctx) {
      return guard(async () => {
        const owner = ownerOf(ctx)
        const sessionId = argString(args, 'sessionId')
        await service.interrupt(owner, sessionId)
        return { content: '已中断正在跑的命令；会话还在，可以接着发命令。' }
      })
    },
  }
}

/** 关会话的工具。 */
function createCloseTool(service: TerminalService): Tool {
  return {
    name: TERMINAL_CLOSE_TOOL,
    description: '关掉终端会话，进程树一起收掉。用完记得关，不然 shell 会一直占着。',
    executionMode: 'sequential',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id（terminal_open 给的）' },
      },
      required: ['sessionId'],
    },
    async execute(args, ctx) {
      return guard(async () => {
        const owner = ownerOf(ctx)
        const sessionId = argString(args, 'sessionId')
        await service.close(owner, sessionId)
        return { content: '会话已关闭，进程树已经收干净。' }
      })
    },
  }
}

/** 终端插件入口：六个工具，随插件 fiber 装卸。 */
export function terminalPlugin(options: TerminalPluginOptions = {}): PluginEntry {
  const dialect = options.dialect ?? (process.platform === 'win32' ? 'pwsh' : 'bash')
  return {
    id: TERMINAL_PLUGIN_ID,
    name: '持久终端',
    description:
      '让助理用一条一直活着的 shell：目录、环境变量和后台进程跨调用保留。装依赖、起服务、反复调 REPL 都用它。',
    group: 'feature',
    capabilities: {
      tools: [
        TERMINAL_OPEN_TOOL,
        TERMINAL_EXEC_TOOL,
        TERMINAL_CD_TOOL,
        TERMINAL_READ_TOOL,
        TERMINAL_INTERRUPT_TOOL,
        TERMINAL_CLOSE_TOOL,
      ],
    },
    impact:
      '关闭后助理只能用一次性的 shell_exec（跑完就退出），目录、环境变量和后台进程不再保留；已开的终端会话会立刻被收掉。',
    inject: ['tools'],
    apply: (ctx: Context) => {
      const service = new TerminalService({ backends: [new LocalShellBackend({ dialect })] })
      ctx.tools.register(createOpenTool(service))
      ctx.tools.register(createExecTool(service))
      ctx.tools.register(createCdTool(service))
      ctx.tools.register(createReadTool(service))
      ctx.tools.register(createInterruptTool(service))
      ctx.tools.register(createCloseTool(service))
      // 会话是活的 shell：插件卸载时必须把进程收干净，不然关掉插件还留着一堆
      // shell 在用户机器上跑。
      ctx.effect(() => {
        return async () => {
          try {
            await service.disposeAll()
          } catch {
            // 关不干净的会话由服务记下原因；卸载不能因为它失败。
          }
        }
      }, 'terminal.service')
    },
  }
}
