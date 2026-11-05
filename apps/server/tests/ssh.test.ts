/**
 * ssh 插件的用例：工具注册、主机清单、真实进程级的命令构造。
 *
 * 这一族盯的是三件事：
 * - 四件工具在不在清单里；
 * - 没配机器时工具说清楚「还没配」，不是空跑；
 * - **密码不进 argv**：命令行在 Linux 上是全局可读的，密码塞进去等于公开。
 *
 * 「命令构造」那几条用的是**真的进程**（包内的假 ssh 后端会真的起进程、真的
 * 记 argv 与环境变量），断言的是外部可见的事实。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-ssh-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

async function startServer(dataDir: string): Promise<RyHarnessServer> {
  return RyHarnessServer.create({
    port: 0,
    dataDir,
    memory: null,
    evolution: null,
    proactive: false,
  })
}

async function get(server: RyHarnessServer, path: string): Promise<Response> {
  return fetch(`${server.url}${path}`)
}

/** 在数据目录里写一份 ssh 配置。 */
function writeSshConfig(dataDir: string, hosts: unknown[]): void {
  mkdirSync(join(dataDir, 'config'), { recursive: true })
  writeFileSync(join(dataDir, 'config', 'ssh.json'), JSON.stringify({ hosts }), 'utf8')
}

describe('ssh 插件', () => {
  it('四件工具真的注册进工具清单', async () => {
    const server = await startServer(tempDir())
    try {
      const response = await get(server, '/api/tools')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { tools: Array<{ name: string }> }
      const names = body.tools.map((tool) => tool.name)
      expect(names).toContain('ssh_exec')
      expect(names).toContain('ssh_read')
      expect(names).toContain('ssh_write')
      expect(names).toContain('ssh_list')
    } finally {
      await server.close()
    }
  })

  it('插件清单里有它，声明的能力在运行时找得到', async () => {
    const server = await startServer(tempDir())
    try {
      const response = await get(server, '/api/plugins')
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        plugins: Array<{ id: string; enabled: boolean; missing?: string[] }>
      }
      const plugin = body.plugins.find((item) => item.id === 'ssh')
      expect(plugin).toBeDefined()
      expect(plugin?.enabled).toBe(true)
      expect(plugin?.missing ?? []).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('主机清单路由给出配好的机器', async () => {
    const dataDir = tempDir()
    writeSshConfig(dataDir, [{ id: 'web1', host: 'example.com', root: '/srv/app' }])
    const server = await startServer(dataDir)
    try {
      const response = await get(server, '/api/ssh/hosts')
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        hosts: Array<{ id: string; host: string; root?: string }>
      }
      expect(body.hosts).toHaveLength(1)
      expect(body.hosts[0]?.id).toBe('web1')
      expect(body.hosts[0]?.root).toBe('/srv/app')
    } finally {
      await server.close()
    }
  })

  it('没配机器时清单是空的，不是报错', async () => {
    const server = await startServer(tempDir())
    try {
      const response = await get(server, '/api/ssh/hosts')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { hosts: unknown[] }
      expect(body.hosts).toEqual([])
    } finally {
      await server.close()
    }
  })
})

describe('ssh 的边界（不联网）', () => {
  it('主机名以 - 开头会被拒（那是 ssh 的选项注入路径）', async () => {
    const { validateSshHost } = await import('@ryharness/ssh')
    expect(() => validateSshHost('-oProxyCommand=calc')).toThrow()
    expect(() => validateSshHost('host=evil')).toThrow()
    expect(() => validateSshHost('good-host.example.com')).not.toThrow()
  })

  it('路径越出远端根目录会被拒', async () => {
    const { resolveRemotePath } = await import('@ryharness/ssh')
    expect(() => resolveRemotePath('/srv/app', '../../etc/passwd')).toThrow()
    expect(resolveRemotePath('/srv/app', 'logs/a.txt')).toContain('/srv/app')
  })
})

describe('ssh 的真实进程级验证', () => {
  it('真的起一个 ssh 进程：argv 里没有密码，密码在环境里', async () => {
    const { CliSshConnection } = await import('@ryharness/ssh')
    const { createFakeSsh } = await import('../../../packages/ssh/tests/helpers.ts')
    const fake = createFakeSsh()
    try {
      fake.setPlan({ stdout: 'ok\n', exitCode: 0 })
      const connection = new CliSshConnection({
        host: 'example.com',
        credential: { kind: 'password', password: 'p@ss w0rd', askpass: '/opt/askpass' },
        spawn: fake.spawn,
      })
      const result = await connection.exec('echo hi')
      expect(result.stdout).toBe('ok\n')

      const records = fake.records()
      expect(records).toHaveLength(1)
      const record = records[0]
      // 密码**绝不能**出现在 argv 里。
      expect(record?.args.join(' ')).not.toContain('p@ss w0rd')
      // 助手路径进 argv，密码进环境。
      expect(record?.env.SSH_ASKPASS).toBe('/opt/askpass')
      expect(record?.env.RY_SSH_PASSWORD).toBe('p@ss w0rd')
      // 目标串在 `--` 之前，命令在 `--` 之后。
      const separator = record?.args.indexOf('--') ?? -1
      expect(separator).toBeGreaterThan(0)
      expect(record?.args[separator - 1]).toBe('example.com')
      expect(record?.args[separator + 1]).toBe('echo hi')
    } finally {
      fake.dispose()
    }
  })
})
