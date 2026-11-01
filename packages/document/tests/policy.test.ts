/**
 * 边界：授权、大小、页数、时限参数。
 */
import { describe, expect, it } from 'vitest'
import {
  checkAuthorized,
  checkInputSize,
  checkPageCount,
  DEFAULT_DOCUMENT_POLICY,
  isDocumentError,
  resolvePolicy,
} from '../src/index.ts'

describe('授权', () => {
  it('显式授权 → 放行', () => {
    expect(() => checkAuthorized(true)).not.toThrow()
  })

  it('没授权 → NOT_AUTHORIZED', () => {
    let caught: unknown
    try {
      checkAuthorized(false)
    } catch (error) {
      caught = error
    }
    expect(isDocumentError(caught, 'NOT_AUTHORIZED')).toBe(true)
  })
})

describe('大小上限', () => {
  it('在上限之内放行', () => {
    expect(() => checkInputSize(1024, DEFAULT_DOCUMENT_POLICY)).not.toThrow()
  })

  it('超上限 → INPUT_TOO_LARGE', () => {
    const policy = resolvePolicy({ maxInputBytes: 10 })
    let caught: unknown
    try {
      checkInputSize(11, policy)
    } catch (error) {
      caught = error
    }
    expect(isDocumentError(caught, 'INPUT_TOO_LARGE')).toBe(true)
  })

  it('刚好等于上限算通过', () => {
    const policy = resolvePolicy({ maxInputBytes: 10 })
    expect(() => checkInputSize(10, policy)).not.toThrow()
  })
})

describe('页数上限', () => {
  it('转换器没报页数就跳过', () => {
    expect(() => checkPageCount(undefined, DEFAULT_DOCUMENT_POLICY)).not.toThrow()
  })

  it('超上限 → PAGE_LIMIT_EXCEEDED', () => {
    const policy = resolvePolicy({ maxPages: 10 })
    let caught: unknown
    try {
      checkPageCount(11, policy)
    } catch (error) {
      caught = error
    }
    expect(isDocumentError(caught, 'PAGE_LIMIT_EXCEEDED')).toBe(true)
  })

  it('在上限之内放行', () => {
    const policy = resolvePolicy({ maxPages: 10 })
    expect(() => checkPageCount(10, policy)).not.toThrow()
  })
})

describe('边界参数', () => {
  it('缺省值是文档里写的那一套', () => {
    expect(DEFAULT_DOCUMENT_POLICY.maxInputBytes).toBe(64 * 1024 * 1024)
    expect(DEFAULT_DOCUMENT_POLICY.maxPages).toBe(500)
    expect(DEFAULT_DOCUMENT_POLICY.timeoutMs).toBe(120_000)
  })

  it('覆盖项生效', () => {
    const policy = resolvePolicy({ maxPages: 3 })
    expect(policy.maxPages).toBe(3)
    expect(policy.maxInputBytes).toBe(DEFAULT_DOCUMENT_POLICY.maxInputBytes)
  })

  it('非法值（负数、NaN）退回默认', () => {
    const policy = resolvePolicy({ maxPages: -1, maxInputBytes: Number.NaN, timeoutMs: 0 })
    expect(policy.maxPages).toBe(DEFAULT_DOCUMENT_POLICY.maxPages)
    expect(policy.maxInputBytes).toBe(DEFAULT_DOCUMENT_POLICY.maxInputBytes)
    expect(policy.timeoutMs).toBe(DEFAULT_DOCUMENT_POLICY.timeoutMs)
  })
})
