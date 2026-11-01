/**
 * 会话服务的单元测试：owner 隔离、有界、超时、危险动作、结构化失败、收尾。
 *
 * 用**假驱动**跑这些用例：服务这一层管的是归属与边界，跟浏览器怎么开无关，
 * 拿真浏览器来测只会让用例变慢又脆（本包本来也不带浏览器）。
 */
import { describe, expect, it } from 'vitest'
import {
  type BrowserDownloader,
  type BrowserDriver,
  type BrowserFormSubmitter,
  BrowserSessionService,
  BrowserUseError,
} from '../src/index.ts'

/** 一个可控的假驱动：记录收到的调用，行为由用例自己塞。 */
class FakeDriver implements BrowserDriver, BrowserFormSubmitter, BrowserDownloader {
  /** 驱动名。 */
  readonly name = 'fake'
  /** 收到的调用序列。 */
  readonly calls: string[] = []
  /** 打开的地址。 */
  openedUrl = ''
  /** 正文。 */
  body = 'hello'
  /** 截图字节。 */
  shot = new Uint8Array([1, 2, 3])
  /** 打开时要不要失败。 */
  failOnOpen = false
  /** 关掉时要不要失败。 */
  failOnClose = false
  /** 打开时要不要卡住（用来测超时）。 */
  hangOnOpen = false

  async open(url: string): Promise<void> {
    this.calls.push(`open:${url}`)
    this.openedUrl = url
    if (this.hangOnOpen) await new Promise((resolve) => setTimeout(resolve, 5_000))
    if (this.failOnOpen) throw new Error('假驱动：故意打不开')
  }

  async click(selector: string): Promise<void> {
    this.calls.push(`click:${selector}`)
  }

  async type(text: string): Promise<void> {
    this.calls.push(`type:${text}`)
  }

  async screenshot(): Promise<{ bytes: Uint8Array; mimeType: string }> {
    this.calls.push('screenshot')
    return { bytes: this.shot, mimeType: 'image/png' }
  }

  async readText(): Promise<string> {
    this.calls.push('readText')
    return this.body
  }

  async close(): Promise<void> {
    this.calls.push('close')
    if (this.failOnClose) throw new Error('假驱动：故意关不掉')
  }

  async submit(selector?: string): Promise<void> {
    this.calls.push(`submit:${selector ?? '(focus)'}`)
  }

  async download(selector: string): Promise<void> {
    this.calls.push(`download:${selector}`)
  }
}

/** 一个只会失败的驱动：用来测「这个驱动不会提交表单」。 */
class BareDriver implements BrowserDriver {
  readonly name = 'bare'
  async open(): Promise<void> {}
  async click(): Promise<void> {}
  async type(): Promise<void> {}
  async screenshot(): Promise<{ bytes: Uint8Array; mimeType: string }> {
    return { bytes: new Uint8Array(0), mimeType: 'image/png' }
  }
  async readText(): Promise<string> {
    return ''
  }
  async close(): Promise<void> {}
}

/** 建一个带假驱动的服务。解析器固定成公网地址。 */
function makeService(
  options: {
    maxTabs?: number
    maxSessions?: number
    stepTimeoutMs?: number
    policy?: { allowPrivateNetwork?: boolean; allowFormSubmit?: boolean; allowDownload?: boolean }
  } = {},
): { service: BrowserSessionService; drivers: FakeDriver[] } {
  const drivers: FakeDriver[] = []
  const service = new BrowserSessionService({
    driverFactory: () => {
      const driver = new FakeDriver()
      drivers.push(driver)
      return driver
    },
    resolveHost: async () => ['93.184.216.34'],
    ...options,
  })
  return { service, drivers }
}

