/**
 * RyVibe 产物预览：按文件类型给不同的看法。
 *
 * 此前除了 HTML 页面，其余一律用 `<pre>` 把原文打出来——于是 README、方案、任务清单
 * 这些**本来就是给人读的 Markdown** 在预览区里显示成带 `#` 和 `-` 的源码。那不是
 * 预览，是把文件原样倒出来：用户看到的是"这些字符"，不是"这份文档"。
 *
 * 四种看法：
 * - `.html` → 页面本身（脚本一律不跑，sandbox 空值）；
 * - `.md` → 渲染成文档（就是聊天里那套 Markdown 渲染）；
 * - `.csv` → 表格（表形态的产物，用户要看的就是表）；
 * - 其它 → 原文（源码、配置、日志就该看原文）。
 */

import { CsvTable } from './CsvTable.tsx'
import { Markdown } from './Markdown.tsx'

/** 按文件名后缀决定看法。 */
export function VibeArtifactPreview({ name, content }: { name: string; content: string }) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.html')) {
    // 预览里的脚本一律不跑：sandbox 空值就是禁脚本、禁表单、禁弹窗。
    // 页面本身在磁盘上双击打开是能跑的，这里只给用户看个样子。
    return <iframe className="vibe-preview-frame" title={name} sandbox="" srcDoc={content} />
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return (
      <div className="vibe-preview-doc">
        <Markdown text={content} />
      </div>
    )
  }
  if (lower.endsWith('.csv')) {
    return <CsvTable content={content} />
  }
  return <pre className="vibe-preview-text">{content}</pre>
}
