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
  const visible = Math.ceil(Math.max(0, options.viewportHeight) / estimate)
  /**
   * 「钉在末尾」用 scrollTop = Infinity 表示（贴底时那一帧的 scrollTop 可能还停在
   * 旧值，窗口必须直接算在末尾）。
   *
   * 此前这里算的是 `floor(Infinity / estimate)` = Infinity，随后被 start 夹成
   * count-1 —— 于是**贴底时窗口只剩最后一行**，视口里其余全是空白哨兵：
   * 会话超过 30 轮后，往上翻过再滚回底部（或点「跳至最新」、或发一条新消息）
   * 就会看到"消息全没了"。钉在末尾时窗口必须**盖住整个视口**。
   */
  const first = Number.isFinite(options.scrollTop)
    ? Math.floor(Math.max(0, options.scrollTop) / estimate)
    : Math.max(0, count - visible - overscan)
  // start 夹到 [0, count-1]：scrollTop 超出内容高度时（橡皮筋、测试里的假值）
  // 不能算出「整表都在窗口外」的空区间。
  const start = Math.min(count - 1, Math.max(0, first - overscan))
  const wanted = Math.min(start + MAX_RENDERED_ROWS, start + visible + overscan * 2 + 1)
  return { start, end: Math.min(count, wanted) }
}

/** 窗口切片：渲染项 + 上下哨兵高度。 */
export interface WindowedSlice<T> {
  visible: T[]
  /** 窗口的起点（渲染区第一项在整表里的下标）。 */
  start: number
  /** 窗口的终点（不含）。 */
  end: number
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
    start,
    end,
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

// ---- 冷热窗口：另一处用得着「只留最近几个」的场合 ----

/** 有上界的最近使用窗口：命中即刷新，逐出按最久未用。 */
export interface BoundedCache<K, V> {
  /** 取或建；返回的实例对同一个 key 恒等（切来切去拿到的是同一份会话状态）。 */
  require(key: K, create: (key: K) => V): V
  get(key: K): V | undefined
  /** 触碰已存在的条目（不创建），把它挪到「最近用过」。 */
  touch(key: K): void
  has(key: K): boolean
  values(): IterableIterator<V>
  readonly size: number
  clear(): void
}

/**
 * 有上界的最近使用窗口（LRU）。
 *
 * 与列表窗口化同一个取舍：**留热、丢冷，让占用有上界**。区别只在于窗口的边界不是
 * 像素而是「最近用过」——会话缓存要的就是这个：一天来回切几十个会话，全留着等于把
 * 内存峰值交给使用历史而不是交给上界。
 *
 * `protected` 是一条「有未发送内容、逐出会丢数据」的保命通道：保命的条目最后才被丢，
 * 全都在保命时才按最久未用丢（并照常回调 {@link onEvict}，让调用方停掉它的定时器）。
 * 不这样设计的话，用户在五个会话里各留了半句话、切到第六个时，第一句草稿就静默消失。
 */
export function createBoundedCache<K, V>(
  max: number,
  options: { onEvict?: (value: V, key: K) => void; protected?: (value: V, key: K) => boolean } = {},
): BoundedCache<K, V> {
  // Map 按插入顺序迭代：把 key 删了再写回同一个 key，它就落到队尾 = 「最近用过」。
  const entries = new Map<K, V>()
  const limit = Math.max(1, Math.trunc(max))

  const evict = (key: K): void => {
    const value = entries.get(key)
    if (value === undefined) return
    entries.delete(key)
    options.onEvict?.(value, key)
  }

  const trim = (): void => {
    while (entries.size > limit) {
      const keys = [...entries.keys()]
      let victim: K | undefined
      for (const key of keys) {
        const value = entries.get(key)
        if (value === undefined) continue
        if (options.protected?.(value, key) === true) continue
        victim = key
        break
      }
      // 全在保命名单里：宁可丢最久未用的那个，也不让窗口无限长下去。
      evict(victim ?? keys[0])
    }
  }

  return {
    require(key, create) {
      const cached = entries.get(key)
      if (cached !== undefined) {
        entries.delete(key)
        entries.set(key, cached)
        return cached
      }
      const created = create(key)
      entries.set(key, created)
      trim()
      return created
    },
    get(key) {
      return entries.get(key)
    },
    touch(key) {
      const cached = entries.get(key)
      if (cached === undefined) return
      entries.delete(key)
      entries.set(key, cached)
    },
    has(key) {
      return entries.has(key)
    },
    values() {
      return entries.values()
    },
    get size() {
      return entries.size
    },
    clear() {
      for (const key of [...entries.keys()]) evict(key)
    },
  }
}