describe('会话服务：owner 隔离', () => {
  it('同一个 owner 能取到自己开的会话', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', 'https://example.com/')
    expect(service.get('agent-1', session.id).id).toBe(session.id)
  })

  it('别人的会话一律取不到', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', 'https://example.com/')
    expect(() => service.get('agent-2', session.id)).toThrow(BrowserUseError)
    try {
      service.get('agent-2', session.id)
      expect.unreachable('不该取到别人的会话')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('NO_SESSION')
    }
  })

  it('围栏逐字比对：多一个空格、大小写不同、前缀相同都不算同一个 owner', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', 'https://example.com/')
    for (const other of ['agent-1 ', ' agent-1', 'Agent-1', 'agent-11', 'agent', '']) {
      expect(() => service.get(other, session.id)).toThrow(BrowserUseError)
    }
  })

  it('不存在的 id 与别人的 id 报同一个错（不泄露 id 是否存在）', async () => {
    const { service } = makeService()
    const theirs = await service.open('agent-2', 'https://example.com/')
    let foreignCode = ''
    let missingCode = ''
    try {
      service.get('agent-1', theirs.id)
    } catch (error) {
      foreignCode = (error as BrowserUseError).code
    }
    try {
      service.get('agent-1', 'ffffffffffffffffffffffff')
    } catch (error) {
      missingCode = (error as BrowserUseError).code
    }
    expect(foreignCode).toBe(missingCode)
    expect(foreignCode).toBe('NO_SESSION')
  })

  it('list 只列自己的会话，别人的连 id 都不出现', async () => {
    const { service } = makeService()
    const mine = await service.open('agent-1', 'https://example.com/')
    const theirs = await service.open('agent-2', 'https://example.org/')
    const listed = service.list('agent-1')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(mine.id)
    expect(service.list('agent-1').map((s) => s.id)).not.toContain(theirs.id)
  })

  it('在别人的会话上开标签页也被拒', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', 'https://example.com/')
    await expect(service.openTab('agent-2', session.id, 'https://example.org/')).rejects.toThrow(BrowserUseError)
  })
})

describe('会话服务：有界', () => {
  it('标签页数到上限就报 TAB_LIMIT', async () => {
    const { service } = makeService({ maxTabs: 2 })
    const session = await service.open('agent-1', 'https://example.com/')
    await service.openTab('agent-1', session.id, 'https://example.com/two')
    try {
      await service.openTab('agent-1', session.id, 'https://example.com/three')
      expect.unreachable('不该超过标签页上限')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('TAB_LIMIT')
    }
  })

  it('达到上限时不会多造一个标签页出来', async () => {
    const { service, drivers } = makeService({ maxTabs: 1 })
    const session = await service.open('agent-1', 'https://example.com/')
    await expect(service.openTab('agent-1', session.id, 'https://example.com/two')).rejects.toThrow(BrowserUseError)
    expect(service.get('agent-1', session.id).tabs).toHaveLength(1)
    expect(drivers).toHaveLength(1)
  })

  it('每个 owner 的会话数到上限就报 SESSION_LIMIT', async () => {
    const { service } = makeService({ maxSessions: 2 })
    await service.open('agent-1', 'https://example.com/')
    await service.open('agent-1', 'https://example.org/')
    try {
      await service.open('agent-1', 'https://example.net/')
      expect.unreachable('不该超过会话上限')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('SESSION_LIMIT')
    }
  })

  it('会话上限是按 owner 算的：别人开满了也不影响我', async () => {
    const { service } = makeService({ maxSessions: 1 })
    await service.open('agent-2', 'https://example.com/')
    const mine = await service.open('agent-1', 'https://example.com/')
    expect(mine.owner).toBe('agent-1')
  })
})

