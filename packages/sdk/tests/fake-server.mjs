/**
 * 假的 RPC 服务端：把收到的帧原样回一遍。
 *
 * 只做「收到什么回什么」这一件事——SDK 客户端要验的是「请求发出去、回包收得到、
 * 子进程没了挂起的请求会失败」，不需要真的实现业务方法。
 */
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  const message = JSON.parse(trimmed)
  if (message.id === undefined) return
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { echo: message.method ?? '', params: message.params ?? null },
    })}\n`,
  )
})
