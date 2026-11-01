import { NodePtcRuntime } from '@ryharness/ptc'
import { describe, expect, it } from 'vitest'

describe('function-body：源码是一个 async 函数体', () => {
  it('函数体的 return 就是返回值', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({ program: 'return 1 + 1', mode: 'function-body' })
    expect(result.ok).toBe(true)
    expect(result.value).toBe(2)
    await runtime.dispose()
  })

  it('绑定是函数的唯一参数（一个对象），按名取', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'const { greet } = bindings; return greet("世界")',
      mode: 'function-body',
      bindings: [
        {
          name: 'greet',
          fn: (args) => {
            return `你好，${String(args[0])}`
          },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.value).toBe('你好，世界')
    await runtime.dispose()
  })

  it('绑定不放进全局：不按参数名取就拿不到', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'return greet("世界")',
      mode: 'function-body',
      bindings: [
        {
          name: 'greet',
          fn: () => '你好',
        },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('runtime')
    await runtime.dispose()
  })

  it('打印的内容原样回到结果里', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'console.log("第一行"); console.log("第二行"); return "ok"',
      mode: 'function-body',
    })
    expect(result.output).toEqual(['第一行', '第二行'])
    expect(result.value).toBe('ok')
    await runtime.dispose()
  })

  it('函数体里没有宿主的 globals（process / require 都拿不到）', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'return [typeof process, typeof require, typeof globalThis.process].join(",")',
      mode: 'function-body',
    })
    expect(result.value).toBe('undefined,undefined,undefined')
    await runtime.dispose()
  })
})

describe('script：源码是整段脚本', () => {
  it('绑定是全局名，脚本里直接按名用', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'return greet("世界")',
      mode: 'script',
      bindings: [
        {
          name: 'greet',
          fn: (args) => {
            return `你好，${String(args[0])}`
          },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.value).toBe('你好，世界')
    await runtime.dispose()
  })

  it('顶层 await 认', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'const v = await later(3); return v * 2',
      mode: 'script',
      bindings: [
        {
          name: 'later',
          fn: async (args) => {
            return Number(args[0])
          },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.value).toBe(6)
    await runtime.dispose()
  })

  it('没有 return 就没有返回值（跟 function-body 一个规矩）', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({ program: 'const a = 2; a * 3', mode: 'script' })
    expect(result.ok).toBe(true)
    expect(result.value).toBeUndefined()
    await runtime.dispose()
  })

  it('整段脚本一次执行完，不会拆成多条语句分别返回', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({ program: 'const a = 1\nconst b = 2\nreturn a + b', mode: 'script' })
    expect(result.value).toBe(3)
    await runtime.dispose()
  })
})

describe('repl：逐条执行语句', () => {
  it('每条语句返回它的完成值', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({ program: '1 + 1', mode: 'repl', owner: 'repl-a' })
    expect(result.ok).toBe(true)
    expect(result.value).toBe(2)
    await runtime.dispose()
  })

  it('声明语句的完成值是空', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({ program: 'const a = 5', mode: 'repl', owner: 'repl-b' })
    expect(result.ok).toBe(true)
    expect(result.value).toBeUndefined()
    await runtime.dispose()
  })

  it('脚本模式下拿不到的完成值，repl 模式下拿得到', async () => {
    const runtime = new NodePtcRuntime()
    const script = await runtime.run({ program: 'const a = 2; a * 3', mode: 'script' })
    const repl = await runtime.run({ program: 'const a = 2; a * 3', mode: 'repl', owner: 'repl-c' })
    expect(script.value).toBeUndefined()
    expect(repl.value).toBe(6)
    await runtime.dispose()
  })
})
