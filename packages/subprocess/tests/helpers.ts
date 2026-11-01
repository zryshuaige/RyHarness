/**
 * 测试公用件：临时目录、可执行文件、进程存活判定、轮询等待。
 *
 * 这些是「怎么把事情摆到桌面上」的工具，不是被测对象——所以放在 helpers 里，
 * 不占测试文件的注意力。
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ManagedProcess, SubprocessResult } from '../src/index.ts'

/** 建一个临时目录；cleanup 负责删掉它。 */
export function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ry-subprocess-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * 在目录里写一个文件。
 *
 * POSIX 上顺手给上执行位——不然它对 shell 来说不是命令（这正是被测行为之一）。
 */
export function writeFileIn(dir: string, name: string, content = ''): string {
  const path = join(dir, name)
  writeFileSync(path, content)
  if (process.platform !== 'win32') chmodSync(path, 0o755)
  return path
}

/** 在目录里写一个**没有执行位**的文件（POSIX 上的反例）。 */
export function writePlainFile(dir: string, name: string, content = ''): string {
  const path = join(dir, name)
  writeFileSync(path, content)
  if (process.platform !== 'win32') chmodSync(path, 0o644)
  return path
}

/** 跑一段 node 代码：给 spawn 用。 */
export function nodeEval(code: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ['-e', code] }
}

/**
 * 进程还在不在。
 *
 * 用 `kill(pid, 0)`：信号 0 只做存在性检查，不真的杀。Windows 上同样有效。
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 轮询等待某个条件成立。
 *
 * 进程回收是异步的：命令发出去了，进程可能还在收尾。这里等一小会儿，
 * 而不是假设它立刻就死。
 */
export async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return predicate()
}

/** 一个已经结束的假进程句柄：给 provider 替身用。 */
export function fakeManagedProcess(overrides: Partial<ManagedProcess> = {}): ManagedProcess {
  const result: SubprocessResult = {
    status: 'completed',
    command: 'fake',
    args: [],
    pid: undefined,
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 0,
  }
  return {
    id: 'fake',
    label: 'fake',
    command: 'fake',
    args: [],
    pid: undefined,
    startedAt: Date.now(),
    finished: true,
    done: Promise.resolve(result),
    kill: async () => undefined,
    ...overrides,
  }
}
