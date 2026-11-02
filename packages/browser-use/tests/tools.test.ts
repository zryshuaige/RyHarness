/**
 * 模型工具与降级实现的单元测试。
 *
 * 工具这一层只做「读参数 → 调服务 → 整结果」，所以测的是两件事：参数读对了没，
 * 以及服务报错时模型看到的是不是一句人话（而不是一串英文异常）。
 */
import { describe, expect, it } from 'vitest'
import type { BrowserDriver } from '../src/index.ts'
import {
  BrowserSessionService,
  type BrowserUseError,
  createBrowserTools,
  createUnavailableBrowserDriver,
  emptyBrowserScreenshot,
  isBrowserUseError,
} from '../src/index.ts'

/** 一个可控的假驱动。 */
class FakeDriver implements BrowserDriver {
  readonly name = 'fake'
  readonly calls: string[] = []
  body = '页面正文'
  shot = new Uint8Array([7, 8, 9])

  async open(url: string): Promise<void> {
    this.calls.push(`open:${url}`)
  }
  async click(selector: string): Promise<void> {
    this.calls.push(`click:${selector}`)
  }
  async type(text: string): Promise<void> {
    this.calls.push(`type:${text}`)
  }
  async screenshot(): Promise<{ bytes: Uint8Array; mimeType: string }> {
    return { bytes: this.shot, mimeType: 'image/png' }
  }
  async readText(): Promise<string> {
    return this.body
  }
  async close(): Promise<void> {
    this.calls.push('close')
  }
}

/** 建一个带假驱动的服务与工具集。 */
function makeTools(): { service: BrowserSessionService; tools: ReturnType<typeof createBrowserTools> } {
  const service = new BrowserSessionService({
    driverFactory: () => new FakeDriver(),
    resolveHost: async () => ['93.184.216.34'],
  })
  return { service, tools: createBrowserTools(service) }
}

/** 按名字取一个工具。 */
function pick(tools: ReturnType<typeof createBrowserTools>, name: string) {
  const tool = tools.find((item) => item.name === name)
  if (tool === undefined) throw new Error(`没有工具 ${name}`)
  return tool
}

