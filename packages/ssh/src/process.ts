/**
 * 进程相关的两件事：怎么起 ssh、怎么把它的整棵树收掉。
 *
 * 单独放一个文件是因为这两件事的**平台差异**集中在这里：
 * - Windows：靠 `taskkill /T /F` 按父子关系枚举回收；
 * - POSIX：把 ssh 进程单独放一个进程组（`detached`），`kill(-pgid)` 一下就都收了。
 *
 * 没有原生绑定，所以这两条都是「尽力而为」：收不干净时要如实说收不干净（返回 false），
 * 不能假装收好了。
 * @module @ryharness/ssh/process
 */

import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'

/**
 * 起进程的方式。
 *
 * 抽成函数是为了让测试能塞一个假的 ssh 进去：假的照样是真实进程（管道、退出码、超时
 * 都真的会发生），只是它把 ssh 该做的事录下来，而不是真的连远端。
 */
export type SshSpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

/** 默认的起进程方式：用 node 的 spawn。 */
export const defaultSpawn: SshSpawnFn = (command, args, options) => spawn(command, [...args], options)

/** 收不掉时的兜底时限（毫秒）：到点就把结果交出去，不让调用方无限等。 */
const KILL_GRACE_MS = 2_000

/**
 * Windows 上按父子关系强杀整棵树。
 * @param pid - 根进程 id。
 * @returns 是不是收掉了。
 */
function taskkillTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    let timer: NodeJS.Timeout | undefined
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(ok)
    }
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => finish(false))
    killer.on('close', (code) => finish(code === 0))
    timer = setTimeout(() => {
      killer.kill('SIGKILL')
      finish(false)
    }, KILL_GRACE_MS)
  })
}

/**
 * POSIX 上按进程组杀整棵树。
 * @param pid - 进程组长 id。
 * @param child - 子进程句柄（组没了就退回只杀它自己）。
 * @returns 是不是收掉了。
 */
function killProcessGroup(pid: number, child: ChildProcess): boolean {
  try {
    process.kill(-pid, 'SIGKILL')
    return true
  } catch {
    try {
      return child.kill('SIGKILL')
    } catch {
      return false
    }
  }
}

/**
 * 把一个进程连同它的整棵子进程树收掉。
 * @param child - 目标进程。
 * @param platform - 平台（缺省当前平台）。
 * @returns 是不是收掉了。
 */
export async function killProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const pid = child.pid
  if (pid === undefined) return false
  if (platform === 'win32') return await taskkillTree(pid)
  return killProcessGroup(pid, child)
}
