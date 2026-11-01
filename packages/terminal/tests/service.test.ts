/**
 * 会话服务的单元测试：owner 围栏、不透明 id、生命周期、等待式清理。
 *
 * 用**假后端**跑这些用例：服务这一层管的是归属与生命周期，跟 shell 怎么跑无关，
 * 拿真 shell 来测只会让用例变慢又脆。真正起进程的用例在 `local.test.ts` 里。
 */
import { describe, expect, it } from 'vitest'
import {
  type TerminalBackend,
  type TerminalBackendSession,
  type TerminalBackendSpec,
  TerminalError,
  type TerminalReadResult,
  TerminalService,
} from '../src/index.ts'

/** 一个可控的假后端：记录收到的调用，输出由用例自己塞。 */
class FakeBackend implements TerminalBackend {
  /** 后端类型名。 */
  readonly type = 'fake'
  /** 能力声明。 */
  readonly capabilities = { realPty: false, fullScreenInteractive: false, notes: '假后端' }
  /** 已经开过的会话。 */
  readonly opened: FakeSession[] = []
  /** 起会话时要不要失败。 */
  failOnOpen = false
  /** 关会话时要不要失败。 */
  failOnClose = false

  async open(spec: TerminalBackendSpec): Promise<TerminalBackendSession> {
    if (this.failOnOpen) throw new Error('假后端：故意起不来')
    const session = new FakeSession(spec)
    this.opened.push(session)
    return session
  }
}

/** 假后端的会话句柄。 */
class FakeSession implements TerminalBackendSession {
  /** 方言。 */
  readonly dialect = 'pwsh' as const
  /** 顶层进程 pid。 */
  readonly pid = 4242
  /** 能力声明。 */
  readonly capabilities = { realPty: false, fullScreenInteractive: false, notes: '假后端' }
  /** 收到的输入。 */
  readonly sent: string[] = []
  /** 还没被读走的输出。 */
  output = 'hello'
  /** 关掉了没有。 */
  closed = false
  /** 等待时是否要报错。 */
  failOnClose = false
  /** 切目录时回报的目录。 */
  cwd = '/tmp'

  constructor(private readonly spec: TerminalBackendSpec) {}

  async waitReady(): Promise<void> {
    if (this.spec.sessionId.length === 0) throw new Error('没有会话 id')
  }

  async send(text: string): Promise<void> {
    this.sent.push(text)
  }

  async read(): Promise<TerminalReadResult> {
    const text = this.output
    this.output = ''
    return { text, bytes: Buffer.byteLength(text), truncated: false, remainingBytes: 0, droppedBytes: 0 }
  }

  async changeDirectory(path: string): Promise<string> {
    this.cwd = path
    return path
  }

  async interrupt(): Promise<void> {
    this.output = 'interrupted'
  }

  async closeInput(): Promise<void> {
    this.closed = true
  }

  async close(): Promise<void> {
    if (this.failOnClose) throw new Error('假后端：故意关不掉')
    this.closed = true
  }
}

/** 建一个带假后端的服务。 */
function makeService(): { service: TerminalService; backend: FakeBackend } {
  const backend = new FakeBackend()
  const service = new TerminalService({ backends: [backend] })
  return { service, backend }
}

describe('会话服务：owner 围栏', () => {
  it('同一个 owner 能取到自己开的会话', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', {})
    expect(service.get('agent-1', session.id).id).toBe(session.id)
  })

  it('别人的会话一律取不到', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', {})
    expect(() => service.get('agent-2', session.id)).toThrow(TerminalError)
    try {
      service.get('agent-2', session.id)
      expect.unreachable('不该取到别人的会话')
    } catch (error) {
      expect(error).toBeInstanceOf(TerminalError)
      expect((error as TerminalError).code).toBe('NO_SESSION')
    }
  })

  it('围栏是逐字比对：多一个空格、大小写不同、前缀相同都不算同一个 owner', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', {})
    for (const other of ['agent-1 ', ' agent-1', 'Agent-1', 'agent-11', 'agent', '']) {
      expect(() => service.get(other, session.id)).toThrow(TerminalError)
    }
  })

  it('list 只列自己的会话', async () => {
    const { service } = makeService()
    const mine = await service.open('agent-1', {})
    await service.open('agent-2', {})
    const listed = service.list('agent-1')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(mine.id)
  })

  it('别人的会话连 id 都不出现在列表里', async () => {
    const { service } = makeService()
    const theirs = await service.open('agent-2', {})
    expect(service.list('agent-1').map((s) => s.id)).not.toContain(theirs.id)
  })

  it('不存在的 id 与别人的 id 报同一个错（不泄露 id 是否存在）', async () => {
    const { service } = makeService()
    const theirs = await service.open('agent-2', {})
    let foreignCode = ''
    let missingCode = ''
    try {
      service.get('agent-1', theirs.id)
    } catch (error) {
      foreignCode = (error as TerminalError).code
    }
    try {
      service.get('agent-1', 'ffffffffffffffffffffffffffffffff')
    } catch (error) {
      missingCode = (error as TerminalError).code
    }
    expect(foreignCode).toBe(missingCode)
  })
})

