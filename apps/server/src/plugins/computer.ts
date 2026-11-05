/**
 * 内置插件：桌面操作（看着屏幕动手）。
 *
 * 五件工具：
 * - `computer_screenshot`：截当前屏幕；
 * - `computer_click`：在坐标上点一下；
 * - `computer_type`：在焦点位置打字；
 * - `computer_key`：按一个键；
 * - `computer_scroll`：滚动。
 *
 * **驱动是 Windows 自带的 PowerShell + .NET**（截图走 `CopyFromScreen`，输入走
 * user32 的 P/Invoke），不需要编译原生代码。其它平台调用会得到结构化错误
 * `NO_DRIVER`，不假装成功。
 *
 * **高危动作要人点头**：点击、打字、按键都会改变屏幕上的东西，所以走的是仓库
 * 里已有的审批链（`approvals.ts`）——界面出审批卡，人点了才执行。模型不能
 * 自己决定要不要点。
 *
 * **截图可能含个人信息**：屏幕上有什么就截到什么。策略里能单独关掉截图，关掉
 * 之后调用得到的是结构化错误，不是一张空图。
 *
 * 会话按助理 id 归属：另一个助理拿同一个会话 id 也碰不到它。
 * @module @ryharness/server/plugins/computer
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool, ToolContext, ToolResult } from '@ryharness/agent'
import {
  ComputerSessionService,
  type ComputerTool,
  type ComputerToolSession,
  createComputerTools,
  WindowsDesktopDriver,
} from '@ryharness/computer-use'
import type { Context } from '@ryharness/cordis'
import type { ApprovalBroker } from '../approvals.ts'
import { json } from '../router.ts'
import type { PluginEntry } from './host.ts'

export const COMPUTER_PLUGIN_ID = 'computer'

/** 电脑插件的依赖。 */
export interface ComputerPluginDeps {
  /** 数据目录：配置文件在 `<dataDir>/config/computer.json`。 */
  readonly dataDir: string
  /** 审批链：高危动作走它要人点头。 */
  readonly approvals: ApprovalBroker
}

/** 配置文件里能放的东西。 */
export interface ComputerConfigFile {
  /** 要不要人点头。默认 true。 */
  readonly requireApproval?: boolean
  /** 截图要不要允许。默认 true。 */
  readonly allowScreenshot?: boolean
  /** 单步时限（毫秒）。默认 30000。 */
  readonly stepTimeoutMs?: number
}

/**
 * 这一轮是谁在说话。
 *
 * 审批卡要挂在会话上，所以工具执行时要能拿到「这是哪一轮」。**用
 * AsyncLocalStorage 而不是模块级变量**：模块级变量在两轮同时跑时会串——A 轮的
 * 点击可能把卡挂到 B 轮的会话上。AsyncLocalStorage 跟着异步调用链走，跨
 * `await` 也不串。
 */
interface ApprovalContext {
  readonly conversationId: string | undefined
  readonly agentId: string | undefined
}

const approvalContext = new AsyncLocalStorage<ApprovalContext>()

/**
 * 读浏览器配置。
 *
 * 读不出来就是「没配」：插件照样装上（工具在），调用时给一句清楚的话。
 * @param dataDir - 数据目录。
 * @returns 桌面配置。
 */
export function readComputerConfig(dataDir: string): ComputerConfigFile {
  const path = join(dataDir, 'config', 'computer.json')
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as ComputerConfigFile
  } catch {
    return {}
  }
}

/**
 * 这个会话归谁。
 *
 * 按助理 id 分：另一个助理拿同一个会话 id 也碰不到它。
 * @param ctx - 工具上下文。
 * @returns owner。
 */
function ownerOf(ctx: ToolContext): string {
  return ctx.agentId ?? ctx.conversationId ?? 'local'
}

/**
 * 把 computer-use 的工具形状套成 agent 的工具形状。
 *
 * 两边本来就兼容（name / description / parameters / execute），差的是**上下文**：
 * agent 的 `ToolContext` 里没有 `owner`，而 computer 的工具靠它做会话隔离。
 * @param tool - computer-use 的工具。
 * @returns agent 的工具。
 */
function adaptTool(tool: ComputerTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const result = await approvalContext.run({ conversationId: ctx.conversationId, agentId: ctx.agentId }, () =>
        tool.execute(args, { owner: ownerOf(ctx), signal: ctx.signal }),
      )
      return { content: result.content, ...(result.isError === undefined ? {} : { isError: result.isError }) }
    },
  }
}

/** 电脑插件入口：五件工具，随插件 fiber 装卸。 */
export function computerPlugin(deps: ComputerPluginDeps): PluginEntry {
  return {
    id: COMPUTER_PLUGIN_ID,
    name: '桌面操作',
    description:
      '让助理看着屏幕动手：截图、点击、打字、按键。用 Windows 自带的 PowerShell + .NET，不需要装额外的东西；点击、打字、按键都要你点头才执行。',
    group: 'feature',
    capabilities: {
      tools: ['computer_screenshot', 'computer_click', 'computer_type', 'computer_key', 'computer_scroll'],
      routes: ['GET /api/computer/sessions'],
    },
    impact:
      '关闭后助理不能再看屏幕、不能动手；已开的桌面会话会立刻被收掉。没装在 Windows 上时这些工具会一直报「没有桌面驱动」。',
    inject: ['tools', 'routes'],
    apply: (ctx: Context) => {
      const config = readComputerConfig(deps.dataDir)
      const service = new ComputerSessionService({
        driverFactory: () => new WindowsDesktopDriver(),
        policy: {
          requireApproval: config.requireApproval ?? true,
          allowScreenshot: config.allowScreenshot ?? true,
        },
        ...(config.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: config.stepTimeoutMs }),
        // 高危动作问人：走仓库里已有的审批链，界面出审批卡，人点了才执行。
        // 没有会话上下文就没有卡可挂，直接拒绝——宁可什么都不做。
        approver: async (request) => {
          const context = approvalContext.getStore()
          if (context?.conversationId === undefined) return false
          return await deps.approvals.request({
            conversationId: context.conversationId,
            agentId: context.agentId ?? '',
            toolName: `computer_${request.kind}`,
            args: JSON.stringify({
              kind: request.kind,
              x: request.x,
              y: request.y,
              text: request.text,
              key: request.key,
            }),
          })
        },
      })
      const session: ComputerToolSession = service
      for (const tool of createComputerTools(session)) {
        ctx.tools.register(adaptTool(tool))
      }
      // 会话视图：让界面能看见「现在开着哪些桌面会话」。
      ctx.routes.register('GET', '/api/computer/sessions', async (req, res) => {
        const owner = req.query.get('owner')
        const sessions = owner === null ? [] : service.list(owner)
        json(res, 200, { sessions })
      })
      // 会话是活的桌面连接：插件卸载时必须收干净。
      ctx.effect(() => {
        return async () => {
          try {
            await service.disposeAll()
          } catch {
            // 关不干净的会话由服务记下原因；卸载不能因为它失败。
          }
        }
      }, 'computer.service')
    },
  }
}
