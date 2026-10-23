/**
 * CSV 表格预览：把一张表摆成格子。
 *
 * 表格不是装饰：用户在 RyVibe 里要一份表、在聊天里拿到一个 CSV，看的都是"哪一行是
 * 哪一格"。用 `<pre>` 打出来是一屏逗号，用户得自己数列——那不是预览，是把文件原样
 * 倒出来。
 *
 * 行的上限是给界面留的：一张几千行的表全画出来，页面会卡住。截断时明说截了多少，
 * 不让用户以为那就是全部。
 */

import { alignCsv, parseCsv } from '../lib/csv.ts'

/** 最多画多少行（不含表头）。 */
export const MAX_CSV_PREVIEW_ROWS = 200

/** 表格预览。 */
export function CsvTable({ content }: { content: string }) {
  const rows = alignCsv(parseCsv(content))
  if (rows.length === 0) {
    return <p className="artifact-note">这个文件是空的。</p>
  }
  const [head, ...body] = rows
  const truncated = body.length > MAX_CSV_PREVIEW_ROWS
  const shown = truncated ? body.slice(0, MAX_CSV_PREVIEW_ROWS) : body
  return (
    <div className="artifact-table-wrap">
      <table className="artifact-table">
        <thead>
          <tr>
            {(head ?? []).map((cell, index) => {
              return <th key={index}>{cell}</th>
            })}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, rowIndex) => {
            return (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => {
                  return <td key={cellIndex}>{cell}</td>
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      {truncated && <p className="artifact-note">只画了前 {MAX_CSV_PREVIEW_ROWS} 行，完整的在文件里。</p>}
    </div>
  )
}
