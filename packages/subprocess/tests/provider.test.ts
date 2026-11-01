/**
 * provider 抽象与**降级披露**。
 *
 * 这一组用例守的是上游 dsh 的一条规矩：provider 做不到什么必须说出来，
 * 因为宿主要拿这些话决定能不能把「已经收干净」说出口。
 */
import { describe, expect, it } from 'vitest'
import type {
  ExecutableResolution,
  ManagedProcess,
  ResolveExecutableOptions,
  SubprocessCapabilities,
  SubprocessProvider,
  SubprocessSpawnOptions,
} from '../src/index.ts'
import { LocalSubprocessProvider, localCapabilities, localProvider, SubprocessService } from '../src/index.ts'
import { fakeManagedProcess } from './helpers.ts'

/** 一个能力很弱的 provider 替身：只杀直接子进程，也不原生托管范围。 */
class WeakProvider implements SubprocessProvider {
  readonly id = 'weak'
  readonly capabilities: SubprocessCapabilities = {
    providerId: 'weak',
    treeKill: 'none',
    nativeManagedRange: false,
    boundedOutput: false,
    notes: ['弱 provider 只能杀直接子进程：进程树收不干净。'],
  }
  readonly seen: SubprocessSpawnOptions[] = []

  resolveExecutable(_options: ResolveExecutableOptions): ExecutableResolution {
    return { found: false, reason: 'not-found', searched: [], message: '弱 provider 不找文件。' }
  }

  spawn(options: SubprocessSpawnOptions): ManagedProcess {
    this.seen.push(options)
    return fakeManagedProcess({ command: options.command })
  }
}

describe('provider 与能力披露', () => {
  it('本机 provider 的 id 与能力位', () => {
    const provider = new LocalSubprocessProvider()

    expect(provider.id).toBe('local')
    expect(provider.capabilities.providerId).toBe('local')
    expect(provider.capabilities.boundedOutput).toBe(true)
    expect(localProvider.id).toBe('local')
  })

  it('进程树怎么收是分平台的：Windows 走 taskkill，POSIX 走进程组', () => {
    expect(localCapabilities('win32').treeKill).toBe('taskkill')
    expect(localCapabilities('linux').treeKill).toBe('process-group')
  })

  it('没有原生托管范围：必须说出来，不能装作有', () => {
    const win = localCapabilities('win32')
    const posix = localCapabilities('linux')

    expect(win.nativeManagedRange).toBe(false)
    expect(win.notes.join(' ')).toContain('Job Object')
    expect(posix.nativeManagedRange).toBe(false)
    expect(posix.notes.join(' ')).toContain('cgroup')
  })

  it('能力不足的 provider：降级说明原样透给调用方', () => {
    const service = new SubprocessService({ provider: new WeakProvider() })

    expect(service.capabilities.notes).toContain('弱 provider 只能杀直接子进程：进程树收不干净。')
    expect(service.capabilities.treeKill).toBe('none')
  })

  it('降级说明会挂到进程范围上：别让界面显示成「原子托管」', () => {
    const service = new SubprocessService({ provider: new WeakProvider() })
    const range = service.createRange('一组')

    expect(range.support).toBe('emulated')
    expect(range.notes).toContain('弱 provider 只能杀直接子进程：进程树收不干净。')
  })

  it('服务把默认值补齐之后再交给 provider', () => {
    const provider = new WeakProvider()
    const service = new SubprocessService({
      provider,
      defaultTimeoutMs: 1234,
      maxStdoutBytes: 10,
      maxStderrBytes: 20,
      envAllowlist: ['PATH'],
    })
    service.spawn({ command: 'demo' })

    expect(provider.seen).toHaveLength(1)
    expect(provider.seen[0].timeoutMs).toBe(1234)
    expect(provider.seen[0].maxStdoutBytes).toBe(10)
    expect(provider.seen[0].maxStderrBytes).toBe(20)
    expect(provider.seen[0].envAllowlist).toEqual(['PATH'])
  })

  it('调用方自己写的值不被默认值覆盖', () => {
    const provider = new WeakProvider()
    const service = new SubprocessService({ provider, defaultTimeoutMs: 1234 })
    service.spawn({ command: 'demo', timeoutMs: 50 })

    expect(provider.seen[0].timeoutMs).toBe(50)
  })

  it('服务下线：还活着的进程被收掉', async () => {
    const service = new SubprocessService()
    const proc = service.spawn({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      resolve: false,
    })

    expect(service.listAlive()).toHaveLength(1)
    await service.dispose()

    expect((await proc.done).status).toBe('terminated')
    expect(service.listAlive()).toHaveLength(0)
  })

  it('找可执行文件走 provider：弱 provider 说自己找不到', () => {
    const service = new SubprocessService({ provider: new WeakProvider() })
    const result = service.resolveExecutable({ name: 'demo' })

    expect(result.found).toBe(false)
    if (result.found) return
    expect(result.message).toContain('弱 provider 不找文件')
  })
})
