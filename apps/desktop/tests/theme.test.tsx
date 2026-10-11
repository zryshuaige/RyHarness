// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { applyTheme } from '../renderer/src/App.tsx'

describe('主题切换', () => {
  it('applyTheme 写 documentElement 的 data-theme', () => {
    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
