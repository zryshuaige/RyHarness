// @vitest-environment jsdom
/**
 * 草稿的跨重启持久化。
 *
 * 草稿此前只活在内存里的会话桶：切会话丢不了（桶还在），**重启应用就没了**。
 * 一个下午打到一半的句子因为手滑关了窗口而消失，是那种"软件不可信"的感觉。
 *
 * 落盘有三条边界要钉住：写进 localStorage、重启后接回来、发出去后删掉；外加
 * localStorage 不可用时静默降级（隐私模式），不能抛错。
 *
 * @module @ryharness/desktop/tests/draft-persistence
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearDraft, draftKey, loadDraft, saveDraft } from '../renderer/src/lib/drafts.ts'
import { ConversationBucket } from '../renderer/src/store.ts'

/** 等过草稿落盘的去抖窗口（300ms）+ 一点余量。 */
const PERSIST_WAIT_MS = 380

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('草稿落盘', () => {
  it('写了草稿，去抖之后落进 localStorage', async () => {
    const bucket = new ConversationBucket('c1')
    bucket.setDraft('打到一半的半句话')
    // 还没到去抖窗口：先不写。
    expect(localStorage.getItem(draftKey('c1'))).toBeNull()
    await wait(PERSIST_WAIT_MS)
    expect(localStorage.getItem(draftKey('c1'))).toBe('打到一半的半句话')
  })

  it('重启后接回来：新建的桶读得到上一次的草稿', async () => {
    const bucket = new ConversationBucket('c1')
    bucket.setDraft('上次没发出去的')
    await wait(PERSIST_WAIT_MS)
    // 新一轮运行 = 一个新的桶（内存里的东西全没了，只有 localStorage 还在）。
    const revived = new ConversationBucket('c1')
    expect(revived.getView().draft).toBe('上次没发出去的')
  })

  it('空草稿 = 删键（不是写一个空串进去）', async () => {
    const bucket = new ConversationBucket('c1')
    bucket.setDraft('先写一句')
    await wait(PERSIST_WAIT_MS)
    expect(localStorage.getItem(draftKey('c1'))).toBe('先写一句')
    bucket.setDraft('')
    expect(localStorage.getItem(draftKey('c1'))).toBeNull()
  })

  it('每个会话各存各的', async () => {
    const first = new ConversationBucket('c1')
    const second = new ConversationBucket('c2')
    first.setDraft('甲的草稿')
    second.setDraft('乙的草稿')
    await wait(PERSIST_WAIT_MS)
    expect(loadDraft('c1')).toBe('甲的草稿')
    expect(loadDraft('c2')).toBe('乙的草稿')
  })

  it('localStorage 不可用时静默降级，不抛错', () => {
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error('denied')
    }
    try {
      const bucket = new ConversationBucket('c1')
      expect(() => {
        bucket.setDraft('写不进去也得不崩')
      }).not.toThrow()
      expect(bucket.getView().draft).toBe('写不进去也得不崩')
    } finally {
      Storage.prototype.getItem = original
    }
  })

  it('clearDraft 删掉一条草稿', () => {
    saveDraft('c1', '要删的')
    expect(loadDraft('c1')).toBe('要删的')
    clearDraft('c1')
    expect(loadDraft('c1')).toBe('')
  })
})
