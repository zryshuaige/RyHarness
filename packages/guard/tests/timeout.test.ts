/**
 * 单次工具调用超时。
 *
 * 用假时钟：超时的判定就是「过了多久」，真时钟在满载的机器上会把 50ms 拖成 500ms，
 * 那测的是机器负载，不是超时逻辑。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GuardToolResult } from '../src/index.ts'
import { resolveToolTimeoutMs, runToolWithTimeout, toolAbortedMessage, toolTimeoutMessage } from '../src/index.ts'

afterEach(() => {
  vi.useRealTimers()
})

/** 永远不返回的工具：模拟卡死的调用。 */
function hangingTool(): Promise<GuardToolResult> {
  return new Promise<GuardToolResult>(() => undefined)
}

describe('工具超时', () => {
  it('工具按时返回：completed', async () => {
    const outcome = await runToolWithTimeout({
      name: 'fs_read',
      timeoutMs: 1000,
      execute: async () => ({ content: 'ok' }),
    })

    expect(outcome.status).toBe('completed')
    expect(outcome.value?.content).toBe('ok')
    expect(outcome.result).toBeUndefined()
  })

  it('工具不返回：到点收掉，给一条中文错误结果', async () => {
    vi.useFakeTimers()
    const promise = runToolWithTimeout({ name: 'shell_exec', timeoutMs: 30_000, execute: () => hangingTool() })

    await vi.advanceTimersByTimeAsync(30_000)
    const outcome = await promise

    expect(outcome.status).toBe('timeout')
    expect(outcome.result?.isError).toBe(true)
    expect(outcome.result?.content).toContain('shell_exec')
    expect(outcome.result?.content).toContain('30000ms')
    expect(outcome.message).toBe(outcome.result?.content)
  })

  it('超时不等工具收尾：结果立刻就交出去了', async () => {
    vi.useFakeTimers()
    const promise = runToolWithTimeout({ name: 'fs_read', timeoutMs: 500, execute: () => hangingTool() })

    await vi.advanceTimersByTimeAsync(500)
    // 工具的 promise 还挂着（它永远不会 settle），但 guard 已经收口了。
    const outcome = await promise

    expect(outcome.status).toBe('timeout')
  })

  it('超时会给工具派发的 signal 发 abort，工具能自己收尾', async () => {
    vi.useFakeTimers()
    const captured: { signal?: AbortSignal } = {}
    const promise = runToolWithTimeout({
      name: 'fs_read',
      timeoutMs: 500,
      execute: (signal) => {
        captured.signal = signal
        return hangingTool()
      },
    })

    await vi.advanceTimersByTimeAsync(500)
    await promise

    expect(captured.signal?.aborted).toBe(true)
  })

  it('工具没声明时限：不设限，多久都不收', async () => {
    vi.useFakeTimers()
    const holder: { resolve?: (value: GuardToolResult) => void } = {}
    const promise = runToolWithTimeout({
      name: 'fs_read',
      execute: () =>
        new Promise<GuardToolResult>((resolve) => {
          holder.resolve = resolve
        }),
    })

    await vi.advanceTimersByTimeAsync(600_000)
    holder.resolve?.({ content: '慢但回来了' })
    const outcome = await promise

    expect(outcome.status).toBe('completed')
    expect(outcome.value?.content).toBe('慢但回来了')
  })

  it('时限写坏了（0 / 负数 / NaN）：当作没有时限', async () => {
    const outcome = await runToolWithTimeout({
      name: 'fs_read',
      timeoutMs: Number.NaN,
      execute: async () => ({ content: 'ok' }),
    })

    expect(outcome.status).toBe('completed')
  })
})

describe('取消与异常', () => {
  it('外层取消：收成 aborted，并给一条中文说明', async () => {
    const controller = new AbortController()
    const promise = runToolWithTimeout({
      name: 'fs_write',
      signal: controller.signal,
      execute: () => hangingTool(),
    })

    controller.abort()
    const outcome = await promise

    expect(outcome.status).toBe('aborted')
    expect(outcome.result?.isError).toBe(true)
    expect(outcome.result?.content).toContain('fs_write')
  })

  it('外层已经取消：工具根本不跑', async () => {
    const controller = new AbortController()
    controller.abort()
    let executed = false
    const outcome = await runToolWithTimeout({
      name: 'fs_write',
      signal: controller.signal,
      execute: async () => {
        executed = true
        return { content: 'ok' }
      },
    })

    expect(outcome.status).toBe('aborted')
    expect(executed).toBe(false)
  })

  it('工具抛错：原样抛出，错误文案是宿主自己的语义', async () => {
    const failure = new Error('磁盘满了')
    await expect(
      runToolWithTimeout({
        name: 'fs_write',
        execute: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure)
  })

  it('工具同步抛错：也一样原样抛出', async () => {
    const failure = new Error('参数不对')
    await expect(
      runToolWithTimeout({
        name: 'fs_write',
        execute: () => {
          throw failure
        },
      }),
    ).rejects.toBe(failure)
  })
})

describe('时限从工具声明上读', () => {
  it('声明了就读到', () => {
    expect(resolveToolTimeoutMs({ name: 'shell_exec', timeoutMs: 30_000 })).toBe(30_000)
  })

  it('没声明 / 不是对象 / 时限不合法：都没有上限', () => {
    expect(resolveToolTimeoutMs({ name: 'shell_exec' })).toBeUndefined()
    expect(resolveToolTimeoutMs(undefined)).toBeUndefined()
    expect(resolveToolTimeoutMs(null)).toBeUndefined()
    expect(resolveToolTimeoutMs('shell_exec')).toBeUndefined()
    expect(resolveToolTimeoutMs({ name: 'x', timeoutMs: 0 })).toBeUndefined()
    expect(resolveToolTimeoutMs({ name: 'x', timeoutMs: -1 })).toBeUndefined()
    expect(resolveToolTimeoutMs({ name: 'x', timeoutMs: '30000' })).toBeUndefined()
  })

  it('文案自带工具名与时限', () => {
    expect(toolTimeoutMessage('shell_exec', 30_000)).toContain('shell_exec')
    expect(toolTimeoutMessage('shell_exec', 30_000)).toContain('30000ms')
    expect(toolAbortedMessage('fs_write')).toContain('fs_write')
  })
})
