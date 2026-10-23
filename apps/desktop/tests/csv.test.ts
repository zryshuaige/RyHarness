/**
 * CSV 解析：引号、逗号、换行、参差行。
 *
 * 这几处是 CSV 的全部麻烦所在——按逗号硬切会把"名称,备注"这种值切成两半，按行硬切
 * 会把引号里的换行切成两行。表格预览全靠它。
 */
import { describe, expect, it } from 'vitest'
import { alignCsv, parseCsv } from '../renderer/src/lib/csv.ts'

describe('CSV 解析', () => {
  it('按行按列切开', () => {
    expect(parseCsv('项目,金额\n房租,1200')).toEqual([
      ['项目', '金额'],
      ['房租', '1200'],
    ])
  })

  it('引号里的逗号不算分隔符', () => {
    expect(parseCsv('名称,备注\n"记账, 理财",每月')).toEqual([
      ['名称', '备注'],
      ['记账, 理财', '每月'],
    ])
  })

  it('两个引号表示一个引号', () => {
    expect(parseCsv('他说"好"')).toEqual([['他说"好"']])
  })

  it('引号里的换行不结束这一行', () => {
    expect(parseCsv('事项,说明\n第一件,"第一行\n第二行"')).toEqual([
      ['事项', '说明'],
      ['第一件', '第一行\n第二行'],
    ])
  })

  it('空文本给空表：没有行，不给一行空格子', () => {
    expect(parseCsv('')).toEqual([])
  })

  it('Windows 的换行（\\r\\n）也认', () => {
    expect(parseCsv('a,b\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('最后一行没有换行也不丢', () => {
    expect(parseCsv('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('参差的行补齐成一样宽', () => {
    const aligned = alignCsv([['a', 'b', 'c'], ['d']])
    expect(aligned).toEqual([
      ['a', 'b', 'c'],
      ['d', '', ''],
    ])
  })
})
