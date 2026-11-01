/**
 * 远端命令的拼装与解析：引号化、base64 管道、目录列表。
 */
import { describe, expect, it } from 'vitest'
import {
  buildListCommand,
  buildReadCommand,
  buildWriteCommand,
  decodeBase64Payload,
  parseListOutput,
  shellQuote,
} from '../src/index.ts'

describe('shell 引号化', () => {
  it('普通路径被单引号包住', () => {
    expect(shellQuote('/srv/work/a b.txt')).toBe("'/srv/work/a b.txt'")
  })

  it('路径里的单引号按 POSIX 写法转义', () => {
    expect(shellQuote("/srv/it's")).toBe("'/srv/it'\\''s'")
  })

  it('分号与反引号不会逃出引号', () => {
    expect(shellQuote('a; rm -rf /')).toBe("'a; rm -rf /'")
    expect(shellQuote('a`id`b')).toBe("'a`id`b'")
  })
})

describe('文件传输命令', () => {
  it('读：base64 从文件读进管道', () => {
    expect(buildReadCommand('/srv/work/a.txt')).toBe("base64 < '/srv/work/a.txt'")
  })

  it('写：base64 解码后重定向到文件', () => {
    expect(buildWriteCommand('/srv/work/a.txt')).toBe("base64 -d > '/srv/work/a.txt'")
  })

  it('写：可以指定解码开关（macOS 用 -D）', () => {
    expect(buildWriteCommand('/srv/work/a.txt', undefined, '-D')).toBe("base64 -D > '/srv/work/a.txt'")
  })

  it('写：给了权限就连着 chmod 一起做', () => {
    expect(buildWriteCommand('/srv/work/a.txt', 0o600)).toBe(
      "base64 -d > '/srv/work/a.txt' && chmod 600 '/srv/work/a.txt'",
    )
  })
})

describe('列目录命令', () => {
  it('先切目录，切不过去用退出码 66', () => {
    expect(buildListCommand('/srv/work')).toContain("cd '/srv/work' || exit 66")
  })

  it('用的都是 POSIX shell 的内置能力', () => {
    const command = buildListCommand('/srv/work')
    expect(command).toContain('[ -L "$f" ]')
    expect(command).toContain("printf '%s\\t%s\\t%s\\n'")
    // 这些是各家不一样的选项，不能用。
    expect(command).not.toContain('find ')
    expect(command).not.toContain('ls -')
  })
})

describe('目录列表解析', () => {
  it('认得类型与大小', () => {
    const entries = parseListOutput('f\t1024\ta.txt\nd\t-\tsub\nl\t-\tlink\n', '/srv/work')
    expect(entries).toHaveLength(3)
    expect(entries[0]).toEqual({ name: 'a.txt', path: '/srv/work/a.txt', kind: 'file', size: 1024 })
    expect(entries[1]).toEqual({ name: 'sub', path: '/srv/work/sub', kind: 'directory' })
    expect(entries[2]).toEqual({ name: 'link', path: '/srv/work/link', kind: 'symlink' })
  })

  it('空输出就是空目录', () => {
    expect(parseListOutput('', '/srv/work')).toEqual([])
  })

  it('看不懂的行被跳过，不当成条目', () => {
    expect(parseListOutput('乱码\nf\t1\ta\n', '/srv/work')).toHaveLength(1)
  })

  it('名字是空的行被跳过', () => {
    expect(parseListOutput('f\t1\t\n', '/srv/work')).toHaveLength(0)
  })
})

describe('base64 解码', () => {
  it('远端换行不影响解码', () => {
    const encoded = Buffer.from('hello 世界', 'utf8').toString('base64')
    const wrapped = `${encoded.slice(0, 4)}\n${encoded.slice(4)}\n`
    const decoded = decodeBase64Payload(wrapped)
    expect(new TextDecoder().decode(decoded)).toBe('hello 世界')
  })

  it('空内容解出空字节', () => {
    expect(decodeBase64Payload('   \n ')).toHaveLength(0)
  })

  it('不合法的内容直接报错', () => {
    expect(() => decodeBase64Payload('***')).toThrow()
  })
})
