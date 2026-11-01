/**
 * 可执行文件查找。
 *
 * 平台差异用「注入 platform」来测：同一个用例在 Windows 与 Linux 上跑出同样的
 * 断言，靠的是把平台当参数传进去，而不是靠 `if (win32)` 分叉两套期望。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveExecutable } from '../src/index.ts'
import { makeTempDir, writeFileIn, writePlainFile } from './helpers.ts'

describe('可执行文件查找', () => {
  it('候选目录里找到：给出完整路径，来源是 candidate', () => {
    const { dir, cleanup } = makeTempDir()
    try {
      writeFileIn(dir, 'mytool')
      const result = resolveExecutable({ name: 'mytool', candidates: [dir], env: { PATH: '' } })

      expect(result.found).toBe(true)
      if (!result.found) return
      expect(result.source).toBe('candidate')
      expect(result.path).toBe(join(dir, 'mytool'))
    } finally {
      cleanup()
    }
  })

  it('PATH 里找到：来源是 path', () => {
    const { dir, cleanup } = makeTempDir()
    try {
      writeFileIn(dir, 'frompath')
      const result = resolveExecutable({ name: 'frompath', env: { PATH: dir } })

      expect(result.found).toBe(true)
      if (!result.found) return
      expect(result.source).toBe('path')
      expect(result.path).toBe(join(dir, 'frompath'))
    } finally {
      cleanup()
    }
  })

  it('候选目录排在 PATH 前面：同名时取候选目录那个', () => {
    const first = makeTempDir()
    const second = makeTempDir()
    try {
      writeFileIn(first.dir, 'dup')
      writeFileIn(second.dir, 'dup')
      const result = resolveExecutable({ name: 'dup', candidates: [first.dir], env: { PATH: second.dir } })

      expect(result.found).toBe(true)
      if (!result.found) return
      expect(result.path).toBe(join(first.dir, 'dup'))
    } finally {
      first.cleanup()
      second.cleanup()
    }
  })

  it('找不到：给结构化原因，不抛异常', () => {
    const { dir, cleanup } = makeTempDir()
    try {
      const result = resolveExecutable({ name: 'ry-no-such-tool-xyz', candidates: [dir], env: { PATH: dir } })

      expect(result.found).toBe(false)
      if (result.found) return
      expect(result.reason).toBe('not-found')
      expect(result.message).toContain('ry-no-such-tool-xyz')
      expect(result.searched.length).toBeGreaterThan(0)
    } finally {
      cleanup()
    }
  })

  it('命令名是空的：原因是 invalid-name', () => {
    const result = resolveExecutable({ name: '   ' })

    expect(result.found).toBe(false)
    if (result.found) return
    expect(result.reason).toBe('invalid-name')
    expect(result.searched).toEqual([])
  })

  it('Windows 上认 .cmd / .bat / .ps1 这些扩展名', () => {
    const { dir, cleanup } = makeTempDir()
    try {
      writeFileIn(dir, 'tool.cmd')
      const result = resolveExecutable({ name: 'tool', candidates: [dir], env: {}, platform: 'win32' })

      expect(result.found).toBe(true)
      if (!result.found) return
      expect(result.path.endsWith('tool.cmd')).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('POSIX 上不认扩展名：只有同名文件才算命令', () => {
    const { dir, cleanup } = makeTempDir()
    try {
      writeFileIn(dir, 'tool.exe')
      const result = resolveExecutable({ name: 'tool', candidates: [dir], env: {}, platform: 'linux' })

      expect(result.found).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('Windows 上还认 PATHEXT 里的扩展名', () => {
    const { dir, cleanup } = makeTempDir()
    try {
      writeFileIn(dir, 'tool.RY')
      const result = resolveExecutable({
        name: 'tool',
        candidates: [dir],
        env: { PATHEXT: '.RY;.ZZ' },
        platform: 'win32',
      })

      expect(result.found).toBe(true)
      if (!result.found) return
      expect(result.path.endsWith('tool.RY')).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('Windows 上 PATH 写成 Path 也认', () => {
    const { dir, cleanup } = makeTempDir()
    try {
      writeFileIn(dir, 'pathtool')
      const result = resolveExecutable({ name: 'pathtool', env: { Path: dir }, platform: 'win32' })

      expect(result.found).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('直接给了绝对路径：来源是 direct', () => {
    const result = resolveExecutable({ name: process.execPath, env: {} })

    expect(result.found).toBe(true)
    if (!result.found) return
    expect(result.source).toBe('direct')
  })

  it('直接给了路径但文件不存在：找不到，原因仍是 not-found', () => {
    const result = resolveExecutable({ name: join(process.cwd(), 'ry-subprocess-not-a-real-dir'), env: {} })

    expect(result.found).toBe(false)
    if (result.found) return
    expect(result.reason).toBe('not-found')
    expect(result.searched).toHaveLength(1)
  })

  // 执行位这件事只在 POSIX 上存在：Windows 的 X_OK 实际上等于「文件在就行」，
  // 所以这条只能在 POSIX 上断言。
  it.skipIf(process.platform === 'win32')('没有执行位的文件不算命令（POSIX 专有）', () => {
    const { dir, cleanup } = makeTempDir()
    try {
      writePlainFile(dir, 'plain')
      const result = resolveExecutable({ name: 'plain', candidates: [dir], env: {}, platform: 'linux' })

      expect(result.found).toBe(false)
    } finally {
      cleanup()
    }
  })
})
