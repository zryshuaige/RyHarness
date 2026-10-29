/**
 * RyHarness 基础工具集：fs_read / fs_write / fs_glob / fs_grep / fs_edit（工作区限定
 * + 真实路径校验）、shell_exec（超时/截断/Git Bash 优先 + 敏感路径安全闸）、
 * file_produce（产物卡片，"发文件"能力内核）。
 *
 * 读、找、改三条路都齐了：只有 read/write 的时候，助理既问不出「有哪些文件」，
 * 也改不动一个已知位置之外的段落——于是它只能反复猜路径，或者干脆不碰文件。
 *
 * 工具本身无状态；「有哪些工具可用」由 {@link ToolRegistry}（cordis 服务
 * `ctx.tools`）在运行时决定，插件注销即工具消失。
 * @module @ryharness/tools
 */

export { fsEdit, replaceInFile } from './edit.ts'
export { fsRead, fsWrite, resolveTarget } from './fs.ts'
export { globMatcher, globToRegExp, MAX_WALK_FILES, normalizeGlob, SKIP_DIRS, walkFiles } from './glob.ts'
export { ARTIFACTS_DIR, fileProduce, guessMime } from './produce.ts'
export { ToolRegistry } from './registry.ts'
export type { GrepMatch } from './search.ts'
export { fsGlob, fsGrep, grepFiles } from './search.ts'
export type { SensitiveHit, ShellGuardPolicy } from './shell.ts'
export { findSensitiveInCommand, setShellGuardPolicy, shellExec, shellGuardPolicy } from './shell.ts'
export { PathEscapeError, resolveInWorkspace, truncateOutput } from './workspace.ts'
