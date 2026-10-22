/** 渲染层启动：等待主进程注入 API 地址（窗口先行启动时后端可能还在起）。 */
import { useEffect, useState } from 'react'
import { DEFAULT_API_BASE, readApiBaseFromLocation } from '../api.ts'

/** 主进程就绪后派发的事件（window 事件，无 preload 依赖）。 */
const API_BASE_EVENT = 'ryharness:api-base'
/** 主进程也可能直接挂全局变量（事件早于监听注册时兜底）。 */
const API_BASE_GLOBAL = '__RYHARNESS_API_BASE__'
/** 非 Electron 环境（浏览器直连 dev server）等不到事件，多久后回落到默认端口。 */
const FALLBACK_DELAY_MS = 600

/** preload 注入的桥（存在即说明跑在 Electron 里，API 地址一定会被主进程推过来）。 */
function inElectron(): boolean {
  return typeof window !== 'undefined' && (window as { ryharnessDesktop?: unknown }).ryharnessDesktop !== undefined
}

function globalApiBase(): string | undefined {
  const value = (window as unknown as Record<string, unknown>)[API_BASE_GLOBAL]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 解析 API 地址：
 * 1) URL query（?api=…，主进程已就绪时注入）；
 * 2) 主进程就绪事件/全局变量（窗口先行、后端并行启动）；
 * 3) 兜底回落到默认回环端口（浏览器直连开发）。
 * 返回 undefined 表示「还没就绪」——调用方先渲染骨架屏。
 */
export function useApiBase(): string | undefined {
  const fromQuery = readApiBaseFromLocation()
  const [base, setBase] = useState<string | undefined>(fromQuery)
  useEffect(() => {
    if (fromQuery !== undefined) return
    let cancelled = false
    const apply = (next: string | undefined): void => {
      if (cancelled || next === undefined || next.length === 0) return
      setBase(next)
    }
    const onEvent = (event: Event): void => {
      apply((event as CustomEvent<unknown>).detail as string | undefined)
    }
    window.addEventListener(API_BASE_EVENT, onEvent)
    apply(globalApiBase())
    // Electron 里主进程一定会推（server 起不来时它自己弹错误框退出），不回落，
    // 否则随机端口的后端还没就绪就被判成「连不上」。浏览器直连才允许回落。
    if (inElectron())
      return () => {
        cancelled = true
        window.removeEventListener(API_BASE_EVENT, onEvent)
      }
    const timer = setTimeout(() => {
      apply(globalApiBase() ?? DEFAULT_API_BASE)
    }, FALLBACK_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
      window.removeEventListener(API_BASE_EVENT, onEvent)
    }
  }, [fromQuery])
  return base ?? fromQuery
}
