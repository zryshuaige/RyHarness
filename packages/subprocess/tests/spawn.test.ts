/**
 * 托管 spawn：输出有界、环境干净、树收得干净、超时与取消会真的收进程。
 *
 * 这里跑的都是真的子进程（node 自己），不是替身——被测行为就是「操作系统真的
 * 发生了什么」，替身测不出来。
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalSubprocessProvider, spawnManaged } from '../src/index.ts'
import { isAlive, makeTempDir, waitUntil, writeFileIn } from './helpers.ts'

/** 打印一段 JSON 的 node 代码。 */
function jsonEval(expression: string): string {
  return `process.stdout.write(JSON.stringify(${expression}))`
}

describe('托管 spawn：输出与终态', () => {
  it('正常退出：stdout 收得到，退出码 0，终态 completed', async () => {
    const proc = spawnManaged({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("hello")'],
      resolve: false,
    })
    const result = await proc.done

    expect(result.status).toBe('completed')
    expect(result.stdout).toBe('hello')
    expect(result.exitCode).toBe(0)
    expect(result.stdoutTruncated).toBe(false)
    expect(result.stderr).toBe('')
    expect(proc.finished).toBe(true)
  })

  it('退出码非零：终态 failed，错误码 non-zero-exit，说明里带退出码', async () => {
    const proc = spawnManaged({
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      resolve: false,
    })
    const result = await proc.done

    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('non-zero-exit')
    expect(result.exitCode).toBe(3)
    expect(result.error?.message).toContain('3')
  })

  it('stderr 单独收，不混进 stdout', async () => {
    const proc = spawnManaged({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("bad")'],
      resolve: false,
    })
    const result = await proc.done

    expect(result.stderr).toBe('bad')
    expect(result.stdout).toBe('')
    expect(result.stderrBytes).toBe(3)
  })

  it('stdout 超限：截断到上限并标记，总字节数照实记', async () => {
    const proc = spawnManaged({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(5000))'],
      maxStdoutBytes: 100,
      resolve: false,
    })
    const result = await proc.done

    expect(result.stdout).toHaveLength(100)
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stdoutBytes).toBe(5000)
  })

  it('stderr 超限：同样截断并标记', async () => {
    const proc = spawnManaged({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("y".repeat(3000))'],
      maxStderrBytes: 50,
      resolve: false,
    })
    const result = await proc.done

    expect(result.stderr).toHaveLength(50)
    expect(result.stderrTruncated).toBe(true)
    expect(result.stderrBytes).toBe(3000)
  })

  it('没超限就不标截断', async () => {
    const proc = spawnManaged({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("short")'],
      maxStdoutBytes: 1000,
      resolve: false,
    })
    const result = await proc.done

    expect(result.stdoutTruncated).toBe(false)
    expect(result.stdoutBytes).toBe(5)
  })

  it('增量回调拿到的是实时片段，拼起来等于全文', async () => {
    const chunks: string[] = []
    const proc = spawnManaged({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("a"); process.stdout.write("b")'],
      resolve: false,
      onStdout: (chunk) => chunks.push(chunk),
    })
    await proc.done

    expect(chunks.join('')).toBe('ab')
  })
})

describe('托管 spawn：超时、取消与终止', () => {
  it('超时：到点收掉进程，终态 timeout，说明里带时限', async () => {
    const proc = spawnManaged({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      timeoutMs: 300,
      resolve: false,
    })
    const result = await proc.done

    expect(result.status).toBe('timeout')
    expect(result.error?.code).toBe('timeout')
    expect(result.error?.message).toContain('300')
  })

  it('超时之后进程真的没了（不是只改了状态）', async () => {
    const proc = spawnManaged({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      timeoutMs: 300,
      resolve: false,
    })
    await proc.done
    const pid = proc.pid

    expect(pid).toBeDefined()
    if (pid === undefined) return
    expect(await waitUntil(() => !isAlive(pid))).toBe(true)
  })

  it('取消：AbortSignal 一响就收，终态 aborted', async () => {
    const controller = new AbortController()
    const proc = spawnManaged({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      signal: controller.signal,
      resolve: false,
    })
    setTimeout(() => controller.abort(), 100)
    const result = await proc.done

    expect(result.status).toBe('aborted')
    expect(result.error?.code).toBe('aborted')
  })

  it('启动前就已取消：进程根本不启动', async () => {
    const controller = new AbortController()
    controller.abort()
    const proc = spawnManaged({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x")'],
      signal: controller.signal,
      resolve: false,
    })
    const result = await proc.done

    expect(result.status).toBe('aborted')
    expect(result.error?.code).toBe('aborted')
    expect(result.stdout).toBe('')
    expect(proc.pid).toBeUndefined()
  })

  it('显式 kill：终态 terminated，理由写进说明里', async () => {
    const proc = spawnManaged({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      resolve: false,
    })
    await proc.kill('用户按了停止')
    const result = await proc.done

    expect(result.status).toBe('terminated')
    expect(result.error?.code).toBe('terminated')
    expect(result.error?.message).toContain('用户按了停止')
  })
})

