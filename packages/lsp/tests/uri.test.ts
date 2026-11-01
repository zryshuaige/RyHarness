/**
 * 路径与 URI 的互转，以及扩展名归一。
 *
 * 这里的错会一路传到服务器那儿，而服务器的回包是「没有定义」——一个看起来完全
 * 正常、其实完全错误的结果。所以这几个转换值得单独钉住。
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileExtension, pathToUri, uriToPath } from '../src/index.ts'

describe('路径与 URI', () => {
  it('扩展名带点、转小写', () => {
    expect(fileExtension('src/app.ts')).toBe('.ts')
    expect(fileExtension('src/App.TSX')).toBe('.tsx')
    expect(fileExtension('src/Makefile')).toBe('')
    expect(fileExtension('.gitignore')).toBe('')
  })

  it('路径转成 file:// URI：没有反斜杠，带盘符', () => {
    const uri = pathToUri(path.resolve('src', 'app.ts'))

    expect(uri.startsWith('file:///')).toBe(true)
    expect(uri).not.toContain('\\')
    expect(uri.endsWith('/src/app.ts')).toBe(true)
  })

  it('路径里的空格会被转义', () => {
    const uri = pathToUri(path.resolve('my dir', 'a b.ts'))

    expect(uri).toContain('%20')
    expect(uri).not.toContain(' ')
  })

  it('URI 转回路径能对上', () => {
    const absolute = path.resolve('src', 'app.ts')

    expect(uriToPath(pathToUri(absolute))).toBe(absolute)
  })

  it('不是文件 URI 时返回 undefined，不抛异常', () => {
    expect(uriToPath('untitled:Untitled-1')).toBeUndefined()
    expect(uriToPath('这不是一个 URI')).toBeUndefined()
  })
})
