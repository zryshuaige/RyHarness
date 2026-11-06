/**
 * 会话服务的单元测试：owner 隔离、有界、超时、高危动作要人点头、收尾。
 *
 * 用**假驱动**跑这些用例：服务这一层管的是归属与边界，跟桌面怎么驱动无关，
 * 拿真桌面来测只会让用例变慢又脆（本包本来也不带桌面自动化）。
 */
import { describe, expect, it } from 'vitest'
import type { ComputerAction, ComputerApprovalRequest, ComputerDriver } from '../src/index.ts'
import {
  ComputerSessionService,
  ComputerUseError,
  DANGEROUS_COMPUTER_ACTIONS,
  describeComputerAction,
  isComputerUseError,
  isDangerousComputerAction,
} from '../src/index.ts'

/** 一个可控的假驱动：记录收到的调用。 */
class FakeDriver implements ComputerDriver {
  readonly name = 'fake'
  readonly calls: string[] = []
  shot = new Uint8Array([1, 2, 3])
  /** 关掉时要不要失败。 */
  failOnClose = false
  /** 截图时要不要卡住（用来测超时）。 */
  hangOnScreenshot = false
  /** 点击时要不要失败。 */
  failOnClick = false

  async screenshot(): Promise<{ bytes: Uint8Array; mimeType: string; width?: number; height?: number }> {
    this.calls.push('screenshot')
    if (this.hangOnScreenshot) await new Promise((resolve) => setTimeout(resolve, 5_000))
    return { bytes: this.shot, mimeType: 'image/png', width: 1920, height: 1080 }
  }

  async click(x: number, y: number): Promise<void> {
    this.calls.push(`click:${x},${y}`)
    if (this.failOnClick) throw new Error('假驱动：故意点不动')
  }

  async type(text: string): Promise<void> {
    this.calls.push(`type:${text}`)
  }

  async key(name: string): Promise<void> {
    this.calls.push(`key:${name}`)
  }

  async move(x: number, y: number): Promise<void> {
    this.calls.push(`move:${x},${y}`)
  }

  async scroll(dx: number, dy: number): Promise<void> {
    this.calls.push(`scroll:${dx},${dy}`)
  }

  async close(): Promise<void> {
    this.calls.push('close')
    if (this.failOnClose) throw new Error('假驱动：故意关不掉')
  }
}

/**
 * 一个不守规矩的驱动：抛的不是 Error，是个字符串。
 *
 * 用来验「驱动出问题时，报错里也得有那句话」——把原因吞掉的话，宿主只看到一句
 * 「操作失败」，用户根本不知道是驱动炸了。
 */
class WeirdDriver extends FakeDriver {
  override async move(): Promise<void> {
    throw '就是字符串不是 Error'
  }
}

/** 建一个带假驱动的服务。 */ function makeService(
  options: {
    maxSessions?: number
    stepTimeoutMs?: number
    policy?: { requireApproval?: boolean; allowScreenshot?: boolean }
    approver?: (request: ComputerApprovalRequest) => Promise<boolean>
  } = {},
): { service: ComputerSessionService; drivers: FakeDriver[] } {
  const drivers: FakeDriver[] = []
  const service = new ComputerSessionService({
    driverFactory: () => {
      const driver = new FakeDriver()
      drivers.push(driver)
      return driver
    },
    ...options,
  })
  return { service, drivers }
}

