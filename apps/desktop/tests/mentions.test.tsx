import { describe, expect, it } from 'vitest'
import { filterMentions, mentionQueryAt } from '../renderer/src/store.ts'

describe('mentionQueryAt', () => {
  it('光标在 @词 中间时返回查询与起点', () => {
    expect(mentionQueryAt('请 @Code 看下', 7)).toEqual({ start: 2, query: 'Code' })
    expect(mentionQueryAt('@R', 2)).toEqual({ start: 0, query: 'R' })
  })

  it('@ 后有空格时返回 null；第二个 @ 开启新查询', () => {
    expect(mentionQueryAt('你好', 2)).toBeNull()
    expect(mentionQueryAt('hi @ code', 6)).toBeNull()
    expect(mentionQueryAt('@A @B', 5)).toEqual({ start: 3, query: 'B' })
    expect(mentionQueryAt('', 0)).toBeNull()
  })
})

describe('filterMentions', () => {
  const members = [
    { id: '1', name: 'Ryen' },
    { id: '2', name: 'CodeBot' },
    { id: '3', name: 'Reviewer' },
  ]

  it('大小写不敏感的包含匹配', () => {
    expect(filterMentions(members, 'code').map((m) => { return m.id })).toEqual(['2'])
    expect(filterMentions(members, 'r').map((m) => { return m.id })).toEqual(['1', '3'])
    expect(filterMentions(members, '')).toHaveLength(3)
    expect(filterMentions(members, 'zzz')).toHaveLength(0)
  })
})
