#!/usr/bin/env node
/**
 * 假的 LSP server：在 stdio 上跑真正的 Content-Length 帧协议。
 *
 * 为什么要有它：语言服务器这一层的毛病，只有真起一个子进程才看得见。协议帧的分片、
 * 握手的顺序、`didOpen` 有没有真的把文件内容送过去、进程崩了之后 provider 会不会
 * 老实说「它没了」——这些用替身对象全都测不出来：替身只会照着我们写的返回，
 * 而我们写的那份返回恰恰就是 bug 所在。
 *
 * 它说的都是真话：帧头按字节数算，走的是 `initialize` → `initialized` →
 * `didOpen` → 请求 的真顺序。
 *
 * 行为开关（环境变量）：
 * - `LSP_FIXTURE_MODE`：
 *   - `normal`（默认）：正常应答；
 *   - `slow`：`textDocument/definition` 永不回包（测超时）；
 *   - `crash`：收到 definition 请求时直接退出（测崩溃与重启）；
 *   - `crash-once`：第一次 definition 请求时退出，之后恢复正常（测自动重起）；
 *   - `exit-on-init`：握手期间退出（测握手失败）；
 *   - `garbage`：握手后写一个坏帧头（测协议错误）；
 *   - `bad-json`：握手后写一帧正文不是 JSON（测协议错误）；
 *   - `noisy`：握手后发一条不是对象的帧与一条没人要的回包（测「装作没看见」）；
 *   - `weird-error`：回一个既没有 code 也没有 message 的错误（测「自己补一句能看的话」）；
 *   - `ignore-exit`：收到 `exit` 通知也不退（测「等一会儿就强杀」）。
 * - `LSP_FIXTURE_CAPABILITIES`：`full`（默认）/ `no-implementation` / `none`。
 * - `LSP_FIXTURE_LOG=<文件>`：把收到的每条消息记成一行 JSON（测握手顺序、
 *   测 `didOpen` 送过去的到底是哪份文本）。
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import process from 'node:process'

const MODE = process.env.LSP_FIXTURE_MODE ?? 'normal'
const LOG = process.env.LSP_FIXTURE_LOG
const CAPABILITIES = process.env.LSP_FIXTURE_CAPABILITIES ?? 'full'
/** crash-once 模式靠这个标记文件记住「已经崩过一次」——重起的是新进程，内存里的标志不算数。 */
const MARKER = process.env.LSP_FIXTURE_MARKER

/** 往 stdout 写一帧（长度按字节算）。 */
function send(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  process.stdout.write(`Content-Length: ${body.byteLength}\r\n\r\n`)
  process.stdout.write(body)
}

/** 把收到的每条消息记下来，一行一条。 */
function record(message) {
  if (LOG === undefined) return
  appendFileSync(LOG, `${JSON.stringify(message)}\n`)
}

/** 这个假服务器自述的能力。 */
function serverCapabilities() {
  if (CAPABILITIES === 'none') return {}
  const capabilities = { definitionProvider: true, referencesProvider: true, hoverProvider: true }
  if (CAPABILITIES === 'full') capabilities.implementationProvider = true
  return capabilities
}

/** 之前那个进程崩过了没有（靠标记文件，重起后仍然算数）。 */
function alreadyCrashed() {
  return MARKER !== undefined && existsSync(MARKER)
}

/** 记下「崩过了」。 */
function markCrashed() {
  if (MARKER === undefined) return
  writeFileSync(MARKER, 'crashed', 'utf8')
}

/** 造一个位置。 */
function location(uri, line, character) {
  return {
    uri,
    range: {
      start: { line, character },
      end: { line, character: character + 5 },
    },
  }
}

