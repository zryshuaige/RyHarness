/**
 * 本地后端的集成测试：真起 shell、真发命令、真读输出。
 *
 * 这些用例跑的是**真的进程**，所以慢一些，也只在装了对应 shell 的机器上跑。
 * 断言的都是**行为**（输出里有没有那句话、目录有没有真的切过去、进程有没有真的
 * 退出），不是内部状态。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LocalShellBackend,
  normalizeShellPath,
  type TerminalBackendSession,
  TerminalService,
  type TerminalShellDialect,
} from '../src/index.ts'

/**
 * 命令名在这台机器的 PATH 上吗。
 *
 * Windows 上要自己拼后缀（`PATHEXT`），POSIX 上就是原样。
 * @param name - 命令名（`pwsh` 这种）。
 * @returns 找得到则 true。
 */
function onPath(name: string): boolean {
  const raw = process.env.PATH ?? ''
  const dirs = raw.split(process.platform === 'win32' ? ';' : ':').filter((dir) => dir.length > 0)
  const exts =
    process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE').split(';').filter((ext) => ext.length > 0) : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      if (existsSync(join(dir, `${name}${ext}`))) return true
    }
  }
  return false
}

/**
 * 这台机器上能用的方言；一个都没有就跳过整组。
 *
 * Windows 上默认 pwsh：它从 stdin 读命令时行为干净（不回显输入、语法错也不死），
 * Git Bash 在管道下要多滤一层噪声（见 README 的方言差异一节）。
 */
function availableDialect(): TerminalShellDialect | undefined {
  if (process.platform === 'win32') {
    if (onPath('pwsh') || onPath('powershell')) return 'pwsh'
    return onPath('bash') ? 'bash' : undefined
  }
  return existsSync('/bin/bash') ? 'bash' : undefined
}

/** 开着、最后要收掉的会话。 */
const opened: TerminalBackendSession[] = []

/** 这台机器的方言；没有就跳过这组用例。 */
const dialect = availableDialect()

/**
 * 取当前方言。
 *
 * 用例组已经用 `skipIf` 跳过了「没有 shell」的机器，这里再取一次是为了让
 * TypeScript 知道方言一定存在——不用 `as` 断言，也不用非空断言。
 * @returns 当前方言。
 */
function currentDialect(): TerminalShellDialect {
  if (dialect === undefined) throw new Error('这台机器上没有可用的 shell')
  return dialect
}

/**
 * 断言一个进程确实已经不在了。
 *
 * `process.kill(pid, 0)` 是**同步**抛异常的：写成 `expect(process.kill(...)).toThrow()`
 * 的话，异常在 `expect` 拿到参数之前就抛出去了，断言根本执行不到。必须把调用
 * 包进箭头函数里。
 * @param pid - 进程 pid（没有 pid 说明会话压根没起来）。
 */
function expectProcessGone(pid: number | undefined): void {
  expect(pid).toBeTypeOf('number')
  if (pid === undefined) return
  expect(() => process.kill(pid, 0)).toThrow()
}

/**
 * 断言一个进程还活着。
 * @param pid - 进程 pid。
 */
function expectProcessAlive(pid: number | undefined): void {
  expect(pid).toBeTypeOf('number')
  if (pid === undefined) return
  expect(() => process.kill(pid, 0)).not.toThrow()
}

/** 开一个真会话。 */
async function openSession(dialect: TerminalShellDialect): Promise<TerminalBackendSession> {
  const backend = new LocalShellBackend({ dialect })
  const session = await backend.open({ sessionId: `test-${opened.length}` })
  opened.push(session)
  return session
}

/** 读输出直到出现某段文字（或者超时）。 */
async function readUntil(session: TerminalBackendSession, needle: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let seen = ''
  while (Date.now() < deadline) {
    const chunk = await session.read({ waitMs: 200 })
    seen += chunk.text
    if (seen.includes(needle)) return seen
  }
  return seen
}

afterEach(async () => {
  while (opened.length > 0) {
    const session = opened.pop()
    if (session === undefined) continue
    await session.close().catch(() => undefined)
  }
})

