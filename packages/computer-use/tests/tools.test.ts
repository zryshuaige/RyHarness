/**
 * 桌面工具层的用例：参数读法、错误整形、截图内联上限。
 *
 * 这一族盯的是「工具给模型的说法」：参数缺了要说清缺哪个，失败要回错误而不是
 * 抛异常，截图太大就不内联（把几兆字节塞进上下文是帮倒忙）。
 */
import { describe, expect, it } from 'vitest'
import {
  type ComputerAction,
  type ComputerScreenshot,
  ComputerSessionService,
  type ComputerToolSession,
  createComputerTools,
} from '../src/index.ts'

/** 一个只记动作的假驱动。 */
class RecordingDriver {
  readonly name = 'recording'
  readonly actions: ComputerAction[] = []
  async screenshot(): Promise<ComputerScreenshot> {
    return { bytes: Buffer.from('fake-png'), mimeType: 'image/png', width: 100, height: 100 }
  }
  async click(): Promise<void> {}
  async type(): Promise<void> {}
  async key(): Promise<void> {}
  async move(): Promise<void> {}
  async scroll(): Promise<void> {}
  async close(): Promise<void> {}
}

/** 建一个带假驱动的会话能力。 */
function makeSession(): { session: ComputerToolSession; actions: ComputerAction[] } {
  const actions: ComputerAction[] = []
  const driver = new RecordingDriver()
  const original = driver.actions
  const service = new ComputerSessionService({
    driverFactory: () => driver,
    // 高危动作不拦：这个文件测的是工具层，不是审批。
    policy: { requireApproval: false, allowScreenshot: true },
    approver: async (request) => {
      actions.push({ kind: request.kind })
      return true
    },
  })
  const session: ComputerToolSession = {
    open: (owner) => service.open(owner),
    act: (owner, sessionId, action) => {
      actions.push(action)
      return service.act(owner, sessionId, action)
    },
    screenshot: (owner, sessionId) => service.screenshot(owner, sessionId),
  }
  void original
  return { session, actions }
}

describe('桌面工具', () => {
  it('五个工具的名字与说明都在', () => {
    const { session } = makeSession()
    const tools = createComputerTools(session)
    expect(tools.map((tool) => tool.name)).toEqual([
      'computer_screenshot',
      'computer_click',
      'computer_type',
      'computer_key',
      'computer_scroll',
    ])
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.parameters.type).toBe('object')
    }
  })

  it('点击要把坐标传给会话，并带上 owner', async () => {
    const { session } = makeSession()
    const tool = createComputerTools(session).find((item) => item.name === 'computer_click')
    const view = await session.open('agent-1')
    const result = await tool?.execute({ sessionId: view.id, x: 10, y: 20 }, { owner: 'agent-1' })
    expect(result?.isError).toBeUndefined()
    expect(result?.content).toContain('(10, 20)')
  })

  it('缺 sessionId 要回错误，不是抛异常', async () => {
    const { session } = makeSession()
    const tool = createComputerTools(session).find((item) => item.name === 'computer_click')
    const result = await tool?.execute({ x: 1, y: 2 }, { owner: 'agent-1' })
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('sessionId')
  })

  it('截图超上限时不内联，只回一句说明', async () => {
    const { session } = makeSession()
    const tools = createComputerTools(session, { maxInlineScreenshotBytes: 1 })
    const tool = tools.find((item) => item.name === 'computer_screenshot')
    const view = await session.open('agent-1')
    const result = await tool?.execute({ sessionId: view.id }, { owner: 'agent-1' })
    expect(result?.isError).toBeUndefined()
    const parsed = JSON.parse(result?.content ?? '{}') as { inline?: boolean; note?: string }
    expect(parsed.inline).toBe(false)
    expect(parsed.note).toContain('超过内联上限')
  })

  it('会话不属于这个 owner 时回 NO_SESSION，不泄露会话是否存在', async () => {
    const { session } = makeSession()
    const tool = createComputerTools(session).find((item) => item.name === 'computer_screenshot')
    const view = await session.open('agent-1')
    const result = await tool?.execute({ sessionId: view.id }, { owner: 'agent-2' })
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('没有这个会话')
  })
})