describe('会话服务：安全边界', () => {
  it('默认不访问本机与内网', async () => {
    const service = new BrowserSessionService({
      driverFactory: () => new FakeDriver(),
      resolveHost: async () => ['10.0.0.1'],
    })
    try {
      await service.open('agent-1', 'http://10.0.0.1/admin')
      expect.unreachable('不该访问内网地址')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('PRIVATE_ADDRESS')
    }
  })

  it('allowPrivateNetwork 打开后内网地址能访问', async () => {
    const { service } = makeService({ policy: { allowPrivateNetwork: true } })
    const session = await service.open('agent-1', 'http://10.0.0.1/admin')
    expect(session.tabs).toHaveLength(1)
  })

  it('默认不自动提交表单，报 ACTION_NOT_ALLOWED', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', 'https://example.com/')
    try {
      await service.act('agent-1', session.id, { kind: 'submit', selector: '#go' })
      expect.unreachable('不该默认提交表单')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('ACTION_NOT_ALLOWED')
    }
  })

  it('默认不自动下载文件，报 ACTION_NOT_ALLOWED', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', 'https://example.com/')
    try {
      await service.act('agent-1', session.id, { kind: 'download', selector: '#file' })
      expect.unreachable('不该默认下载文件')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('ACTION_NOT_ALLOWED')
    }
  })

  it('放行之后提交表单与下载文件都能做', async () => {
    const { service, drivers } = makeService({
      policy: { allowFormSubmit: true, allowDownload: true },
    })
    const session = await service.open('agent-1', 'https://example.com/')
    await service.act('agent-1', session.id, { kind: 'submit', selector: '#go' })
    await service.act('agent-1', session.id, { kind: 'download', selector: '#file' })
    expect(drivers[0]?.calls).toContain('submit:#go')
    expect(drivers[0]?.calls).toContain('download:#file')
  })

  it('驱动不支持提交表单时报 UNSUPPORTED_ACTION，不含糊', async () => {
    const service = new BrowserSessionService({
      driverFactory: () => new BareDriver(),
      resolveHost: async () => ['93.184.216.34'],
      policy: { allowFormSubmit: true },
    })
    const session = await service.open('agent-1', 'https://example.com/')
    try {
      await service.act('agent-1', session.id, { kind: 'submit', selector: '#go' })
      expect.unreachable('裸驱动不该提交表单')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('UNSUPPORTED_ACTION')
    }
  })

  it('click 缺选择器、type 缺文字都报 INVALID_ARGUMENT', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', 'https://example.com/')
    try {
      await service.act('agent-1', session.id, { kind: 'click' })
      expect.unreachable('click 缺选择器该报错')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('INVALID_ARGUMENT')
    }
    try {
      await service.act('agent-1', session.id, { kind: 'type' })
      expect.unreachable('type 缺文字该报错')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('INVALID_ARGUMENT')
    }
  })
})

describe('会话服务：超时与结构化失败', () => {
  it('驱动卡住时按 TIMEOUT 报错，而不是让整轮对话挂着', async () => {
    const service = new BrowserSessionService({
      driverFactory: () => {
        const driver = new FakeDriver()
        driver.hangOnOpen = true
        return driver
      },
      resolveHost: async () => ['93.184.216.34'],
      stepTimeoutMs: 50,
    })
    try {
      await service.open('agent-1', 'https://example.com/')
      expect.unreachable('不该一直等下去')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('TIMEOUT')
    }
  })

  it('驱动内部出错时报 DRIVER_FAILED，并带上原始原因', async () => {
    const service = new BrowserSessionService({
      driverFactory: () => {
        const driver = new FakeDriver()
        driver.failOnOpen = true
        return driver
      },
      resolveHost: async () => ['93.184.216.34'],
    })
    try {
      await service.open('agent-1', 'https://example.com/')
      expect.unreachable('打不开就该报错')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('DRIVER_FAILED')
      expect((error as BrowserUseError).message).toContain('故意打不开')
    }
  })

  it('没装驱动时报 NO_DRIVER，不假装成功', async () => {
    const service = new BrowserSessionService()
    try {
      await service.open('agent-1', 'https://example.com/')
      expect.unreachable('没驱动就不该开起来')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('NO_DRIVER')
    }
  })

  it('页面打不开时不留下半个会话', async () => {
    const service = new BrowserSessionService({
      driverFactory: () => {
        const driver = new FakeDriver()
        driver.failOnOpen = true
        return driver
      },
      resolveHost: async () => ['93.184.216.34'],
    })
    await expect(service.open('agent-1', 'https://example.com/')).rejects.toThrow(BrowserUseError)
    expect(service.list('agent-1')).toHaveLength(0)
  })
})

