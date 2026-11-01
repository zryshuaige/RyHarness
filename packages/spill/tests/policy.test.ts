/**
 * 工具结果策略的用例。
 *
 * 盯住四件事：**超限换预览**、**阈值内原样**、**存不下时保留原文**、
 * **结构化结果不溢出**。这四条是这一族存在的理由，别的都是细节。
 */

import { describe, expect, it } from 'vitest'
import {
  applySpillPolicy,
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_MAX_INLINE_TOKENS,
  formatSpillNotice,
  inlineLimitChars,
  isPlainTextResult,
  SpillPolicy,
} from '../src/policy.ts'
import type {
  SpillCleanupOptions,
  SpillCleanupResult,
  SpillMeta,
  SpillReadOptions,
  SpillReadResult,
  SpillRef,
  SpillStore,
} from '../src/types.ts'
import { SpillError } from '../src/types.ts'

/** 内存里的假存储：只实现接口，用来观察策略有没有正确地调用它。 */
class FakeStore implements SpillStore {
  readonly texts = new Map<string, string>()
  lastMeta: SpillMeta | undefined
  /** 存不下时抛的东西：可以是 Error，也可以是任意值（策略要能接住两种）。 */
  failWith: unknown
  private seq = 0

  store(text: string, meta?: SpillMeta): SpillRef {
    if (this.failWith !== undefined) throw this.failWith
    this.seq += 1
    const id = `fake_${this.seq}`
    this.texts.set(id, text)
    this.lastMeta = meta
    return {
      id,
      chars: text.length,
      path: `fake/${id}.txt`,
      retrieval: `调用 spill_read，参数 id="${id}"（可分页：offset / limit）。`,
      createdAt: new Date(0).toISOString(),
      ...(meta?.sessionId === undefined ? {} : { sessionId: meta.sessionId }),
      ...(meta?.tool === undefined ? {} : { tool: meta.tool }),
    }
  }

  read(locator: string | SpillRef, options?: SpillReadOptions): SpillReadResult {
    const id = typeof locator === 'string' ? locator : locator.id
    const text = this.texts.get(id)
    if (text === undefined) throw new SpillError('NOT_FOUND', '找不到这段溢出文本。')
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? text.length
    const slice = text.slice(offset, offset + limit)
    const nextOffset = offset + slice.length < text.length ? offset + slice.length : undefined
    return {
      id,
      text: slice,
      chars: text.length,
      offset,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      hasMore: nextOffset !== undefined,
      createdAt: new Date(0).toISOString(),
    }
  }

  remove(): boolean {
    return false
  }

  cleanup(_options?: SpillCleanupOptions): SpillCleanupResult {
    return { removed: 0, freedBytes: 0 }
  }

  list(): SpillRef[] {
    return []
  }
}

/** 一段够长的正文（默认阈值 8000 字符，得比它长才触发溢出）。 */
function longText(marker = '尾巴'): string {
  return `${'甲'.repeat(9000)}${marker}`
}

