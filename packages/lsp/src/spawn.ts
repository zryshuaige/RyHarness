/**
 * 起子进程的那点讲究。
 *
 * 只有一个坑，但它在 Windows 上是致命的：`.cmd` / `.bat` 文件**不能**直接 spawn。
 * Node 为了防命令注入，要求这类文件必须经过 shell，直接 spawn 会报 EINVAL。而
 * 全局装的 npm 包（`typescript-language-server`、`gopls`、`pyright-langserver`…）
 * 在 Windows 上恰恰都是 `.cmd` 垫片——直接 spawn 必然失败。
 *
 * 所以这里在 Windows 上把 `.cmd` / `.bat` 包一层 `cmd.exe /d /s /c`，其余平台直接
 * 起。参数自己加引号，不依赖 shell 的转义规则。
 *
 * 本包**不碰** `packages/subprocess`：那一包是另一个 lane 在写的，它做的是完整的
 * 进程托管（环境清洗、进程树回收、配额）。这里只需要「把语言服务器拉起来、给它
 * 三根管子」，所以自己写最小的一份；将来集成时由主控决定要不要换过去。
 * @module @ryharness/lsp/spawn
 */

/** 一次 spawn 的最终形状：真正要跑的命令与参数。 */
export interface SpawnPlan {
  /** 真正要起的可执行文件。 */
  readonly command: string
  /** 真正要传的参数。 */
  readonly args: readonly string[]
}

/**
 * 给 cmd 的参数加引号。
 *
 * 含空格或 cmd 元字符（`& | < > ^ ( )`）就整体包进双引号，里面的双引号按 cmd 的
 * 规矩翻倍。没这些字符的原样传，省得满屏转义符。
 * @param arg - 一个参数。
 * @returns 可以安全交给 cmd 的写法。
 */
function quoteCmdArg(arg: string): string {
  if (arg.length > 0 && !/[\s"^&|<>()%!]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

/**
 * 决定这次到底跑什么。
 *
 * @param command - 配置里写的命令。
 * @param args - 配置里写的参数；不配就是空参数。
 * @param platform - 平台；缺省当前平台。
 * @returns 真正要 spawn 的命令与参数。
 */
export function planSpawn(
  command: string,
  args: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): SpawnPlan {
  const lower = command.toLowerCase()
  const isWindowsScript = lower.endsWith('.cmd') || lower.endsWith('.bat')
  if (platform === 'win32' && isWindowsScript) {
    const line = [quoteCmdArg(command), ...args.map((arg) => quoteCmdArg(arg))].join(' ')
    // /s 让 cmd 剥掉整串命令的首尾引号，所以我们外面补的那对正好被吃掉。
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`] }
  }
  return { command, args: [...args] }
}
