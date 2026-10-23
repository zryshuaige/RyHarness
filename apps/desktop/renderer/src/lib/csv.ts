/**
 * CSV 解析：把一张表读成行与列。
 *
 * 为什么自己写：表形态的产物（`.csv`）要能**直接看见表格**，而不是一坨逗号分隔的
 * 原文——后者在预览区里和「把文件原样打印出来」没有区别，用户还得自己数逗号。
 *
 * 按 RFC 4180 处理那几处必须处理对的地方：
 * - 引号里的逗号不算分隔符（`名称,备注` vs `"名称,备注"`）；
 * - 字段里可以带换行（引号内的换行不结束这一行）；
 * - 两个引号表示一个引号（`"他说""好"` → `他说"好`）。
 *
 * 解析不了不报错：宁可表格歪一点，也不要给用户一句「这个文件读不出来」——文件本身
 * 是好的，只是我们没能把它摆整齐。
 */

/** 一张表：行 → 列。 */
export type CsvTable = string[][]

/**
 * 读一张 CSV。
 *
 * @param text - 文件正文。
 * @returns 行与列；空文本返回空数组。
 */
export function parseCsv(text: string): CsvTable {
  const rows: CsvTable = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let started = false

  const endField = (): void => {
    row.push(field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    rows.push(row)
    row = []
    started = false
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string
    if (inQuotes) {
      if (char === '"') {
        // 两个引号 = 一个引号；单个引号 = 字段结束。
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
          continue
        }
        inQuotes = false
        continue
      }
      field += char
      continue
    }
    if (char === '"' && field.trim().length === 0) {
      // 只有字段开头（前面没有内容）时的引号才当引用开始：正文里的引号按普通字符算。
      inQuotes = true
      started = true
      field = ''
      continue
    }
    if (char === ',') {
      endField()
      started = true
      continue
    }
    if (char === '\r') {
      continue
    }
    if (char === '\n') {
      endRow()
      continue
    }
    field += char
    started = true
  }
  if (started || field.length > 0 || row.length > 0) {
    endRow()
  }
  return rows
}

/**
 * 把一张表摆正：每行补到最宽的那行，缺的地方补空串。
 *
 * 不补的话，表格渲染出来会缺格子——短行在 HTML 表格里会自动补空单元格，但自己画
 * 的时候得知道每行有几列。
 */
export function alignCsv(rows: CsvTable): CsvTable {
  const width = rows.reduce((max, row) => {
    return Math.max(max, row.length)
  }, 0)
  return rows.map((row) => {
    if (row.length === width) return row
    return [...row, ...new Array<string>(width - row.length).fill('')]
  })
}
