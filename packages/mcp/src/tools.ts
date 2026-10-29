/**
 * 把 MCP server 的工具声明翻译成我们的 {@link Tool}。
 *
 * 翻译时要守住两件事：参数 schema 原样透传（server 怎么定义就怎么给模型，改
 * 写只会让模型的调用和 server 的期望对不上），以及**失败必须是中文短句**——
 * server 启动失败、协议违规、工具自己报错，原样回给模型只会得到一句看不懂的
 * 抱怨，模型多半会换个工具瞎试。
 * @module @ryharness/mcp/tools
 */

import type { Tool, ToolContext, ToolResult } from '@ryharness/agent'
import { describeFailure, McpError } from './errors.ts'
import { isPlainObject } from './json.ts'
import type { McpContentBlock, McpToolDescriptor, McpToolResult } from './types.ts'

/** 执行一个 MCP 工具的能力（客户端实现；测试可以给替身）。 */
export type McpToolInvoker = (args: Record<string, unknown>, ctx: ToolContext) => Promise<McpToolResult>

/** 造一个 MCP 工具所需的材料。 */
export interface McpToolOptions {
  /** 对外的工具名（已按命名规则清洗并去过重）。 */
  name: string
  /** server 名，用于错误文案。 */
  server: string
  /** server 侧的真实工具名（未经清洗）。 */
  remoteName: string
  descriptor: McpToolDescriptor
  invoke: McpToolInvoker
  /** 是否每次调用都要用户点头（宿主决定，模型改不了）。 */
  requiresApproval?: boolean
}

/**
 * 把 MCP 的内容块渲染成给模型看的文本。
 *
 * 模型这一侧只有文本，所以图片、音频、二进制资源都换成一句人话说明——总比丢
 * 一段没头没尾的 base64 强。
 */
export function renderMcpContent(blocks: readonly McpContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    parts.push(renderContentBlock(block))
  }
  return parts.join('\n')
}

/** 渲染单个内容块。 */
function renderContentBlock(block: McpContentBlock): string {
  if (block.type === 'text') return block.text ?? ''
  if (block.type === 'image') return `[图片${suffix(block.mimeType)}]`
  if (block.type === 'audio') return `[音频${suffix(block.mimeType)}]`
  if (block.type === 'resource') {
    const resource = block.resource
    if (resource === undefined) return '[内嵌资源]'
    if (resource.text !== undefined) return resource.text
    return `[二进制资源 ${resource.uri}${suffix(resource.mimeType)}]`
  }
  return `[未知内容类型：${block.type}]`
}

/** 类型说明的后缀（`: application/pdf`）。 */
function suffix(mimeType: string | undefined): string {
  return mimeType === undefined ? '' : `：${mimeType}`
}

/**
 * 造一个 MCP 工具。
 *
 * `execute` 永远**不抛异常**：失败一律变成 `isError` 的结果，由 AgentLoop 以
 * tool 消息回给模型。抛异常会把整轮打断，而 MCP 的失败（超时、server 挂了、
 * 工具自己报错）都是可以就地说明白、让模型自己调整的那种。
 */
export function createMcpTool(options: McpToolOptions): Tool {
  const description = options.descriptor.description ?? ''
  return {
    name: options.name,
    description: `MCP 服务器「${options.server}」的工具 ${options.remoteName}：${description}`,
    parameters: options.descriptor.inputSchema ?? { type: 'object', properties: {} },
    requiresApproval: options.requiresApproval === true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (!isPlainObject(args)) {
        return {
          content: `MCP 工具「${options.name}」的参数必须是一个对象，收到的是 ${describeArgType(args)}`,
          isError: true,
        }
      }
      try {
        const result = await options.invoke(args, ctx)
        const text = renderMcpContent(result.content)
        if (result.isError === true) {
          return { content: `MCP 工具「${options.name}」执行失败：\n${text}`, isError: true }
        }
        return { content: text }
      } catch (error) {
        const detail = error instanceof McpError ? error.message : `内部错误：${describeFailure(error)}`
        return { content: detail, isError: true }
      }
    },
  }
}

/** 说清模型传错了什么类型的参数。 */
function describeArgType(args: unknown): string {
  if (args === null) return 'null'
  if (Array.isArray(args)) return '数组'
  return typeof args
}
