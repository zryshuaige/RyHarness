import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@ryharness/agent'
import { fileProduce, fsRead, fsWrite, PathEscapeError, resolveInWorkspace, shellExec } from '@ryharness/tools'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
function workspace(): { root: string; ctx: ToolContext } {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-tools-'))
  roots.push(root)
  return { root, ctx: { workspaceRoot: root } }
}

afterEach(async () => {
  // 断言之外的无条件兜底：探针要是还活着，先收掉再走。一条红用例的代价远小于一个
  // 烧 CPU 的孤儿进程——泄漏必须以"红"的形式暴露，而不是留在用户机器上。
  if (probesActive > 0) {
    probesActive = 0
    await reapMarkedProcesses()
  }
  while (roots.length > 0) {
    try {
      rmSync(roots.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 被取消杀掉的子进程退出后，Windows 释放目录句柄会滞后一拍；
      // 残留目录落在系统临时区，不影响仓库。
    }
  }
})

afterAll(async () => {
  if (issuedMarkers.length === 0) return
  const hits = await findMarkedProcesses(issuedMarkers)
  expect(hits.map(describeHit), 'shell_exec 用例跑完之后仍有探针进程存活').toEqual([])
  // 兜底回收收掉过东西 = 确实漏过进程，只是被 afterEach 抢先补了刀。
  expect(reaped, 'shell_exec 的进程收尾漏掉了进程（已由 afterEach 兜底回收记账）').toEqual([])
})

/**
 * 泄漏探针夹具：一个「自己不会结束、但 CPU 占用为 0」的进程替身，还会再拉一层子孙。
 *
 * 为什么不能继续用 `while true; do :; done`：那个写法自己就占满一个核，而 shell_exec
 * 的收尾逻辑一旦有洞，它会以孤儿身份一直跑到会话结束——用户机器 CPU 被吃满的直接原因，
 * 而且断言只看 promise settle 时完全看不见它。
 *
 * 替身挂在一个 24.8 天的定时器上：CPU 占用为 0，且**不会因为父进程/stdin 管道消失就自己
 * 走**。这一点是刻意的——早先的版本读 stdin，管道一关它就自己退出了，于是无论收尾逻辑
 * 有没有洞，用例都是绿的，探针等于白放。
 */
const IDLE_TREE_FIXTURE = [
  "const { appendFileSync } = require('node:fs')",
  "const { spawn } = require('node:child_process')",
  'const [pidFile, depth, marker] = process.argv.slice(2)',
  'appendFileSync(pidFile, process.pid + "\\n")',
  'if (Number(depth) > 0) {',
  "  spawn(process.execPath, [__filename, pidFile, String(Number(depth) - 1), marker], { stdio: 'inherit' })",
  '}',
  'setTimeout(() => {}, 2147483647)',
  '',
].join('\n')

/** 本文件所有用过的探针 marker：收尾时一个都不该剩下。 */
const issuedMarkers: string[] = []
/** afterEach 兜底回收记账：非空即代表有进程漏了出来。 */
let reaped: string[] = []
let probesActive = 0

/** depth=1 = 夹具自己 + 它拉起的一层，两条命令行里都带 marker。 */
function idleTree(root: string, depth: number): { command: string; marker: string; pidsFile: string } {
  const fixture = join(root, 'idle-tree.cjs')
  const pidsFile = join(root, 'idle-pids.txt')
  writeFileSync(fixture, IDLE_TREE_FIXTURE)
  // marker 必须每次随机：写死的话探测命令自己就命中，测试会永远红。
  const marker = `RY_IDLE_TREE_${randomBytes(6).toString('hex')}`
  issuedMarkers.push(marker)
  probesActive += 1
  const slash = (path: string): string => path.replace(/\\/g, '/')
  return {
    command: `node "${slash(fixture)}" "${slash(pidsFile)}" ${depth} ${marker}`,
    marker,
    pidsFile,
  }
}

function readPids(pidsFile: string): number[] {
  if (!existsSync(pidsFile)) return []
  return readFileSync(pidsFile, 'utf8')
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 等夹具把自己和它拉起的子孙都登记完；命令提前结束就返回已登记的那些。 */
async function awaitPids(pidsFile: string, expected: number, settled: Promise<unknown>): Promise<number[]> {
  let finished = false
  void settled.then(() => {
    finished = true
  })
  const deadline = Date.now() + 10_000
  while (!finished && Date.now() < deadline) {
    const pids = readPids(pidsFile)
    if (pids.length >= expected) return pids
    await delay(50)
  }
  return readPids(pidsFile)
}

interface SurvivingProcess {
  pid: number
  commandLine: string
}

function describeHit(hit: SurvivingProcess): string {
  return `pid=${hit.pid} cmd=${hit.commandLine}`
}

function capture(file: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: { ...process.env, ...env }, windowsHide: true })
    const out = child.stdout
    if (out === null) {
      resolve('')
      return
    }
    let text = ''
    out.setEncoding('utf8')
    out.on('data', (chunk: string) => {
      text += chunk
    })
    child.on('error', reject)
    child.on('close', () => {
      resolve(text)
    })
  })
}

