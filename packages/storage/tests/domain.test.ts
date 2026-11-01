import {
  assertShape,
  checkShape,
  type DomainFieldType,
  type DomainShape,
  describeType,
  isPlainObject,
  matchesType,
  StorageValidationError,
} from '@ryharness/storage'
import { describe, expect, it } from 'vitest'

const shape: DomainShape = {
  fields: {
    name: { type: 'string' },
    count: { type: 'number' },
    on: { type: 'boolean' },
    extra: { type: 'object' },
    list: { type: 'array' },
    nothing: { type: 'null' },
    note: { type: 'string', required: false },
  },
}

describe('形状检查', () => {
  it('全对的数据没有问题', () => {
    const issues = checkShape(shape, {
      name: 'x',
      count: 1,
      on: true,
      extra: {},
      list: [],
      nothing: null,
    })
    expect(issues).toEqual([])
  })

  it('一次把所有没过的地方都列出来', () => {
    const issues = checkShape(shape, { name: 1, 多余: 2 })
    expect(issues.map((issue) => issue.field)).toEqual(['name', 'count', 'on', 'extra', 'list', 'nothing', '多余'])
  })

  it('缺必填字段报「缺少必填字段」', () => {
    const issues = checkShape({ fields: { name: { type: 'string' } } }, {})
    expect(issues).toEqual([{ field: 'name', reason: '缺少必填字段' }])
  })

  it('标了 required: false 的字段可以不给', () => {
    const issues = checkShape({ fields: { note: { type: 'string', required: false } } }, {})
    expect(issues).toEqual([])
  })

  it('给了 undefined 也当没给', () => {
    const issues = checkShape({ fields: { name: { type: 'string' } } }, { name: undefined })
    expect(issues.map((issue) => issue.reason)).toEqual(['缺少必填字段'])
  })

  it('类型不对时报出实际类型', () => {
    const issues = checkShape({ fields: { count: { type: 'number' } } }, { count: '不是数字' })
    expect(issues).toEqual([{ field: 'count', reason: '应当是 number，实际是 string' }])
  })

  it('整体不是对象时报在 <root> 上', () => {
    expect(checkShape(shape, '一个字符串')).toEqual([{ field: '<root>', reason: '应当是对象，实际是 string' }])
    expect(checkShape(shape, null)).toEqual([{ field: '<root>', reason: '应当是对象，实际是 null' }])
    expect(checkShape(shape, [1, 2])).toEqual([{ field: '<root>', reason: '应当是对象，实际是 array' }])
  })

  it('形状是白名单：没声明的字段也要拒', () => {
    const issues = checkShape({ fields: { name: { type: 'string' } } }, { name: 'x', 拼错: 1 })
    expect(issues).toEqual([{ field: '拼错', reason: '形状里没有声明这个字段' }])
  })
})

describe('assertShape', () => {
  it('合格时什么也不做', () => {
    expect(() => assertShape('note', { fields: { name: { type: 'string' } } }, { name: 'x' })).not.toThrow()
  })

  it('不合格时抛 StorageValidationError，带 kind 与字段名', () => {
    let caught: unknown
    try {
      assertShape('note', { fields: { name: { type: 'string' } } }, { name: 1 })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(StorageValidationError)
    const failure = caught as StorageValidationError
    expect(failure.kind).toBe('note')
    expect(failure.field).toBe('name')
    expect(failure.message).toContain('kind「note」')
    expect(failure.message).toContain('字段「name」')
  })

  it('有多处问题时消息里说明还有几处', () => {
    let caught: unknown
    try {
      assertShape('note', { fields: { a: { type: 'string' }, b: { type: 'string' } } }, { a: 1, b: 2 })
    } catch (error) {
      caught = error
    }
    expect((caught as StorageValidationError).message).toContain('另有 1 处问题')
  })
})

describe('类型判定', () => {
  it('number 不收 NaN 与 Infinity', () => {
    expect(matchesType(1, 'number')).toBe(true)
    expect(matchesType(Number.NaN, 'number')).toBe(false)
    expect(matchesType(Number.POSITIVE_INFINITY, 'number')).toBe(false)
  })

  it('object 只收普通对象，数组与 null 都不算', () => {
    expect(matchesType({}, 'object')).toBe(true)
    expect(matchesType([], 'object')).toBe(false)
    expect(matchesType(null, 'object')).toBe(false)
  })

  it('array 与 null 各归各的', () => {
    expect(matchesType([], 'array')).toBe(true)
    expect(matchesType({}, 'array')).toBe(false)
    expect(matchesType(null, 'null')).toBe(true)
    expect(matchesType(undefined, 'null')).toBe(false)
  })

  it('不认识的类型一律不匹配', () => {
    // JSON.parse 给的是 any，转成声明之外的类型不费劲（这里要的就是一个非法值）。
    const bogusType = JSON.parse('"不是类型"') as DomainFieldType
    expect(matchesType('x', bogusType)).toBe(false)
  })

  it('isPlainObject 认出普通对象', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject('x')).toBe(false)
  })

  it('describeType 说得像人话', () => {
    expect(describeType(null)).toBe('null')
    expect(describeType([])).toBe('array')
    expect(describeType({})).toBe('object')
    expect(describeType(1)).toBe('number')
    expect(describeType('x')).toBe('string')
    expect(describeType(undefined)).toBe('undefined')
  })
})
