import { NodePtcRuntime, PtcBindingError } from '@ryharness/ptc'
import { describe, expect, it } from 'vitest'

describe('宿主提供的绑定', () => {
  it('绑定按名调用，参数原样传过去', async () => {
    const seen: unknown[][] = []
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'return add(2, 3)',
      mode: 'script',
      bindings: [
        {
          name: 'add',
          description: '两个数相加',
          fn: (args) => {
            seen.push([...args])
            return Number(args[0]) + Number(args[1])
          },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.value).toBe(5)
    expect(seen).toEqual([[2, 3]])
    await runtime.dispose()
  })

  it('绑定可以是异步的，程序 await 得到结果', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'const v = await slow(4); return v * 2',
      mode: 'script',
      bindings: [
        {
          name: 'slow',
          fn: async (args) => {
            await new Promise((resolve) => {
              setTimeout(resolve, 10)
            })
            return Number(args[0])
          },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.value).toBe(8)
    await runtime.dispose()
  })

  it('绑定抛错时，程序里能接住', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'try { await boom() } catch (error) { return "接住了：" + error.message }',
      mode: 'script',
      bindings: [
        {
          name: 'boom',
          fn: () => {
            throw new Error('绑定炸了')
          },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.value).toBe('接住了：绑定炸了')
    await runtime.dispose()
  })

  it('绑定没接住时，失败分类跟着绑定报上来的分类走', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'return boom()',
      mode: 'script',
      bindings: [
        {
          name: 'boom',
          fn: () => {
            throw new PtcBindingError('这个路径不许碰', 'policy')
          },
        },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('policy')
    expect(result.failure?.message).toContain('这个路径不许碰')
    await runtime.dispose()
  })

  it('绑定返回的值过不去时会报错，不会静悄悄变成空', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'return weird()',
      mode: 'script',
      bindings: [
        {
          name: 'weird',
          fn: () => {
            const circular: Record<string, unknown> = {}
            circular.self = circular
            return circular
          },
        },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.failure?.message).toContain('不能序列化成 JSON')
    await runtime.dispose()
  })

  it('同一轮里多个绑定各叫各的', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'return [await one(), await two()].join("+")',
      mode: 'script',
      bindings: [
        { name: 'one', fn: () => '一' },
        { name: 'two', fn: () => '二' },
      ],
    })
    expect(result.value).toBe('一+二')
    await runtime.dispose()
  })

  it('程序忘了 await 绑定时，那次调用照样跑完（写文件不能丢）', async () => {
    const written: string[] = []
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'save("别丢下我"); return "跑完了"',
      mode: 'script',
      bindings: [
        {
          name: 'save',
          fn: (args) => {
            written.push(String(args[0]))
            return 'saved'
          },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.value).toBe('跑完了')
    expect(written).toEqual(['别丢下我'])
    await runtime.dispose()
  })

  it('程序忘了 await 绑定，而那次绑定失败了：这一轮算失败', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'boom(); return "看起来跑完了"',
      mode: 'script',
      bindings: [
        {
          name: 'boom',
          fn: () => {
            throw new PtcBindingError('这个不该发生', 'policy')
          },
        },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('policy')
    expect(result.failure?.message).toContain('这个不该发生')
    await runtime.dispose()
  })

  it('上一轮留下的绑定不会留在上下文里', async () => {
    const runtime = new NodePtcRuntime()
    await runtime.run({
      program: 'kept = 1',
      mode: 'script',
      owner: '换绑定',
      persistence: 'script',
      bindings: [{ name: 'onlyHere', fn: () => 'x' }],
    })
    const second = await runtime.run({
      program: 'return typeof onlyHere',
      mode: 'script',
      owner: '换绑定',
      persistence: 'script',
    })
    expect(second.value).toBe('undefined')
    await runtime.dispose()
  })
})
