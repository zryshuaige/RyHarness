/**
 * 沙箱：模式从哪儿来、一次操作能不能做、围栏长什么样。
 */
import { resolve } from 'node:path'
import {
  bubblewrapAvailable,
  bubblewrapConfinement,
  confine,
  ENV_ALLOWLIST,
  fenceConfinement,
  findOutsideWriteTarget,
  isSandboxMode,
  modeForTier,
  SANDBOX_MODES,
  SandboxPolicy,
  scrubEnv,
} from '@ryharness/sandbox'
import { describe, expect, it } from 'vitest'

const WORKSPACE = 'F:/work/space'

describe('档位 → 沙箱模式', () => {
  it('一一对应；没有档位时按工作区可写', () => {
    expect(modeForTier('read-only')).toBe('read-only')
    expect(modeForTier('workspace-write')).toBe('workspace-write')
    expect(modeForTier('full-access')).toBe('full-access')
    expect(modeForTier(undefined)).toBe('workspace-write')
  })
})

describe('模式优先级', () => {
  it('会话覆盖 > 助理档位 > 部署默认值', () => {
    const policy = new SandboxPolicy({ workspaceRoot: WORKSPACE, defaultMode: 'full-access' })
    expect(policy.modeFor({ agentId: 'a1', tier: 'read-only' })).toBe('read-only')
    policy.setConversationMode('c1', 'workspace-write')
    expect(policy.modeFor({ conversationId: 'c1', agentId: 'a1', tier: 'read-only' })).toBe('workspace-write')
    policy.clearConversationMode('c1')
    expect(policy.modeFor({ conversationId: 'c1', agentId: 'a1', tier: 'read-only' })).toBe('read-only')
    expect(policy.modeFor({ agentId: 'a2' })).toBe('full-access')
  })
})

describe('一次操作的判定', () => {
  it('只读：写文件与执行命令都拒，且说清能不能提权', () => {
    const policy = new SandboxPolicy({ workspaceRoot: WORKSPACE })
    const write = policy.decide(
      { operation: 'fs-write', path: `${WORKSPACE}/a.txt`, escalation: 'ask' },
      { tier: 'read-only' },
    )
    expect(write.allowed).toBe(false)
    if (write.allowed === false) {
      expect(write.canEscalate).toBe(true)
      expect(write.reason).toContain('只读')
    }
    const spawn = policy.decide({ operation: 'process-spawn', command: 'ls' }, { tier: 'read-only' })
    expect(spawn.allowed).toBe(false)
  })

  it('只读：读文件放行', () => {
    const policy = new SandboxPolicy({ workspaceRoot: WORKSPACE })
    expect(policy.decide({ operation: 'fs-read', path: `${WORKSPACE}/a.txt` }, { tier: 'read-only' }).allowed).toBe(
      true,
    )
  })

  it('工作区可写：写工作区内放行、写工作区外拒', () => {
    const policy = new SandboxPolicy({ workspaceRoot: WORKSPACE })
    expect(
      policy.decide({ operation: 'fs-write', path: `${WORKSPACE}/a.txt` }, { tier: 'workspace-write' }).allowed,
    ).toBe(true)
    const outside = policy.decide(
      { operation: 'fs-write', path: 'F:/work/elsewhere/a.txt' },
      { tier: 'workspace-write' },
    )
    expect(outside.allowed).toBe(false)
  })

  it('工作区可写：命令放行但要套围栏', () => {
    const policy = new SandboxPolicy({ workspaceRoot: WORKSPACE })
    const decision = policy.decide({ operation: 'process-spawn', command: 'ls' }, { tier: 'workspace-write' })
    expect(decision.allowed).toBe(true)
    if (decision.allowed) expect(decision.confined).toBe(true)
  })

  it('全权：放行且不套围栏', () => {
    const policy = new SandboxPolicy({ workspaceRoot: WORKSPACE })
    const decision = policy.decide({ operation: 'process-spawn', command: 'ls' }, { tier: 'full-access' })
    expect(decision.allowed).toBe(true)
    if (decision.allowed) expect(decision.confined).toBe(false)
  })
})

describe('围栏', () => {
  it('环境按白名单裁剪：模型凭据不在里面', () => {
    const scrubbed = scrubEnv({
      PATH: '/usr/bin',
      SILICONFLOW_API_KEY: 'sk-secret',
      HOME: '/home/u',
    })
    expect(scrubbed.PATH).toBe('/usr/bin')
    expect(scrubbed.HOME).toBe('/home/u')
    expect(scrubbed.SILICONFLOW_API_KEY).toBeUndefined()
    expect(ENV_ALLOWLIST).not.toContain('SILICONFLOW_API_KEY')
  })

  it('宿主明确要透传的环境变量照旧给出去', () => {
    const scrubbed = scrubEnv({ PATH: '/usr/bin' }, { MY_TOKEN: 't' })
    expect(scrubbed.MY_TOKEN).toBe('t')
  })

  it('bubblewrap：根目录只读、工作区可写、私有 /tmp', () => {
    const confined = bubblewrapConfinement({
      mode: 'workspace-write',
      workspaceRoot: WORKSPACE,
      command: '/bin/ls',
      args: ['-la'],
      env: { PATH: '/usr/bin' },
    })
    expect(confined.command).toBe('bwrap')
    expect(confined.kernelLevel).toBe(true)
    const args = confined.args.join(' ')
    expect(args).toContain('--ro-bind / /')
    expect(args).toContain(`--bind ${resolve(WORKSPACE)} ${resolve(WORKSPACE)}`)
    expect(args).toContain('--tmpfs /tmp')
    expect(args).toContain('--unshare-pid')
    // 被围起来的是原命令，不是我们自己的参数。
    expect(confined.args[confined.args.length - 2]).toBe('/bin/ls')
  })

  it('Windows 围栏：强度写明不是内核级', () => {
    const confined = fenceConfinement({
      mode: 'workspace-write',
      workspaceRoot: WORKSPACE,
      command: 'cmd.exe',
      args: ['/c', 'dir'],
      env: { PATH: 'C:/Windows', SILICONFLOW_API_KEY: 'sk-secret' },
    })
    expect(confined.kernelLevel).toBe(false)
    expect(confined.notes).toContain('内核级')
    expect(confined.env.SILICONFLOW_API_KEY).toBeUndefined()
  })

  it('全权不套围栏', () => {
    const confined = confine({
      mode: 'full-access',
      workspaceRoot: WORKSPACE,
      command: 'cmd.exe',
      args: [],
      env: { PATH: 'C:/Windows', SILICONFLOW_API_KEY: 'sk-secret' },
    })
    expect(confined.command).toBe('cmd.exe')
    expect(confined.env.SILICONFLOW_API_KEY).toBe('sk-secret')
  })
})