describe('会话服务：owner 隔离', () => {
  it('同一个 owner 能取到自己开的会话', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1')
    expect(service.get('agent-1', session.id).id).toBe(session.id)
  })

  it('别人的会话一律取不到', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1')
    try {
      service.get('agent-2', session.id)
      expect.unreachable('不该取到别人的会话')
    } catch (error) {
      expect((error as ComputerUseError).code).toBe('NO_SESSION')
    }
  })

  it('围栏逐字比对：多一个空格、大小写不同、前缀相同都不算同一个 owner', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1')
    for (const other of ['agent-1 ', ' agent-1', 'Agent-1', 'agent-11', 'agent', '']) {
      expect(() => service.get(other, session.id)).toThrow(ComputerUseError)
    }
  })

  it('不存在的 id 与别人的 id 报同一个错（不泄露 id 是否存在）', async () => {
    const { service } = makeService()
    const theirs = await service.open('agent-2')
    let foreignCode = ''
    let missingCode = ''
    try {
      service.get('agent-1', theirs.id)
    } catch (error) {
      foreignCode = (error as ComputerUseError).code
    }
    try {
      service.get('agent-1', 'ffffffffffffffffffffffff')
    } catch (error) {
      missingCode = (error as ComputerUseError).code
    }
    expect(foreignCode).toBe(missingCode)
    expect(foreignCode).toBe('NO_SESSION')
  })

  it('list 只列自己的会话', async () => {
    const { service } = makeService()
    const mine = await service.open('agent-1')
    const theirs = await service.open('agent-2')
    expect(service.list('agent-1')).toHaveLength(1)
    expect(service.list('agent-1').map((s) => s.id)).not.toContain(theirs.id)
    expect(service.list('agent-1')[0]?.id).toBe(mine.id)
  })

  it('在别人的会话上做动作也被围栏挡住', async () => {
    const { service } = makeService({ approver: async () => true })
    const session = await service.open('agent-1')
    await expect(service.act('agent-2', session.id, { kind: 'move', x: 1, y: 1 })).rejects.toThrow(ComputerUseError)
  })
})

describe('会话服务：有界', () => {
  it('每个 owner 的会话数到上限就报 SESSION_LIMIT', async () => {
    const { service } = makeService({ maxSessions: 2 })
    await service.open('agent-1')
    await service.open('agent-1')
    try {
      await service.open('agent-1')
      expect.unreachable('不该超过会话上限')
    } catch (error) {
      expect((error as ComputerUseError).code).toBe('SESSION_LIMIT')
    }
  })

  it('会话上限是按 owner 算的：别人开满了也不影响我', async () => {
    const { service } = makeService({ maxSessions: 1 })
    await service.open('agent-2')
    const mine = await service.open('agent-1')
    expect(mine.owner).toBe('agent-1')
  })

  it('会话 id 是不透明的随机串', async () => {
    const { service } = makeService()
    const a = await service.open('agent-1')
    const b = await service.open('agent-1')
    expect(a.id).not.toBe(b.id)
    expect(a.id).not.toContain('agent-1')
    expect(a.id).toMatch(/^[0-9a-f]+$/)
  })
})

