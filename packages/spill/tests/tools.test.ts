/**
 * 取回工具的用例。
 *
 * 用真的 {@link LocalSpillStore} 跑：工具与存储是一套东西，分开跑反而测不到
 * 「会话对不上时取不到」这种要紧的行为。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalSpillStore } from '../src/local.ts'
import { createSpillReadTool, DEFAULT_READ_CHARS } from '../src/tools.ts'
import { SPILL_READ_TOOL_NAME } from '../src/types.ts'

let dataDir = ''

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ryharness-spill-tool-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

/** 造一套「存储 + 工具」。 */
function setup(maxChars?: number): { store: LocalSpillStore; tool: ReturnType<typeof createSpillReadTool> } {
  const store = new LocalSpillStore({ dataDir })
  return { store, tool: createSpillReadTool({ store, ...(maxChars === undefined ? {} : { maxChars }) }) }
}

describe('spill_read 工具', () => {
  it('工具名是 spill_read，参数里 id 是必填', () => {
    const { tool } = setup()

    expect(tool.name).toBe(SPILL_READ_TOOL_NAME)
    expect(tool.parameters.required).toEqual(['id'])
  })

  it('没给 id 时给一条能看懂的错误', async () => {
    const { tool } = setup()

    const result = await tool.execute({}, { conversationId: 'conv-1' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('id')
  })

  it('取回时给的是正文加一句页脚', async () => {
    const { store, tool } = setup()
    const ref = store.store('0123456789', { sessionId: 'conv-1' })

    const result = await tool.execute({ id: ref.id }, { conversationId: 'conv-1' })

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('0123456789')
    expect(result.content).toContain('已取完')
  })

  it('一次只给一段，页脚告诉模型下一段从哪开始', async () => {
    const { store, tool } = setup(10)
    const ref = store.store('0123456789ABCDEF', { sessionId: 'conv-1' })

    const result = await tool.execute({ id: ref.id }, { conversationId: 'conv-1' })

    expect(result.content).toContain('0123456789')
    expect(result.content).not.toContain('ABCDEF')
    expect(result.content).toContain('第 1/2 页')
    expect(result.content).toContain('offset=10')
  })

  it('给了 offset 就从那一段开始取', async () => {
    const { store, tool } = setup(10)
    const ref = store.store('0123456789ABCDEFGHIJKLMNOP', { sessionId: 'conv-1' })

    const result = await tool.execute({ id: ref.id, offset: 10 }, { conversationId: 'conv-1' })

    expect(result.content).toContain('ABCDEFGHIJ')
    expect(result.content).not.toContain('KLMNOP')
    expect(result.content).toContain('第 2/3 页')
    expect(result.content).toContain('offset=20')
  })

  it('要超过单次上限时按上限截断', async () => {
    const { store, tool } = setup(10)
    const ref = store.store('0123456789ABCDEF', { sessionId: 'conv-1' })

    const result = await tool.execute({ id: ref.id, limit: 100 }, { conversationId: 'conv-1' })

    expect(result.content).toContain('0123456789')
    expect(result.content).not.toContain('ABCDEF')
  })

  it('会话对不上时取不到，给的是错误结果', async () => {
    const { store, tool } = setup()
    const ref = store.store('属于 conv-1', { sessionId: 'conv-1' })

    const result = await tool.execute({ id: ref.id }, { conversationId: 'conv-2' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('别的会话')
  })

  it('轮次已经取消时不去取', async () => {
    const { store, tool } = setup()
    const ref = store.store('正文', { sessionId: 'conv-1' })
    const controller = new AbortController()
    controller.abort()

    const result = await tool.execute({ id: ref.id }, { conversationId: 'conv-1', signal: controller.signal })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('取消')
  })

  it('取一个不存在的定位符，给的是错误结果而不是抛异常', async () => {
    const { tool } = setup()

    const result = await tool.execute({ id: 'sp_0000_000000000000' }, { conversationId: 'conv-1' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('找不到')
  })

  it('空文本给一句话，不给空白', async () => {
    const { store, tool } = setup()
    const ref = store.store('', { sessionId: 'conv-1' })

    const result = await tool.execute({ id: ref.id }, { conversationId: 'conv-1' })

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('空的')
  })

  it('单次上限的缺省值是 4000 字符', () => {
    expect(DEFAULT_READ_CHARS).toBe(4000)
  })

  it('参数不是对象时给一条能看懂的错误', async () => {
    const { tool } = setup()

    const result = await tool.execute('不是对象', { conversationId: 'conv-1' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('id')
  })

  it('存储抛的不是 Error 时，错误消息照样给得出来', async () => {
    const badStore = {
      store: () => {
        throw new Error('用不上')
      },
      read: () => {
        throw '存储炸了'
      },
      remove: () => false,
      cleanup: () => ({ removed: 0, freedBytes: 0 }),
      list: () => [],
    }
    const tool = createSpillReadTool({ store: badStore })

    const result = await tool.execute({ id: 'sp_0000_000000000000' }, { conversationId: 'conv-1' })

    expect(result.isError).toBe(true)
    expect(result.content).toBe('存储炸了')
  })
})
