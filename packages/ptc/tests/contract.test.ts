import { isPtcMode, PTC_FAILURE_KINDS, PTC_MODES, PtcBindingError } from '@ryharness/ptc'
import { describe, expect, it } from 'vitest'

describe('服务契约里的常量', () => {
  it('三种程序形态就是那三种', () => {
    expect(PTC_MODES).toEqual(['function-body', 'repl', 'script'])
  })

  it('模式校验只认这三个', () => {
    expect(isPtcMode('function-body')).toBe(true)
    expect(isPtcMode('repl')).toBe(true)
    expect(isPtcMode('script')).toBe(true)
    expect(isPtcMode('vm')).toBe(false)
    expect(isPtcMode(undefined)).toBe(false)
    expect(isPtcMode(7)).toBe(false)
  })

  it('失败分类都有名字，没有匿名分类', () => {
    expect(PTC_FAILURE_KINDS.length).toBeGreaterThanOrEqual(7)
    for (const kind of PTC_FAILURE_KINDS) {
      expect(kind.length).toBeGreaterThan(0)
    }
  })
})

describe('绑定错误', () => {
  it('默认按运行时错误算', () => {
    const error = new PtcBindingError('坏了')
    expect(error.kind).toBe('runtime')
    expect(error.message).toBe('坏了')
    expect(error.name).toBe('PtcBindingError')
  })

  it('分类可以自己定，跨进程传过去时靠它', () => {
    expect(new PtcBindingError('越界', 'policy').kind).toBe('policy')
    expect(new PtcBindingError('派太多了', 'limit').kind).toBe('limit')
  })
})
