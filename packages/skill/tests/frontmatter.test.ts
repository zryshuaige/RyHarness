/**
 * frontmatter 解析的用例。
 *
 * 技能文件的开头是一段 yaml 头，解析错了整个技能就进不了目录——所以这里盯的是
 * 「哪种写法要能认出来」与「哪种写法要老实当没有」，不是「跑通就行」。
 */
import { describe, expect, it } from 'vitest'
import { describeSkillFailure, frontmatterList, frontmatterText, parseFrontmatter } from '../src/index.ts'

describe('frontmatter 解析', () => {
  it('没有 frontmatter：整篇都是正文', () => {
    const parsed = parseFrontmatter('# 标题\n\n正文')

    expect(parsed.hasFrontmatter).toBe(false)
    expect(parsed.body).toBe('# 标题\n\n正文')
    expect(Object.keys(parsed.fields)).toEqual([])
  })

  it('拆开 name 与 description，正文是剩下的部分', () => {
    const parsed = parseFrontmatter('---\nname: my-skill\ndescription: 一句话说明\n---\n# 正文\n第二行')

    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.fields.name).toBe('my-skill')
    expect(parsed.fields.description).toBe('一句话说明')
    expect(parsed.body).toBe('# 正文\n第二行')
  })

  it('成对的引号会被去掉', () => {
    const parsed = parseFrontmatter('---\nname: "quoted"\ndescription: \'single\'\n---\n正文')

    expect(parsed.fields.name).toBe('quoted')
    expect(parsed.fields.description).toBe('single')
  })

  it('true/false 与数字会转成对应类型', () => {
    const parsed = parseFrontmatter('---\nflag: true\ncount: 3\nratio: 1.5\n---\n正文')

    expect(parsed.fields.flag).toBe(true)
    expect(parsed.fields.count).toBe(3)
    expect(parsed.fields.ratio).toBe(1.5)
  })

  it('行内列表会被拆开', () => {
    const parsed = parseFrontmatter('---\nname: a\ntags: ["写作", 校对]\n---\n正文')

    expect(parsed.fields.tags).toEqual(['写作', '校对'])
  })

  it('缩进的块列表会被收下', () => {
    const parsed = parseFrontmatter('---\nname: a\ntags:\n  - 写作\n  - 校对\n---\n正文')

    expect(parsed.fields.tags).toEqual(['写作', '校对'])
  })

  it('块文本：竖杠保留换行，大于号折成空格', () => {
    const parsed = parseFrontmatter(
      '---\nname: a\nbody: |\n  第一行\n  第二行\nfolded: >\n  折起来\n  的一行\n---\n正文',
    )

    expect(parsed.fields.body).toBe('第一行\n第二行')
    expect(parsed.fields.folded).toBe('折起来 的一行')
  })

  it('注释行被跳过，键写坏的那行也跳过', () => {
    const parsed = parseFrontmatter('---\n# 这是注释\nname: a\n这不是键值对\n---\n正文')

    expect(parsed.fields.name).toBe('a')
    expect(Object.keys(parsed.fields)).toEqual(['name'])
  })

  it('frontmatter 没闭合：整篇当正文', () => {
    const parsed = parseFrontmatter('---\nname: a\ndescription: b\n')

    expect(parsed.hasFrontmatter).toBe(false)
    expect(parsed.body).toBe('---\nname: a\ndescription: b\n')
  })

  it('取字段：不是对应类型就返回 undefined', () => {
    const fields = parseFrontmatter('---\nname: a\ntags:\n  - x\ncount: 2\n---\n正文').fields

    expect(frontmatterText(fields, 'name')).toBe('a')
    expect(frontmatterText(fields, 'tags')).toBeUndefined()
    expect(frontmatterText(fields, 'missing')).toBeUndefined()
    expect(frontmatterList(fields, 'tags')).toEqual(['x'])
    expect(frontmatterList(fields, 'count')).toBeUndefined()
  })

  it('行尾风格原样保留', () => {
    const parsed = parseFrontmatter('---\r\nname: a\r\n---\r\n第一行\r\n第二行')

    expect(parsed.body).toBe('第一行\r\n第二行')
  })

  it('键后面没写值、后面也没有列表：算空串', () => {
    const parsed = parseFrontmatter('---\nname: a\nempty:\n---\n正文')

    expect(parsed.fields.empty).toBe('')
  })

  it('块文本里的空行会保留', () => {
    const parsed = parseFrontmatter('---\nname: a\nbody: |\n  第一段\n\n  第二段\n---\n正文')

    expect(parsed.fields.body).toBe('第一段\n\n第二段')
  })
})

describe('失败说明', () => {
  it('异常、字符串、其它东西都能翻成一句话', () => {
    expect(describeSkillFailure(new Error('炸了'))).toBe('炸了')
    expect(describeSkillFailure('直接给的话')).toBe('直接给的话')
    expect(describeSkillFailure(42)).toBe('42')
  })
})