describe('安全边界：高危动作要人点头', () => {
  it('坐标点击默认被拒（没接确认回调）', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1')
    try {
      await service.act('agent-1', session.id, { kind: 'click', x: 800, y: 600 })
      expect.unreachable('坐标点击不该自己放行')
    } catch (error) {
      expect((error as ComputerUseError).code).toBe('APPROVAL_REQUIRED')
    }
  })

  it('打字与按键默认也被拒', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1')
    for (const action of [{ kind: 'type', text: '你好' } as const, { kind: 'key', key: 'Enter' } as const]) {
      try {
        await service.act('agent-1', session.id, action)
        expect.unreachable(`${action.kind} 不该自己放行`)
      } catch (error) {
        expect((error as ComputerUseError).code).toBe('APPROVAL_REQUIRED')
      }
    }
  })

  it('人点头之后动作才执行', async () => {
    const { service, drivers } = makeService({ approver: async () => true })
    const session = await service.open('agent-1')
    await service.act('agent-1', session.id, { kind: 'click', x: 800, y: 600 })
    expect(drivers[0]?.calls).toContain('click:800,600')
  })

  it('人拒绝时动作不执行', async () => {
    const { service, drivers } = makeService({ approver: async () => false })
    const session = await service.open('agent-1')
    try {
      await service.act('agent-1', session.id, { kind: 'click', x: 800, y: 600 })
      expect.unreachable('人拒绝了就不该执行')
    } catch (error) {
      expect((error as ComputerUseError).code).toBe('APPROVAL_REQUIRED')
    }
    expect(drivers[0]?.calls).not.toContain('click:800,600')
  })

  it('确认请求里带着坐标与一句中文描述，人能看懂批的是什么', async () => {
    const seen: ComputerApprovalRequest[] = []
    const { service } = makeService({
      approver: async (request) => {
        seen.push(request)
        return true
      },
    })
    const session = await service.open('agent-1')
    await service.act('agent-1', session.id, { kind: 'click', x: 800, y: 600 })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.x).toBe(800)
    expect(seen[0]?.y).toBe(600)
    expect(seen[0]?.kind).toBe('click')
    expect(seen[0]?.description).toContain('(800, 600)')
  })

  it('鼠标移动与滚动不算高危，不打扰人', async () => {
    let asked = 0
    const { service, drivers } = makeService({
      approver: async () => {
        asked += 1
        return true
      },
    })
    const session = await service.open('agent-1')
    await service.act('agent-1', session.id, { kind: 'move', x: 10, y: 20 })
    await service.act('agent-1', session.id, { kind: 'scroll', dx: 0, dy: 120 })
    expect(asked).toBe(0)
    expect(drivers[0]?.calls).toContain('move:10,20')
    expect(drivers[0]?.calls).toContain('scroll:0,120')
  })

  it('策略里把确认关掉之后，高危动作直接执行', async () => {
    const { service, drivers } = makeService({ policy: { requireApproval: false } })
    const session = await service.open('agent-1')
    await service.act('agent-1', session.id, { kind: 'click', x: 5, y: 6 })
    expect(drivers[0]?.calls).toContain('click:5,6')
  })

  it('危险动作清单就是 click / type / key 三样', () => {
    expect(DANGEROUS_COMPUTER_ACTIONS).toEqual(['click', 'type', 'key'])
    expect(isDangerousComputerAction('click')).toBe(true)
    expect(isDangerousComputerAction('type')).toBe(true)
    expect(isDangerousComputerAction('key')).toBe(true)
    expect(isDangerousComputerAction('move')).toBe(false)
    expect(isDangerousComputerAction('scroll')).toBe(false)
  })

  it('动作描述能说出人话（打字与按键各一句）', () => {
    expect(describeComputerAction({ kind: 'type', description: '', text: '你好' })).toContain('你好')
    expect(describeComputerAction({ kind: 'key', description: '', key: 'Enter' })).toContain('Enter')
  })

  it('动作描述对移动与滚动也说得清', () => {
    expect(describeComputerAction({ kind: 'move', description: '', x: 12, y: 34 })).toContain('(12, 34)')
    expect(describeComputerAction({ kind: 'scroll', description: '', dx: 0, dy: 120 })).toContain('(0, 120)')
  })
})

describe('安全边界：坐标与参数', () => {
  it('缺坐标或坐标是负数都报 INVALID_ARGUMENT', async () => {
    const { service } = makeService({ approver: async () => true })
    const session = await service.open('agent-1')
    for (const action of [
      { kind: 'click' } as const,
      { kind: 'click', x: -1, y: 5 } as const,
      { kind: 'click', x: 1.5, y: 5 } as const,
    ]) {
      try {
        await service.act('agent-1', session.id, action)
        expect.unreachable('坐标不对就该报错')
      } catch (error) {
        expect((error as ComputerUseError).code).toBe('INVALID_ARGUMENT')
      }
    }
  })

  it('type 缺文字、key 缺键名、scroll 缺 dx/dy 都报 INVALID_ARGUMENT', async () => {
    const { service } = makeService({ approver: async () => true })
    const session = await service.open('agent-1')
    for (const action of [{ kind: 'type' } as const, { kind: 'key' } as const, { kind: 'scroll' } as const]) {
      try {
        await service.act('agent-1', session.id, action)
        expect.unreachable('参数不对就该报错')
      } catch (error) {
        expect((error as ComputerUseError).code).toBe('INVALID_ARGUMENT')
      }
    }
  })

  it('不认识的 action.kind 报 INVALID_ARGUMENT，不当成「什么都没做也算成功」', async () => {
    const { service, drivers } = makeService({ approver: async () => true })
    const session = await service.open('agent-1')
    // 动作可能来自宿主解析出来的 JSON——编译期管不到 kind 的取值。
    // 认不出来的 kind 必须报错：下面那个分发 switch 没有 default 分支，
    // 放过去就会「什么都不做就返回」，调用方以为点成功了。
    for (const kind of ['drag', 'double-click', '', 'CLICK']) {
      try {
        await service.act('agent-1', session.id, { kind } as unknown as ComputerAction)
        expect.unreachable(`不认识的 kind「${kind}」就该报错`)
      } catch (error) {
        expect((error as ComputerUseError).code).toBe('INVALID_ARGUMENT')
        expect((error as ComputerUseError).message).toContain('不认识的动作种类')
      }
    }
    // 认不出来的时候也不能真的去驱动桌面。
    expect(drivers[0]?.calls ?? []).toEqual([])
  })
})

