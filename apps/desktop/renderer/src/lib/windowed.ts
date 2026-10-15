/**
 * 长列表的窗口化：只渲染可视区，上下各留若干行的余量，其余用「哨兵」占位。
 *
 * 不用第三方虚拟列表库——本产品的列表就两类（会话列表、聊天气泡），需要的只是
 * 「别把几千条一次性塞进 DOM」，一个定高估算 + 两个 spacer 就够：
 *
 *   <div class="conversation-list" ref={scrollRef}>
 *     <div style={{ height: padTop }} />        // 上哨兵：撑住滚动条的位置
 *     {visible.map(...)}
 *     <div style={{ height: padBottom }} />     // 下哨兵
 *   </div>
 *
 * 三个刻意的取舍：
 * 1. **定高估算**而非实测高度：气泡高度差几十倍，实测要靠 ResizeObserver 逐条量，
 *    那是另一个量级的复杂度；估算偏了就只是哨兵高度略有出入，滚动条仍连续。
 * 2. **硬上界** {@link MAX_RENDERED_ROWS}：超宽屏 + 极矮行时可视区可能一次框住
 *    上千行，仍然截断，否则「窗口化」在极端屏上等于没做。
 * 3. **兜底可视高度**：首帧量不到 clientHeight（jsdom、隐藏容器）时先按
 *    {@link FALLBACK_VIEWPORT_ROWS} 行渲染，列表不会空一帧再突然长出来。
 */
import { type RefObject, useEffect, useState } from 'react'

/** 渲染区间（左闭右开）。 */
export interface WindowRange {
  start: number
  end: number
}

/** 上下各多渲染的行数：滚动稍快时不至于露白。 */
export const DEFAULT_OVERSCAN = 6
/** 量不到可视高度时先按这么多行渲染。 */
export const FALLBACK_VIEWPORT_ROWS = 12
/** 一次最多渲染的行数硬上界。 */
export const MAX_RENDERED_ROWS = 120

/** 算窗口所需的全部输入（纯函数，好测）。 */
export interface WindowOptions {
  /** 条目总数。 */
  count: number
  /** 每行估算高度（px）。 */
  estimateHeight: number
  /** 可视区顶部的滚动偏移（scrollTop）。 */
  scrollTop: number
  /** 可视区高度（clientHeight）。 */
  viewportHeight: number
  /** 上下余量；缺省 {@link DEFAULT_OVERSCAN}。 */
  overscan?: number
}

/** 纯函数：算出要渲染的行区间。 */
export function visibleRange(options: WindowOptions): WindowRange {
  const count = Math.max(0, Math.trunc(options.count))
  if (count === 0) return { start: 0, end: 0 }
  const estimate = Math.max(1, Math.max(0, Math.trunc(options.estimateHeight)))
  const overscan = Math.max(0, Math.trunc(options.overscan ?? DEFAULT_OVERSCAN))
  const first = Math.floor(Math.max(0, options.scrollTop) / estimate)
  const visible = Math.ceil(Math.max(0, options.viewportHeight) / estimate)
  // start 夹到 [0, count-1]：scrollTop 超出内容高度时（橡皮筋、测试里的假值）
  // 不能算出「整表都在窗口外」的空区间。
  const start = Math.min(count - 1, Math.max(0, first - overscan))
  const wanted = Math.min(start + MAX_RENDERED_ROWS, start + visible + overscan * 2 + 1)
  return { start, end: Math.min(count, wanted) }
}

/** 窗口切片：渲染项 + 上下哨兵高度。 */
export interface WindowedSlice<T> {
  visible: T[]
  /** 上哨兵高度（px）：被截掉的上方内容。 */
  padTop: number
  /** 下哨兵高度（px）。 */
  padBottom: number
}

/** 纯函数：把数组切成窗口 + 哨兵高度。 */
export function windowSlice<T>(items: readonly T[], range: WindowRange, estimateHeight: number): WindowedSlice<T> {
  const start = Math.min(Math.max(0, range.start), items.length)
  const end = Math.min(Math.max(start, range.end), items.length)
  return {
    visible: items.slice(start, end),
    padTop: start * Math.max(0, estimateHeight),
    padBottom: (items.length - end) * Math.max(0, estimateHeight),
  }
}

/** useVisibleWindow 的返回值。 */
export interface VisibleWindow extends WindowRange {
  padTop: number
  padBottom: number
}

/**
 * 跟着滚动容器走的可视窗口。
 *
 * 不传 scrollRef 时按「滚动位置 0」计算（非滚动容器，或调用方自己管 onScroll）。
 * 滚动事件按 requestAnimationFrame 合帧：连续滚动下每帧最多重算一次，而不是每个
 * scroll 事件都让整列表重渲染。
 */
export function useVisibleWindow(options: {
  count: number
  estimateHeight: number
  overscan?: number
  scrollRef?: RefObject<HTMLElement | null>
}): VisibleWindow {
  const { count, estimateHeight, overscan, scrollRef } = options
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  useEffect(() => {
    const node = scrollRef?.current
    if (node === undefined || node === null) return
    let frame = 0
    const measure = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setScrollTop(node.scrollTop)
        setViewportHeight(node.clientHeight)
      })
    }
    node.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      node.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [scrollRef])

  const range = visibleRange({
    count,
    estimateHeight,
    overscan,
    scrollTop,
    viewportHeight: viewportHeight > 0 ? viewportHeight : Math.max(1, estimateHeight) * FALLBACK_VIEWPORT_ROWS,
  })
  const padTop = range.start * estimateHeight
  const padBottom = Math.max(0, count - range.end) * estimateHeight
  return { ...range, padTop, padBottom }
}
