import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@ryharness/agent'
import {
  findSensitiveInCommand,
  fsRead,
  fsWrite,
  setShellGuardPolicy,
  shellExec,
  shellGuardPolicy,
} from '@ryharness/tools'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
function workspace(): { root: string; ctx: ToolContext } {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-guard-'))
  roots.push(root)
  return { root, ctx: { workspaceRoot: root } }
}

/** 工作区之外的目录：用来验证写/读确实没穿透出去。 */
function outsideDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-outside-'))
  roots.push(dir)
  return dir
}

/** Windows 上 junction 不需要管理员权限，普通 symlink 需要；目录逃逸用 junction 就够。 */
function linkDir(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

afterEach(() => {
  setShellGuardPolicy()
  while (roots.length > 0) {
    try {
      rmSync(roots.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 残留目录落在系统临时区，不影响仓库。
    }
  }
})

describe('shell_exec 敏感路径闸', () => {
  it('默认开着（宿主不放开即拦截）', () => {
    expect(shellGuardPolicy().blockSensitivePaths).toBe(true)
  })

  it('命中凭据文件/目录的命令一律拒绝', () => {
    const blocked = [
      'cat .env',
      'cat ./.env.local',
      'type C:\\Users\\me\\.env',
      'cat api-keys.json',
      'cat ~/.ssh/id_rsa',
      'cat $HOME/.aws/credentials',
      'cat ../other-repo/.git/config',
      'git config --list',
      'git -C . config user.email',
      'cat deploy/prod-secret.json',
      'cat server.pem',
      'cat my.private_key',
      'cat ~/.netrc',
      'cat credentials',
    ]
    for (const command of blocked) {
      expect(findSensitiveInCommand(command), command).toBeDefined()
    }
  })

  it('不误伤日常命令与 .env 模板', () => {
    const allowed = [
      'ls',
      'echo hello-ryharness',
      'npm test',
      'cat .env.example',
      'cat docs/env.sample',
      'grep -rn secret src/',
      'git status',
      'git commit -m "fix token refresh"',
      'cat src/tokenizer.ts',
    ]
    for (const command of allowed) {
      expect(findSensitiveInCommand(command), command).toBeUndefined()
    }
  })

  it('命中即报错且不执行（连输出重定向都不落地）', async () => {
    const { root, ctx } = workspace()
    writeFileSync(join(root, 'marker.txt'), 'hi')
    const blocked = await shellExec.execute({ command: 'cat marker.txt > copied.txt' }, ctx)
    expect(blocked.isError).toBeUndefined()

    const denied = await shellExec.execute({ command: 'cat .env > leaked.txt' }, ctx)
    expect(denied.isError).toBe(true)
    expect(denied.content).toContain('shell_exec blocked')
    expect(denied.content).toContain('.env')
    expect(existsSync(join(root, 'leaked.txt'))).toBe(false)
  })

  it('默认拒绝读工作区外的凭据目录', async () => {
    const { ctx } = workspace()
    const denied = await shellExec.execute({ command: 'cat ~/.ssh/id_rsa' }, ctx)
    expect(denied.isError).toBe(true)
    expect(denied.content).toContain('.ssh/')
  })

  it('宿主显式放行后才执行（默认关闭的是"放开"这件事）', async () => {
    const { root, ctx } = workspace()
    writeFileSync(join(root, '.env'), 'TOKEN=abc')
    const policy = setShellGuardPolicy({ blockSensitivePaths: false })
    expect(policy.blockSensitivePaths).toBe(false)
    const allowed = await shellExec.execute({ command: 'cat .env' }, ctx)
    expect(allowed.isError).toBeUndefined()
    expect(allowed.content).toContain('TOKEN=abc')
  })

  it('工具入参关不掉闸（模型不能自己放开）', async () => {
    const { ctx } = workspace()
    const denied = await shellExec.execute({ command: 'cat .env', allowSensitivePaths: true }, ctx)
    expect(denied.isError).toBe(true)
    expect(denied.content).toContain('shell_exec blocked')
  })

  it('宿主可追加环境相关的敏感片段', async () => {
    const { ctx } = workspace()
    setShellGuardPolicy({ extraSensitivePatterns: ['internal-host'] })
    const denied = await shellExec.execute({ command: 'ssh internal-host' }, ctx)
    expect(denied.isError).toBe(true)
    expect(denied.content).toContain('internal-host')
    // 整体替换而非增量：重置后自定义片段不再拦。
    setShellGuardPolicy()
    expect(findSensitiveInCommand('ssh internal-host')).toBeUndefined()
    const allowed = await shellExec.execute({ command: 'echo ssh internal-host' }, ctx)
    expect(allowed.isError).toBeUndefined()
    expect(allowed.content).toContain('ssh internal-host')
  })

  it('凭据命名规则独立于自定义片段（db-password.sql 默认就拦）', async () => {
    const { ctx } = workspace()
    const denied = await shellExec.execute({ command: 'psql -f db-password.sql' }, ctx)
    expect(denied.isError).toBe(true)
    expect(denied.content).toContain('db-password.sql')
  })
})

describe('fs 工具的工作区边界（符号链接）', () => {
  it('工作区内的符号链接照常可用', async () => {
    const { root, ctx } = workspace()
    mkdirSync(join(root, 'real'), { recursive: true })
    writeFileSync(join(root, 'real', 'note.md'), '# ok')
    linkDir(join(root, 'real'), join(root, 'alias'))
    const read = await fsRead.execute({ path: 'alias/note.md' }, ctx)
    expect(read.isError).toBeUndefined()
    expect(read.content).toBe('# ok')
    const wrote = await fsWrite.execute({ path: 'alias/out.md', content: '写进去了' }, ctx)
    expect(wrote.isError).toBeUndefined()
    expect(readFileSync(join(root, 'real', 'out.md'), 'utf8')).toBe('写进去了')
  })

  it('指向工作区之外的链接读不到、写不进', async () => {
    const { root, ctx } = workspace()
    const outside = outsideDir()
    writeFileSync(join(outside, 'secret.txt'), '不该被读到')
    linkDir(outside, join(root, 'escape'))

    const read = await fsRead.execute({ path: 'escape/secret.txt' }, ctx)
    expect(read.isError).toBe(true)
    expect(read.content).toContain('escapes workspace root')

    const wrote = await fsWrite.execute({ path: 'escape/evil.txt', content: '穿透' }, ctx)
    expect(wrote.isError).toBe(true)
    expect(existsSync(join(outside, 'evil.txt'))).toBe(false)
  })

  it('链接逃逸在目标尚未存在时也拦得住（写入新建路径）', async () => {
    const { root, ctx } = workspace()
    const outside = outsideDir()
    linkDir(outside, join(root, 'escape'))
    const wrote = await fsWrite.execute({ path: 'escape/new/deep.txt', content: 'x' }, ctx)
    expect(wrote.isError).toBe(true)
    expect(existsSync(join(outside, 'new'))).toBe(false)
  })

  it('工作区根本身是链接时不误判（真实根参与比较）', async () => {
    const real = outsideDir()
    const { root } = workspace()
    linkDir(real, join(root, 'linked-root'))
    const ctx: ToolContext = { workspaceRoot: join(root, 'linked-root') }
    const wrote = await fsWrite.execute({ path: 'note.md', content: '写进去了' }, ctx)
    expect(wrote.isError).toBeUndefined()
    expect(readFileSync(join(real, 'note.md'), 'utf8')).toBe('写进去了')
  })
})
