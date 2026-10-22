/**
 * 退场态 hook：把 styles.css 6.3 的退场体系（根节点挂 .is-leaving → 播完再卸载）
 * 变成一条可复用的接线，toast / 提示条 / 浮层都走它，避免各处手写计时器。
 *
 * 三条约定：
 * 1. **value 驱动**：`value` 传 `undefined` 即表示「该走了」（内容类型本身不应为
 *    undefined），比 `visible: boolean` 多带一层内容——退场期间 `shown` 保持上一次的
 *    值，浮层不会闪成空白。
 * 2. **时间 + 事件双兜底**：CSS 动画被覆盖、被禁用或压根没跑起来时，定时器保证
 *    元素一定卸载；动画真的跑完了则由 `animationend` 提前结束，不白等。
 * 3. **可打断**：退场途中 `value` 回来就立刻回到进场态（连续两次触发不会留下残影）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** 退场时长，需与 styles.css 的 `--dur-leave` 保持一致。 */
export const LEAVE_MS = 150

/** 前庭障碍用户关闭动效时不需要等动画，直接卸载。 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export interface Leaving<T> {
  /** 当前该展示的内容；`undefined` 表示已彻底退场（可以卸载）。 */
  shown: T | undefined
  /** 退场态：拼进根节点的 className（`.is-leaving` 由样式表处理动画）。 */
  leaving: boolean
  /**
   * 退场态的根节点 className：`className('typing-indicator')` 即
   * `'typing-indicator is-leaving'` / `'typing-indicator'`。
   * 手写这层三元表达式散在九个调用点，早晚有一处把 `.is-leaving` 拼错位置。
   */
  className: (base: string) => string
  /** 挂到退场根节点，用于监听 `animationend` 提前结束。 */
  ref: (node: HTMLElement | null) => void
}

interface Phase<T> {
  shown: T
  leaving: boolean
}

export function useLeaving<T>(durationMs: number, value: T | undefined): Leaving<T> {
  // state 只记「离开当前这次出现」的过程：undefined = 已经彻底退场（该卸载了），
  // 有值 = 还在屏上（可能正在退场）。进场时直接渲染最新 value，不复制进 state，
  // 否则每帧新建的数组/对象会让整个组件无谓重渲染。
  const [phase, setPhase] = useState<Phase<T> | undefined>(() => {
    return value === undefined ? undefined : { shown: value, leaving: false }
  })

  // 渲染期纠正状态：与内容消失发生在同一次提交，少一帧闪动（React 官方的派生状态写法）。
  if (value === undefined) {
    if (phase !== undefined && !phase.leaving) {
      setPhase(prefersReducedMotion() ? undefined : { shown: phase.shown, leaving: true })
    }
  } else if (phase === undefined || phase.leaving) {
    // 内容回来了：打断退场，重新武装成可退场状态。
    setPhase({ shown: value, leaving: false })
  }

  useEffect(() => {
    if (phase?.leaving !== true) return
    const timer = setTimeout(() => {
      setPhase(undefined)
    }, durationMs)
    return () => {
      clearTimeout(timer)
    }
  }, [phase, durationMs])

  const nodeRef = useRef<HTMLElement | null>(null)
  const finish = useCallback((): void => {
    setPhase((prev) => {
      return prev?.leaving === true ? undefined : prev
    })
  }, [])

  const onAnimationEnd = useCallback(
    (event: Event): void => {
      // 子元素的动画也会冒泡上来，只有根节点自身的退场动画才算数。
      if (event.target !== nodeRef.current) return
      finish()
    },
    [finish],
  )

  const ref = useCallback(
    (node: HTMLElement | null): void => {
      const previous = nodeRef.current
      if (previous !== null && previous !== node) previous.removeEventListener('animationend', onAnimationEnd)
      nodeRef.current = node
      if (node !== null) node.addEventListener('animationend', onAnimationEnd)
    },
    [onAnimationEnd],
  )

  const className = useCallback(
    (base: string): string => {
      return phase?.leaving === true ? `${base} is-leaving` : base
    },
    [phase],
  )

  return {
    shown: value !== undefined ? value : phase?.shown,
    leaving: phase?.leaving === true,
    className,
    ref,
  }
}
