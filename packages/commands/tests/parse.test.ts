/**
 * 命令行解析的用例。
 *
 * 这里最要紧的是「什么时候**不**算命令」：把普通消息当命令跑，是这类功能
 * 最严重的事故——所以否定用例比肯定用例多。
 */
import { describe, expect, it } from 'vitest'
import { isCommandName, parseCommandLine } from '../src/index.ts'

describe('命令行解析', () => {
  it('斜杠 + 名字 + 参数', () => {
    const parsed = parseCommandLine('/goal 继续')

    expect(parsed?.name).toBe('goal')
    expect(parsed?.input).toBe('继续')
  })

  it('没有参数的命令：参数是空串', () => {
    const parsed = parseCommandLine('/goal')

    expect(parsed?.name).toBe('goal')
    expect(parsed?.input).toBe('')
  })

  it('参数里的空格原样保留', () => {
    const parsed = parseCommandLine('/goal 继续 看看')

    expect(parsed?.input).toBe('继续 看看')
  })

  it('raw 保留名字后面的分隔空白', () => {
    const parsed = parseCommandLine('/goal   继续')

    expect(parsed?.raw).toBe('   继续')
    expect(parsed?.input).toBe('继续')
  })

  it('普通消息不是命令', () => {
    expect(parseCommandLine('今天天气不错')).toBeUndefined()
    expect(parseCommandLine('')).toBeUndefined()
  })

  it('斜杠必须在第一个字节：前面有空格就不是命令', () => {
    expect(parseCommandLine(' /goal')).toBeUndefined()
  })

  it('只有一个斜杠、或者斜杠后面没名字，都不是命令', () => {
    expect(parseCommandLine('/')).toBeUndefined()
    expect(parseCommandLine('//goal')).toBeUndefined()
    expect(parseCommandLine('/ 继续')).toBeUndefined()
  })

  it('名字后面直接跟非空白字符：不是命令', () => {
    expect(parseCommandLine('/goal?x')).toBeUndefined()
    expect(parseCommandLine('/goal:继续')).toBeUndefined()
  })

  it('名字里的连字符与下划线都认', () => {
    expect(parseCommandLine('/my-cmd_2 x')?.name).toBe('my-cmd_2')
  })

  it('大写的名字会被转成小写', () => {
    expect(parseCommandLine('/Goal')?.name).toBe('goal')
  })

  it('isCommandName 只认小写', () => {
    expect(isCommandName('goal')).toBe(true)
    expect(isCommandName('my-cmd_2')).toBe(true)
    expect(isCommandName('Goal')).toBe(false)
    expect(isCommandName('-goal')).toBe(false)
    expect(isCommandName('')).toBe(false)
  })
})