describe('安全边界：截图', () => {
  it('截图返回字节、mime 与屏幕尺寸', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1')
    const shot = await service.screenshot('agent-1', session.id)
    expect(shot.mimeType).toBe('image/png')
    expect([...shot.bytes]).toEqual([1, 2, 3])
    expect(shot.width).toBe(1920)
    expect(shot.height).toBe(1080)
  })

  it('策略关掉截图后报 SCREENSHOT_NOT_ALLOWED，不给空图', async () => {
    const { service } = makeService({ policy: { allowScreenshot: false } })
    const session = await service.open('agent-1')
    try {
      await service.screenshot('agent-1', session.id)
      expect.unreachable('截图关了就不该给图')
    } catch (error) {
      expect((error as ComputerUseError).code).toBe('SCREENSHOT_NOT_ALLOWED')
    }
  })
})

describe('会话服务：超时与结构化失败', () => {
  it('驱动卡住时按 TIMEOUT 报错', async () => {
    const service = new ComputerSessionService({
      driverFactory: () => {
        const driver = new FakeDriver()
        driver.hangOnScreenshot = true
        return driver
      },
      stepTimeoutMs: 50,
    })
    const session = await service.open('agent-1')
    try {
      await service.screenshot('agent-1', session.id)
      expect.unreachable('不该一直等下去')
    } catch (error) {
      expect((error as ComputerUseError).code).toBe('TIMEOUT')
    }
  })

  it('驱动内部出错时报 DRIVER_FAILED，并带上原始原因', async () => {
    const { service, drivers } = makeService({ approver: async () => true })
    const session = await service.open('agent-1')
    const driver = drivers[0]
    if (driver === undefined) throw new Error('没有开起来')
    driver.failOnClick = true
    try {
      await service.act('agent-1', session.id, { kind: 'click', x: 1, y: 1 })
      expect.unreachable('点不动就该报错')
    } catch (error) {
      expect((error as ComputerUseError).code).toBe('DRIVER_FAILED')
      expect((error as ComputerUseError).message).toContain('故意点不动')
    }
  })

  it('没装驱动时报 NO_DRIVER，不假装成功', async () => {
    const service = new ComputerSessionService()
    try {
      await service.open('agent-1')
      expect.unreachable('没驱动就不该开起来')
    } catch (error) {
      expect((error as ComputerUseError).code).toBe('NO_DRIVER')
    }
  })

  it('起驱动失败时报 DRIVER_FAILED，且不留半个会话', async () => {
    const service = new ComputerSessionService({
      driverFactory: () => {
        throw new Error('假驱动：故意起不来')
      },
    })
    await expect(service.open('agent-1')).rejects.toThrow(ComputerUseError)
    expect(service.list('agent-1')).toHaveLength(0)
  })

  it('驱动抛出不是 Error 的东西时，报错里也有那句话（不吞掉原因）', async () => {
    const service = new ComputerSessionService({
      driverFactory: () => new WeirdDriver(),
    })
    const session = await service.open('agent-1')
    try {
      await service.act('agent-1', session.id, { kind: 'move', x: 1, y: 1 })
      expect.unreachable('该报错')
    } catch (error) {
      expect((error as ComputerUseError).code).toBe('DRIVER_FAILED')
      expect((error as ComputerUseError).message).toContain('就是字符串不是 Error')
    }
  })
})

