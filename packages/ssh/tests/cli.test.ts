/**
 * SSH 命令行后端：拿假 ssh 后端把整套流程走一遍。
 *
 * 断言的都是**外部可见的事实**：命令行长什么样、密码在不在 argv 里、退出码对不对、
 * 超时有没有把进程收掉、越界的路径有没有被挡住。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ignoreStreamError } from '../src/cli.ts'
import { CliSshConnection, classifyRemoteFailure, errorCode, isSshError, SshError } from '../src/index.ts'
import { createFakeSsh, type FakeSsh } from './helpers.ts'

/** 当前测试用的假 ssh（每个用例结束后收掉临时目录）。 */
let fake: FakeSsh | undefined

afterEach(() => {
  fake?.dispose()
  fake = undefined
})

/** 造一条连着假 ssh 的连接。 */
function connect(options: Partial<ConstructorParameters<typeof CliSshConnection>[0]> = {}): {
  connection: CliSshConnection
  fake: FakeSsh
} {
  const backend = createFakeSsh()
  fake = backend
  const connection = new CliSshConnection({
    host: 'deploy@example.com',
    spawn: backend.spawn,
    ...options,
  })
  return { connection, fake: backend }
}

/** 抓住一次失败，返回它的错误码。 */
async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    if (isSshError(error)) return error.code
    return undefined
  }
}