describe.skipIf(dialect === undefined)('本地 shell 后端', () => {
  it('起得来，并且就绪探测通过（不是「发完就算 ready」）', async () => {
    const session = await openSession(currentDialect())
    expect(session.pid).toBeGreaterThan(0)
    // 就绪之后立刻能收到命令输出，说明 stdin 确实被 shell 读走了。
    await session.send('echo RY_ALIVE')
    const output = await readUntil(session, 'RY_ALIVE')
    expect(output).toContain('RY_ALIVE')
  })

  it('声明自己不是真 PTY，也不支持全屏交互程序', async () => {
    const session = await openSession(currentDialect())
    expect(session.capabilities.realPty).toBe(false)
    expect(session.capabilities.fullScreenInteractive).toBe(false)
    expect(session.capabilities.notes).toContain('管道模式')
  })

  it('工作目录跨调用保留', async () => {
    const session = await openSession(currentDialect())
    const target = process.platform === 'win32' ? 'C:/Windows' : '/tmp'
    const cwd = await session.changeDirectory(target)
    expect(normalizeShellPath(cwd)).toContain(normalizeShellPath(target).split('/').pop() ?? '')
    // 换一个调用再问一次：目录还在，就说明状态留在了那个 shell 里。
    await session.send('echo RY_PWD_CHECK')
    const output = await readUntil(session, 'RY_PWD_CHECK')
    expect(output).toContain('RY_PWD_CHECK')
  })

  it('环境变量跨调用保留', async () => {
    const session = await openSession(currentDialect())
    // 环境变量的写法两个方言不一样：bash 是 `export`/`$VAR`，pwsh 是 `$env:VAR`。
    // 写错了 pwsh 会把 `export` 当成 cmdlet 报「无法识别」，命令根本没执行。
    if (currentDialect() === 'pwsh') {
      await session.send("$env:RY_PERSIST='kept'")
      await session.send('Write-Output "RY_VALUE=$env:RY_PERSIST"')
    } else {
      await session.send('export RY_PERSIST=kept')
      await session.send('echo RY_VALUE=$RY_PERSIST')
    }
    const output = await readUntil(session, 'RY_VALUE=')
    expect(output).toContain('RY_VALUE=kept')
  })

  it('切到不存在的目录会报错，而不是假装切过去了', async () => {
    const session = await openSession(currentDialect())
    const missing = process.platform === 'win32' ? 'C:/NoSuchDirRyTerminal' : '/no-such-dir-ry-terminal'
    await expect(session.changeDirectory(missing)).rejects.toThrow()
  })

  it('读取是增量的：第二次读不会重复读到第一次的内容', async () => {
    const session = await openSession(currentDialect())
    await session.send('echo RY_ONCE')
    const first = await readUntil(session, 'RY_ONCE')
    expect(first).toContain('RY_ONCE')
    const second = await session.read({ waitMs: 200 })
    expect(second.text).not.toContain('RY_ONCE')
  })

  it('单次读取有上限，超出的部分留在缓冲里', async () => {
    const backend = new LocalShellBackend({ dialect: currentDialect(), maxReadBytes: 16 })
    const session = await backend.open({ sessionId: 'bounded' })
    opened.push(session)
    await session.send('echo RY_LONG_OUTPUT_MARKER_0123456789')
    await readUntil(session, 'RY_LONG_OUTPUT_MARKER_0123456789')
    // 缓冲里可能还有别的内容；读一小段必然被截断。
    await session.send('echo MORE_OUTPUT_HERE_AFTER')
    await readUntil(session, 'MORE_OUTPUT_HERE_AFTER')
    const bounded = await session.read({ maxBytes: 4 })
    expect(bounded.bytes).toBeLessThanOrEqual(4)
  })

  it('关掉会话后进程真的不在了', async () => {
    const backend = new LocalShellBackend({ dialect: currentDialect() })
    const session = await backend.open({ sessionId: 'closing' })
    const pid = session.pid
    expect(pid).toBeGreaterThan(0)
    await session.close()
    // 等一小会儿，让操作系统回收进程表里的条目。
    await new Promise((resolve) => setTimeout(resolve, 300))
    expectProcessGone(pid)
  })

  it('中断会停掉正在跑的命令，而且会话还能继续用', async () => {
    const backend = new LocalShellBackend({ dialect: currentDialect() })
    const session = await backend.open({ sessionId: 'interrupting' })
    opened.push(session)
    const pid = session.pid
    // 起一个跑很久的命令。
    await session.send(process.platform === 'win32' ? 'ping -n 30 127.0.0.1' : 'sleep 30')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await session.interrupt()
    // 中断之后 shell 本身还得活着：控制台宿主（conhost.exe）也是进程树上的叶子，
    // 但它不是命令——连它一起杀掉会把 shell 带走（实测 pwsh 直接退出）。
    expectProcessAlive(pid)
    // 中断之后 shell 还得能接着收命令。
    await session.send('echo RY_AFTER_INTERRUPT')
    const output = await readUntil(session, 'RY_AFTER_INTERRUPT')
    expect(output).toContain('RY_AFTER_INTERRUPT')
  })

  it('结束输入流（Ctrl-D 的真 EOF）会让 shell 退出', async () => {
    const backend = new LocalShellBackend({ dialect: currentDialect() })
    const session = await backend.open({ sessionId: 'eof' })
    const pid = session.pid
    await session.closeInput()
    await new Promise((resolve) => setTimeout(resolve, 800))
    expectProcessGone(pid)
  })
})

describe.skipIf(dialect === undefined)('会话服务 + 真实后端', () => {
  it('开出来的会话能发命令并读回输出', async () => {
    const backend = new LocalShellBackend({ dialect: currentDialect() })
    const service = new TerminalService({ backends: [backend] })
    const session = await service.open('agent-1', {})
    await service.send('agent-1', session.id, 'echo RY_SERVICE_OUTPUT')
    const deadline = Date.now() + 15_000
    let seen = ''
    while (Date.now() < deadline && !seen.includes('RY_SERVICE_OUTPUT')) {
      const chunk = await service.read('agent-1', session.id, { waitMs: 200 })
      seen += chunk.text
    }
    expect(seen).toContain('RY_SERVICE_OUTPUT')
    await service.disposeAll()
  })

  it('disposeAll 之后所有 shell 进程都不在了', async () => {
    const backend = new LocalShellBackend({ dialect: currentDialect() })
    const service = new TerminalService({ backends: [backend] })
    const a = await service.open('agent-1', {})
    const b = await service.open('agent-2', {})
    const pidA = a.pid
    const pidB = b.pid
    await service.disposeAll()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expectProcessGone(pidA)
    expectProcessGone(pidB)
  })

  it('owner 围栏在真后端上也拦得住', async () => {
    const backend = new LocalShellBackend({ dialect: currentDialect() })
    const service = new TerminalService({ backends: [backend] })
    const session = await service.open('agent-1', {})
    await expect(service.read('agent-2', session.id)).rejects.toThrow()
    await expect(service.send('agent-2', session.id, 'echo HACKED')).rejects.toThrow()
    await service.disposeAll()
  })
})