/** 处理一条消息。 */
function dispatch(message) {
  record(message)
  const id = message.id
  const method = message.method
  const params = message.params ?? {}

  if (id === undefined || id === null) {
    // 通知：exit 让服务器自己退，其余（initialized / didOpen）不用回。
    if (method === 'exit' && MODE !== 'ignore-exit') process.exit(0)
    return
  }

  if (method === 'initialize') {
    if (MODE === 'exit-on-init') {
      process.exit(3)
      return
    }
    if (MODE === 'bad-json') {
      // 帧头没问题，正文不是 JSON：客户端必须报协议错误。
      const body = Buffer.from('这不是 JSON', 'utf8')
      process.stdout.write(`Content-Length: ${body.byteLength}\r\n\r\n`)
      process.stdout.write(body)
      return
    }
    send({
      jsonrpc: '2.0',
      id,
      result: {
        capabilities: serverCapabilities(),
        serverInfo: { name: 'fake-lsp', version: '1.0.0' },
      },
    })
    // 真服务器在握手期间会打日志（通知）。客户端必须把它当没看见，而不是当成协议错误。
    send({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 3, message: '假服务器已就绪' } })
    if (MODE === 'noisy') {
      // 一条不是对象的帧 + 一条没人要的回包：客户端都必须装作没看见。
      const stray = Buffer.from('123', 'utf8')
      process.stdout.write(`Content-Length: ${stray.byteLength}\r\n\r\n`)
      process.stdout.write(stray)
      send({ jsonrpc: '2.0', id: 987654, result: { stray: true } })
    }
    if (MODE === 'garbage') {
      // 帧头里的长度不是数字：客户端解帧时必须报协议错误，而不是把后面的字节当正文。
      process.stdout.write('Content-Length: not-a-number\r\n\r\n{}')
    }
    return
  }

  if (method === 'shutdown') {
    send({ jsonrpc: '2.0', id, result: null })
    return
  }

  if (method === 'textDocument/definition') {
    if (MODE === 'crash' || (MODE === 'crash-once' && !alreadyCrashed())) {
      markCrashed()
      process.exit(3)
      return
    }
    if (MODE === 'slow') {
      // 永远不回复：用来测超时。
      return
    }
    send({ jsonrpc: '2.0', id, result: location(params.textDocument?.uri ?? '', 42, 8) })
    return
  }

  if (method === 'textDocument/references') {
    send({
      jsonrpc: '2.0',
      id,
      result: [location(params.textDocument?.uri ?? '', 7, 2), location('file:///elsewhere/ref.ts', 11, 4)],
    })
    return
  }

  if (method === 'textDocument/implementation') {
    send({ jsonrpc: '2.0', id, result: [location('file:///elsewhere/impl.ts', 3, 0)] })
    return
  }

  if (method === 'textDocument/hover') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        contents: { kind: 'markdown', value: '```ts\nconst answer: number\n```' },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      },
    })
    return
  }

  if (MODE === 'weird-error') {
    // 错误对象里既没有 code 也没有 message：客户端必须自己补一句能看的话。
    send({ jsonrpc: '2.0', id, error: { data: '只有 data' } })
    return
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
}

let buffer = Buffer.alloc(0)

/** 喂进一段 stdin，拆帧、逐条处理。 */
function onData(chunk) {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) break
    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const match = /content-length:\s*(\d+)/i.exec(header)
    if (match === null) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const length = Number.parseInt(match[1], 10)
    const bodyStart = headerEnd + 4
    if (buffer.length < bodyStart + length) break
    const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
    buffer = buffer.subarray(bodyStart + length)
    try {
      dispatch(JSON.parse(body))
    } catch {
      // 假服务器不处理坏帧，忽略即可。
    }
  }
}

process.stdin.on('data', onData)
// ignore-exit 模式故意不退：用来测客户端「等一会儿还不退就强杀」的那条路。
// 光是不 exit 不够——stdin 一断，事件循环空了的 Node 自己就退了，所以要留一个活干。
if (MODE === 'ignore-exit') {
  setInterval(() => undefined, 1_000)
}
process.stdin.on('end', () => {
  if (MODE === 'ignore-exit') return
  process.exit(0)
})
// 日志必须走 stderr：混进 stdout 就会把协议流带崩。
process.stderr.write('fake-lsp server 已启动\n')
