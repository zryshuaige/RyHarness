/**
 * RyAgent 基础工具集：fs_read / fs_write（工作区限定 + 真实路径校验）、shell_exec
 * （超时/截断/Git Bash 优先 + 敏感路径安全闸）、file_produce（产物卡片，
 * "发文件"能力内核）。
 *
 * 四个工具都在 execute 入口检查 `ToolContext.signal`：已取消的轮次既不产生
 * 副作用也不返回结果；shell_exec 进一步把信号交给 spawn，点「停止」后子
 * 进程立刻被杀，而不是等超时。
 * @module @ryagent/tools
 */

export { fsRead, fsWrite } from './fs.ts'
export { ARTIFACTS_DIR, fileProduce, guessMime } from './produce.ts'
export type { SensitiveHit, ShellGuardPolicy } from './shell.ts'
export { findSensitiveInCommand, setShellGuardPolicy, shellExec, shellGuardPolicy } from './shell.ts'
export { PathEscapeError, resolveInWorkspace, truncateOutput } from './workspace.ts'