describe('模型工具：browser_open', () => {
  it('打开成功后回会话 id 与地址', async () => {
    const { tools } = makeTools()
    const result = await pick(tools, 'browser_open').execute({ url: 'https://example.com/' }, { owner: 'agent-1' })
    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content) as { sessionId: string; url: string }
    expect(payload.url).toBe('https://example.com/')
    expect(payload.sessionId).toMatch(/^[0-9a-f]+$/)
  })

  it('url 缺失时回一句中文错误，不去调服务', async () => {
    const { tools } = makeTools()
    const result = await pick(tools, 'browser_open').execute({}, { owner: 'agent-1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('url')
  })

  it('地址指向内网时把安全闸的错误原样回给模型', async () => {
    const { tools } = makeTools()
    const result = await pick(tools, 'browser_open').execute({ url: 'http://127.0.0.1/admin' }, { owner: 'agent-1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('内网')
  })

  it('没装驱动时回 NO_DRIVER 的消息', async () => {
    const service = new BrowserSessionService()
    const tools = createBrowserTools(service)
    const result = await pick(tools, 'browser_open').execute({ url: 'https://example.com/' }, { owner: 'agent-1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('没装浏览器驱动')
  })
})

describe('模型工具：browser_act', () => {
  it('click 会落到驱动上', async () => {
    const { service, tools } = makeTools()
    const opened = await pick(tools, 'browser_open').execute({ url: 'https://example.com/' }, { owner: 'agent-1' })
    const sessionId = (JSON.parse(opened.content) as { sessionId: string }).sessionId
    const result = await pick(tools, 'browser_act').execute(
      { sessionId, action: 'click', selector: '#go' },
      { owner: 'agent-1' },
    )
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content)).toEqual({ ok: true, action: 'click', sessionId })
    expect(service.get('agent-1', sessionId).tabs).toHaveLength(1)
  })

  it('action 不是合法值时回一句中文错误', async () => {
    const { tools } = makeTools()
    const result = await pick(tools, 'browser_act').execute(
      { sessionId: 'abc', action: 'destroy' },
      { owner: 'agent-1' },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('click / type / submit / download')
  })

  it('sessionId 缺失时回一句中文错误', async () => {
    const { tools } = makeTools()
    const result = await pick(tools, 'browser_act').execute({ action: 'click' }, { owner: 'agent-1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('sessionId')
  })

  it('在别人的会话上操作会被围栏挡住', async () => {
    const { tools } = makeTools()
    const opened = await pick(tools, 'browser_open').execute({ url: 'https://example.com/' }, { owner: 'agent-1' })
    const sessionId = (JSON.parse(opened.content) as { sessionId: string }).sessionId
    const result = await pick(tools, 'browser_act').execute(
      { sessionId, action: 'click', selector: '#go' },
      { owner: 'agent-2' },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('没有这个会话')
  })

  it('提交表单默认被拦，消息里说清了要放行', async () => {
    const { tools } = makeTools()
    const opened = await pick(tools, 'browser_open').execute({ url: 'https://example.com/' }, { owner: 'agent-1' })
    const sessionId = (JSON.parse(opened.content) as { sessionId: string }).sessionId
    const result = await pick(tools, 'browser_act').execute(
      { sessionId, action: 'submit', selector: '#go' },
      { owner: 'agent-1' },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('allowFormSubmit')
  })
})

describe('模型工具：browser_read', () => {
  it('读正文返回页面文本', async () => {
    const { tools } = makeTools()
    const opened = await pick(tools, 'browser_open').execute({ url: 'https://example.com/' }, { owner: 'agent-1' })
    const sessionId = (JSON.parse(opened.content) as { sessionId: string }).sessionId
    const result = await pick(tools, 'browser_read').execute({ sessionId }, { owner: 'agent-1' })
    const payload = JSON.parse(result.content) as { kind: string; text: string }
    expect(payload.kind).toBe('text')
    expect(payload.text).toBe('页面正文')
  })

  it('截图回成 data URL，带上 mime 与字节数', async () => {
    const { tools } = makeTools()
    const opened = await pick(tools, 'browser_open').execute({ url: 'https://example.com/' }, { owner: 'agent-1' })
    const sessionId = (JSON.parse(opened.content) as { sessionId: string }).sessionId
    const result = await pick(tools, 'browser_read').execute({ sessionId, kind: 'screenshot' }, { owner: 'agent-1' })
    const payload = JSON.parse(result.content) as {
      kind: string
      mimeType: string
      bytes: number
      inline: boolean
      dataUrl: string
    }
    expect(payload.kind).toBe('screenshot')
    expect(payload.mimeType).toBe('image/png')
    expect(payload.bytes).toBe(3)
    expect(payload.inline).toBe(true)
    expect(payload.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('截图超过内联上限时只回说明，不把字节塞进结果', async () => {
    const service = new BrowserSessionService({
      driverFactory: () => new FakeDriver(),
      resolveHost: async () => ['93.184.216.34'],
    })
    const tools = createBrowserTools(service, { maxInlineScreenshotBytes: 1 })
    const opened = await pick(tools, 'browser_open').execute({ url: 'https://example.com/' }, { owner: 'agent-1' })
    const sessionId = (JSON.parse(opened.content) as { sessionId: string }).sessionId
    const result = await pick(tools, 'browser_read').execute({ sessionId, kind: 'screenshot' }, { owner: 'agent-1' })
    const payload = JSON.parse(result.content) as { inline: boolean; dataUrl?: string; note: string }
    expect(payload.inline).toBe(false)
    expect(payload.dataUrl).toBeUndefined()
    expect(payload.note).toContain('内联上限')
  })

  it('kind 只能是 text 或 screenshot', async () => {
    const { tools } = makeTools()
    const result = await pick(tools, 'browser_read').execute({ sessionId: 'abc', kind: 'video' }, { owner: 'agent-1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('text 或 screenshot')
  })
})

describe('模型工具：出错的兜底', () => {
  it('会话服务抛出不是 BrowserUseError 的异常时，模型看到的是一句中文摘要', async () => {
    // 服务这一层理论上只抛 BrowserUseError；这里塞一个「不守规矩」的实现，
    // 看看工具层是不是能把原始异常挡住（模型不需要看到 stack）。
    const broken = {
      open: async () => {
        throw new TypeError('boom')
      },
      act: async () => {},
      read: async () => ({ kind: 'text' as const, text: '' }),
    }
    const tools = createBrowserTools(broken)
    const result = await pick(tools, 'browser_open').execute({ url: 'https://example.com/' }, { owner: 'agent-1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('内部错误')
    expect(result.content).not.toContain('boom')
  })

  it('browser_read 缺 sessionId 时回一句中文错误', async () => {
    const { tools } = makeTools()
    const result = await pick(tools, 'browser_read').execute({}, { owner: 'agent-1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('sessionId')
  })

  it('browser_read 在别人的会话上读会被围栏挡住', async () => {
    const { tools } = makeTools()
    const opened = await pick(tools, 'browser_open').execute({ url: 'https://example.com/' }, { owner: 'agent-1' })
    const sessionId = (JSON.parse(opened.content) as { sessionId: string }).sessionId
    const result = await pick(tools, 'browser_read').execute({ sessionId }, { owner: 'agent-2' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('没有这个会话')
  })
})

describe('降级实现：没装驱动就如实报错', () => {
  it('每个方法都报 NO_DRIVER，没有一个假装成功', async () => {
    const driver = createUnavailableBrowserDriver()
    expect(driver.name).toBe('unavailable')
    for (const call of [
      () => driver.open('https://example.com/'),
      () => driver.click('#a'),
      () => driver.type('x'),
      () => driver.screenshot(),
      () => driver.readText(),
      () => driver.close(),
    ]) {
      try {
        await call()
        expect.unreachable('降级驱动不该成功')
      } catch (error) {
        expect(isBrowserUseError(error, 'NO_DRIVER')).toBe(true)
      }
    }
  })

  it('错误消息说清了是「没装浏览器驱动」', async () => {
    const driver = createUnavailableBrowserDriver()
    try {
      await driver.readText()
      expect.unreachable('降级驱动不该成功')
    } catch (error) {
      expect((error as BrowserUseError).message).toContain('没装浏览器驱动')
    }
  })

  it('空截图是空字节，不是假装有图的占位数据', () => {
    const shot = emptyBrowserScreenshot()
    expect(shot.bytes.byteLength).toBe(0)
    expect(shot.mimeType).toBe('application/octet-stream')
  })
})
