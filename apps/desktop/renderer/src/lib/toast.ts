/**
 * 轻量 toast：极小状态容器（模块级单例 + useSyncExternalStore 订阅）。
 *
 * 起因：点赞/踩此前是静默 `.catch(() => {})`，用户既不知道反馈去了哪，
 * 也不知道助理有没有因此改变——而"自我进化"正是本产品的核心卖点。
 */
import { useSyncExternalStore } from 'react'

export type ToastKind = 'info' | 'success' | 'error'

/**
 * toast 上的常驻操作（删除后的「撤销」）。点了由 ToastHost 顺手收掉这一条。
 * duration: 0 = 需要手动关闭，正是给这种「等用户决定」的提示预留的语义。
 */
export interface ToastAction {
  label: string
  run: () => void
}

export interface ToastOptions {
  /** 毫秒；0 表示需要手动关闭。带操作按钮时默认常驻（0），不自动消失。 */
  duration?: number
  action?: ToastAction
}

export interface ToastItem {
  id: number
  kind: ToastKind
  text: string
  /** 毫秒；0 表示需要手动关闭。 */
  duration: number
  action?: ToastAction
}

type Listener = () => void

const DEFAULT_MS: Record<ToastKind, number> = {
  info: 2600,
  success: 2600,
  error: 5200,
}

let seq = 0
let items: ToastItem[] = []
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) listener()
}

function remove(id: number): void {
  items = items.filter((item) => {
    return item.id !== id
  })
  emit()
}

function push(kind: ToastKind, text: string, options: ToastOptions = {}): number {
  seq += 1
  const id = seq
  const action = options.action
  const duration = options.duration ?? (action === undefined ? DEFAULT_MS[kind] : 0)
  // 同类提示只保留最新一条，避免连点 👍 时刷屏。
  items = [
    ...items.filter((item) => {
      return item.kind !== kind || item.text !== text
    }),
    { id, kind, text, duration, ...(action === undefined ? {} : { action }) },
  ]
  emit()
  if (duration > 0) setTimeout(() => {
    remove(id)
  }, duration)
  return id
}

export const toast = {
  info: (text: string, options?: ToastOptions): number => {
    return push('info', text, options)
  },
  success: (text: string, options?: ToastOptions): number => {
    return push('success', text, options)
  },
  error: (text: string, options?: ToastOptions): number => {
    return push('error', text, options)
  },
  dismiss: remove,
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getToasts(): readonly ToastItem[] {
  return items
}

export function useToasts(): readonly ToastItem[] {
  return useSyncExternalStore(subscribeToasts, getToasts, getToasts)
}