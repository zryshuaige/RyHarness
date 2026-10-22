/**
 * `/` 命令面板的纯逻辑：解析命令触发状态、按关键字过滤候选、算执行后该剩下什么。
 *
 * 与 @提及补全同一套形状（纯函数住在 lib/，状态与算法分开）：命令表由壳构建
 * （每条命令要拿到应用级动作），这里只负责"用户此刻是不是在输命令"、"哪些
 * 候选该露出来"与"命令跑完该删掉哪一段"。
 *
 * 触发口径：**行首**的 `/`（前面要么没有字，要么只有空白）才算命令。中间的
 * 斜杠是正文——"路径是 C:/Users" 这种句子不该被命令面板劫持。
 *
 * @module @ryharness/renderer/lib/commands
 */

/** 一条命令。 */
export interface Command {
  /** 稳定的 id。 */
  id: string
  /** 列表里显示的文案。 */
  label: string
  /** 右侧的提示（快捷键、说明）。 */
  hint?: string
  /** 执行。 */
  run: () => void
}

/** `/` 补全状态：斜杠的位置与已输入的片段。 */
export interface CommandQuery {
  /** 斜杠在文本中的下标。 */
  start: number
  /** 斜杠之后已输入的片段。 */
  query: string
}

/**
 * 从输入文本与光标位置解析 `/` 补全状态；不在命令里时返回 null。
 *
 * 只有**行首**的斜杠算触发：前面有字（哪怕只是空格之外的一个字符）就当正文。
 * 片段里也不允许空白——" / 新" 里的空格说明这一段不是命令。
 */
export function commandQueryAt(text: string, cursor: number): CommandQuery | null {
  const before = text.slice(0, cursor)
  const at = before.lastIndexOf('/')
  if (at === -1) return null
  // 斜杠必须行首：前面只能有空白。
  if (before.slice(0, at).trim().length > 0) return null
  const query = before.slice(at + 1)
  if (/[\s/]/.test(query)) return null
  return { start: at, query }
}

/** 按 query 过滤候选（大小写不敏感包含匹配）。 */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const lowered = query.trim().toLowerCase()
  if (lowered.length === 0) return [...commands]
  return commands.filter((command) => {
    return command.label.toLowerCase().includes(lowered)
  })
}

/** 命令词在文本里占的那一段。 */
export interface CommandWord {
  /** 斜杠的下标。 */
  start: number
  /** 命令词的结束下标（不含）。 */
  end: number
  /** 命令词本身（斜杠之后那一段，不含后面的分隔空格）。 */
  word: string
}

/**
 * 文本里命令词占哪一段（行首斜杠之后的那个词）。
 *
 * 与 {@link commandQueryAt} 的差别只有一处：这里**允许命令词后面还跟着正文**。
 * "/help 帮我看看这段代码" 里命令是 /help，后半截是用户自己写的草稿——命令跑完
 * 那一段必须留着（清空整个输入框就是那次"草稿静默消失"的根因）。
 *
 * 两件事不该共用一条口径：commandQueryAt 判的是"用户此刻是不是在输命令"（面板的
 * 触发口径，光标前那一段里不能有空白），这里判的是"这段文字里的命令词在哪"。
 *
 * 仍然遵守行首口径：斜杠前面只能有空白，"abc /help" 是正文，不是命令。
 */
export function commandWordAt(text: string, cursor: number): CommandWord | null {
  const before = text.slice(0, cursor)
  const at = before.lastIndexOf('/')
  if (at === -1) return null
  // 斜杠必须行首：前面只能有空白。
  if (before.slice(0, at).trim().length > 0) return null
  const rest = text.slice(at + 1)
  // 光标就停在斜杠后面：命令词还没写出来（面板正在列候选），命令词就是斜杠本身。
  if (rest.length === 0) return { start: at, end: at + 1, word: '' }
  // 斜杠后面紧跟空白：那是正文里的斜杠（"/ 新"），不是命令。
  const matched = /^\S+/.exec(rest)
  if (matched === null) return null
  return { start: at, end: at + 1 + matched[0].length, word: matched[0] }
}

/** 命令跑完之后，文本与光标该变成什么样。 */
export interface CommandStrip {
  /** 去掉命令之后剩下的文本。 */
  text: string
  /** 新的光标位置（落在剩下的文本里）。 */
  cursor: number
}

/**
 * 把文本里的命令那截去掉，只留用户写的正文。
 *
 * 只删**光标之前**的那一段：命令在光标前，而用户可能已经在光标后写了东西
 * （"/help 帮我看看这段代码" 里光标停在 help 后面），把后面一起吃掉就是又一次
 * 静默丢草稿。命令后面那个分隔空格一并删掉，剩下的正文才是干净的一句。
 *
 * 光标落在剩余文本的起点：命令原来在哪，剩下就从哪开始。
 */
export function stripCommand(text: string, cursor: number): CommandStrip {
  const word = commandWordAt(text, cursor)
  if (word === null) return { text, cursor }
  // 不越过光标：光标后面的内容一个字都不动。
  const cut = Math.min(word.end, cursor)
  // 连同命令后面那个分隔空格一起删掉。
  const end = cut < text.length && text[cut] === ' ' ? cut + 1 : cut
  return { text: text.slice(0, word.start) + text.slice(end), cursor: word.start }
}
