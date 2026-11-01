import { NodePtcRuntime, type PtcMode, type PtcRequest } from '@ryharness/ptc'
import { describe, expect, it } from 'vitest'

describe('失败当结果，不抛异常', () => {
  it('语法错变成一条结构化失败', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({ program: 'const = = 1', mode: 'script' })
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('syntax')
    expect(result.failure?.message.length).toBeGreaterThan(0)
    await runtime.dispose()
  })

  it('运行时抛错变成失败，原因给模型看得懂', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({ program: 'throw new Error("这趟活干不下去")', mode: 'script' })
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('runtime')
    expect(result.failure?.message).toContain('这趟活干不下去')
    await runtime.dispose()
  })

  it('失败之前打印过的内容照样带回来', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({
      program: 'console.log("先说一句"); throw new Error("然后炸了")',
      mode: 'script',
    })
    expect(result.ok).toBe(false)
    expect(result.output).toEqual(['先说一句'])
    await runtime.dispose()
  })

  it('超时到点终止进程，回一条超时失败', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({ program: 'while (true) {}', mode: 'script', timeoutMs: 300 })
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('timeout')
    expect(result.failure?.message).toContain('300')
    expect(result.durationMs).toBeGreaterThanOrEqual(250)
    await runtime.dispose()
  })

  it('超时之后这个 owner 的进程也没了（状态跟着一起没）', async () => {
    const runtime = new NodePtcRuntime()
    await runtime.run({ program: 'kept = 1', mode: 'repl', owner: '超时会话' })
    const timedOut = await runtime.run({
      program: 'while (true) {}',
      mode: 'repl',
      owner: '超时会话',
      timeoutMs: 300,
    })
    expect(timedOut.failure?.kind).toBe('timeout')
    const after = await runtime.run({ program: 'typeof kept', mode: 'repl', owner: '超时会话' })
    expect(after.value).toBe('undefined')
    await runtime.dispose()
  })

  it('取消信号能收掉这次执行', async () => {
    const runtime = new NodePtcRuntime()
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 100)
    const result = await runtime.run({
      program: 'while (true) {}',
      mode: 'script',
      timeoutMs: 10_000,
      signal: controller.signal,
    })
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('aborted')
    await runtime.dispose()
  })

  it('空程序是一条失败，不是异常', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run({ program: '   ', mode: 'script' })
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('syntax')
    await runtime.dispose()
  })

  it('未知模式也是一条失败', async () => {
    const runtime = new NodePtcRuntime()
    const result = await runtime.run(requestWithBadMode())
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('runtime')
    expect(result.failure?.message).toContain('未知的执行模式')
    await runtime.dispose()
  })

  it('node 起不来时也是一条失败，不是异常', async () => {
    const runtime = new NodePtcRuntime({ nodePath: '这个可执行文件不存在' })
    const result = await runtime.run({ program: 'return 1', mode: 'script' })
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('spawn')
    await runtime.dispose()
  })
})

/**
 * 造一个模式非法的请求。
 *
 * 模式是接口字段，类型上只能是那三个；这里要测的是「接口校验那一路」，
 * 所以从 `string` 收窄过去（不走双重断言）。
 */
function requestWithBadMode(): PtcRequest {
  const mode: string = 'vm'
  return { program: 'return 1', mode: mode as PtcMode }
}
