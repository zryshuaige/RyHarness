/**
 * 全局快捷键表：渲染层与 Electron 菜单**共用同一份**。
 *
 * 两处各写一遍的代价是"迟早对不上"——菜单上写着 Ctrl+K，渲染层认的却是
 * Ctrl+Shift+K，用户按菜单上那个没反应。所以定义放这里：菜单拿它显示
 * accelerator，渲染层拿它判定按键。
 *
 * 纯数据 + 纯函数，不碰 DOM、不碰 Electron：两边都能直接 import。
 *
 * @module @ryharness/desktop/shared/shortcuts
 */

/** 一条快捷键。 */
export interface ShortcutDef {
  /** 稳定的动作 id（渲染层按它分派）。 */
  id: string
  /** 菜单与提示里显示的文案。 */
  label: string
  /** Electron 的 accelerator 写法（菜单项与渲染层提示共用）。 */
  accelerator: string
}

/**
 * 聚焦左栏搜索框的窗口事件。
 *
 * App 是快捷键的持有者，搜索框在会话列表里——两边隔着一个组件层级，用事件
 * 搭桥（与"滚到那条消息"同一条路）比层层透传回调省事。
 */
export const SEARCH_FOCUS_EVENT = 'ryharness:focus-search'

/** 搜索会话与消息。 */
export const SEARCH_SHORTCUT: ShortcutDef = {
  id: 'focus-search',
  label: '搜索会话与消息',
  accelerator: 'CmdOrCtrl+K',
}

/** 新对话（回到欢迎页）。 */
export const NEW_CHAT_SHORTCUT: ShortcutDef = {
  id: 'new-chat',
  label: '新对话',
  accelerator: 'CmdOrCtrl+N',
}

/** 页签快捷键：Ctrl/Cmd+1..n（序号与页签顺序一致）。 */
export function tabShortcut(index: number, label: string): ShortcutDef {
  return { id: `tab-${index + 1}`, label: `切到${label}`, accelerator: `CmdOrCtrl+${index + 1}` }
}

/** 渲染层判定快捷键时用到的键事件字段（只取需要的，测试里也能造）。 */
export interface ShortcutKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** 认出来的快捷键。 */
export interface MatchedShortcut {
  /** 动作 id。 */
  id: string
  /** 页签快捷键带的页签序号（1 起）。 */
  tab?: number
}

/**
 * 从一个键事件里认出要执行的动作；认不出返回 undefined。
 *
 * 三条边界：
 * - **必须带 Ctrl 或 Cmd**：单键快捷键会跟输入法、跟聊天区的打字抢键；
 * - **不带 Alt / Shift**：那已经是别的组合（Alt+← 是 wordwise 移动、Shift 是选区）；
 * - **页签序号不能越界**：页签数量会变（插件页可能没有），越界就不认。
 */
export function matchShortcut(event: ShortcutKeyEvent, tabCount: number): MatchedShortcut | undefined {
  if (!event.ctrlKey && !event.metaKey) return undefined
  if (event.altKey || event.shiftKey) return undefined
  const key = event.key.toLowerCase()
  if (key === 'k') return { id: SEARCH_SHORTCUT.id }
  if (key === 'n') return { id: NEW_CHAT_SHORTCUT.id }
  if (/^[1-9]$/.test(key)) {
    const tab = Number(key)
    if (tab <= tabCount) return { id: `tab-${tab}`, tab }
  }
  return undefined
}
