/**
 * 产物预览的按类型分派：文件名/扩展名 → 渲染器种类。
 *
 * 单独成文件是因为这张表是**产品判断**，不是渲染细节：多一个扩展名就多一种
 * 体验，而「无法内嵌」的那一类必须明确落到用系统程序打开/下载/复制路径，
 * 不能退化成一个点开就没反应的链接。
 */

/** 内嵌预览的渲染器种类。 */
export type PreviewKind = 'image' | 'pdf' | 'html' | 'markdown' | 'table' | 'text' | 'code' | 'external'

/**
 * `<img>` 直接能画的位图/矢量图。
 *
 * `svg` 留在这支而没有跟着 html 走 iframe：`<img>` 里的 SVG 是**比任何 sandbox 都紧**
 * 的上下文——脚本完全不跑、外部资源（远程字体、外链 CSS、`href` 跳转）一律不加载，
 * 只有内联样式与 CSS 动画能动。产物里的 SVG 绝大多数是图表/示意图，这已经足够；
 * 为了「万一有脚本」而去换成 `allow-scripts`，是拿一个真实的能力损失换一个不存在的风险。
 */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif'])

/** 走 Markdown 渲染器的文档。 */
const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx'])

/**
 * 要当作页面渲染的 HTML。
 *
 * 早先这里是把 `html` 塞进 CODE_EXT 按源码显示，理由是「本仓没有 HTML 消毒器，
 * 不敢内嵌」。那个顾虑是对的，但结论过时了：**隔离由 iframe 的 sandbox 提供，
 * 不需要消毒器**。sandbox 里没有 allow-same-origin，这份文档拿到的是一个 opaque
 * origin——够不到本应用的 localStorage / origin / DOM，也导航不了顶层。
 *
 * 反过来说，正因为隔离来自 sandbox 而不是消毒，**绝不能顺手补上
 * allow-same-origin**：补上之后 iframe 与宿主同源，一份产物里的 `<script>` 就等价于
 * 应用自己的脚本，那时才真的需要消毒器。
 */
const HTML_EXT = new Set(['html', 'htm'])

/**
 * 当代码看的文件。
 *
 * 产物里的 `xml` 也在这一支：它是数据/配置，不是要在预览框里跑的页面，
 * 塞进 HTML 分支只会让它拿到一个能执行的上下文。
 */
const CODE_EXT = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'sh',
  'bash',
  'py',
  'rs',
  'go',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'rb',
  'php',
  'sql',
  'css',
  'scss',
  'less',
  'xml',
  'vue',
])

/**
 * 当表看的文件。
 *
 * 表格与纯文本分开：CSV 用 `<pre>` 打出来是一屏逗号，用户要自己数列——把它摆成格子
 * 才是"看见这张表"。
 */
const TABLE_EXT = new Set(['csv', 'tsv'])

/** 当纯文本看的文件（没有语法高亮的那一支）。 */
const TEXT_EXT = new Set(['txt', 'text', 'log'])

/** Office 二进制格式：没有纯前端的渲染器，只能交给系统程序。 */
const OFFICE_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'])

/** 取小写扩展名（不含点）；没有扩展名返回空串。 */
function extOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * 按名字与 MIME 决定渲染器。
 *
 * 扩展名优先、MIME 兜底：产物名是 agent 自己起的（`.md` 常常压根没带 MIME），
 * 只有扩展名认不出来时才让 MIME 说话。
 *
 * **认不出来的一律 external**：把 zip 之类的二进制当文本塞进 `<pre>` 只会得到
 * 一屏乱码，那比老实说「不能内嵌」更糟。
 */
export function previewKindOf(name: string, mime = ''): PreviewKind {
  const ext = extOf(name)
  if (IMAGE_EXT.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (HTML_EXT.has(ext)) return 'html'
  if (MARKDOWN_EXT.has(ext)) return 'markdown'
  if (TABLE_EXT.has(ext)) return 'table'
  if (CODE_EXT.has(ext)) return 'code'
  if (TEXT_EXT.has(ext)) return 'text'
  if (OFFICE_EXT.has(ext)) return 'external'
  if (ext !== '') return 'external'
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (mime === 'text/html') return 'html'
  if (mime === 'text/markdown') return 'markdown'
  if (mime.startsWith('text/')) return 'text'
  return 'external'
}

/** 需要把整份读成字符串再渲染的种类（其余交给 `<img>` / `<iframe>` 直接吃 URL）。 */
export function needsTextBody(kind: PreviewKind): boolean {
  return kind === 'markdown' || kind === 'table' || kind === 'text' || kind === 'code' || kind === 'html'
}

/**
 * HTML 预览的字节上限：超过就只给「下载 / 用系统程序打开」，不内嵌。
 *
 * 数字跟着服务端 `MAX_PREVIEW_BYTES`（32MB）往下压一个大档，因为 HTML 这一支
 * 比 `<pre>` 贵两截：整份 UTF-8 解码成一个 JS 字符串，再整份编码进 Blob，
 * 最后整份交给 Chromium 解析成 DOM——三趟都压在渲染进程的主线程上。5MB 的
 * 单文件页面已经能让框里的滚动明显发涩，32MB 会直接白屏好几秒。
 */
export const HTML_PREVIEW_MAX_BYTES = 8 * 1024 * 1024
