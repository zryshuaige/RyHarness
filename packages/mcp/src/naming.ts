/**
 * MCP 工具的对外命名。
 *
 * 规则是 `mcp__<server>__<tool>`，两段用双下划线隔开。名字要进 agent 的工具
 * 白名单、要进模型的 tools 列表、还要出现在对话记录里，所以它必须**稳定**：
 * 同一个 server 的同一个工具，今天叫什么明天还得叫什么——不然历史记录里的
 * 工具名对不上，回放时就会变成「模型调用了一个不存在的工具」。
 *
 * 清洗只保留 `[a-zA-Z0-9_-]`，其余换成下划线。server 名与工具名都过这一道，
 * 因为两边都可能带空格、斜杠、冒号（`weird name/with:chars` 这类真出现过）。
 * @module @ryharness/mcp/naming
 */

/** 名字里允许保留的字符；其余一律换成下划线。 */
const DISALLOWED = /[^a-zA-Z0-9_-]+/g

/** 清洗一段名字：非法字符换成下划线，两端的下划线去掉，全空时用兜底名。 */
export function sanitizeNameSegment(raw: string, fallback = 'x'): string {
  const cleaned = raw.replace(DISALLOWED, '_').replace(/^_+|_+$/g, '')
  return cleaned.length > 0 ? cleaned : fallback
}

/** 按命名规则拼出工具名（不处理重名——重名要跨 server 一起判）。 */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizeNameSegment(server, 'server')}__${sanitizeNameSegment(tool, 'tool')}`
}

/** 一个工具的来源：哪个 server 的哪个工具。 */
export interface McpToolRef {
  server: string
  tool: string
}

/**
 * 来源的内部键。
 *
 * 用 JSON 元组而不是拼字符串：server 名与工具名是原始值，什么字符都可能有，
 * 拼起来当键迟早碰上「两个不同的来源拼出同一个键」。JSON 元组不会。
 */
export function mcpToolRefKey(ref: McpToolRef): string {
  return JSON.stringify([ref.server, ref.tool])
}

/**
 * 给一批工具来源分配互不重名的对外名字。
 *
 * 重名有两种来源：同一个 server 里有两个清洗后同名的工具；两个 server 的名字
 * 清洗后撞上（`a b` 与 `a-b` 都变成 `a_b`）。两种都用尾部序号兜住
 * （`__2`、`__3`…）。
 *
 * 序号必须是**确定**的：这里按 server 名、工具名排序后再分配，于是「谁拿到
 * `__2`」与登记顺序、连接顺序都无关。今天先连 A 再连 B 还是反过来，名字一样。
 * @param refs - 工具来源清单。
 * @returns 内部键 → 对外工具名。
 */
export function assignMcpToolNames(refs: readonly McpToolRef[]): Map<string, string> {
  const ordered = [...refs].sort((left, right) => {
    if (left.server !== right.server) return left.server.localeCompare(right.server)
    return left.tool.localeCompare(right.tool)
  })
  const used = new Set<string>()
  const assigned = new Map<string, string>()
  for (const ref of ordered) {
    const base = mcpToolName(ref.server, ref.tool)
    let name = base
    let suffix = 2
    while (used.has(name)) {
      name = `${base}__${suffix}`
      suffix += 1
    }
    used.add(name)
    assigned.set(mcpToolRefKey(ref), name)
  }
  return assigned
}
