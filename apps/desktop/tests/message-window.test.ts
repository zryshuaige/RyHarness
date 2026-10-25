// @vitest-environment node
/**
 * 聊天区窗口化纯计算层的单测：高度估算按会话密度、贴底钉窗口、短会话全量渲染、
 * 用户滚动时间窗。此前这些公式内联在两千行的 ChatView 里，没有任何单测。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  BUBBLE_ESTIMATE_PX,
  chatWindowOf,
  createUserScrollGate,
  measuredTurnHeight,
  PAGE_SIZE,
  TURN_ESTIMATE_PX,
  turnEstimateOf,
  USER_SCROLL_MS,
  WINDOW_MIN_TURNS,
} from '../renderer/src/lib/message-window.ts'

describe('measuredTurnHeight：量已渲染轮次的真实间距', () => {
  it('按已渲染的那几块算，哨兵不算在内', () => {
    // 真实的量法：offsetTop 是相对滚动容器的，哨兵在第一块之前，把它减掉。
    // 这一组模拟「上哨兵 3000px + 三块轮次，间距 200px」：
    const blocks = [
      { top: 3000, height: 180 },
      { top: 3200, height: 180 },
      { top: 3400, height: 180 },
    ]
    expect(measuredTurnHeight(blocks)).toBe(200)
  })

  it('量的是轮次间距（顶到顶），不是内容高', () => {
    // 窗口的映射按「轮号 × 间距 = 那一轮顶端的像素位置」算，所以要间距。
    const blocks = [
      { top: 0, height: 180 },
      { top: 220, height: 180 },
    ]
    expect(measuredTurnHeight(blocks)).toBe(220)
  })

  it('只有一块时用那块自己的高度', () => {
    expect(measuredTurnHeight([{ top: 120, height: 260 }])).toBe(260)
  })

  it('量不出来时给 0（调用方据此放弃这一轮，而不是用 0 继续算）', () => {
    expect(measuredTurnHeight([])).toBe(0)
    expect(measuredTurnHeight([{ top: 0, height: 0 }])).toBe(0)
  })

  it('只用已渲染的块数做分母——不是总轮数', () => {
    // 这一条是根因：此前量的是容器的 scrollHeight（含上下哨兵）÷ **总**轮数，
    // 算出来还是那个估算值，真实高度从来没被学到，窗口映射差着近两倍。
    const blocks = [
      { top: 0, height: 300 },
      { top: 300, height: 300 },
    ]
    expect(measuredTurnHeight(blocks)).toBe(300)
  })
})

describe('turnEstimateOf：轮次高度估算', () => {
  it('空历史回落到单轮下限', () => {
    expect(turnEstimateOf([])).toBe(TURN_ESTIMATE_PX)
  })

  it('按已加载历史的密度估算：一轮一条≈单气泡，一轮四条≈四气泡', () => {
    const dense = [{ turnIndex: 0 }, { turnIndex: 1 }, { turnIndex: 2 }]
    expect(turnEstimateOf(dense)).toBe(TURN_ESTIMATE_PX)
    const chatty = [
      { turnIndex: 0 },
      { turnIndex: 0 },
      { turnIndex: 0 },
      { turnIndex: 0 },
      { turnIndex: 1 },
      { turnIndex: 1 },
      { turnIndex: 1 },
      { turnIndex: 1 },
    ]
    expect(turnEstimateOf(chatty)).toBe(4 * BUBBLE_ESTIMATE_PX)
  })

  it('估算低于单轮下限时夹回下限（时间分隔 + 一条气泡至少这么高）', () => {
    // 两轮三条：密度 1.5 → 1.5×76=114 > 88，不触下限；构造触下限的对照：一轮一条
    expect(turnEstimateOf([{ turnIndex: 0 }])).toBe(TURN_ESTIMATE_PX)
  })
})

describe('chatWindowOf：可视窗口组装', () => {
  const turns = Array.from({ length: 200 }, (_unused, index) => {
    return { key: `t${index}` }
  })

  it('未过 WINDOW_MIN_TURNS 的会话全量渲染（padTop/padBottom 均为 0）', () => {
    const slice = chatWindowOf({
      turns: turns.slice(0, 10),
      windowed: false,
      atBottom: true,
      viewTop: 0,
      viewHeight: 600,
      turnEstimate: 88,
    })
    expect(slice.visible).toHaveLength(10)
    expect(slice.padTop).toBe(0)
    expect(slice.padBottom).toBe(0)
  })

  it('贴底时窗口钉在末尾：不管 scrollTop 停在旧值哪里，最后一轮总在窗口里', () => {
    const slice = chatWindowOf({
      turns,
      windowed: true,
      atBottom: true,
      // 贴底帧的 scrollTop 可能还停在很靠上的旧值——窗口不能信它
      viewTop: 0,
      viewHeight: 600,
      turnEstimate: 88,
    })
    expect(slice.visible.at(-1)).toEqual({ key: 't199' })
    expect(slice.padBottom).toBe(0)
  })

  it('视口高度未量到时按估算行数兜底，而不是拿 0 当视口', () => {
    const slice = chatWindowOf({
      turns,
      windowed: true,
      atBottom: false,
      viewTop: 0,
      viewHeight: 0,
      turnEstimate: 88,
    })
    // 兜底视口 = 12 行 × 88px + overscan：可见数必须是有限窗口而不是全量
    expect(slice.visible.length).toBeLessThan(turns.length)
    expect(slice.padBottom).toBeGreaterThan(0)
  })

  it('padTop = 窗口起点 × 估算：滚动条连续性的来源', () => {
    const slice = chatWindowOf({
      turns,
      windowed: true,
      atBottom: false,
      viewTop: 88 * 50,
      viewHeight: 600,
      turnEstimate: 88,
    })
    expect(slice.padTop).toBeGreaterThan(0)
    expect(slice.padTop % 88).toBe(0)
  })
})

describe('createUserScrollGate：用户滚动时间窗', () => {
  it('mark 之后窗口内算用户驱动，窗口外不再算', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      // 注入 Date.now 作为时钟：fake timers 默认伪造 Date 而不伪造 performance.now
      const gate = createUserScrollGate(() => Date.now())
      expect(gate.isUserDriven()).toBe(false)
      gate.mark()
      expect(gate.isUserDriven()).toBe(true)
      vi.setSystemTime(1_000 + USER_SCROLL_MS - 1)
      expect(gate.isUserDriven()).toBe(true)
      vi.setSystemTime(1_000 + USER_SCROLL_MS)
      expect(gate.isUserDriven()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('翻页常量口径', () => {
  it('PAGE_SIZE 与窗口化阈值是有限正整数（翻页/桥接逻辑的输入）', () => {
    expect(PAGE_SIZE).toBeGreaterThan(0)
    expect(WINDOW_MIN_TURNS).toBeGreaterThan(0)
  })
})
