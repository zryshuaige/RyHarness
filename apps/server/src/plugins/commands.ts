/**
 * 内置插件：斜杠命令。
 *
 * 人可以在输入框里敲 `/goal 继续` 这种命令：它**不花模型一轮**，直接跑命令自己
 * 的逻辑，跑完把结果给界面看。本插件把这件事接到 HTTP 上——
 * - `GET /api/commands`：命令清单，界面拿它做输入框补全；
 * - `POST /api/commands/execute`：跑一行输入。
 *
 * 命令本身由别的插件或主控注册进来（见 {@link CommandsPluginOptions.commands}），
 * 本插件不内置任何命令——内置命令等于替用户决定了「有哪些命令可用」。
 * @module @ryharness/server/plugins/commands
 */

import { type CommandDefinition, CommandRegistry, parseCommandLine } from '@ryharness/commands'
import type { Context } from '@ryharness/cordis'
import { HttpRequestError, json, strField } from '../router.ts'
import type { PluginEntry } from './host.ts'

export const COMMANDS_PLUGIN_ID = 'commands'

/** 命令清单路由。 */
export const COMMANDS_LIST_ROUTE = 'GET /api/commands'
/** 执行一条命令的路由。 */
export const COMMANDS_EXECUTE_ROUTE = 'POST /api/commands/execute'

/** 命令插件的依赖。 */
export interface CommandsPluginOptions {
  /**
   * 已经建好的命令注册表。
   *
   * 给了就用它；不给就插件自己建一个，把 {@link commands} 里的命令登记进去。
   */
  readonly registry?: CommandRegistry
  /** 要注册的命令。 */
  readonly commands?: readonly CommandDefinition[]
}

/** 命令插件入口：两条路由，全部随插件 fiber 装卸。 */
export function commandsPlugin(options: CommandsPluginOptions): PluginEntry {
  return {
    id: COMMANDS_PLUGIN_ID,
    name: '斜杠命令',
    description: '让人在输入框里敲 /命令 直接触发动作：不等模型回话，命令自己跑完把结果给界面。',
    group: 'feature',
    capabilities: {
      routes: [COMMANDS_LIST_ROUTE, COMMANDS_EXECUTE_ROUTE],
    },
    impact: '关闭后输入框里没有斜杠命令补全，敲 /命令 也不再触发动作；已注册的命令定义留在内存里，重新打开即可用。',
    inject: ['routes'],
    apply: (ctx: Context) => {
      const registry = options.registry ?? new CommandRegistry()
      for (const command of options.commands ?? []) registry.register(command)

      ctx.routes.register('GET', '/api/commands', async (_req, res) => {
        json(res, 200, { commands: registry.list() })
      })

      ctx.routes.register('POST', '/api/commands/execute', async (req, res) => {
        const body = await req.body()
        const line = strField(body, 'line')
        if (line === undefined) {
          throw new HttpRequestError(400, '缺少 line（要跑的命令行）', 'COMMAND_BAD_REQUEST')
        }
        // 「这不是命令」与「没有这个命令」要分开说：前者是用户敲错了，后者是
        // 插件没装或者命令还没注册。
        if (parseCommandLine(line) === undefined) {
          throw new HttpRequestError(400, '这不是命令', 'NOT_A_COMMAND')
        }
        /**
         * 会话 id：命令按会话归属（目标、待办、提醒都是），所以它得知道这是哪个会话。
         *
         * 从 body 的 sessionId 或查询串取；两者都没有就不给——命令自己会回一句
         * 「这条命令得在一个会话里用」，而不是去猜一个全局的「当前会话」
         * （两个会话同时敲命令时那份会张冠李戴）。
         */
        const sessionId = strField(body, 'sessionId') ?? req.query.get('sessionId') ?? undefined
        const execution = await registry.execute(line, sessionId === undefined ? undefined : { sessionId })
        if (!execution.ran) {
          throw new HttpRequestError(404, execution.text, 'UNKNOWN_COMMAND')
        }
        json(res, 200, execution)
      })
    },
  }
}
