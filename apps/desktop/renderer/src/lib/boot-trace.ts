/**
 * 渲染层启动计时：模块执行 → DOM 就绪 → 首帧 → 首屏可用。
 *
 * 阶段挂在 `window.__RYAGENT_BOOT__` 上，主进程在 did-finish-load 之后用
 * executeJavaScript 读走、并入自己的时间轴（见 electron/main.ts 的 collectRendererBootPhases）。
 * 整条链路不经 preload、不依赖遥测服务，因此单测、离线开发、CI 里都只是往一个普通
 * 对象里写几行数字。
 *
 * 时间基准是渲染层的 `performance.now()`（从导航起点计时），主进程按 loadURL 那一刻
 * 换算到自己的时钟上，两边才对得上一条时间轴。
 */
export interface RendererBootPhase {
  stage: string
  /** 相对导航起点的毫秒数。 */
  ms: number
}

/** 主进程读取的全局键。 */
const BOOT_GLOBAL = '__RYAGENT_BOOT__'

const phases: RendererBootPhase[] = []
const seen = new Set<string>()

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

/** 打一个阶段（同名只记第一次）。 */
export function markBootPhase(stage: string): void {
  if (seen.has(stage)) return
  seen.add(stage)
  phases.push({ stage, ms: Math.round(now() * 10) / 10 })
  publish()
}

/** 已记录的阶段（副本，调用方改不动内部状态）。 */
export function readBootPhases(): RendererBootPhase[] {
  return phases.map((phase) => {
    return { ...phase }
  })
}

function publish(): void {
  if (typeof window === 'undefined') return
  ;(window as unknown as Record<string, unknown>)[BOOT_GLOBAL] = { phases: readBootPhases() }
}

/** 首帧之后即可交互（数据到达、首屏可点）；App 拿到首份列表后调一次即可（幂等）。 */
export function markFirstInteractive(): void {
  markBootPhase('first-interactive')
}

markBootPhase('module')

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      markBootPhase('dom-ready')
    })
  } else {
    markBootPhase('dom-ready')
  }
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      markBootPhase('first-paint')
    })
    // 窗口隐藏时 Chromium 不跑 rAF：兜一个超时点，宁可粗也别让这一段空着。
    setTimeout(() => {
      markBootPhase('first-paint-timeout')
    }, 3000)
  }
}
