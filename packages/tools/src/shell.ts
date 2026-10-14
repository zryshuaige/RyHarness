/**
 * shell_exec：在工作区根目录下执行 shell 命令。
 *
 * Windows 上优先使用 Git Bash（本开发/部署环境的 shell），找不到时退回
 * cmd.exe；POSIX 上使用 /bin/sh。用 execFile 直接.spawn 解释器（不经
 * cmd 字符串拼接），避免 Windows 路径空格引号问题；输出按字符数截断，
 * 超时强杀进程。取消时把 `ToolContext.signal` 交给 spawn：等待立刻中断，
 * 并按进程树把 shell 及其子孙一起收掉。
 * @module @ryagent/tools/shell
 */

import type { ChildProcess } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { type Tool, throwIfAborted } from '@ryagent/agent'
import { truncateOutput } from './workspace.ts'

const execFileAsync = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_CHARS = 32_000

/** 各平台的默认 shell 与单命令标志；Windows 优先 Git Bash。 */
function defaultShell(): { shell: string; args: (command: string) => string[] } {
  if (process.platform === 'win32') {
    const candidates = [
      process.env.GIT_BASH_PATH,
      'C:/Program Files/Git/bin/bash.exe',
      'C:/Program Files (x86)/Git/bin/bash.exe',
    ].filter((path): path is string => {
      return typeof path === 'string' && path.length > 0
    })
    for (const candidate of candidates) {
      if (existsSync(candidate))
        return {
          shell: candidate,
          args: (command) => {
            return ['-c', command]
          },
        }
    }
    return {
      shell: process.env.ComSpec ?? 'cmd.exe',
      args: (command) => {
        return ['/d', '/s', '/c', `"${command}"`]
      },
    }
  }
  return {
    shell: '/bin/sh',
    args: (command) => {
      return ['-c', command]
    },
  }
}

function argString(args: unknown, key: string, fallback?: string): string {
  if (typeof args === 'object' && args !== null && key in args) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  if (fallback !== undefined) return fallback
  throw new Error(`shell_exec: missing string argument "${key}"`)
}

function argNumber(args: unknown, key: string, fallback: number): number {
  if (typeof args === 'object' && args !== null && key in args) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
    if (typeof value === 'string' && value.length > 0 && Number.isFinite(Number(value))) return Number(value)
  }
  return fallback
}

/** 在工作区根目录执行命令，返回合并截断的输出。 */
export const shellExec: Tool = {
  name: 'shell_exec',
  description: '在工作区根目录执行 shell 命令（有超时与输出长度限制），返回 stdout/stderr。',
  // 命令会改工作区（rm / npm install / 构建脚本都可能动同一批路径），并发执行
  // 互相踩踏且输出交错；声明 sequential 让 AgentLoop 把整批工具调用退回串行。
  executionMode: 'sequential',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeoutMs: { type: 'number', description: `超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}）` },
    },
    required: ['command'],
  },
  async execute(args, ctx) {
    throwIfAborted(ctx.signal)
    const command = argString(args, 'command')
    const timeoutMs = argNumber(args, 'timeoutMs', DEFAULT_TIMEOUT_MS)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return { content: `invalid timeoutMs: ${String(timeoutMs)}`, isError: true }
    }
    const { shell, args: shellArgs } = defaultShell()
    const running = execFileAsync(shell, shellArgs(command), {
      cwd: ctx.workspaceRoot,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    })
    try {
      const { stdout, stderr } = await running
      const combined = stderr.length > 0 ? `${stdout}\n[stderr]\n${stderr}` : stdout
      return { content: truncateOutput(combined.trimEnd(), MAX_OUTPUT_CHARS) }
    } catch (error) {
      // 取消不是命令失败：结果无意义，由循环在边界抛 AbortedError 收尾。
      if (ctx.signal?.aborted === true) {
        killProcessTree(running.child)
        return { content: 'command aborted', isError: true }
      }
      const failed = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean }
      const output = [failed.stdout, failed.stderr]
        .filter((part): part is string => {
          return typeof part === 'string' && part.length > 0
        })
        .join('\n')
      const reason = failed.killed === true ? `timed out after ${timeoutMs}ms` : (failed.message ?? 'command failed')
      return {
        content: output.length > 0 ? `${reason}\n${truncateOutput(output.trimEnd(), MAX_OUTPUT_CHARS)}` : reason,
        isError: true,
      }
    }
  },
}

/**
 * 按进程树收尾。Windows 上杀掉 shell 并不会自动带走它启动的子进程：
 * Git Bash 走 MSYS2，信号会顺着进程组传下去，但退化到 cmd.exe（或任何
 * 不做信号传播的 shell）时，`npm install` / `python x.py` 里真正干活的进程
 * 会继续跑几分钟并占着工作区。taskkill /T 才是按树清理。
 */
function killProcessTree(child: ChildProcess): void {
  if (process.platform !== 'win32' || child.pid === undefined) return
  try {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref()
  } catch {
    // 进程可能已经退出；杀不掉不该改变工具结果。
  }
}
