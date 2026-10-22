/**
 * 宏观状态切换的统一补间（切主题 / 列表增删重排 / 切会话）。
 *
 * 用户说"不丝滑"的三处硬切全都属于同一类问题：**状态是瞬间换的，而视觉没有过渡**。
 * 逐处手写 FLIP（先量旧位置、改 DOM、再量新位置、反推 transform）要写四遍且四处都会
 * 漏边界；Chromium 的 View Transitions 把这个流程内置成一次调用：浏览器替我们对
 * 旧状态与新状态各拍一张快照，自动做 FLIP + cross-fade。Electron 44 的 Chromium
 * 已支持，因此优先走它。
 *
 * 不支持该 API（老内核 / jsdom 测试环境）或用户要求减少动效时，**直接同步执行**——
 * 结果完全一致，只是没有补间。调用方不需要写分支。
 */

/** 与 styles.css 里 `::view-transition-*` 的时长同源（改时长只改一处注释与那里）。 */
const DEFAULT_DURATION_MS = 220

/** 是否应当跳过补间（前庭障碍用户 / 测试环境）。 */
export function skipsTransition(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => { finished: Promise<unknown> }
}

/**
 * 把一次状态更新包进补间。
 *
 * @param update 真正改状态的同步函数（必须同步完成 DOM 变更，异步的部分不会进快照）。
 * @param _durationMs 预留参数：实际时长由 CSS 的 `::view-transition-*` 决定。
 */
export function withViewTransition(update: () => void, _durationMs: number = DEFAULT_DURATION_MS): void {
  const doc = document as ViewTransitionDocument
  if (typeof doc.startViewTransition !== 'function' || skipsTransition()) {
    update()
    return
  }
  try {
    const transition = doc.startViewTransition(() => {
      update()
    })
    // 补间被中断（例如用户连点两次）时 finished 会 reject，这里吞掉即可——
    // 状态更新本身已经完成，视觉补间失败不该冒泡成错误。
    void Promise.resolve(transition.finished).catch(() => {})
  } catch {
    // 极端情况下（同一帧内嵌套调用）浏览器会抛错：退化为直切，不能因为补间失败丢状态。
    update()
  }
}

/**
 * 给列表行分配稳定的 view-transition-name。
 * 名称必须唯一且以字母开头（UUID 可能以数字开头），因此统一加前缀。
 */
export function rowTransitionName(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^0-9A-Za-z_-]/g, '')}`
}
