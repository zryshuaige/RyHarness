/**
 * styles-content.css 的验收网：把与 styles.css 相同的几条样式约定钉住。
 * 跑在 node 环境（要读文件），所以和 jsdom 的渲染测试分开。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../renderer/src/', import.meta.url)

/** 去注释后的样式源码：注释里提到的 token / 选择器不算数。 */
const strip = (css: string): string => {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}
const sheet = (name: string): string => {
  return strip(readFileSync(new URL(name, SRC), 'utf8'))
}
const content = sheet('styles-content.css')
const base = sheet('styles.css')

/** 顶层 class 选择器集合（.md-code、.attach-zone…）。 */
function classesOf(css: string): Set<string> {
  const found = new Set<string>()
  for (const match of css.matchAll(/(?:^|[};])\s*(\.[a-zA-Z][\w-]*)/g)) found.add(match[1] as string)
  return found
}

describe('内容渲染扩展层', () => {
  it('不重画 styles.css 的既有选择器（一个组件的边缘只定义一次）', () => {
    const overlap = [...classesOf(content)].filter((name) => classesOf(base).has(name))
    expect(overlap).toEqual([])
  })

  it('只长 md- / attach- 前缀的类', () => {
    const foreign = [...classesOf(content)].filter((name) => !/^\.(md|attach)-/.test(name))
    expect(foreign).toEqual([])
  })

  it('token 是唯一真源：无就地兜底、无裸 z-index、无 px line-height', () => {
    expect(content.match(/var\(\s*--[a-z0-9-]+\s*,/g)).toBeNull()
    expect(content.match(/z-index:\s*\d/)).toBeNull()
    expect(content.match(/line-height:\s*[\d.]+px/)).toBeNull()
  })

  it('引用到的 token 都在样式里定义过', () => {
    const defined = new Set<string>()
    for (const m of base.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1] as string)
    for (const m of content.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1] as string)
    for (const m of content.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
      expect(defined.has(m[1] as string), `未定义 ${m[1]}`).toBe(true)
    }
  })
})