/**
 * 列出命令行里带 marker 的存活进程。
 *
 * marker 走环境变量而不拼进探测命令：拼进去的话 powershell/ps 自己就命中，测试永远红。
 * Windows 上 wmic 在新版系统已被移除，这里走 PowerShell 的 CIM。
 */
async function findMarkedProcesses(markers: readonly string[]): Promise<SurvivingProcess[]> {
  const hits: SurvivingProcess[] = []
  for (const marker of markers) {
    if (process.platform === 'win32') {
      const script =
        'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:RY_PROBE_MARKER) } | ForEach-Object { $_.ProcessId.ToString() + "::" + $_.CommandLine }'
      const out = await capture('powershell', ['-NoProfile', '-Command', script], { RY_PROBE_MARKER: marker })
      for (const line of out.split('\n')) {
        const at = line.indexOf('::')
        if (at > 0) hits.push({ pid: Number(line.slice(0, at)), commandLine: line.slice(at + 2).trim() })
      }
      continue
    }
    const out = await capture('ps', ['-Ao', 'pid=,args='], {})
    for (const line of out.split('\n')) {
      const trimmed = line.trim()
      const at = trimmed.indexOf(' ')
      if (at > 0 && trimmed.includes(marker)) {
        hits.push({ pid: Number(trimmed.slice(0, at)), commandLine: trimmed.slice(at + 1) })
      }
    }
  }
  return hits
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 轮询到「登记过的 pid 全都不在了，且没有进程再带着 marker」为止。
 *
 * 终止是异步的：taskkill 返回时进程未必已经从系统表里消失，所以只能轮询。
 * 超时就把证据（pid + 命令行）原样返回，交给断言报错。
 */
async function waitNoSurvivors(pids: readonly number[], markers: readonly string[]): Promise<string> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const marked = await findMarkedProcesses(markers)
    const alive = pids.filter(isAlive)
    if (marked.length === 0 && alive.length === 0) return ''
    if (Date.now() >= deadline) {
      return [
        ...marked.map(describeHit),
        ...alive.filter((pid) => !marked.some((hit) => hit.pid === pid)).map((pid) => `pid=${pid}`),
      ].join('\n')
    }
    await delay(200)
  }
}

/** 无条件把探针残留收干净，并记账。 */
async function reapMarkedProcesses(): Promise<void> {
  for (const hit of await findMarkedProcesses(issuedMarkers)) {
    reaped.push(describeHit(hit))
    if (process.platform === 'win32') {
      await capture('taskkill', ['/pid', String(hit.pid), '/T', '/F'], {})
      continue
    }
    try {
      process.kill(hit.pid, 'SIGKILL')
    } catch {
      // 已经自己走了。
    }
  }
}

describe('resolveInWorkspace', () => {
  it('resolves relative paths inside the root and rejects escapes', () => {
    const { root } = workspace()
    expect(resolveInWorkspace(root, 'a/b.txt')).toBe(join(root, 'a', 'b.txt'))
    expect(() => {
      resolveInWorkspace(root, '../evil.txt')
    }).toThrow(PathEscapeError)
    expect(() => {
      resolveInWorkspace(root, 'a/../../evil.txt')
    }).toThrow(/escapes/)
    expect(resolveInWorkspace(root, root)).toBe(root)
  })
})

