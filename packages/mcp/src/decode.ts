/**
 * 把 MCP 回包里的 JSON 读成我们认识的形状。
 *
 * 这些函数是纯的：回包形状不对时返回空数组而不是抛错——一个 server 的畸形数据
 * 不该把整条连接带崩，「0 个工具」这个结果本身就在告诉调用方出事了。
 * 唯一会抛的是工具调用结果：那是一次具体调用的回执，形状不对就没有回执可言。
 * @module @ryharness/mcp/decode
 */

import { McpError } from './errors.ts'
import { isPlainObject, readArray, readObject, readString } from './json.ts'
import type {
  McpContentBlock,
  McpPromptDescriptor,
  McpResourceContents,
  McpResourceDescriptor,
  McpServerInfo,
  McpToolDescriptor,
  McpToolResult,
} from './types.ts'

/** 读 `initialize` 的结果。 */
export function readServerInfo(result: unknown, serverName: string): McpServerInfo {
  const root = isPlainObject(result) ? result : {}
  const info = readObject(root, 'serverInfo') ?? {}
  return {
    name: readString(info, 'name') ?? serverName,
    version: readString(info, 'version') ?? '0.0.0',
    protocolVersion: readString(root, 'protocolVersion') ?? 'unknown',
    title: readString(info, 'title'),
    instructions: readString(root, 'instructions'),
    capabilities: readObject(root, 'capabilities') ?? {},
  }
}

/** 读 `tools/list` 的结果。 */
export function readToolDescriptors(result: unknown): McpToolDescriptor[] {
  const root = isPlainObject(result) ? result : {}
  const items = readArray(root, 'tools') ?? []
  const descriptors: McpToolDescriptor[] = []
  for (const item of items) {
    if (!isPlainObject(item)) continue
    const name = readString(item, 'name')
    if (name === undefined || name.length === 0) continue
    descriptors.push({
      name,
      title: readString(item, 'title'),
      description: readString(item, 'description'),
      inputSchema: readObject(item, 'inputSchema'),
    })
  }
  return descriptors
}

/** 读 `tools/call` 的结果；形状不对就是这次调用没有回执，直接报错。 */
export function readToolResult(result: unknown, serverName: string): McpToolResult {
  if (!isPlainObject(result)) {
    throw new McpError('protocol', serverName, `MCP 服务器「${serverName}」的工具调用结果不是对象`)
  }
  const blocks = readArray(result, 'content') ?? []
  const content: McpContentBlock[] = []
  for (const block of blocks) {
    if (!isPlainObject(block)) continue
    content.push({
      type: readString(block, 'type') ?? 'text',
      text: readString(block, 'text'),
      data: readString(block, 'data'),
      mimeType: readString(block, 'mimeType'),
      uri: readString(block, 'uri'),
      resource: readEmbeddedResource(block.resource),
    })
  }
  return { content, isError: result.isError === true }
}

/**
 * 读内嵌资源（内容块里的 `resource` 字段）。
 *
 * 它和 `resources/read` 的回包不是一个形状：那边是 `{ contents: [...] }`，
 * 这边就是资源本身 `{ uri, text, blob }`——两种形状混用会把内容读成空。
 */
export function readEmbeddedResource(value: unknown): McpResourceContents | undefined {
  if (!isPlainObject(value)) return undefined
  const uri = readString(value, 'uri')
  if (uri === undefined) return undefined
  return {
    uri,
    mimeType: readString(value, 'mimeType'),
    text: readString(value, 'text'),
    blob: readString(value, 'blob'),
  }
}

/** 读 `resources/list` 的结果。 */
export function readResourceDescriptors(result: unknown): McpResourceDescriptor[] {
  const root = isPlainObject(result) ? result : {}
  const items = readArray(root, 'resources') ?? []
  const descriptors: McpResourceDescriptor[] = []
  for (const item of items) {
    if (!isPlainObject(item)) continue
    const uri = readString(item, 'uri')
    if (uri === undefined) continue
    descriptors.push({
      uri,
      name: readString(item, 'name') ?? uri,
      title: readString(item, 'title'),
      description: readString(item, 'description'),
      mimeType: readString(item, 'mimeType'),
    })
  }
  return descriptors
}

/** 读 `resources/read` 的结果。 */
export function readResourceContents(result: unknown): McpResourceContents[] {
  if (!isPlainObject(result)) return []
  const items = readArray(result, 'contents') ?? []
  const contents: McpResourceContents[] = []
  for (const item of items) {
    if (!isPlainObject(item)) continue
    const uri = readString(item, 'uri')
    if (uri === undefined) continue
    contents.push({
      uri,
      mimeType: readString(item, 'mimeType'),
      text: readString(item, 'text'),
      blob: readString(item, 'blob'),
    })
  }
  return contents
}

/** 读 `prompts/list` 的结果。 */
export function readPromptDescriptors(result: unknown): McpPromptDescriptor[] {
  const root = isPlainObject(result) ? result : {}
  const items = readArray(root, 'prompts') ?? []
  const descriptors: McpPromptDescriptor[] = []
  for (const item of items) {
    if (!isPlainObject(item)) continue
    const name = readString(item, 'name')
    if (name === undefined || name.length === 0) continue
    descriptors.push({
      name,
      title: readString(item, 'title'),
      description: readString(item, 'description'),
      arguments: readPromptArguments(item.arguments),
    })
  }
  return descriptors
}

/** 读 prompt 的参数声明；不是数组就当作没有参数。 */
function readPromptArguments(value: unknown): McpPromptDescriptor['arguments'] {
  if (!Array.isArray(value)) return undefined
  const args: NonNullable<McpPromptDescriptor['arguments']> = []
  for (const item of value) {
    if (!isPlainObject(item)) continue
    const name = readString(item, 'name')
    if (name === undefined) continue
    args.push({
      name,
      description: readString(item, 'description'),
      required: item.required === true,
    })
  }
  return args
}
