/**
 * 窗口位置与尺寸的记忆。
 *
 * 桌面应用的基本盘：用户摆好的窗口位置下次启动该原样恢复。但记住的坐标必须
 * **收敛回当前屏幕**——换了显示器、分辨率变了之后，上次的位置可能整块在屏外
 * （窗口开在看不见的地方，用户以为应用没起来）。
 *
 * @module @ryharness/desktop/tests/window-bounds
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clampBounds, readWindowBounds, writeWindowBounds } from '../shared/window-bounds.ts'

const tmpDirs: string[] = []

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir === undefined) continue
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

function statePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-window-state-'))
  tmpDirs.push(dir)
  return join(dir, 'window-state.json')
}

describe('窗口位置的记忆', () => {
  it('写进去读得回来', () => {
    const path = statePath()
    writeWindowBounds(path, { x: 120, y: 80, width: 1400, height: 900 })
    expect(readWindowBounds(path)).toEqual({ x: 120, y: 80, width: 1400, height: 900 })
  })

  it('没有记录时返回 undefined（按缺省尺寸开窗）', () => {
    expect(readWindowBounds(statePath())).toBeUndefined()
  })

  it('状态文件坏了不是故障：读不出来就按缺省尺寸开', () => {
    const path = statePath()
    writeFileSync(path, '这不是 JSON', 'utf8')
    expect(readWindowBounds(path)).toBeUndefined()
    writeFileSync(path, JSON.stringify({ bounds: { x: 'a', y: 1, width: 2, height: 3 } }), 'utf8')
    expect(readWindowBounds(path)).toBeUndefined()
  })

  it('写不进去也静默（记不住窗口位置不是故障）', () => {
    const path = join(statePath(), 'nested', 'window-state.json')
    expect(() => {
      writeWindowBounds(path, { x: 0, y: 0, width: 800, height: 600 })
    }).not.toThrow()
  })
})

describe('位置收敛回当前屏幕', () => {
  const min = { width: 1024, height: 680 }

  it('屏幕够大时原样保留', () => {
    const bounds = clampBounds({ x: 100, y: 50, width: 1400, height: 900 }, { width: 1920, height: 1080 }, min)
    expect(bounds).toEqual({ x: 100, y: 50, width: 1400, height: 900 })
  })

  it('窗口比屏幕大时收到屏幕里', () => {
    const bounds = clampBounds({ x: 0, y: 0, width: 3000, height: 2000 }, { width: 1920, height: 1080 }, min)
    expect(bounds.width).toBeLessThanOrEqual(1920)
    expect(bounds.height).toBeLessThanOrEqual(1080)
  })

  it('整块在屏外的坐标被夹回屏内（换了显示器也不会开在看不见的地方）', () => {
    const bounds = clampBounds({ x: 3000, y: 2000, width: 1200, height: 800 }, { width: 1920, height: 1080 }, min)
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x).toBeLessThanOrEqual(1920 - bounds.width)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.y).toBeLessThanOrEqual(1080 - bounds.height)
  })

  it('尺寸不小于最小值', () => {
    const bounds = clampBounds({ x: 0, y: 0, width: 10, height: 10 }, { width: 1920, height: 1080 }, min)
    expect(bounds.width).toBe(min.width)
    expect(bounds.height).toBe(min.height)
  })
})
