/**
 * 远端路径的归一化与「关在根目录里」。
 *
 * 这些是纯函数，所以断言可以直接对着值写，不需要任何替身。
 */
import { describe, expect, it } from 'vitest'
import { isInsideRoot, isSshError, normalizeRemotePath, resolveRemotePath, SshError } from '../src/index.ts'

describe('远端路径归一化', () => {
  it('消掉 . 与空段', () => {
    expect(normalizeRemotePath('/srv/work/./a//b')).toBe('/srv/work/a/b')
  })

  it('.. 只往上收一段，不会跳到根', () => {
    expect(normalizeRemotePath('/srv/work/../etc')).toBe('/srv/etc')
  })

  it('绝对路径在根之上没有东西', () => {
    expect(normalizeRemotePath('/..')).toBe('/')
    expect(normalizeRemotePath('/a/../..')).toBe('/')
  })

  it('相对路径保留开头的 ..', () => {
    expect(normalizeRemotePath('../../etc/passwd')).toBe('../../etc/passwd')
  })

  it('反斜杠是普通字符（远端是 POSIX）', () => {
    expect(normalizeRemotePath('/srv/work/a\\b')).toBe('/srv/work/a\\b')
  })

  it('空路径不合法', () => {
    expect(() => normalizeRemotePath('')).toThrow(SshError)
  })
})

describe('根目录判定', () => {
  it('同一个目录与它的子目录都在里面', () => {
    expect(isInsideRoot('/srv/work', '/srv/work')).toBe(true)
    expect(isInsideRoot('/srv/work', '/srv/work/a/b')).toBe(true)
  })

  it('前缀相同但不是同一个目录的，不算在里面', () => {
    expect(isInsideRoot('/srv/work', '/srv/workspace')).toBe(false)
  })

  it('根本身关不住任何东西', () => {
    expect(isInsideRoot('/', '/etc/passwd')).toBe(true)
  })
})

describe('路径解析与越界', () => {
  it('相对路径按根目录解析', () => {
    expect(resolveRemotePath('/srv/work', 'notes/a.txt')).toBe('/srv/work/notes/a.txt')
  })

  it('绝对路径原样使用（在里面时）', () => {
    expect(resolveRemotePath('/srv/work', '/srv/work/a.txt')).toBe('/srv/work/a.txt')
  })

  it('.. 跑出去 → PATH_OUTSIDE_ROOT', () => {
    let caught: unknown
    try {
      resolveRemotePath('/srv/work', '../etc/passwd')
    } catch (error) {
      caught = error
    }
    expect(isSshError(caught, 'PATH_OUTSIDE_ROOT')).toBe(true)
  })

  it('绝对路径指向别处 → PATH_OUTSIDE_ROOT', () => {
    expect(() => resolveRemotePath('/srv/work', '/etc/shadow')).toThrow(SshError)
  })

  it('没给根目录就没有围栏，只做归一化', () => {
    expect(resolveRemotePath(undefined, 'a/../b.txt')).toBe('b.txt')
  })

  it('根目录不是绝对路径 → INVALID_ARGUMENT', () => {
    expect(() => resolveRemotePath('relative/root', 'a.txt')).toThrow(SshError)
  })
})