describe('applySpillPolicy', () => {
  it('阈值内的结果原样返回，一个字都不改', () => {
    const store = new FakeStore()
    const text = '短短的一段结果。'

    const outcome = applySpillPolicy({ text }, { store, maxInlineChars: 100 })

    expect(outcome.spilled).toBe(false)
    expect(outcome.content).toBe(text)
    expect(outcome.chars).toBe(text.length)
    expect(outcome.ref).toBeUndefined()
    expect(store.texts.size).toBe(0)
  })

  it('超限时换成「预览 + 定位符」，模型看不到全文', () => {
    const store = new FakeStore()
    const text = longText('这一段不该出现在模型面前')

    const outcome = applySpillPolicy({ text }, { store, maxInlineChars: 100, previewChars: 50 })

    expect(outcome.spilled).toBe(true)
    expect(outcome.ref?.id).toBe('fake_1')
    expect(outcome.content).toContain(text.slice(0, 50))
    expect(outcome.content).not.toContain('这一段不该出现在模型面前')
    expect(outcome.content).toContain('spill_read')
    expect(outcome.content).toContain('fake_1')
  })

  it('存不下时保留原文，不把内容丢掉', () => {
    const store = new FakeStore()
    store.failWith = new SpillError('CAPACITY_EXCEEDED', '磁盘满了。')
    const text = longText()

    const outcome = applySpillPolicy({ text }, { store, maxInlineChars: 100 })

    expect(outcome.spilled).toBe(false)
    expect(outcome.content).toBe(text)
    expect(outcome.failure).toContain('磁盘满了')
    expect(outcome.ref).toBeUndefined()
  })

  it('结构化结果不溢出：JSON 原文照旧给模型', () => {
    const store = new FakeStore()
    const text = JSON.stringify({ rows: Array.from({ length: 500 }, (_unused, index) => ({ index })) })

    const outcome = applySpillPolicy({ text }, { store, maxInlineChars: 100 })

    expect(outcome.spilled).toBe(false)
    expect(outcome.content).toBe(text)
    expect(store.texts.size).toBe(0)
  })

  it('宿主明确说是结构化结果时也不溢出', () => {
    const store = new FakeStore()
    const text = longText()

    const outcome = applySpillPolicy({ text, plainText: false }, { store, maxInlineChars: 100 })

    expect(outcome.spilled).toBe(false)
    expect(outcome.content).toBe(text)
  })

  it('看着像 JSON 但解析不了，仍按纯文本溢出', () => {
    const store = new FakeStore()
    const text = `{ 这不是 JSON ${'甲'.repeat(9000)}`

    const outcome = applySpillPolicy({ text }, { store, maxInlineChars: 100 })

    expect(outcome.spilled).toBe(true)
  })

  it('空结果不溢出', () => {
    const store = new FakeStore()

    const outcome = applySpillPolicy({ text: '' }, { store, maxInlineChars: 100 })

    expect(outcome.spilled).toBe(false)
    expect(outcome.content).toBe('')
  })

  it('存的时候把会话归属与来源工具一起记上', () => {
    const store = new FakeStore()

    applySpillPolicy({ text: longText(), tool: 'shell_exec' }, { store, maxInlineChars: 100, sessionId: 'conv-9' })

    expect(store.lastMeta?.sessionId).toBe('conv-9')
    expect(store.lastMeta?.tool).toBe('shell_exec')
  })

  it('token 阈值按每个 token 折算多少字符换算', () => {
    const store = new FakeStore()
    const text = '甲'.repeat(300)

    const outcome = applySpillPolicy({ text }, { store, maxInlineTokens: 50, charsPerToken: 4 })

    expect(outcome.limitChars).toBe(200)
    expect(outcome.spilled).toBe(true)
  })

  it('两个阈值同时给时取更小的那个', () => {
    const store = new FakeStore()
    const text = '甲'.repeat(300)

    const outcome = applySpillPolicy({ text }, { store, maxInlineTokens: 100, maxInlineChars: 50, charsPerToken: 4 })

    expect(outcome.limitChars).toBe(50)
  })

  it('没给阈值时用缺省上限', () => {
    const store = new FakeStore()
    const short = '甲'.repeat(100)

    const outcome = applySpillPolicy({ text: short }, { store })

    expect(outcome.limitChars).toBe(DEFAULT_MAX_INLINE_TOKENS * DEFAULT_CHARS_PER_TOKEN)
    expect(outcome.spilled).toBe(false)
  })

  it('预览长度可以单独调', () => {
    const store = new FakeStore()
    const text = '甲'.repeat(500)

    const outcome = applySpillPolicy({ text }, { store, maxInlineChars: 100, previewChars: 10 })

    expect(outcome.content).toContain('甲'.repeat(10))
    expect(outcome.content).not.toContain('甲'.repeat(11))
  })

  it('存失败时抛的不是 Error，也能把原因说清楚', () => {
    const store = new FakeStore()
    store.failWith = '磁盘满了'
    const text = longText()

    const outcome = applySpillPolicy({ text }, { store, maxInlineChars: 100 })

    expect(outcome.spilled).toBe(false)
    expect(outcome.content).toBe(text)
    expect(outcome.failure).toBe('磁盘满了')
  })

  it('正文不是字符串时当空文本处理，不炸', () => {
    const store = new FakeStore()
    const bad: unknown = undefined

    const outcome = applySpillPolicy({ text: bad as string }, { store, maxInlineChars: 100 })

    expect(outcome.content).toBe('')
    expect(outcome.chars).toBe(0)
    expect(outcome.spilled).toBe(false)
  })
})

describe('isPlainTextResult', () => {
  it('普通文字算纯文本', () => {
    expect(isPlainTextResult('就是一段说明文字。')).toBe(true)
  })

  it('能解析的 JSON 算结构化结果', () => {
    expect(isPlainTextResult('{"a":1}')).toBe(false)
    expect(isPlainTextResult('[1,2,3]')).toBe(false)
  })

  it('解析不了的类 JSON 仍算纯文本', () => {
    expect(isPlainTextResult('{ 这不是 JSON')).toBe(true)
  })
})

describe('inlineLimitChars', () => {
  it('只给字符阈值时用它', () => {
    expect(inlineLimitChars({ store: new FakeStore(), maxInlineChars: 123 })).toBe(123)
  })

  it('只给 token 阈值时按折算换算', () => {
    expect(inlineLimitChars({ store: new FakeStore(), maxInlineTokens: 10, charsPerToken: 3 })).toBe(30)
  })
})

describe('formatSpillNotice', () => {
  it('说清原文多长、看到多少、怎么取回', () => {
    const ref: SpillRef = {
      id: 'sp_1',
      chars: 12345,
      path: 'spills/conv/sp_1.txt',
      retrieval: '调用 spill_read，参数 id="sp_1"（可分页：offset / limit）。',
      createdAt: new Date(0).toISOString(),
    }

    const notice = formatSpillNotice('甲'.repeat(12345), ref, 10)

    expect(notice).toContain('12345')
    expect(notice).toContain('sp_1')
    expect(notice).toContain('spill_read')
    expect(notice).toContain('甲'.repeat(10))
  })
})

describe('SpillPolicy', () => {
  it('构造时给的阈值与存储一直生效', () => {
    const store = new FakeStore()
    const policy = new SpillPolicy({ store, maxInlineChars: 100 })

    const outcome = policy.apply({ text: longText() })

    expect(outcome.spilled).toBe(true)
    expect(store.texts.size).toBe(1)
  })

  it('单次判定可以覆盖会话归属', () => {
    const store = new FakeStore()
    const policy = new SpillPolicy({ store, maxInlineChars: 100, sessionId: 'conv-1' })

    policy.apply({ text: longText() }, { sessionId: 'conv-2' })

    expect(store.lastMeta?.sessionId).toBe('conv-2')
  })

  it('单次判定可以覆盖来源工具', () => {
    const store = new FakeStore()
    const policy = new SpillPolicy({ store, maxInlineChars: 100 })

    policy.apply({ text: longText() }, { tool: 'shell_exec' })

    expect(store.lastMeta?.tool).toBe('shell_exec')
  })
})