describe('会话服务：动作与读取', () => {
  it('click 与 type 会落到驱动上', async () => {
    const { service, drivers } = makeService()
    const session = await service.open('agent-1', 'https://example.com/')
    await service.act('agent-1', session.id, { kind: 'click', selector: '#btn' })
    await service.act('agent-1', session.id, { kind: 'type', text: '你好' })
    expect(drivers[0]?.calls).toEqual(['open:https://example.com/', 'click:#btn', 'type:你好'])
  })

  it('读正文返回驱动给的文本', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', 'https://example.com/')
    const result = await service.read('agent-1', session.id, 'text')
    expect(result.kind).toBe('text')
    expect(result.kind === 'text' ? result.text : '').toBe('hello')
  })

  it('截图返回字节与 mime', async () => {
    const { service } = makeService()
    const session = await service.open('agent-1', 'https://example.com/')
    const result = await service.read('agent-1', session.id, 'screenshot')
    expect(result.kind).toBe('screenshot')
    if (result.kind === 'screenshot') {
      expect(result.mimeType).toBe('image/png')
      expect([...result.bytes]).toEqual([1, 2, 3])
    }
  })

  it('新开的标签页会成为当前操作的标签页', async () => {
    const { service, drivers } = makeService()
    const session = await service.open('agent-1', 'https://example.com/')
    const tab = await service.openTab('agent-1', session.id, 'https://example.org/')
    expect(service.get('agent-1', session.id).activeTabId).toBe(tab.id)
    await service.act('agent-1', session.id, { kind: 'click', selector: '#x' })
    expect(drivers[1]?.calls).toContain('click:#x')
    expect(drivers[0]?.calls).not.toContain('click:#x')
  })
})

describe('会话服务：收尾', () => {
  it('close 会把会话里所有标签页的驱动都关掉', async () => {
    const { service, drivers } = makeService()
    const session = await service.open('agent-1', 'https://example.com/')
    await service.openTab('agent-1', session.id, 'https://example.org/')
    await service.close('agent-1', session.id)
    expect(drivers.every((driver) => driver.calls.includes('close'))).toBe(true)
    expect(service.list('agent-1')).toHaveLength(0)
  })

  it('disposeAll 把所有会话都收掉', async () => {
    const { service, drivers } = makeService()
    await service.open('agent-1', 'https://example.com/')
    await service.open('agent-2', 'https://example.org/')
    await service.disposeAll()
    expect(drivers.every((driver) => driver.calls.includes('close'))).toBe(true)
    expect(service.list('agent-1')).toHaveLength(0)
    expect(service.list('agent-2')).toHaveLength(0)
  })

  it('关不掉就如实报错，不能假装关好了', async () => {
    const { service, drivers } = makeService()
    const session = await service.open('agent-1', 'https://example.com/')
    const driver = drivers[0]
    if (driver === undefined) throw new Error('没有开起来')
    driver.failOnClose = true
    try {
      await service.close('agent-1', session.id)
      expect.unreachable('关不掉就该报错')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('CLEANUP_FAILED')
    }
  })

  it('关不掉的会话仍然留在表里，还能再收一次', async () => {
    const { service, drivers } = makeService()
    const session = await service.open('agent-1', 'https://example.com/')
    const driver = drivers[0]
    if (driver === undefined) throw new Error('没有开起来')
    driver.failOnClose = true
    await expect(service.close('agent-1', session.id)).rejects.toThrow(BrowserUseError)
    expect(() => service.get('agent-1', session.id)).not.toThrow()
    driver.failOnClose = false
    await service.close('agent-1', session.id)
    expect(() => service.get('agent-1', session.id)).toThrow(BrowserUseError)
  })

  it('会话 id 是不透明的随机串，看不出归属', async () => {
    const { service } = makeService()
    const a = await service.open('agent-1', 'https://example.com/')
    const b = await service.open('agent-1', 'https://example.org/')
    expect(a.id).not.toBe(b.id)
    expect(a.id).not.toContain('agent-1')
    expect(a.id).toMatch(/^[0-9a-f]+$/)
  })
})
