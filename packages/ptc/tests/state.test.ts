import { NodePtcRuntime } from '@ryharness/ptc'
import { describe, expect, it } from 'vitest'

describe('保留状态', () => {
  it('同一个 owner 的后续语句能看到前面留下的变量', async () => {
    const runtime = new NodePtcRuntime()
    const first = await runtime.run({ program: 'total = 10', mode: 'repl', owner: '会话1' })
    const second = await runtime.run({ program: 'total + 5', mode: 'repl', owner: '会话1' })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second.value).toBe(15)
    await runtime.dispose()
  })

  it('不同 owner 之间不共享状态', async () => {
    const runtime = new NodePtcRuntime()
    await runtime.run({ program: 'total = 10', mode: 'repl', owner: '甲' })
    const other = await runtime.run({ program: 'typeof total', mode: 'repl', owner: '乙' })
    expect(other.value).toBe('undefined')
    await runtime.dispose()
  })

  it('script 模式默认每次新进程：上一次的变量留不下来', async () => {
    const runtime = new NodePtcRuntime()
    await runtime.run({ program: 'kept = 1', mode: 'script', owner: '脚本1' })
    const second = await runtime.run({ program: 'return typeof kept', mode: 'script', owner: '脚本1' })
    expect(second.value).toBe('undefined')
    await runtime.dispose()
  })

  it('打开 scriptPersistence 之后，同一个 owner 的脚本共用一个进程', async () => {
    const runtime = new NodePtcRuntime()
    await runtime.run({
      program: 'kept = 42',
      mode: 'script',
      owner: '脚本2',
      persistence: 'script',
    })
    const second = await runtime.run({
      program: 'return kept + 1',
      mode: 'script',
      owner: '脚本2',
      persistence: 'script',
    })
    expect(second.ok).toBe(true)
    expect(second.value).toBe(43)
    await runtime.dispose()
  })

  it('release 之后状态没了', async () => {
    const runtime = new NodePtcRuntime()
    await runtime.run({ program: 'kept = 7', mode: 'repl', owner: '会话2' })
    await runtime.release('会话2')
    const after = await runtime.run({ program: 'typeof kept', mode: 'repl', owner: '会话2' })
    expect(after.value).toBe('undefined')
    await runtime.dispose()
  })

  it('release 一个不存在的 owner 不报错', async () => {
    const runtime = new NodePtcRuntime()
    await expect(runtime.release('没这个')).resolves.toBeUndefined()
    await runtime.dispose()
  })

  it('dispose 之后所有保留进程都没了', async () => {
    const runtime = new NodePtcRuntime()
    await runtime.run({ program: 'kept = 3', mode: 'repl', owner: '会话3' })
    await runtime.dispose()
    const after = await runtime.run({ program: 'typeof kept', mode: 'repl', owner: '会话3' })
    expect(after.value).toBe('undefined')
  })
})