describe('远程命令执行', () => {
  it('跑通：返回退出码与输出', async () => {
    const { connection, fake: backend } = connect()
    backend.setPlan({ stdout: 'hello\n', exitCode: 0 })

    const result = await connection.exec('echo hello')

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello\n')
    expect(result.stderr).toBe('')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('命令行形状是 选项 + 目标 + -- + 命令', async () => {
    const { connection, fake: backend } = connect({ port: 2222 })
    backend.setPlan({ stdout: '' })

    await connection.exec('echo hello')

    const record = backend.records()[0]
    const args = record?.args ?? []
    expect(args).toContain('--')
    expect(args).toContain('deploy@example.com')
    expect(args[args.length - 1]).toBe('echo hello')
    expect(args).toContain('-p')
    expect(args).toContain('2222')
  })

  it('远端非零退出 → REMOTE_FAILED（说清退出码与原因）', async () => {
    const { connection, fake: backend } = connect()
    backend.setPlan({ exitCode: 3, stderr: 'boom: 没有那个文件\n' })

    let caught: unknown
    try {
      await connection.exec('cat missing')
    } catch (error) {
      caught = error
    }
    expect(isSshError(caught, 'REMOTE_FAILED')).toBe(true)
    expect((caught as SshError).message).toContain('3')
    expect((caught as SshError).message).toContain('boom')
    expect((caught as SshError).exitCode).toBe(3)
  })

  it('rejectOnNonZeroExit=false：非零退出不抛，返回退出码', async () => {
    const { connection, fake: backend } = connect()
    backend.setPlan({ exitCode: 1, stderr: '没匹配到\n' })

    const result = await connection.exec('grep x file', { rejectOnNonZeroExit: false })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('没匹配到\n')
  })

  it('远端没有这个命令（127）→ COMMAND_NOT_FOUND', async () => {
    const { connection, fake: backend } = connect()
    backend.setPlan({ exitCode: 127, stderr: 'sh: nope: command not found\n' })

    expect(await codeOf(() => connection.exec('nope'))).toBe('COMMAND_NOT_FOUND')
  })

  it('认证失败 → AUTH_FAILED', async () => {
    const { connection, fake: backend } = connect()
    backend.setPlan({ exitCode: 255, stderr: 'deploy@example.com: Permission denied (publickey).\n' })

    expect(await codeOf(() => connection.exec('true'))).toBe('AUTH_FAILED')
  })

  it('连不上 → CONNECT_FAILED', async () => {
    const { connection, fake: backend } = connect()
    backend.setPlan({ exitCode: 255, stderr: 'ssh: connect to host example.com port 22: Connection refused\n' })

    expect(await codeOf(() => connection.exec('true'))).toBe('CONNECT_FAILED')
  })

  it('连接断了 → CONNECTION_LOST（不是「命令没输出」）', async () => {
    const { connection, fake: backend } = connect()
    backend.setPlan({ exitCode: 255, stderr: 'Connection closed by remote host\n' })

    let caught: unknown
    try {
      await connection.exec('sleep 100')
    } catch (error) {
      caught = error
    }
    expect(isSshError(caught, 'CONNECTION_LOST')).toBe(true)
    expect((caught as SshError).message).toContain('没跑完')
  })

  it('远端目录不存在（66）→ REMOTE_NOT_FOUND', async () => {
    const { connection, fake: backend } = connect()
    backend.setPlan({ exitCode: 66, stderr: '' })

    expect(await codeOf(() => connection.list('/nope'))).toBe('REMOTE_NOT_FOUND')
  })

  it('退出码 255 但看不出原因 → 也算连不上', async () => {
    const { connection, fake: backend } = connect()
    backend.setPlan({ exitCode: 255, stderr: 'ssh: 说不上来为什么\n' })

    expect(await codeOf(() => connection.exec('true'))).toBe('CONNECT_FAILED')
  })

  it('远端没给任何说明 → 错误文案里说清楚「没有更多说明」', async () => {
    const { connection, fake: backend } = connect()
    backend.setPlan({ exitCode: 2, stderr: '' })

    let caught: unknown
    try {
      await connection.exec('false')
    } catch (error) {
      caught = error
    }
    expect((caught as SshError).message).toContain('远端没有给出更多说明')
  })

  it('输出超过上限：截断并标出来', async () => {
    const { connection, fake: backend } = connect()
    backend.setPlan({ stdout: 'x'.repeat(100) })

    const result = await connection.exec('cat big', { maxOutputBytes: 10 })

    expect(result.stdoutTruncated).toBe(true)
    expect(result.stdout.length).toBe(10)
  })

  it('超时 → TIMEOUT，并且不等远端自己结束', async () => {
    const { connection, fake: backend } = connect()
    backend.setPlan({ stdout: '', delayMs: 5_000 })

    const startedAt = Date.now()
    const code = await codeOf(() => connection.exec('sleep 100', { timeoutMs: 200 }))
    const elapsed = Date.now() - startedAt

    expect(code).toBe('TIMEOUT')
    expect(elapsed).toBeLessThan(4_000)
  })

  it('取消 → CANCELLED', async () => {
    const { connection, fake: backend } = connect()
    backend.setPlan({ stdout: '', delayMs: 5_000 })
    const controller = new AbortController()

    const pending = codeOf(() => connection.exec('sleep 100', { signal: controller.signal }))
    setTimeout(() => controller.abort(), 50)

    expect(await pending).toBe('CANCELLED')
  })

  it('开始前就取消了：根本不启动 ssh', async () => {
    const { connection, fake: backend } = connect()
    const controller = new AbortController()
    controller.abort()

    expect(await codeOf(() => connection.exec('true', { signal: controller.signal }))).toBe('CANCELLED')
    expect(backend.records()).toHaveLength(0)
  })

  it('给了 cwd：命令前先切目录', async () => {
    const { connection, fake: backend } = connect({ root: '/srv/work' })
    backend.setPlan({ stdout: '' })

    await connection.exec('ls', { cwd: 'sub' })

    const record = backend.records()[0]
    const args = record?.args ?? []
    expect(args[args.length - 1]).toBe("cd '/srv/work/sub' || exit 66; ls")
  })
})

describe('远端文件读写', () => {
  it('写文件：内容走 base64 管道', async () => {
    const { connection, fake: backend } = connect({ root: '/srv/work' })
    backend.setPlan({ stdout: '' })

    await connection.writeFile('notes/a.txt', 'hello 世界')

    const record = backend.records()[0]
    const decoded = Buffer.from(record?.stdin.trim() ?? '', 'base64').toString('utf8')
    expect(decoded).toBe('hello 世界')
    const args = record?.args ?? []
    expect(args[args.length - 1]).toBe("base64 -d > '/srv/work/notes/a.txt'")
  })

  it('写文件：路径越界 → PATH_OUTSIDE_ROOT，且不启动 ssh', async () => {
    const { connection, fake: backend } = connect({ root: '/srv/work' })

    expect(await codeOf(() => connection.writeFile('../etc/passwd', 'x'))).toBe('PATH_OUTSIDE_ROOT')
    expect(backend.records()).toHaveLength(0)
  })

  it('读文件：解出内容', async () => {
    const { connection, fake: backend } = connect({ root: '/srv/work' })
    backend.setPlan({ stdout: Buffer.from('你好', 'utf8').toString('base64') })

    const bytes = await connection.readFile('a.txt')

    expect(new TextDecoder().decode(bytes)).toBe('你好')
    const args = backend.records()[0]?.args ?? []
    expect(args[args.length - 1]).toBe("base64 < '/srv/work/a.txt'")
  })

  it('读文件：超过上限就说「没读全」，不返回半截内容', async () => {
    const { connection, fake: backend } = connect({ root: '/srv/work' })
    backend.setPlan({ stdout: Buffer.from('x'.repeat(500), 'utf8').toString('base64') })

    let caught: unknown
    try {
      await connection.readFile('big.txt', { maxBytes: 10 })
    } catch (error) {
      caught = error
    }
    expect(isSshError(caught, 'REMOTE_FAILED')).toBe(true)
    expect((caught as SshError).message).toContain('没读全')
  })

  it('列目录：解析出条目', async () => {
    const { connection, fake: backend } = connect({ root: '/srv/work' })
    backend.setPlan({ stdout: 'f\t10\ta.txt\nd\t-\tsub\n' })

    const entries = await connection.list('.')

    expect(entries).toHaveLength(2)
    expect(entries[0]?.name).toBe('a.txt')
    expect(entries[0]?.kind).toBe('file')
    expect(entries[1]?.kind).toBe('directory')
  })
})

describe('凭据与主机名', () => {
  it('密码不进 argv，只进环境', async () => {
    const { connection, fake: backend } = connect({
      credential: { kind: 'password', password: 'p@ss w0rd', askpass: '/opt/askpass' },
    })
    backend.setPlan({ stdout: '' })

    await connection.exec('true')

    const record = backend.records()[0]
    const args = record?.args ?? []
    expect(args.some((arg) => arg.includes('p@ss w0rd'))).toBe(false)
    expect(record?.env.SSH_ASKPASS).toBe('/opt/askpass')
    expect(record?.env.SSH_ASKPASS_REQUIRE).toBe('force')
    expect(record?.env.RY_SSH_PASSWORD).toBe('p@ss w0rd')
  })

  it('密码认证时不启用 BatchMode（否则问不到密码）', async () => {
    const { connection, fake: backend } = connect({
      credential: { kind: 'password', password: 'x', askpass: '/opt/askpass' },
    })
    backend.setPlan({ stdout: '' })

    await connection.exec('true')

    const args = backend.records()[0]?.args ?? []
    expect(args).not.toContain('BatchMode=yes')
    expect(args).toContain('PreferredAuthentications=password')
  })

  it('私钥只传路径，不传内容', async () => {
    const { connection, fake: backend } = connect({
      credential: { kind: 'key', identityFile: '/home/me/.ssh/id_ed25519' },
    })
    backend.setPlan({ stdout: '' })

    await connection.exec('true')

    const args = backend.records()[0]?.args ?? []
    expect(args).toContain('-i')
    expect(args).toContain('/home/me/.ssh/id_ed25519')
    expect(args).toContain('BatchMode=yes')
  })

  it('主机名带注入 → 直接拒绝，连接都建不起来', () => {
    expect(() => new CliSshConnection({ host: '-oProxyCommand=curl evil' })).toThrow(SshError)
  })

  it('本机没有 ssh 客户端 → SSH_CLIENT_MISSING', async () => {
    const connection = new CliSshConnection({
      host: 'example.com',
      sshPath: 'ry-ssh-no-such-binary-9f2a',
    })

    expect(await codeOf(() => connection.exec('true'))).toBe('SSH_CLIENT_MISSING')
  })

  it('关掉之后再用 → CONNECTION_CLOSED', async () => {
    const { connection } = connect()

    await connection.close()

    expect(await codeOf(() => connection.exec('true'))).toBe('CONNECTION_CLOSED')
  })

  it('关连接时在跑的命令：报「连接关了」，不是「远端失败」', async () => {
    const { connection, fake: backend } = connect()
    backend.setPlan({ stdout: '', delayMs: 5_000 })

    const pending = codeOf(() => connection.exec('sleep 100', { timeoutMs: 10_000 }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    await connection.close()

    expect(await pending).toBe('CONNECTION_CLOSED')
  })

  it('起 ssh 的时候就抛错 → SSH_CLIENT_MISSING', async () => {
    const connection = new CliSshConnection({
      host: 'example.com',
      spawn: () => {
        throw new Error('这台机器不让起 ssh')
      },
    })

    expect(await codeOf(() => connection.exec('true'))).toBe('SSH_CLIENT_MISSING')
  })

  it('连接级失败可以自己分类（拿原始结果调）', () => {
    const failure = classifyRemoteFailure(
      {
        exitCode: -1,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        signal: 'SIGTERM',
        durationMs: 10,
      },
      'sleep 100',
      'deploy@example.com',
    )

    expect(failure.code).toBe('CONNECTION_LOST')
    expect(failure.message).toContain('SIGTERM')
  })

  it('读错误上的 code：不是对象、没有 code、code 不是字符串', () => {
    expect(errorCode(new Error('x'))).toBeUndefined()
    expect(errorCode('x')).toBeUndefined()
    expect(errorCode({ code: 5 })).toBeUndefined()
    expect(errorCode({ code: 'ENOENT' })).toBe('ENOENT')
  })

  it('给了默认时限 → 命令行里带上 ConnectTimeout', async () => {
    const { connection, fake: backend } = connect({ defaultTimeoutMs: 5_000 })
    backend.setPlan({ stdout: '' })

    await connection.exec('true')

    expect(backend.records()[0]?.args ?? []).toContain('ConnectTimeout=5')
  })

  it('isSshError 不给码时只判类型', () => {
    expect(isSshError(new SshError('TIMEOUT', '超时了'))).toBe(true)
    expect(isSshError(new Error('别的错'))).toBe(false)
  })

  it('管道上的错误被忽略：远端提前退出时的 EPIPE 不该把进程带崩', () => {
    expect(ignoreStreamError(new Error('EPIPE'))).toBeUndefined()
  })
})
