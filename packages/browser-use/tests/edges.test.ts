/**
 * 边界的补充用例：几处「平时走不到、但走错了就出事」的分支。
 *
 * 单独放一个文件，是为了让「这些用例在补什么」一眼看得见——它们多半是在补
 * 失败路径上的兜底。
 */
import { describe, expect, it } from 'vitest'
import {
  BrowserSessionService,
  BrowserUseError,
  defaultResolveHost,
  type BrowserDriver,
  type BrowserDownloader,
} from '../src/index.ts'

/** 一个只实现基本动作的驱动：不会提交表单，也不会下载文件。 */
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

/** 一个连下载也不会的驱动：用来测「驱动不支持下载」。 */
class NoDownloadDriver extends BareDriver implements BrowserDownloader {
  async download(): Promise<void> {
    throw new Error('不该走到这里')
  }
}

/** 一个不守规矩的驱动：抛的不是 Error，是个字符串。 */
class WeirdDriver extends BareDriver {
  override async open(): Promise<void> {
    throw '就是字符串不是 Error'
  }
}

/** 建一个带假驱动的服务。 */
function makeService(
  options: {
    policy?: { allowPrivateNetwork?: boolean; allowFormSubmit?: boolean; allowDownload?: boolean }
    driver?: () => BrowserDriver
    failOnClose?: boolean
  } = {},
): { service: BrowserSessionService; drivers: BrowserDriver[] } {
  const drivers: BrowserDriver[] = []
  const service = new BrowserSessionService({
    driverFactory: () => {
      const driver = options.driver
        ? options.driver()
        : {
            name: 'fake',
            async open() {},
            async click() {},
            async type() {},
            async screenshot() {
              return { bytes: new Uint8Array(0), mimeType: 'image/png' }
            },
            async readText() {
              return ''
            },
            async close() {
              if (options.failOnClose === true) throw new Error('假驱动：故意关不掉')
            },
          }
      drivers.push(driver)
      return driver
    },
    resolveHost: async () => ['93.184.216.34'],
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  })
  return { service, drivers }
}

describe('补充：策略快照', () => {
  it('policy 拿到的是副本，改它不影响服务', async () => {
    const { service } = makeService()
    const snapshot = service.policy
    expect(snapshot).toEqual({ allowPrivateNetwork: false, allowFormSubmit: false, allowDownload: false })
    // 快照是副本：改它不能影响服务（字段本身是 readonly，测试里临时按可变看待）。
    const mutable = snapshot as { allowFormSubmit: boolean }
    mutable.allowFormSubmit = true
    expect(service.policy.allowFormSubmit).toBe(false)
  })

  it('放行策略会被服务记住', async () => {
    const { service } = makeService({ policy: { allowDownload: true } })
    expect(service.policy.allowDownload).toBe(true)
    expect(service.policy.allowFormSubmit).toBe(false)
  })
})

describe('补充：驱动不支持的动作', () => {
  it('驱动不会下载文件时报 UNSUPPORTED_ACTION', async () => {
    const { service } = makeService({
      policy: { allowDownload: true },
      driver: () => new BareDriver(),
    })
    const session = await service.open('agent-1', 'https://example.com/')
    try {
      await service.act('agent-1', session.id, { kind: 'download', selector: '#file' })
      expect.unreachable('裸驱动不该下载文件')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('UNSUPPORTED_ACTION')
    }
  })

  it('下载动作缺选择器时报 INVALID_ARGUMENT', async () => {
    const { service } = makeService({
      policy: { allowDownload: true },
      driver: () => new NoDownloadDriver(),
    })
    const session = await service.open('agent-1', 'https://example.com/')
    try {
      await service.act('agent-1', session.id, { kind: 'download' })
      expect.unreachable('download 缺选择器该报错')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('INVALID_ARGUMENT')
    }
  })
})

describe('补充：清理失败要报出来', () => {
  it('disposeAll 里有会话关不掉时报 CLEANUP_FAILED，并说清是哪个', async () => {
    const { service } = makeService({ failOnClose: true })
    await service.open('agent-1', 'https://example.com/')
    await service.open('agent-2', 'https://example.org/')
    try {
      await service.disposeAll()
      expect.unreachable('关不掉就该报错')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('CLEANUP_FAILED')
      expect((error as BrowserUseError).message).toContain('故意关不掉')
    }
  })
})

describe('补充：默认解析器', () => {
  it('默认解析器能把 localhost 解析到环回地址', async () => {
    const addresses = await defaultResolveHost('localhost')
    expect(addresses.length).toBeGreaterThan(0)
    expect(addresses.some((address) => address === '127.0.0.1' || address === '::1')).toBe(true)
  })
})

describe('补充：驱动抛出不是 Error 的东西', () => {
  it('驱动抛一个字符串时，报错里也有那句话（不吞掉原因）', async () => {
    const service = new BrowserSessionService({
      driverFactory: () => new WeirdDriver(),
      resolveHost: async () => ['93.184.216.34'],
    })
    try {
      await service.open('agent-1', 'https://example.com/')
      expect.unreachable('该报错')
    } catch (error) {
      expect((error as BrowserUseError).code).toBe('DRIVER_FAILED')
      expect((error as BrowserUseError).message).toContain('就是字符串不是 Error')
    }
  })
})
