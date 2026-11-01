/**
 * 协议原样结果 → 归一化形状。
 *
 * 这一层是「换 provider 不改变模型拿到的东西」的兑现处，所以每一种协议形态都得
 * 有一个用例：单个 Location、Location 数组、LocationLink 数组、四种 hover 内容。
 */
import { describe, expect, it } from 'vitest'
import { LspError, normalizeHover, normalizeLocations } from '../src/index.ts'

describe('结果归一化', () => {
  it('服务器回 null 时是空数组', () => {
    expect(normalizeLocations(null)).toEqual([])
    expect(normalizeLocations(undefined)).toEqual([])
  })

  it('单个 Location 也能读', () => {
    const locations = normalizeLocations({
      uri: 'file:///a.ts',
      range: { start: { line: 3, character: 7 }, end: { line: 3, character: 12 } },
    })

    expect(locations).toEqual([{ uri: 'file:///a.ts', line: 3, character: 7 }])
  })

  it('Location 数组逐个读', () => {
    const locations = normalizeLocations([
      { uri: 'file:///a.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } },
      { uri: 'file:///b.ts', range: { start: { line: 9, character: 2 }, end: { line: 9, character: 6 } } },
    ])

    expect(locations).toEqual([
      { uri: 'file:///a.ts', line: 1, character: 0 },
      { uri: 'file:///b.ts', line: 9, character: 2 },
    ])
  })

  it('LocationLink 用 targetUri 与 targetSelectionRange', () => {
    const locations = normalizeLocations([
      {
        targetUri: 'file:///linked.ts',
        targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        targetSelectionRange: { start: { line: 20, character: 5 }, end: { line: 20, character: 9 } },
      },
    ])

    expect(locations).toEqual([{ uri: 'file:///linked.ts', line: 20, character: 5 }])
  })

  it('位置缺 range 字段时报协议错误', () => {
    expect(() => normalizeLocations([{ uri: 'file:///a.ts' }])).toThrowError(LspError)
    expect(() => normalizeLocations([{ uri: 'file:///a.ts' }])).toThrowError(/range/)
  })

  it('位置缺 uri 字段时报协议错误', () => {
    expect(() =>
      normalizeLocations([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]),
    ).toThrowError(/uri/)
  })

  it('结果既不是对象也不是数组时报协议错误', () => {
    expect(() => normalizeLocations('不是位置')).toThrowError(LspError)
  })

  it('数组里有一条不是对象时报协议错误', () => {
    expect(() => normalizeLocations(['不是位置'])).toThrowError(/不是对象/)
  })

  it('位置里的行列不是数字时报协议错误', () => {
    expect(() =>
      normalizeLocations([
        { uri: 'file:///a.ts', range: { start: { line: '第三行', character: 0 }, end: { line: 0, character: 1 } } },
      ]),
    ).toThrowError(/range/)
  })

  it('range 不是对象时报协议错误', () => {
    expect(() => normalizeLocations([{ uri: 'file:///a.ts', range: '不是对象' }])).toThrowError(/range/)
  })

  it('range 缺 end 时报协议错误', () => {
    expect(() =>
      normalizeLocations([{ uri: 'file:///a.ts', range: { start: { line: 0, character: 0 } } }]),
    ).toThrowError(/range/)
  })

  it('hover 的 MarkupContent 取 value', () => {
    const hover = normalizeHover({ contents: { kind: 'markdown', value: '**说明**' } })

    expect(hover?.contents).toBe('**说明**')
  })

  it('hover 的 MarkedString 包成围栏代码块', () => {
    const hover = normalizeHover({ contents: { language: 'ts', value: 'const a = 1' } })

    expect(hover?.contents).toBe('```ts\nconst a = 1\n```')
  })

  it('hover 的字符串数组拼在一起', () => {
    const hover = normalizeHover({ contents: ['第一段', '第二段'] })

    expect(hover?.contents).toBe('第一段\n\n第二段')
  })

  it('hover 的范围一起带出来', () => {
    const hover = normalizeHover({
      contents: '说明',
      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } },
    })

    expect(hover?.range?.start).toEqual({ line: 2, character: 4 })
    expect(hover?.range?.end).toEqual({ line: 2, character: 10 })
  })

  it('服务器回 null 表示没有 hover', () => {
    expect(normalizeHover(null)).toBeUndefined()
    expect(normalizeHover(undefined)).toBeUndefined()
    expect(normalizeHover({ contents: '' })).toBeUndefined()
  })

  it('hover 结果不是对象时报协议错误', () => {
    expect(() => normalizeHover('一段话')).toThrowError(LspError)
  })

  it('hover 的内容不是我们认得的任何一种形态时，当作没有 hover', () => {
    expect(normalizeHover({ contents: 42 })).toBeUndefined()
    expect(normalizeHover({ contents: { kind: 'markdown' } })).toBeUndefined()
    expect(normalizeHover({ contents: [42, '真话'] })?.contents).toBe('真话')
  })
})