describe('会话服务：动作真的落到驱动上', () => {
  it('点头之后 type 与 key 都会落到驱动上', async () => {
    const { service, drivers } = makeService({ approver: async () => true })
    const session = await service.open('agent-1')
    await service.act('agent-1', session.id, { kind: 'type', text: '你好' })
    await service.act('agent-1', session.id, { kind: 'key', key: 'Enter' })
    expect(drivers[0]?.calls).toContain('type:你好')
    expect(drivers[0]?.calls).toContain('key:Enter')
  })

  it('策略快照是副本，改它不影响服务', async () => {
    const { service } = makeService()
    const snapshot = service.policy
    expect(snapshot).toEqual({ requireApproval: true, allowScreenshot: true })
    // 快照是副本：改它不能影响服务（字段本身是 readonly，测试里临时按可变看待）。
    const mutable = snapshot as { requireApproval: boolean }
    mutable.requireApproval = false
    expect(service.policy.requireApproval).toBe(true)
  })

  it('放行策略会被服务记住', async () => {
    const { service } = makeService({ policy: { allowScreenshot: false } })
    expect(service.policy.allowScreenshot).toBe(false)
    expect(service.policy.requireApproval).toBe(true)
  })
})

describe('会话服务：收尾', () => {
  it('close 会把驱机关掉', async () => {
    const { service, drivers } = makeService()
    const session = await service.open('agent-1')
    await service.close('agent-1', session.id)
    expect(drivers[0]?.calls).toContain('close')
    expect(service.list('agent-1')).toHaveLength(0)
  })

  it('disposeAll 把所有会话都收掉', async () => {
    const { service, drivers } = makeService()
    await service.open('agent-1')
    await service.open('agent-2')
    await service.disposeAll()
    expect(drivers.every((driver) => driver.calls.includes('close'))).toBe(true)
    expect(service.list('agent-1')).toHaveLength(0)
    expect(service.list('agent-2')).toHaveLength(0)
  })

  it('关不掉就如实报错，不能假装关好了', async () => {
    const { service, drivers } = makeService()
    const session = await service.open('agent-1')
    const driver = drivers[0]
    if (driver === undefined) throw new Error('没有开起来')
    driver.failOnClose = true
    try {
      await service.close('agent-1', session.id)
      expect.unreachable('关不掉就该报错')
    } catch (error) {
      expect((error as ComputerUseError).code).toBe('CLEANUP_FAILED')
    }
  })

  it('disposeAll 里有会话关不掉时报 CLEANUP_FAILED，并说清是哪个', async () => {
    const { service, drivers } = makeService()
    await service.open('agent-1')
    const driver = drivers[0]
    if (driver === undefined) throw new Error('没有开起来')
    driver.failOnClose = true
    try {
      await service.disposeAll()
      expect.unreachable('关不掉就该报错')
    } catch (error) {
      expect((error as ComputerUseError).code).toBe('CLEANUP_FAILED')
      expect((error as ComputerUseError).message).toContain('故意关不掉')
    }
  })

  it('关不掉的会话仍然留在表里，还能再收一次', async () => {
    const { service, drivers } = makeService()
    const session = await service.open('agent-1')
    const driver = drivers[0]
    if (driver === undefined) throw new Error('没有开起来')
    driver.failOnClose = true
    await expect(service.close('agent-1', session.id)).rejects.toThrow(ComputerUseError)
    expect(() => service.get('agent-1', session.id)).not.toThrow()
    driver.failOnClose = false
    await service.close('agent-1', session.id)
    expect(() => service.get('agent-1', session.id)).toThrow(ComputerUseError)
  })

  it('错误码判定工具认得 computer-use 的错误', () => {
    const error = new ComputerUseError('NO_SESSION', 'x')
    expect(isComputerUseError(error, 'NO_SESSION')).toBe(true)
    expect(isComputerUseError(error, 'TIMEOUT')).toBe(false)
    expect(isComputerUseError(new Error('x'), 'NO_SESSION')).toBe(false)
  })
})
