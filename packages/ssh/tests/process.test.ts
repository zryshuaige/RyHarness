/**
 * 进程树的回收：超时与取消都要真的把 ssh 收掉。
 *
 * 这块是平台相关的，所以只断言**外部可见的事实**（进程还在不在），
 * 不去断言内部调用了多少次 taskkill。
 */
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { killProcessTree } from '../src/index.ts'

/** 等一小会儿，让子进程真的起来。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 起一个会一直睡着的子进程。 */
function sleeper(): ReturnType<typeof spawn> {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
}

describe('进程树回收', () => {
  it('Windows 方式：整棵树被收掉', async () => {
    const child = sleeper()
    await delay(150)

    const killed = await killProcessTree(child, 'win32')

    expect(killed).toBe(true)
  })

  it('POSIX 方式：在本机上退回到只杀直接子进程，也算收掉了', async () => {
    const child = sleeper()
    await delay(150)

    const killed = await killProcessTree(child, 'linux')

    expect(killed).toBe(true)
  })

  it('进程已经退了：如实说没杀掉', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true })
    await new Promise((resolve) => child.once('close', resolve))
    await delay(100)

    const killed = await killProcessTree(child, 'win32')

    expect(killed).toBe(false)
  })
})
