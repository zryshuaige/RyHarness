// @vitest-environment jsdom
/**
 * 改名那天的 localStorage 兼容：新键没有就回落旧键。
 *
 * 产品从 RyAgent 改成 RyHarness 时，localStorage 的键前缀也跟着换了。键名一变，
 * 用户的主题、面板收起态、**没发出去的草稿**就都"消失"了——它们其实还在，只是不在
 * 新键名下。
 *
 * @module apps/desktop/tests/storage-legacy
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSetting, removeSetting, writeSetting } from '../renderer/src/lib/storage.ts'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('界面偏好的旧键回落', () => {
  it('新键有值时直接用它', () => {
    localStorage.setItem('ryharness-theme', 'dark')
    expect(readSetting('ryharness-theme')).toBe('dark')
  })

  it('只有旧键时读得到，并顺手搬进新键', () => {
    localStorage.setItem('ryagent-theme', 'light')
    expect(readSetting('ryharness-theme')).toBe('light')
    // 搬过之后旧键就没了：两份值各说各话比一份更糟。
    expect(localStorage.getItem('ryharness-theme')).toBe('light')
    expect(localStorage.getItem('ryagent-theme')).toBeNull()
  })

  it('两个都没有时是 null', () => {
    expect(readSetting('ryharness-theme')).toBeNull()
  })

  it('不是新前缀的键没有旧键可回落', () => {
    localStorage.setItem('other-key', 'v')
    expect(readSetting('other-key')).toBe('v')
  })

  it('写新键时把旧键清掉', () => {
    localStorage.setItem('ryagent-panel-collapsed', '1')
    writeSetting('ryharness-panel-collapsed', '0')
    expect(localStorage.getItem('ryharness-panel-collapsed')).toBe('0')
    expect(localStorage.getItem('ryagent-panel-collapsed')).toBeNull()
  })

  it('删键时新旧都删', () => {
    localStorage.setItem('ryharness-draft:c1', '草稿')
    localStorage.setItem('ryagent-draft:c1', '旧草稿')
    removeSetting('ryharness-draft:c1')
    expect(localStorage.getItem('ryharness-draft:c1')).toBeNull()
    expect(localStorage.getItem('ryagent-draft:c1')).toBeNull()
  })

  it('localStorage 不可用时不抛（隐私模式）', () => {
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error('denied')
    }
    try {
      expect(readSetting('ryharness-theme')).toBeNull()
      expect(() => {
        writeSetting('ryharness-theme', 'dark')
      }).not.toThrow()
    } finally {
      Storage.prototype.getItem = original
    }
  })
})
