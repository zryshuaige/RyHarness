// @vitest-environment jsdom

/**
 * 渲染层启动计时：阶段挂在 window.__RYHARNESS_BOOT__ 上，主进程读走并入自己的时间轴。
 * 这里只验渲染层这一半：打点幂等、快照是副本、没挂到 window 上时不炸。
 */
import { describe, expect, it } from 'vitest'
import { markBootPhase, markFirstInteractive, readBootPhases } from '../renderer/src/lib/boot-trace.ts'

describe('渲染层启动埋点', () => {
  it('import 即记下模块执行与 DOM 就绪两个阶段', () => {
    const stages = readBootPhases().map((phase) => phase.stage)
    expect(stages[0]).toBe('module')
    expect(stages).toContain('dom-ready')
  })

  it('阶段同时挂到 window.__RYHARNESS_BOOT__（主进程 executeJavaScript 读的就是它）', () => {
    markBootPhase('first-interactive')
    const published = (window as unknown as Record<string, unknown>).__RYHARNESS_BOOT__ as {
      phases: { stage: string; ms: number }[]
    }
    expect(published.phases.some((phase) => phase.stage === 'first-interactive')).toBe(true)
    markFirstInteractive()
    expect(readBootPhases().filter((phase) => phase.stage === 'first-interactive')).toHaveLength(1)
  })

  it('同名阶段只记第一次，快照是副本（调用方改不动内部状态）', () => {
    markBootPhase('module')
    const snapshot = readBootPhases()
    expect(snapshot.filter((phase) => phase.stage === 'module')).toHaveLength(1)
    snapshot[0]!.ms = -1
    expect(readBootPhases()[0]!.ms).not.toBe(-1)
  })

  it('毫秒数是从导航起点起的非负相对时间', () => {
    for (const phase of readBootPhases()) {
      expect(phase.ms).toBeGreaterThanOrEqual(0)
    }
  })
})
