/**
 * glob 匹配与工作区遍历。
 *
 * 口径写在源码注释里，这里按它钉住：`**` 跨目录且能匹配零层、`*` 不跨 `/`、
 * `{a,b}` 是或、`[abc]` 是字符类、模式开头的 `!` 是排除。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globMatcher, globToRegExp, normalizeGlob, walkFiles } from '@ryharness/tools'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-glob-'))
  tmpDirs.push(dir)
  return dir
}

function write(root: string, relativePath: string, content = 'x'): void {
  const target = join(root, relativePath)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

describe('globToRegExp', () => {
  it('* 不跨目录分隔符', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true)
    expect(globToRegExp('*.ts').test('src/a.ts')).toBe(false)
  })

  it('** 跨目录，且能匹配零层', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts').test('src/x/y/a.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts').test('other/a.ts')).toBe(false)
  })

  it('{a,b} 是或，分支里也可以带通配', () => {
    expect(globToRegExp('*.{ts,tsx}').test('a.ts')).toBe(true)
    expect(globToRegExp('*.{ts,tsx}').test('a.tsx')).toBe(true)
    expect(globToRegExp('*.{ts,tsx}').test('a.js')).toBe(false)
  })

  it('[abc] 与 [a-z] 是字符类，! 取反', () => {
    expect(globToRegExp('file[0-9].txt').test('file7.txt')).toBe(true)
    expect(globToRegExp('file[0-9].txt').test('filex.txt')).toBe(false)
    expect(globToRegExp('file[!0-9].txt').test('filex.txt')).toBe(true)
  })

  it('? 匹配一个非分隔符字符', () => {
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true)
    expect(globToRegExp('a?.ts').test('a.ts')).toBe(false)
  })

  it('其余字符按字面量处理（正则元字符不被当通配）', () => {
    expect(globToRegExp('a.b').test('a.b')).toBe(true)
    expect(globToRegExp('a.b').test('axb')).toBe(false)
  })

  it('归一：反斜杠换正斜杠、去掉开头的 ./', () => {
    expect(normalizeGlob('src\\**\\a.ts')).toBe('src/**/a.ts')
    expect(normalizeGlob('./src/a.ts')).toBe('src/a.ts')
  })
})

describe('globMatcher', () => {
  it('包含项筛、排除项剔', () => {
    const match = globMatcher(['**/*.ts', '!vendor/**'])
    expect(match('src/a.ts')).toBe(true)
    expect(match('vendor/a.ts')).toBe(false)
    expect(match('src/a.js')).toBe(false)
  })

  it('只有排除项时，默认全通过再剔掉排除的', () => {
    const match = globMatcher(['!node_modules/**'])
    expect(match('src/a.ts')).toBe(true)
    expect(match('node_modules/x/a.ts')).toBe(false)
  })
})

describe('walkFiles', () => {
  it('按相对路径返回文件，跳过版本库/依赖/产物目录', () => {
    const root = workspace()
    write(root, 'src/a.ts')
    write(root, 'src/deep/b.ts')
    write(root, 'node_modules/pkg/c.ts')
    write(root, '.git/config')
    write(root, '.ryharness-artifacts/out.md')
    const found = walkFiles(root).map((file) => {
      return file.relativePath
    })
    expect(found).toContain('src/a.ts')
    expect(found).toContain('src/deep/b.ts')
    expect(
      found.some((path) => {
        return path.startsWith('node_modules/')
      }),
    ).toBe(false)
    expect(
      found.some((path) => {
        return path.startsWith('.git/')
      }),
    ).toBe(false)
    expect(
      found.some((path) => {
        return path.startsWith('.ryharness-artifacts/')
      }),
    ).toBe(false)
  })

  it('filter 决定要哪些文件，limit 截断', () => {
    const root = workspace()
    write(root, 'a.ts')
    write(root, 'b.txt')
    const onlyTs = walkFiles(root, { filter: globMatcher(['**/*.ts']) }).map((file) => {
      return file.relativePath
    })
    expect(onlyTs).toEqual(['a.ts'])
    const limited = walkFiles(root, { limit: 1 })
    expect(limited).toHaveLength(1)
  })

  it('相对路径用正斜杠（跨平台一致）', () => {
    const root = workspace()
    write(root, 'src/deep/b.ts')
    const found = walkFiles(root)
    expect(found[0]?.relativePath).toBe('src/deep/b.ts')
  })
})
