/**
 * 假的 RyHarness 服务端：说网关那一套的话，回能认的形状。
 *
 * 只实现 SDK 客户端会用到的那几个方法；别的回「没有这个方法」。
 */
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  const message = JSON.parse(trimmed)
  if (message.id === undefined) return

  const reply = (result) => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
  }

  if (message.method === 'remote/graph') {
    reply({
      version: 1,
      namespaces: ['ryharness'],
      services: [
        {
          namespace: 'ryharness',
          serviceKey: 'RyHarness',
          methods: [{ method: 'listConversations', exportName: 'listConversations', params: [] }],
        },
      ],
    })
    return
  }

  if (message.method === 'remote/call') {
    const params = message.params ?? {}
    if (params.namespace !== 'ryharness') {
      reply({ error: `没有这个命名空间：${params.namespace}` })
      return
    }
    if (params.method === 'listConversations') {
      reply([
        {
          id: 'conv-1',
          kind: 'direct',
          title: '假会话',
          memberAgentIds: ['ryen'],
          updatedAt: 0,
        },
      ])
      return
    }
    if (params.method === 'listTools') {
      reply([{ name: 'fs_read', description: '读文件' }])
      return
    }
    if (params.method === 'listMessages') {
      // 形状不对（不是数组）：客户端要能扛住，给空数组而不是崩。
      reply({ not: 'an array' })
      return
    }
    if (params.method === 'recallMemory') {
      reply(['记得你喜欢猫'])
      return
    }
    if (params.method === 'writeSetting') {
      reply(null)
      return
    }
    reply({ error: `没有这个方法：${params.method}` })
    return
  }

  reply(null)
})