describe('fs_read / fs_write', () => {
  it('writes and reads back a file, creating parent directories', async () => {
    const { root, ctx } = workspace()
    const wrote = await fsWrite.execute({ path: 'notes/daily.md', content: '# hello' }, ctx)
    expect(wrote.isError).toBeUndefined()
    expect(readFileSync(join(root, 'notes', 'daily.md'), 'utf8')).toBe('# hello')
    const read = await fsRead.execute({ path: 'notes/daily.md' }, ctx)
    expect(read.content).toBe('# hello')
  })

  it('rejects paths that escape the workspace', async () => {
    const { ctx } = workspace()
    const wrote = await fsWrite.execute({ path: '../outside.txt', content: 'x' }, ctx)
    expect(wrote.isError).toBe(true)
    const read = await fsRead.execute({ path: '../../etc/passwd' }, ctx)
    expect(read.isError).toBe(true)
  })

  it('reports missing files as errors', async () => {
    const { ctx } = workspace()
    const result = await fsRead.execute({ path: 'nope.txt' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not found')
  })

  it('truncates very long files', async () => {
    const { ctx } = workspace()
    await fsWrite.execute({ path: 'big.txt', content: 'x'.repeat(100_000) }, ctx)
    const read = await fsRead.execute({ path: 'big.txt' }, ctx)
    expect(read.content).toContain('[truncated:')
  })

  it('超大文件只读开头窗口（不整文件入内存），截断标注真实文件大小', async () => {
    const { root, ctx } = workspace()
    // 100k 个 CJK 字符 ≈ 300KB，超过 256KB 读窗口。
    writeFileSync(join(root, 'huge.txt'), '汉'.repeat(100_000))
    const read = await fsRead.execute({ path: 'huge.txt' }, ctx)
    expect(read.content).toContain('[truncated: file is 300000 bytes')
    expect(read.content.length).toBeLessThan(70_000)
  })
})

describe('shell_exec', () => {
  it('runs a simple command in the workspace', async () => {
    const { root, ctx } = workspace()
    writeFileSync(join(root, 'marker.txt'), 'hi')
    const result = await shellExec.execute({ command: 'ls' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('marker.txt')
  })

  it('captures stdout of echo-level commands', async () => {
    const { ctx } = workspace()
    const result = await shellExec.execute({ command: 'echo hello-ryharness' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('hello-ryharness')
  })

  it('reports failures without throwing', async () => {
    const { ctx } = workspace()
    const result = await shellExec.execute({ command: 'exit 3' }, ctx)
    expect(result.isError).toBe(true)
  })

  it('times out long-running commands', async () => {
    const { ctx } = workspace()
    const result = await shellExec.execute({ command: 'sleep 5', timeoutMs: 300 }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('timed out')
  }, 10_000)

  it('取消时立刻结束，且按进程树收干净（不留孤儿进程）', async () => {
    const { root, ctx } = workspace()
    const { command, marker, pidsFile } = idleTree(root, 1)
    const controller = new AbortController()
    const started = Date.now()
    const pending = shellExec.execute({ command, timeoutMs: 20_000 }, { ...ctx, signal: controller.signal })
    const pids = await awaitPids(pidsFile, 2, pending)
    // 夹具没把两层都登记齐，说明探针压根没起来，后面的存活断言全是空的。
    expect(pids).toHaveLength(2)
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content).toContain('aborted')
    // 这条命令没有出口：秒回即证明等待被取消打断，而不是等子进程跑完。
    expect(Date.now() - started).toBeLessThan(5_000)
    // 只断言 promise settle 是不够的：泄漏发生时本用例照样绿，门禁看不见。
    const leaked = await waitNoSurvivors(pids, [marker])
    expect(leaked, `取消之后仍有进程存活：\n${leaked}`).toBe('')
  }, 30_000)

  it('超时时按进程树收干净，不留孤儿进程', async () => {
    const { root, ctx } = workspace()
    const { command, marker, pidsFile } = idleTree(root, 1)
    const pending = shellExec.execute({ command, timeoutMs: 5_000 }, ctx)
    const pids = await awaitPids(pidsFile, 2, pending)
    expect(pids).toHaveLength(2)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content).toContain('timed out')
    const leaked = await waitNoSurvivors(pids, [marker])
    expect(leaked, `超时之后仍有进程存活：\n${leaked}`).toBe('')
  }, 30_000)

  it('已取消时直接拒绝执行（四个工具都不产生副作用）', async () => {
    const { root, ctx } = workspace()
    const controller = new AbortController()
    controller.abort()
    const cancelled = { ...ctx, signal: controller.signal }
    await expect(shellExec.execute({ command: 'ls' }, cancelled)).rejects.toThrow(/aborted/i)
    await expect(fsWrite.execute({ path: 'nope.txt', content: 'x' }, cancelled)).rejects.toThrow(/aborted/i)
    await expect(fsRead.execute({ path: 'nope.txt' }, cancelled)).rejects.toThrow(/aborted/i)
    await expect(fileProduce.execute({ name: 'out.md', content: 'x' }, cancelled)).rejects.toThrow(/aborted/i)
    expect(existsSync(join(root, 'nope.txt'))).toBe(false)
    expect(existsSync(join(root, '.ryharness-artifacts', 'out.md'))).toBe(false)
  })
})

describe('file_produce', () => {
  it('writes into the artifacts dir and returns a produce card', async () => {
    const { root, ctx } = workspace()
    const result = await fileProduce.execute({ name: 'report.md', content: '# 周报' }, ctx)
    expect(result.isError).toBeUndefined()
    const card = result.produce
    expect(card).toBeDefined()
    expect(card!.name).toBe('report.md')
    expect(card!.mime).toBe('text/markdown')
    expect(card!.size).toBe(Buffer.byteLength('# 周报', 'utf8'))
    expect(card!.path.startsWith(root)).toBe(true)
    expect(readFileSync(card!.path, 'utf8')).toBe('# 周报')
  })

  it('rejects path components in the file name', async () => {
    const { ctx } = workspace()
    await expect(fileProduce.execute({ name: 'a/../../evil.txt', content: 'x' }, ctx)).rejects.toThrow(/leaf|invalid/)
  })

  it('falls back to octet-stream for unknown extensions', async () => {
    const { ctx } = workspace()
    const result = await fileProduce.execute({ name: 'data.unknownext', content: 'x' }, ctx)
    expect(result.produce!.mime).toBe('application/octet-stream')
  })
})