describe('会话服务：不透明 id', () => {
  it('id 是随机十六进制，不含 owner 也不含序号', async () => {
    const { service } = makeService()
    const a = await service.open('agent-1', {})
    const b = await service.open('agent-1', {})
    expect(a.id).not.toBe(b.id)
    expect(a.id).not.toContain('agent-1')
    expect(a.id).toMatch(/^[0-9a-f]+$/)
  })

  it('id 长度够长，猜不中', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', {})
    expect(session.id.length).toBe(32)
  })
})

describe('会话服务：生命周期', () => {
  it('开出来的会话是 ready 状态，带着方言与 pid', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', {})
    expect(session.state).toBe('ready')
    expect(session.dialect).toBe('pwsh')
    expect(session.pid).toBe(4242)
    expect(session.backend).toBe('fake')
  })

  it('初始 cwd 是请求的目录，没有就用进程当前的', async () => {
    const { service } = makeService()
    const withCwd = await service.open('agent-1', { cwd: '/tmp/work' })
    expect(withCwd.cwd).toBe('/tmp/work')
    const without = await service.open('agent-1', {})
    expect(without.cwd).toBe(process.cwd())
  })

  it('注入的环境变量记在会话上（不含继承自宿主的）', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', { env: { RY_TEST: 'v' } })
    expect(session.env).toEqual({ RY_TEST: 'v' })
    expect(Object.keys(session.env)).not.toContain('PATH')
  })

  it('发过的命令进历史', async () => {
    const { service, backend } = makeService()
    const session = await service.open('agent-1', {})
    await service.send('agent-1', session.id, 'ls -la')
    await service.send('agent-1', session.id, 'pwd')
    expect(service.get('agent-1', session.id).history).toEqual(['ls -la', 'pwd'])
    expect(backend.opened[0]?.sent).toEqual(['ls -la', 'pwd'])
  })

  it('切目录后会话上的 cwd 跟着更新', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', {})
    await service.changeDirectory('agent-1', session.id, '/var/log')
    expect(service.get('agent-1', session.id).cwd).toBe('/var/log')
  })

  it('关掉的会话不再能被取到', async () => {
    const { service, backend } = makeService()
    const session = await service.open('agent-1', {})
    await service.close('agent-1', session.id)
    expect(() => service.get('agent-1', session.id)).toThrow(TerminalError)
    expect(backend.opened[0]?.closed).toBe(true)
  })

  it('关掉的会话上再发命令会被拒', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', {})
    await service.close('agent-1', session.id)
    await expect(service.send('agent-1', session.id, 'ls')).rejects.toThrow(TerminalError)
  })
})

describe('会话服务：等待式清理', () => {
  it('close 会等后端真的关完', async () => {
    const { service, backend } = makeService()
    const session = await service.open('agent-1', {})
    await service.close('agent-1', session.id)
    expect(backend.opened[0]?.closed).toBe(true)
  })

  it('disposeAll 把所有会话都收掉', async () => {
    const { service, backend } = makeService()
    await service.open('agent-1', {})
    await service.open('agent-2', {})
    await service.disposeAll()
    expect(backend.opened.every((s) => s.closed)).toBe(true)
    expect(service.list('agent-1')).toHaveLength(0)
    expect(service.list('agent-2')).toHaveLength(0)
  })

  it('关不掉就如实报错，不能假装关好了', async () => {
    const { service, backend } = makeService()
    const session = await service.open('agent-1', {})
    const fake = backend.opened[0]
    if (fake === undefined) throw new Error('没有开起来')
    fake.failOnClose = true
    await expect(service.close('agent-1', session.id)).rejects.toThrow(TerminalError)
    try {
      await service.close('agent-1', session.id)
    } catch (error) {
      expect((error as TerminalError).code).toBe('CLEANUP_FAILED')
    }
  })

  it('关不掉的会话仍然留在表里，还能再收一次', async () => {
    const { service, backend } = makeService()
    const session = await service.open('agent-1', {})
    const fake = backend.opened[0]
    if (fake === undefined) throw new Error('没有开起来')
    fake.failOnClose = true
    await expect(service.close('agent-1', session.id)).rejects.toThrow(TerminalError)
    // 没关干净就不能从表里摘掉：摘了这个会话就再也没法收它了。
    expect(() => service.get('agent-1', session.id)).not.toThrow()
    fake.failOnClose = false
    await service.close('agent-1', session.id)
    expect(() => service.get('agent-1', session.id)).toThrow(TerminalError)
  })

  it('起不来的后端不会留下半个会话', async () => {
    const { service, backend } = makeService()
    backend.failOnOpen = true
    await expect(service.open('agent-1', {})).rejects.toThrow(TerminalError)
    expect(service.list('agent-1')).toHaveLength(0)
  })

  it('要一个没有注册的后端时报 NO_BACKEND', async () => {
    const { service } = makeService()
    try {
      await service.open('agent-1', { backend: 'nonexistent' })
      expect.unreachable('不该开起来')
    } catch (error) {
      expect((error as TerminalError).code).toBe('NO_BACKEND')
    }
  })
})

describe('会话服务：并发发送', () => {
  it('同一个会话上第二次并发发送会被拒', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', {})
    const first = service.send('agent-1', session.id, 'slow-command')
    await expect(service.send('agent-1', session.id, 'another')).rejects.toThrow(TerminalError)
    await first
    // 前一次结束后还能再发。
    await expect(service.send('agent-1', session.id, 'third')).resolves.toBeUndefined()
  })
})
