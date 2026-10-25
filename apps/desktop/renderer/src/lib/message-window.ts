/**
 * 聊天区窗口化的纯计算层：高度估算、可视窗口组装、用户滚动时间窗。
 *
 * 从 ChatView 抽出的**没有任何 React 依赖**的那部分——它们此前内联在两千多行
 * 的组件里，改任何聊天功能都要在同一个闭包里下刀，而且没有单测。滚动仲裁的
 * 其余部分（贴底跟踪、跟随合帧、padTop 搬移）与组件的 ref/bucket 状态共生，
 * 留在组件里；这里只收纯函数、常量与时间窗小状态机，jsdom 不起真滚动也能测。
 *
 * 可视区间的底层（visibleRange / windowSlice）仍是 lib/windowed.ts 那一份——
 * 会话列表与聊天区共用同一套能力，这里只是把聊天区特有的取参逻辑钉在这层。
 * @module
 */

import { DEFAULT_OVERSCAN, FALLBACK_VIEWPORT_ROWS, visibleRange, type WindowedSlice, windowSlice } from './windowed.ts'

/** 单条气泡的高度估算（px）：短文本一行 + 内边距。 */
export const BUBBLE_ESTIMATE_PX = 76
/** 一个 turn（轮次块：时间分隔 + 至少一条气泡）的高度估算（px）。 */
export const TURN_ESTIMATE_PX = 88
/**
 * 多少轮以上才启动窗口化：短会话一次性渲染完，滚动条长度、观感与此前完全一致，
 * 窗口化只对真正会长的流有意义。
 */
export const WINDOW_MIN_TURNS = 30
/** 定位时把命中那一轮上方再留几轮余量，避免 scrollIntoView 顶在容器边缘。 */
export const REVEAL_LEAD_TURNS = 2
/** 定位后补空洞最多翻几页（每页 PAGE_SIZE 条）。 */
export const GAP_BRIDGE_PAGES = 3
/** 每页历史消息数（向上翻页）。 */
export const PAGE_SIZE = 50

/**
 * 用户输入（滚轮/触摸/拖滚动条）之后多久之内，scroll 事件还算「用户滚的」。
 *
 * scroll 事件本身分不清是谁动的：程序化写 scrollTop、浏览器把越界的 scrollTop
 * 夹回合法范围，同样会派发 scroll。留一段窗口是因为「输入 → 滚动 → scroll 事件」
 * 不是同一歩（流式占用主线程时这个间隔能到几十毫秒），但也不能太长——那段时间里
 * 我们自己写的滚动又会被当成用户滚动。300ms 足够覆盖一帧到几十帧的抖动。
 */
export const USER_SCROLL_MS = 300

/**
 * 一个 turn 块的估算高度：按本会话实际的消息密度算（群聊一轮三五句、单聊常常
 * 一来一回两条），估偏了只是哨兵略有出入，滚动条仍连续。
 *
 * 密度只按**已加载的历史**算，不含正在流式的那一轮：上哨兵 = 窗口起点 × 估算，
 * 而流式每个 token 都会让消息数组换一次身份，把它算进去等于让估算一像素一像素
 * 地爬——窗口起点在 100 时，估算动 1px 就是视口跳 100px。
 */
export function turnEstimateOf(history: readonly { turnIndex: number }[]): number {
  const pastTurns = new Set<number>()
  for (const message of history) pastTurns.add(message.turnIndex)
  const perTurn = pastTurns.size === 0 ? 1 : history.length / pastTurns.size
  return Math.max(TURN_ESTIMATE_PX, Math.round(perTurn * BUBBLE_ESTIMATE_PX))
}

/** {@link chatWindowOf} 的入参。 */
export interface ChatWindowInput<T> {
  /** 按 turn 分组后的全部轮次块。 */
  turns: readonly T[]
  /** 是否启用窗口化（turns 未过 {@link WINDOW_MIN_TURNS} 时为 false，全量渲染）。 */
  windowed: boolean
  /** 视口是否贴底：贴底帧无视 scrollTop，窗口直接钉在末尾。 */
  atBottom: boolean
  viewTop: number
  viewHeight: number
  turnEstimate: number
}

/**
 * 聊天区这一次要渲染的窗口。
 *
 * 贴底时无视 scrollTop（那一帧可能还停在旧值），窗口直接钉在末尾：新消息到达时
 * 窗口已经把它算进去了，否则「跟随底部」要等下一次滚动事件才补上。视口高度还没
 * 量到（首轮渲染）时按估算行数兜底，而不是拿 0 当视口去算窗口。
 */
export function chatWindowOf<T>(input: ChatWindowInput<T>): WindowedSlice<T> {
  const viewportHeight = input.viewHeight > 0 ? input.viewHeight : input.turnEstimate * FALLBACK_VIEWPORT_ROWS
  const range = visibleRange({
    count: input.turns.length,
    estimateHeight: input.turnEstimate,
    scrollTop: input.windowed && input.atBottom ? Number.POSITIVE_INFINITY : input.viewTop,
    viewportHeight,
    overscan: DEFAULT_OVERSCAN,
  })
  return windowSlice(input.turns, input.windowed ? range : { start: 0, end: input.turns.length }, input.turnEstimate)
}

/**
 * 已渲染的那几轮，**轮次间距**是多少像素。
 *
 * 要的是间距（一个轮次块的顶 → 下一个轮次块的顶），不是内容高：窗口的映射按
 * 「轮号 × 间距 = 那一轮顶端的像素位置」算，间距才对得上这条式子。
 *
 * 只量**已渲染的那几轮**：容器的 scrollHeight 里含上下哨兵（它们按估算高度撑出来的），
 * 除以总轮数算出来还是那个估算值——真实高度从头到尾没被学到，窗口的映射就一直差着
 * 两倍，滚轮往上一滚内容就换掉，看着像滚不动。
 *
 * @param blocks - 已渲染轮次块的顶与高（px）
 * @returns 每轮的间距（px）；量不出来时返回 0
 */
export function measuredTurnHeight(blocks: readonly { top: number; height: number }[]): number {
  const first = blocks[0]
  const last = blocks[blocks.length - 1]
  if (first === undefined || last === undefined) return 0
  if (blocks.length === 1) {
    return first.height > 0 ? first.height : 0
  }
  const span = last.top - first.top
  if (!Number.isFinite(span) || span <= 0) return 0
  return span / (blocks.length - 1)
}

/**
 * 用户滚动时间窗：mark 之后 {@link USER_SCROLL_MS} 内的滚动算「用户在驱动」。
 *
 * 做成工厂而不是常量判断，是为了测试能注入时钟；组件里仍是一个 ref 持有到期
 * 时间戳——这里给出的是同一语义的最小状态机。
 */
export function createUserScrollGate(now: () => number = () => performance.now()) {
  let until = Number.NEGATIVE_INFINITY
  return {
    mark(): void {
      until = now() + USER_SCROLL_MS
    },
    isUserDriven(): boolean {
      return now() < until
    },
  }
}
