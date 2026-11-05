/**
 * SDK 的高层客户端：起一个子进程，连上，问它一句话。
 *
 * 这一族盯的是「连上之后用起来顺不顺」：方法名对不对、参数对不对、关了会不会
 * 留下孤儿进程。
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RyHarnessClient } from '../src/index.ts'

/** 假的 RyHarness 服务端：把网关方法回成能认的样子。 */
const FAKE_SERVER = fileURLToPath(new URL('./fake-ryharness.mjs', import.meta.url))

describe('RyHarnessClient', () => {
  it(
    '连上之后能调通一个方法：拿到的是服务端给的东西',
    async () => {
      const client = await RyHarnessClient.spawn({
        command: process.execPath,
        args: [FAKE_SERVER],
        timeoutMs: 10_000,
      })
      try {
        const conversations = await client.listConversations(3)
        expect(Array.isArray(conversations)).toBe(true)
        expect(conversations.length).toBe(1)
        expect(conversations[0]?.id).toBe('conv-1')
        expect(conversations[0]?.title).toBe('假会话')
      } finally {
        await client.close()
      }
    },
    30_000,
  )

  it(
    '类型图能拿到：上面挂着 ryharness 这个命名空间',
    async () => {
      const client = await RyHarnessClient.spawn({
        command: process.execPath,
        args: [FAKE_SERVER],
        timeoutMs: 10_000,
      })
      try {
        const graph = (await client.graph()) as { namespaces?: string[] }
        expect(graph.namespaces).toContain('ryharness')
      } finally {
        await client.close()
      }
    },
    30_000,
  )

  it(
    '工具清单能拿到',
    async () => {
      const client = await RyHarnessClient.spawn({
        command: process.execPath,
        args: [FAKE_SERVER],
        timeoutMs: 10_000,
      })
      try {
        const tools = await client.listTools()
        expect(tools.length).toBeGreaterThan(0)
        expect(tools[0]?.name).toBe('fs_read')
      } finally {
        await client.close()
      }
    },
    30_000,
  )

  it(
    '服务端回的东西形状不对时，给的是空数组而不是崩掉',
    async () => {
      const client = await RyHarnessClient.spawn({
        command: process.execPath,
        args: [FAKE_SERVER],
        timeoutMs: 10_000,
      })
      try {
        // 假服务端对 writeSetting 回的不是数组——那一层要能扛住。
        const messages = await client.listMessages('conv-1', 10)
        expect(Array.isArray(messages)).toBe(true)
      } finally {
        await client.close()
      }
    },
    30_000,
  )

  it(
    '关掉之后子进程真的不在了',
    async () => {
      const client = await RyHarnessClient.spawn({
        command: process.execPath,
        args: [FAKE_SERVER],
        timeoutMs: 10_000,
      })
      await client.listTools()
      await client.close()
      // 再调一次就该失败——连接真的断了。
      await expect(client.listTools()).rejects.toThrow()
    },
    30_000,
  )
})
