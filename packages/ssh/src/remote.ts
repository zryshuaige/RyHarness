/**
 * 远端命令的拼装与解析。
 *
 * 远端是 POSIX shell，所以这里所有路径与参数都要**先引号化再拼进命令**：
 * 引号化错了就是一次命令注入（文件名里有空格、反斜杠、分号都能要命）。
 *
 * 约定：
 * - 引号用单引号，内部的单引号按 POSIX 写法转义（`'` → `'\''`）。
 * - 文件内容走 **base64 管道**：写是 `base64 -d > 文件`，读是 `base64 < 文件`。
 *   走 base64 是因为它让管道里全是 ASCII 文本，不会有编码层的弯弯绕绕。
 * - 列目录用一段纯 POSIX 的 shell 循环，不依赖 `ls -p`、`find -printf` 这些各家不一样的选项。
 * @module @ryharness/ssh/remote
 */

import { SshError } from './errors.ts'
import type { SshFileEntry } from './types.ts'

/**
 * 把一段文本按 POSIX shell 的规矩引号化。
 *
 * 单引号里的一切都是字面量（连 `$` 与反斜杠也是），所以这是最省心的写法；
 * 唯一的麻烦是字符串里本身有单引号——POSIX 的写法是把它拆成四段：`'` + `\'` + `'`。
 * @param value - 原文。
 * @returns 引号化之后可以直接拼进命令的片段。
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** base64 解码用的开关：GNU 用 `-d`，BSD/macOS 用 `-D`。 */
export type Base64DecodeFlag = '-d' | '-D'

/** 列目录时远端用的类型标记。 */
const KIND_BY_MARK: Readonly<Record<string, SshFileEntry['kind']>> = {
  f: 'file',
  d: 'directory',
  l: 'symlink',
  o: 'other',
}

/**
 * 拼「读文件」的远端命令。
 * @param path - 远端绝对路径。
 * @returns 命令文本。
 */
export function buildReadCommand(path: string): string {
  return `base64 < ${shellQuote(path)}`
}

/**
 * 拼「写文件」的远端命令。
 *
 * `chmod` 放在同一条命令里：单独跑第二条命令的话，文件会先以远端默认权限落盘，
 * 中间那一瞬间是可读的。
 * @param path - 远端绝对路径。
 * @param mode - 权限（八进制）；不给就不 chmod。
 * @param flag - base64 解码开关。
 * @returns 命令文本。
 */
export function buildWriteCommand(path: string, mode?: number, flag: Base64DecodeFlag = '-d'): string {
  const quoted = shellQuote(path)
  const decode = `base64 ${flag} > ${quoted}`
  if (mode === undefined) return decode
  return `${decode} && chmod ${mode.toString(8)} ${quoted}`
}

/**
 * 拼「列目录」的远端命令。
 *
 * 这段脚本刻意只用了 POSIX shell 的内置能力：
 * - `./*` 列出普通名字，`./.[!.]*` 与 `./..?*` 补上点开头的名字（`.` 与 `..` 被排除）；
 * - `[ -L ]` / `[ -d ]` / `[ -f ]` 判类型，符号链接先判（否则永远被判成它指向的东西）；
 * - 大小用 `wc -c < 文件` 拿——只对普通文件拿，别的类型不碰（对命名管道这么做会卡住）。
 *
 * 已知限制：名字里带制表符或换行的文件会把这条输出解析乱（这种文件在真实仓库里极少，
 * 但真遇到了会表现为「多出几条看不懂的条目」）。
 * @param dir - 远端绝对目录。
 * @returns 命令文本。
 */
export function buildListCommand(dir: string): string {
  const quoted = shellQuote(dir)
  return [
    `cd ${quoted} || exit 66`,
    'for f in ./* ./.[!.]* ./..?*; do',
    '  [ -e "$f" ] || [ -L "$f" ] || continue',
    '  if [ -L "$f" ]; then t=l; s=-;',
    '  elif [ -d "$f" ]; then t=d; s=-;',
    '  elif [ -f "$f" ]; then t=f; s=$(wc -c < "$f" | tr -d \' \');',
    '  else t=o; s=-; fi',
    // 这一行用模板字面量写：`\${f#./}` 是 POSIX 的参数展开（去掉开头的 ./），
    // 不是 JS 的模板占位符，所以要转义。
    `  printf '%s\\t%s\\t%s\\n' "$t" "$s" "\${f#./}"`,
    'done',
  ].join('\n')
}

/**
 * 解析列目录命令的输出。
 *
 * 每行是「类型标记 \t 字节数 \t 名字」。字节数是 `-` 表示不是普通文件（没有大小）。
 * @param stdout - 远端 stdout。
 * @param dir - 目录的远端绝对路径（用来拼条目的完整路径）。
 * @returns 目录条目。
 */
export function parseListOutput(stdout: string, dir: string): SshFileEntry[] {
  const entries: SshFileEntry[] = []
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const mark = parts[0] ?? ''
    const size = parts[1] ?? '-'
    const name = parts.slice(2).join('\t')
    if (name.length === 0) continue
    const kind = KIND_BY_MARK[mark] ?? 'other'
    const sizeNumber = size === '-' ? Number.NaN : Number.parseInt(size, 10)
    entries.push({
      name,
      path: `${dir.replace(/\/+$/, '')}/${name}`,
      kind,
      ...(Number.isFinite(sizeNumber) ? { size: sizeNumber } : {}),
    })
  }
  return entries
}

/**
 * 把远端回来的 base64 文本解成字节。
 *
 * 远端 base64 会按 76 列换行，所以先去掉所有空白再解。
 * @param text - base64 文本。
 * @returns 解出来的字节。
 */
export function decodeBase64Payload(text: string): Uint8Array {
  const compact = text.replace(/\s+/g, '')
  if (compact.length === 0) return new Uint8Array(0)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new SshError('REMOTE_FAILED', '远端回来的 base64 内容不合法。')
  }
  return new Uint8Array(Buffer.from(compact, 'base64'))
}
