import { describe, expect, it } from 'vitest'
import { parseMentions } from '../renderer/src/lib/mention-text.ts'

const targets = [
  { id: 'ryen', name: 'Ryen' },
  { id: 'eng', name: '工程师' },
  { id: 'code', name: 'Code' },
  { id: 'codebot', name: 'CodeBot' },
]

describe('parseMentions', () => {
  it('认出名单里的 @某人，前后文字照旧', () => {
    expect(parseMentions('请 @工程师 看一下', targets)).toEqual([
      { kind: 'text', text: '请 ' },
      { kind: 'mention', text: '@工程师', target: { id: 'eng', name: '工程师' } },
      { kind: 'text', text: ' 看一下' },
    ])
  })

  it('中文名没有词边界：后面的句子不算进名字', () => {
    expect(parseMentions('@工程师帮我看看', targets)).toEqual([
      { kind: 'mention', text: '@工程师', target: { id: 'eng', name: '工程师' } },
      { kind: 'text', text: '帮我看看' },
    ])
  })

  it('中文名后面跟标点也算结束', () => {
    const segments = parseMentions('@工程师，动手', targets)
    expect(segments[0]).toEqual({ kind: 'mention', text: '@工程师', target: { id: 'eng', name: '工程师' } })
    expect(segments[1]).toEqual({ kind: 'text', text: '，动手' })
  })

  it('拉丁名按词边界断：@CodeBotx 不是 @CodeBot', () => {
    expect(parseMentions('@CodeBotx', targets)).toEqual([{ kind: 'text', text: '@CodeBotx' }])
  })

  it('长名优先：@CodeBot 不会被截成 @Code', () => {
    expect(parseMentions('@CodeBot', targets)).toEqual([
      { kind: 'mention', text: '@CodeBot', target: { id: 'codebot', name: 'CodeBot' } },
    ])
  })

  it('@Code 命中短的那个（CodeBot 并不是它的前缀）', () => {
    expect(parseMentions('@Code', targets)).toEqual([
      { kind: 'mention', text: '@Code', target: { id: 'code', name: 'Code' } },
    ])
  })

  it('邮箱里的 @ 不算提及', () => {
    const withExample = [...targets, { id: 'ex', name: 'example' }]
    expect(parseMentions('写信到 foo@example.com 就行', withExample)).toEqual([
      { kind: 'text', text: '写信到 foo@example.com 就行' },
    ])
  })

  it('名单里没有的名字仍是普通文字', () => {
    expect(parseMentions('@陌生人 你好', targets)).toEqual([{ kind: 'text', text: '@陌生人 你好' }])
  })

  it('一条正文里认得出多个提及', () => {
    expect(parseMentions('@Ryen 和 @CodeBot 都来', targets)).toEqual([
      { kind: 'mention', text: '@Ryen', target: { id: 'ryen', name: 'Ryen' } },
      { kind: 'text', text: ' 和 ' },
      { kind: 'mention', text: '@CodeBot', target: { id: 'codebot', name: 'CodeBot' } },
      { kind: 'text', text: ' 都来' },
    ])
  })

  it('空正文返回空片段；没有名单时原样返回', () => {
    expect(parseMentions('', targets)).toEqual([])
    expect(parseMentions('@Ryen', [])).toEqual([{ kind: 'text', text: '@Ryen' }])
  })
})
