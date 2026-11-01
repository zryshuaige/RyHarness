/**
 * 失败原因这一层：机器可读的 code 与一句中文原因。
 *
 * 还有起进程的那点讲究（Windows 上 `.cmd` 不能直接 spawn）。
 */
import { describe, expect, it } from 'vitest'
import { describeLspFailure, LspError, planSpawn } from '../src/index.ts'

describe('结构化失败', () => {
  it('LspError 带 code 与中文原因', () => {
    const error = new LspError('timeout', '语言服务器在 100ms 内没有响应')

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('LspError')
    expect(error.code).toBe('timeout')
    expect(error.message).toBe('语言服务器在 100ms 内没有响应')
  })

  it('details 可以带上原始上下文', () => {
    const error = new LspError('protocol-error', '帧解析失败', { raw: 'xxx' })

    expect(error.details).toEqual({ raw: 'xxx' })
  })

  it('describeLspFailure 把各种抛出来的东西翻成一句话', () => {
    expect(describeLspFailure(new LspError('timeout', '超时了'))).toBe('超时了')
    expect(describeLspFailure(new Error('普通异常'))).toBe('普通异常')
    expect(describeLspFailure('一段字符串')).toBe('一段字符串')
    expect(describeLspFailure(undefined)).toBe('undefined')
  })
})

describe('起子进程的命令', () => {
  it('POSIX 上直接起命令', () => {
    const plan = planSpawn('typescript-language-server', ['--stdio'], 'linux')

    expect(plan.command).toBe('typescript-language-server')
    expect(plan.args).toEqual(['--stdio'])
  })

  it('Windows 上 .cmd 要包一层 cmd.exe', () => {
    const plan = planSpawn('typescript-language-server.cmd', ['--stdio'], 'win32')

    expect(plan.command).toBe('cmd.exe')
    expect(plan.args[0]).toBe('/d')
    expect(plan.args[1]).toBe('/s')
    expect(plan.args[2]).toBe('/c')
    expect(plan.args[3]).toContain('typescript-language-server.cmd')
    expect(plan.args[3]).toContain('--stdio')
  })

  it('Windows 上 .exe 不用包', () => {
    const plan = planSpawn('gopls.exe', [], 'win32')

    expect(plan.command).toBe('gopls.exe')
    expect(plan.args).toEqual([])
  })

  it('带空格的参数会被加引号', () => {
    const plan = planSpawn('my server.cmd', ['--root', 'C:\\Program Files\\x'], 'win32')

    expect(plan.args[3]).toContain('"my server.cmd"')
    expect(plan.args[3]).toContain('"C:\\Program Files\\x"')
  })
})
