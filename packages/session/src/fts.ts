/**
 * 消息全文索引的文本工具：中文 bigram 分词 + FTS5 MATCH 查询串 + 正文抽取。
 *
 * 消息正文存在 `messages.content_blocks` 的 JSON 里，本身不可索引；关键词搜索
 * 只能把整库消息拉进内存做子串匹配（每页都要 JSON.parse + 全文扫）。这里给
 * 正文建一份 FTS5 索引，搜索变成一次 MATCH。
 *
 * 分词与查询串的写法照搬 @ryagent/memory 的同名实现（unicode61 不切 CJK，
 * 相邻两字一个 token；token 逐个加引号防元字符），但**刻意不依赖那个包**：
 * 记忆与会话虽共用一个 SQLite 文件，本包不引入跨包依赖，重复的两百行文本工具
 * 比一条包依赖便宜。
 * @module @ryagent/session/fts
 */

/**
 * 中文 bigram 分词：unicode61 不把 CJK 切段，整句是一个 token，前缀查询失效。
 * 索引用相邻两字一个 token（"用户养猫" → "用户 户养 养猫"），查询同样变换，
 * FTS5 默认 AND 语义 → 真实的中文 BM25。
 */
export function bigrams(text: string): string {
  const compact = text.replace(/\s+/g, '')
  if (compact.length === 0) return ''
  if (compact.length === 1) return compact
  const parts: string[] = []
  for (let i = 0; i < compact.length - 1; i++) parts.push(compact.slice(i, i + 2))
  return parts.join(' ')
}

/**
 * FTS5 MATCH 查询串：bigram token 逐个加引号，token 内的 `"` 双写。
 *
 * 不转义时 bigram 会把原文标点带进查询语法，整条词法通道直接抛错：`e:` 被当成
 * 列过滤器、`a"b` 的引号当成字符串定界、`PORT` 的 `OR` 段成了布尔关键字。用户
 * 发一条带 `- . / @ # : "` 的输入，全文搜索就整条静默失效。
 *
 * OR 语义：候选词常比消息长，全 AND 会零命中；BM25 按命中比例排序。
 */
export function ftsMatchQuery(text: string): string {
  return bigrams(text)
    .split(' ')
    .filter((token) => {
      return token.length > 0
    })
    .map((token) => {
      return `"${token.replace(/"/g, '""')}"`
    })
    .join(' OR ')
}

/**
 * 一条消息的可搜索正文：只取 `type === 'text'` 的块。
 *
 * 工具载荷不进索引——那是模型输入/output 原文，体量大且搜索价值低，进索引只会
 * 稀释 BM25 并放大库文件。
 */
export function messageSearchText(contentBlocks: unknown): string {
  if (!Array.isArray(contentBlocks)) return ''
  return contentBlocks
    .filter((block): block is { type: string; text: string } => {
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string'
    })
    .map((block) => {
      return block.text
    })
    .join('\n')
}
