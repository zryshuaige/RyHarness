#!/usr/bin/env node
/**
 * 假 MCP server：在 stdio 上跑 JSON-RPC 2.0，给集成测试当对端。
 *
 * 为什么要有它：只测纯函数的话，协议这一层最容易带病上线——分片到达的行、
 * stderr 混进 stdout、server 半路退出，这三件事单元测试都编不出来，只有真起
 * 一个子进程才看得见。
 *
 * 行为开关（环境变量）：
 * - `MCP_FIXTURE_MODE=garbage`：initialize 时往 stdout 写一行非 JSON，测协议违规。
 * - `MCP_FIXTURE_MODE=exit`：握手期间直接退出，测「server 中途没了」。
 * - `MCP_FIXTURE_LOG=<文件>`：把收到的通知记下来，测取消通知确实发到了。
 */
import { appendFileSync } from 'node:fs'
import process from 'node:process'

const PROTOCOL_VERSION = '2024-11-05'
const MODE = process.env.MCP_FIXTURE_MODE ?? 'normal'
const LOG = process.env.MCP_FIXTURE_LOG

const TOOLS = [
  {
    name: 'echo',
    description: '把收到的参数原样回显',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
  },
  { name: 'boom', description: '总是失败', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: '永远不回复', inputSchema: { type: 'object', properties: {} } },
  { name: 'weird name/with:chars', description: '名字带非法字符', inputSchema: { type: 'object', properties: {} } },
  { name: 'image', description: '回一张图片', inputSchema: { type: 'object', properties: {} } },
]

const RESOURCES = [
  { uri: 'file:///greeting.txt', name: 'greeting', mimeType: 'text/plain' },
  { uri: 'file:///binary.bin', name: 'binary' },
]

const PROMPTS = [{ name: 'summarize', description: '总结一段文字', arguments: [{ name: 'topic', required: true }] }]

/** 往 stdout 写一行 JSON。 */
function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

/**
 * 回包前先掺几句「不该出现的东西」。
 *
 * 真实 server 偶尔会多打一个空行、发一条通知、或者回一个我们没发过的 id。
 * 客户端碰到这些必须装作没看见，而不是当成协议错误把整条连接掐了。
 */
function sendNoise() {
  process.stdout.write('\n')
  send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } })
  send({ jsonrpc: '2.0', id: 987654, result: { stray: true } })
}

/** 把收到的通知记进日志文件（测试据此确认取消通知到了对端）。 */
function recordNotification(payload) {
  if (LOG === undefined) return
  appendFileSync(LOG, `${JSON.stringify(payload)}\n`)
}

/** initialize 的结果。 */
function initializeResult() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {}, resources: {}, prompts: {} },
    serverInfo: { name: 'fake-mcp', version: '1.0.0' },
    instructions: '这是测试用的假 MCP server。',
  }
}

/** 处理 tools/call。 */
function callTool(params) {
  const name = typeof params?.name === 'string' ? params.name : ''
  const args = params?.arguments ?? {}
  if (name === 'echo') {
    return { content: [{ type: 'text', text: `回显：${JSON.stringify(args)}` }] }
  }
  if (name === 'boom') {
    return { content: [{ type: 'text', text: '故意的失败原因' }], isError: true }
  }
  if (name === 'image') {
    return { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }
  }
  if (name === 'slow') {
    // 永远不回复：用来测超时与取消。
    return undefined
  }
  return undefined
}

function handle(message) {
  const { id, method, params } = message
  if (id === undefined || id === null) {
    recordNotification(message)
    return
  }
  if (method === 'initialize') {
    if (MODE === 'garbage') {
      process.stdout.write('这不是 JSON\n')
      return
    }
    if (MODE === 'exit') {
      setTimeout(() => process.exit(3), 50)
      return
    }
    const payload = { jsonrpc: '2.0', id, result: initializeResult() }
    // 故意分两片写：客户端必须自己按行拼回来。
    const text = JSON.stringify(payload)
    const cut = Math.floor(text.length / 2)
    process.stdout.write(text.slice(0, cut))
    setTimeout(() => {
      process.stdout.write(`${text.slice(cut)}\n`)
    }, 10)
    return
  }
  if (method === 'tools/list') {
    sendNoise()
    // dupe 模式：报两个同名工具，客户端得自己认出来只留一个。
    const tools = MODE === 'dupe' ? [...TOOLS, TOOLS[0]] : TOOLS
    send({ jsonrpc: '2.0', id, result: { tools } })
    return
  }
  if (method === 'tools/call') {
    const result = callTool(params)
    if (result === undefined) {
      const known = TOOLS.some((tool) => tool.name === params?.name)
      if (known) return
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${params?.name}` } })
      return
    }
    send({ jsonrpc: '2.0', id, result })
    return
  }
  if (method === 'resources/list') {
    send({ jsonrpc: '2.0', id, result: { resources: RESOURCES } })
    return
  }
  if (method === 'resources/read') {
    const uri = typeof params?.uri === 'string' ? params.uri : ''
    if (uri === 'file:///binary.bin') {
      send({
        jsonrpc: '2.0',
        id,
        result: { contents: [{ uri, blob: 'AAEC' }] },
      })
      return
    }
    send({
      jsonrpc: '2.0',
      id,
      result: { contents: [{ uri, mimeType: 'text/plain', text: '资源正文' }] },
    })
    return
  }
  if (method === 'prompts/list') {
    send({ jsonrpc: '2.0', id, result: { prompts: PROMPTS } })
    return
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index < 0) break
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim().length === 0) continue
    try {
      handle(JSON.parse(line))
    } catch {
      // 假 server 不处理坏行，忽略即可。
    }
  }
})
process.stdin.on('end', () => process.exit(0))
// 日志必须走 stderr：混进 stdout 就会把协议流带崩，这正是要测的现象之一。
process.stderr.write('fake-mcp server 已启动\n')
