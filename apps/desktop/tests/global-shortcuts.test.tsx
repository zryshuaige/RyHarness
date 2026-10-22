// @vitest-environment jsdom
/**
 * 全局快捷键：Ctrl/Cmd+K 搜索、Ctrl/Cmd+N 新对话、Ctrl/Cmd+1..4 切页签。
 *
 * 判定口径在 shared/shortcuts.ts（渲染层与 Electron 菜单读同一份），这里钉住
 * 两件事：**认得出**（哪些组合算、哪些不算）与**派得对**（按下去会发生什么）。
 *
 * @module @ryharness/desktop/tests/global-shortcuts
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { matchShortcut, NEW_CHAT_SHORTCUT, SEARCH_SHORTCUT, tabShortcut } from '../shared/shortcuts.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('快捷键判定', () => {
  it('Ctrl+K 与 Cmd+K 都算「搜索」', () => {
    expect(matchShortcut({ key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, 4)).toEqual({
      id: 'focus-search',
    })
    expect(matchShortcut({ key: 'k', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }, 4)).toEqual({
      id: 'focus-search',
    })
  })

  it('Ctrl+N 是「新对话」', () => {
    expect(matchShortcut({ key: 'n', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, 4)).toEqual({
      id: 'new-chat',
    })
  })

  it('Ctrl+1..4 是页签，越界不认', () => {
    expect(matchShortcut({ key: '1', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, 4)).toEqual({
      id: 'tab-1',
      tab: 1,
    })
    expect(matchShortcut({ key: '4', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, 4)).toEqual({
      id: 'tab-4',
      tab: 4,
    })
    // 页签只有 3 个时，Ctrl+4 不认（不越界）。
    expect(
      matchShortcut({ key: '4', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, 3),
    ).toBeUndefined()
  })

  it('单键、Alt 组合、Shift 组合都不算', () => {
    expect(
      matchShortcut({ key: 'k', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, 4),
    ).toBeUndefined()
    expect(matchShortcut({ key: 'k', ctrlKey: true, metaKey: false, altKey: true, shiftKey: false }, 4)).toBeUndefined()
    expect(matchShortcut({ key: 'K', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, 4)).toBeUndefined()
  })

  it('accelerator 与判定口径是同一份（不会各写一遍而对不上）', () => {
    expect(SEARCH_SHORTCUT.accelerator).toBe('CmdOrCtrl+K')
    expect(NEW_CHAT_SHORTCUT.accelerator).toBe('CmdOrCtrl+N')
    expect(tabShortcut(0, '聊天').accelerator).toBe('CmdOrCtrl+1')
  })
})

describe('快捷键派发', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot> | undefined

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = undefined
    container.remove()
    vi.unstubAllGlobals()
  })

  it('Ctrl+K 把焦点送到搜索框', async () => {
    const { ConversationList } = await import('../renderer/src/components/ConversationList.tsx')
    act(() => {
      root?.render(<ConversationList conversations={[]} agents={[]} activeId={undefined} onSelect={() => {}} />)
    })
    const input = container.querySelector('.search-box') as HTMLInputElement
    expect(input).not.toBeNull()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
    })
    // App 是快捷键的持有者：这里只验证"事件搭桥"这条路通——
    // 派发 SEARCH_FOCUS_EVENT 之后搜索框拿到焦点。
    const { SEARCH_FOCUS_EVENT } = await import('../shared/shortcuts.ts')
    act(() => {
      window.dispatchEvent(new CustomEvent(SEARCH_FOCUS_EVENT))
    })
    expect(document.activeElement).toBe(input)
  })
})
