/**
 * 窗口位置与尺寸的记忆（主进程专用；渲染层不 import 这个文件——它碰 node:fs）。
 *
 * 桌面应用的基本盘之一：用户把窗口拖到顺手的位置、拉到合适的大小，下次启动
 * 就该**原样恢复**。每次都重置成同一个居中尺寸，等于让用户每次开机都要重新
 * 摆一次窗口。
 *
 * 记下来的位置必须**收敛回当前屏幕**：换了显示器、分辨率变了、拔了外接屏之后，
 * 上次的坐标可能整块落在屏外（窗口开在看不见的地方，用户以为应用没起来）。
 *
 * @module @ryharness/desktop/shared/window-bounds
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 一份窗口位置与尺寸（DIP）。 */
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 窗口状态的存储文件名（落在 userData 下）。 */
export const WINDOW_STATE_FILE = 'window-state.json'

/**
 * 把记住的窗口位置收敛回当前工作区。
 *
 * 尺寸：不超过工作区（留 32px 余量），但不低于最小尺寸。
 * 位置：夹回工作区内——整块在屏外是不行的（用户看不到窗口）。
 *
 * @param saved - 记住的那一份。
 * @param work - 当前工作区尺寸（DIP）。
 * @param min - 窗口的最小尺寸。
 */
export function clampBounds(
  saved: WindowBounds,
  work: { width: number; height: number },
  min: { width: number; height: number },
): WindowBounds {
  // 尺寸：夹在 [最小尺寸, 可用空间] 之间——比屏幕大的收到屏内，比最小值小的抬到
  // 最小值（否则窗口小到没法用）。
  const width = Math.max(min.width, Math.min(saved.width, Math.max(min.width, work.width - 32)))
  const height = Math.max(min.height, Math.min(saved.height, Math.max(min.height, work.height - 32)))
  return {
    width,
    height,
    x: Math.max(0, Math.min(saved.x, Math.max(0, work.width - width))),
    y: Math.max(0, Math.min(saved.y, Math.max(0, work.height - height))),
  }
}

/** 读回记住的窗口位置；没有、坏了、字段不对都是 undefined（按缺省尺寸开）。 */
export function readWindowBounds(path: string): WindowBounds | undefined {
  try {
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { bounds?: unknown }
    const bounds = parsed.bounds
    if (typeof bounds !== 'object' || bounds === null) return undefined
    const record = bounds as Record<string, unknown>
    const x = Number(record.x)
    const y = Number(record.y)
    const width = Number(record.width)
    const height = Number(record.height)
    if (
      ![x, y, width, height].every((value) => {
        return Number.isFinite(value)
      })
    ) {
      return undefined
    }
    if (width <= 0 || height <= 0) return undefined
    return { x, y, width, height }
  } catch {
    // 状态文件坏了不是故障：按缺省尺寸开窗即可，不该因此启动失败。
    return undefined
  }
}

/**
 * 记住一份窗口位置。
 *
 * 写不进去（只读目录、权限）**静默忽略**：记不住窗口位置不是故障，不该弹错
 * 打断用户。
 */
export function writeWindowBounds(path: string, bounds: WindowBounds): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ bounds }), 'utf8')
  } catch {
    // 忽略持久化失败。
  }
}