describe('越界写目标的启发式判定', () => {
  it('重定向到工作区外算越界', () => {
    expect(findOutsideWriteTarget('echo hi > F:/other/x.txt', WORKSPACE)).toBe('F:/other/x.txt')
    expect(findOutsideWriteTarget('echo hi > out.txt', WORKSPACE)).toBeUndefined()
  })

  it('写工作区里不算越界', () => {
    expect(findOutsideWriteTarget(`echo hi > ${WORKSPACE}/x.txt`, WORKSPACE)).toBeUndefined()
  })

  it('copy 的源在工作区、目标在外面也算', () => {
    expect(findOutsideWriteTarget(`copy ${WORKSPACE}/a.txt F:/other/b.txt`, WORKSPACE)).toBe('F:/other/b.txt')
  })

  it('引号包着的路径照样认得出', () => {
    expect(findOutsideWriteTarget(`echo hi > "F:/other/x.txt"`, WORKSPACE)).toBe('F:/other/x.txt')
  })

  it('>> 也是重定向；mv 的目标在工作区里不算', () => {
    expect(findOutsideWriteTarget(`echo hi >> F:/other/x.txt`, WORKSPACE)).toBe('F:/other/x.txt')
    expect(findOutsideWriteTarget(`mv ${WORKSPACE}/a.txt ${WORKSPACE}/b.txt`, WORKSPACE)).toBeUndefined()
  })

  it('命令里没有写目标时返回 undefined', () => {
    expect(findOutsideWriteTarget('ls -la', WORKSPACE)).toBeUndefined()
    expect(findOutsideWriteTarget('echo >', WORKSPACE)).toBeUndefined()
  })
})

describe('会话覆盖的存取', () => {
  it('覆盖写得进、读得出、撤得掉；撤掉后回到档位', () => {
    const policy = new SandboxPolicy({ workspaceRoot: WORKSPACE })
    expect(policy.conversationMode('c1')).toBeUndefined()
    policy.setConversationMode('c1', 'read-only')
    expect(policy.conversationMode('c1')).toBe('read-only')
    expect(policy.conversationOverrides()).toEqual({ c1: 'read-only' })
    policy.clearConversationMode('c1')
    expect(policy.conversationMode('c1')).toBeUndefined()
    expect(policy.conversationOverrides()).toEqual({})
  })

  it('模式清单与合法性判定', () => {
    expect(SANDBOX_MODES).toEqual(['read-only', 'workspace-write', 'full-access'])
    expect(isSandboxMode('read-only')).toBe(true)
    expect(isSandboxMode('whatever')).toBe(false)
    expect(isSandboxMode(undefined)).toBe(false)
    expect(isSandboxMode(3)).toBe(false)
  })
})

describe('围栏后端的选择', () => {
  it('bubblewrap 能不能用：探测要真跑一次', () => {
    // Windows 上永远 false（那是事实，不是缺陷）；POSIX 上按装没装 bwrap 走。
    expect(typeof bubblewrapAvailable()).toBe('boolean')
    if (process.platform === 'win32') expect(bubblewrapAvailable()).toBe(false)
  })

  it('宿主给了临时目录时把它单独挂成可写', () => {
    const confined = bubblewrapConfinement({
      mode: 'workspace-write',
      workspaceRoot: WORKSPACE,
      command: '/bin/ls',
      args: [],
      env: { PATH: '/usr/bin' },
      tempDir: '/tmp/ry',
    })
    const temp = resolve('/tmp/ry')
    expect(confined.args.join(' ')).toContain(`--bind ${temp} ${temp}`)
    // 插进去不能把工作区那对参数挤歪：bwrap 的「标志 + 值」是成对的。
    expect(confined.args.join(' ')).toContain(`--bind ${resolve(WORKSPACE)} ${resolve(WORKSPACE)}`)
  })

  it('要断网时加一条 --unshare-net', () => {
    const confined = bubblewrapConfinement({
      mode: 'workspace-write',
      workspaceRoot: WORKSPACE,
      command: '/bin/ls',
      args: [],
      env: {},
      isolateNetwork: true,
    })
    expect(confined.args).toContain('--unshare-net')
  })
})