describe('托管 spawn：可执行查找与环境', () => {
  it('找不到可执行文件：给结构化原因，不是裸异常', async () => {
    const proc = spawnManaged({ command: 'ry-definitely-not-a-real-binary-xyz', args: [] })
    const result = await proc.done

    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('executable-not-found')
    expect(result.error?.message).toContain('ry-definitely-not-a-real-binary-xyz')
    expect(proc.pid).toBeUndefined()
  })

  it('路径不存在：启动失败也给结构化原因', async () => {
    const proc = spawnManaged({
      command: join(tmpdir(), 'ry-subprocess-no-such-binary-xyz'),
      args: [],
      resolve: false,
    })
    const result = await proc.done

    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('spawn-failed')
  })

  it('白名单之外的宿主变量传不进子进程', async () => {
    const provider = new LocalSubprocessProvider({
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        RY_HOST_SECRET: 'leak-me',
      },
    })
    const proc = provider.spawn({
      command: process.execPath,
      args: ['-e', jsonEval('{ secret: process.env.RY_HOST_SECRET ?? null, temp: process.env.TEMP ?? null }')],
      resolve: false,
    })
    const result = await proc.done
    const parsed = JSON.parse(result.stdout) as { secret: string | null; temp: string | null }

    expect(parsed.secret).toBeNull()
    expect(parsed.temp).not.toBeNull()
  })

  it('追加的环境变量确实进了子进程', async () => {
    const provider = new LocalSubprocessProvider({ env: { PATH: process.env.PATH ?? '' } })
    const proc = provider.spawn({
      command: process.execPath,
      args: ['-e', jsonEval('{ trace: process.env.RY_TRACE ?? null }')],
      env: { RY_TRACE: 'on' },
      resolve: false,
    })
    const result = await proc.done
    const parsed = JSON.parse(result.stdout) as { trace: string | null }

    expect(parsed.trace).toBe('on')
  })

  it('工作目录生效', async () => {
    const { dir, cleanup } = makeTempDir()
    try {
      const proc = spawnManaged({
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.cwd())'],
        cwd: dir,
        resolve: false,
      })
      const result = await proc.done
      const cwd = result.stdout.replace(/\\/g, '/').toLowerCase()
      const expected = dir.replace(/\\/g, '/').toLowerCase()

      expect(cwd).toContain(expected.split('/').pop() ?? expected)
    } finally {
      cleanup()
    }
  })
})

describe('托管 spawn：进程树回收', () => {
  it('子进程自己起的孙子进程也被收掉（不留孤儿）', async () => {
    // 被托管的进程会再起一个 node（孙子），把孙子 pid 打到 stdout 上。
    const code = [
      "import('node:child_process').then(({ spawn }) => {",
      "  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })",
      '  process.stdout.write(String(child.pid))',
      '  setTimeout(() => {}, 60000)',
      '})',
    ].join('\n')
    let grandchildPid = 0
    const proc = spawnManaged({
      command: process.execPath,
      args: ['-e', code],
      resolve: false,
      onStdout: (chunk) => {
        const matched = /(\d+)/.exec(chunk)
        if (matched !== null) grandchildPid = Number.parseInt(matched[1], 10)
      },
    })

    try {
      expect(await waitUntil(() => grandchildPid > 0)).toBe(true)
      expect(isAlive(grandchildPid)).toBe(true)

      await proc.kill('测试收树')

      expect(await waitUntil(() => !isAlive(grandchildPid))).toBe(true)
    } finally {
      if (grandchildPid > 0 && isAlive(grandchildPid)) {
        try {
          process.kill(grandchildPid, 'SIGKILL')
        } catch {
          // 已经没了就算了。
        }
      }
    }
  })
})

describe('托管 spawn：Windows 上的脚本宿主', () => {
  it.skipIf(process.platform !== 'win32')(
    '.cmd 脚本能跑起来（走 cmd.exe，参数带空格也不散）',
    async () => {
      const { dir, cleanup } = makeTempDir()
      try {
        const script = writeFileIn(dir, 'hello.cmd', '@echo off\r\necho ARGS:%*\r\n')
        const proc = spawnManaged({ command: script, args: ['one', 'two three'], resolve: false })
        const result = await proc.done

        expect(result.status).toBe('completed')
        expect(result.stdout).toContain('one')
        expect(result.stdout).toContain('two three')
      } finally {
        cleanup()
      }
    },
    90_000,
  )

  it.skipIf(process.platform !== 'win32')(
    '.ps1 脚本能跑起来（走 powershell）',
    async () => {
      const { dir, cleanup } = makeTempDir()
      try {
        const script = writeFileIn(dir, 'hello.ps1', 'Write-Output "PS-OK"\n')
        const proc = spawnManaged({ command: script, args: [], resolve: false })
        const result = await proc.done

        expect(result.status).toBe('completed')
        expect(result.stdout).toContain('PS-OK')
      } finally {
        cleanup()
      }
    },
    90_000,
  )
})
