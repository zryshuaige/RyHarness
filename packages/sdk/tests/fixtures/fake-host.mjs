#!/usr/bin/env node
/**
 * 假宿主：按行读 JSON-RPC 请求，按行回 JSON-RPC 回包。
 *
 * 这是 SDK 用例里的**进程外**那一半——真的起一个 Node 子进程，用真实的管道
 * 说话，不拿内存替身糊弄。
 *
 * 支持的方法：
 * - `host/echo`：把参数原样回��（测参数有没有原样送到）。
 * - `host/sum`：把参数里的两个数加起来（测返回值能不能原样回来）。
 * - `host/boom`：回一个带机器码的失败（测错误能不能带机器码到客户端）。
 * - `host/hang`：不回包（测超时与进程没了）。
 * - `host/quit`：正常退出（测收尾）。
 * - `host/crash`：直接退出并带一个非零码（测进程崩了）。
 */
import { createInterface } from 'node:readline'

const reader = createInterface({ input: process.stdin })

/**
 * 回一条 JSON-RPC 回包。
 * @param {object} message - 回包内容。
 */
function respond(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

reader.on('line', (line) => {
  const text = line.trim()
  if (text.length === 0) return
  const message = JSON.parse(text)
  const id = message.id
  switch (message.method) {
    case 'host/echo':
      respond({ jsonrpc: '2.0', id, result: message.params })
      break
    case 'host/sum': {
      const params = message.params ?? {}
      respond({ jsonrpc: '2.0', id, result: (params.a ?? 0) + (params.b ?? 0) })
      break
    }
    case 'host/boom':
      respond({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: '宿主炸了', data: { remoteCode: 'gateway/internal' } },
      })
      break
    case 'host/hang':
      break
    case 'host/quit':
      process.exit(0)
      break
    case 'host/crash':
      process.exit(3)
      break
    default:
      respond({ jsonrpc: '2.0', id, error: { code: -32601, message: `没有这个方法：${message.method}` } })
      break
  }
})

reader.on('close', () => {
  process.exit(0)
})
