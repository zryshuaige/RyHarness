/**
 * 长驻进程的托管：起、登记、收。
 *
 * 这一族盯的是「进程树收得干净」与「输出有界时的处置」：
 * - 子进程起的孙进程也要收掉（不留孤儿）；
 * - 输出超过上限时**收掉进程**而不是截断——截断会破坏协议流；
 * - 服务下线时统一收。
 */
import { describe, expect, it } from 'vitest'
import { SubprocessService, spawnManagedStream } from '../src/index.ts'

/** 起一个会一直待着的子进程。 */
function longLivedScript(): string {
  return 'setInterval(() => {}, 1000)'
}

describe('长驻进程的托管', () => {
  it('起的进程真的活着，服务下线时被收掉', async () => {
    const service = new SubprocessService()
    const managed = service.spawnStream({
      command: process.execPath,
      args: ['-e', longLivedScript()],
      label: '测试用长驻进程',
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(managed.pid).toBeDefined()
    expect(managed.finished).toBe(false)

    await service.dispose()
    // 收完之后进程应该不在了。
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(managed.finished).toBe(true)
  })

  it('输出超过上限时收掉进程，而不是截断', async () => {
    // 这个子进程疯狂打印——协议流被截断就废了，只能收掉。
    const managed = spawnManagedStream(new SubprocessService().provider, {
      command: process.execPath,
      args: ['-e', 'while (true) { process.stdout.write("x".repeat(4096)) }'],
      maxOutputBytes: 8 * 1024,
      label: '刷屏的进程',
    })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(managed.finished).toBe(true)
  })

  it('进程自己退了，句柄如实报告结束', async () => {
    const managed = spawnManagedStream(new SubprocessService().provider, {
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    })
    await managed.done
    expect(managed.finished).toBe(true)
  })

  it('起不来的命令：spawn 立刻失败，不留一个假进程', async () => {
    const managed = spawnManagedStream(new SubprocessService().provider, {
      command: 'ryharness-definitely-not-a-real-command',
      args: [],
    })
    await managed.done
    expect(managed.finished).toBe(true)
  })

  it('kill 之后进程真的不在了', async () => {
    const managed = spawnManagedStream(new SubprocessService().provider, {
      command: process.execPath,
      args: ['-e', longLivedScript()],
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await managed.kill('测试收尾')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(managed.finished).toBe(true)
  })

  it('环境是洗过的：名字像密钥的变量不传下去', async () => {
    process.env.RYHARNESS_STREAM_TEST_SECRET = '不该被传下去'
    try {
      const managed = spawnManagedStream(new SubprocessService().provider, {
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.env.RYHARNESS_STREAM_TEST_SECRET ?? "空")'],
      })
      const chunks: Buffer[] = []
      managed.child.stdout?.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })
      await managed.done
      const output = Buffer.concat(chunks).toString('utf8')
      expect(output).not.toContain('不该被传下去')
    } finally {
      delete process.env.RYHARNESS_STREAM_TEST_SECRET
    }
  })
})
