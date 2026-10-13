/**
 * shell_exec：在工作区根目录下执行 shell 命令。
 *
 * Windows 上优先使用 Git Bash（本开发/部署环境的 shell），找不到时退回
 * cmd.exe；POSIX 上使用 /bin/sh。用 execFile 直接.spawn 解释器（不经
 * cmd 字符串拼接），避免 Windows 路径空格引号问题；输出按字符数截断，
 * 超时强杀进程。
 * @module @ryagent/tools/shell
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { Tool } from '@ryagent/agent'
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
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeoutMs: { type: 'number', description: `超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}）` },
    },
    required: ['command'],
  },
  async execute(args, ctx) {
    const command = argString(args, 'command')
    const timeoutMs = argNumber(args, 'timeoutMs', DEFAULT_TIMEOUT_MS)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return { content: `invalid timeoutMs: ${String(timeoutMs)}`, isError: true }
    }
    const { shell, args: shellArgs } = defaultShell()
    try {
      const { stdout, stderr } = await execFileAsync(shell, shellArgs(command), {
        cwd: ctx.workspaceRoot,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      })
      const combined = stderr.length > 0 ? `${stdout}\n[stderr]\n${stderr}` : stdout
      return { content: truncateOutput(combined.trimEnd(), MAX_OUTPUT_CHARS) }
    } catch (error) {
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
