/**
 * 「已经被软删掉的会话」名单（渲染层本地的一份）。
 *
 * 为什么需要它：服务端删会话是**软删**（只打标记，数据一条不动），列表接口随后就
 * 不再返回它——但那要等壳重拉列表才生效。欢迎页那次删除不会触发重拉，左栏手里那份
 * 还是旧的：不摘掉的话，用户会看到一行点进去 404 的僵尸会话，还以为没删干净。
 *
 * 为什么放在模块级而不是组件 state：左栏会被卸载重挂（切到通讯录再切回来），组件
 * state 一丢，那一行就又冒出来了。模块级这份名单跟着整个渲染进程活着。
 *
 * 名单只收「别处删掉的」会话——左栏自己删的那条走它自己的 state（删完紧接着就让壳
 * 重拉列表，壳拿到的是服务端的真值，不需要这份名单插手）。
 */
import { useSyncExternalStore } from 'react'

let removed = new Set<string>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** 某个会话在别处被删掉了：左栏别再画这一行。 */
export function markConversationRemoved(id: string): void {
  if (removed.has(id)) return
  removed = new Set([...removed, id])
  emit()
}

/** 撤销删除：会话回到列表。 */
export function markConversationRestored(id: string): void {
  if (!removed.has(id)) return
  const next = new Set(removed)
  next.delete(id)
  removed = next
  emit()
}

/** 这个会话是不是已经被软删了。 */
export function isConversationRemoved(id: string): boolean {
  return removed.has(id)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): ReadonlySet<string> {
  return removed
}

/** 订阅这份名单（React 读法）。 */
export function useRemovedConversations(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
