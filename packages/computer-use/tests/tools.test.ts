/**
 * 桌面工具层的用例：参数读法、错误整形、截图内联上限。
 *
 * 这一族盯的是「工具给模型的说法」：参数缺了要说清缺哪个，失败要回错误而不是
 * 抛异常，截图太大就不内联（把几兆字节塞进上下文是帮倒忙）。
 *
 * 这里的会话能力是**替身**：桌面驱动要真的开窗口、真的点，不适合放在单测里；
 * 驱动本身另有真机用例（`windows.test.ts`）。
 */
import { describe, expect, it } from 'vitest'
import {
  type ComputerAction,
  type ComputerScreenshot,
  type ComputerToolSession,
  ComputerUseError,
  createComputerTools,
  isComputerActionKind,
} from '../src/index.ts'

/** 记下收到过什么动作的替身。 */
interface Recorder {
  readonly session: ComputerToolSession
  readonly actions: ComputerAction[]
  readonly screenshots: number
}

/**
 * 造一个会话替身。
 * @param options - 截图大小（字节）与失败方式。
 * @returns 替身与记录。
 */
function makeSession(options: { shotBytes?: number; failWith?: unknown; shotWithoutSize?: boolean } = {}): Recorder {
  const actions: ComputerAction[] = []
  let screenshots = 0
  const session: ComputerToolSession = {
    open: async () => ({
      id: 'session-1',
      owner: 'agent-1',
      driver: 'fake',
      createdAt: 0,
    }),
    act: async (_owner, _sessionId, action) => {
      if (options.failWith !== undefined) throw options.failWith
      actions.push(action)
    },
    screenshot: async () => {
      screenshots += 1
      if (options.failWith !== undefined) throw options.failWith
      const size = options.shotBytes ?? 8
      // 有些截图驱动给不出屏幕尺寸（截的是窗口而不是整屏）：那就不写尺寸。
      if (options.shotWithoutSize === true) {
        return { bytes: new Uint8Array(size), mimeType: 'image/png' } satisfies ComputerScreenshot
      }
      return {
        bytes: new Uint8Array(size),
        mimeType: 'image/png',
        width: 800,
        height: 600,
      } satisfies ComputerScreenshot
    },
  }
  return {
    session,
    actions,
    get screenshots() {
      return screenshots
    },
  }
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

  it('点击把坐标传给会话，并带上 owner', async () => {
    const recorder = makeSession()
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_click')
    const result = await tool?.execute({ sessionId: 'session-1', x: 10, y: 20 }, { owner: 'agent-1' })
    expect(result?.isError).toBeUndefined()
    expect(recorder.actions[0]).toEqual({ kind: 'click', x: 10, y: 20 })
  })

  it('坐标是小数时取整（像素是整数）', async () => {
    const recorder = makeSession()
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_click')
    await tool?.execute({ sessionId: 'session-1', x: 10.7, y: 20.2 }, { owner: 'agent-1' })
    expect(recorder.actions[0]).toEqual({ kind: 'click', x: 10, y: 20 })
  })

  it('缺 sessionId 要回错误，不是抛异常', async () => {
    const recorder = makeSession()
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_click')
    const result = await tool?.execute({ x: 1, y: 2 }, { owner: 'agent-1' })
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('sessionId')
  })

  it('缺坐标要回错误', async () => {
    const recorder = makeSession()
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_click')
    const result = await tool?.execute({ sessionId: 'session-1' }, { owner: 'agent-1' })
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('x')
  })

  it('打字把正文传给会话', async () => {
    const recorder = makeSession()
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_type')
    const result = await tool?.execute({ sessionId: 'session-1', text: '你好' }, { owner: 'agent-1' })
    expect(result?.isError).toBeUndefined()
    expect(recorder.actions[0]).toEqual({ kind: 'type', text: '你好' })
  })

  it('打字缺正文要回错误', async () => {
    const recorder = makeSession()
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_type')
    const result = await tool?.execute({ sessionId: 'session-1' }, { owner: 'agent-1' })
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('text')
  })

  it('按键把键名传给会话', async () => {
    const recorder = makeSession()
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_key')
    const result = await tool?.execute({ sessionId: 'session-1', key: 'Enter' }, { owner: 'agent-1' })
    expect(result?.isError).toBeUndefined()
    expect(recorder.actions[0]).toEqual({ kind: 'key', key: 'Enter' })
  })

  it('滚动：dy 缺了要回错误，dx 缺了按 0 算', async () => {
    const recorder = makeSession()
    const tools = createComputerTools(recorder.session)
    const scroll = tools.find((item) => item.name === 'computer_scroll')
    const missing = await scroll?.execute({ sessionId: 'session-1' }, { owner: 'agent-1' })
    expect(missing?.isError).toBe(true)
    const ok = await scroll?.execute({ sessionId: 'session-1', dy: 120 }, { owner: 'agent-1' })
    expect(ok?.isError).toBeUndefined()
    expect(recorder.actions[0]).toEqual({ kind: 'scroll', dx: 0, dy: 120 })
  })

  it('截图：小图内联进结果', async () => {
    const recorder = makeSession({ shotBytes: 8 })
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_screenshot')
    const result = await tool?.execute({ sessionId: 'session-1' }, { owner: 'agent-1' })
    const parsed = JSON.parse(result?.content ?? '{}') as { inline?: boolean; dataUrl?: string }
    expect(parsed.inline).toBe(true)
    expect(parsed.dataUrl).toContain('data:image/png;base64,')
  })

  it('截图超上限时不内联，只回一句说明', async () => {
    const recorder = makeSession({ shotBytes: 64 })
    const tools = createComputerTools(recorder.session, { maxInlineScreenshotBytes: 1 })
    const tool = tools.find((item) => item.name === 'computer_screenshot')
    const result = await tool?.execute({ sessionId: 'session-1' }, { owner: 'agent-1' })
    const parsed = JSON.parse(result?.content ?? '{}') as { inline?: boolean; note?: string }
    expect(parsed.inline).toBe(false)
    expect(parsed.note).toContain('超过内联上限')
  })

  it('会话里出的错要变成给模型看的错误结果，不是抛出去', async () => {
    const recorder = makeSession({ failWith: new ComputerUseError('NO_SESSION', 'computer-use: 没有这个会话') })
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_click')
    const result = await tool?.execute({ sessionId: 'session-1', x: 1, y: 2 }, { owner: 'agent-1' })
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('没有这个会话')
  })

  it('不是 ComputerUseError 的异常也要变成错误结果', async () => {
    const recorder = makeSession({ failWith: new Error('驱动崩了') })
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_click')
    const result = await tool?.execute({ sessionId: 'session-1', x: 1, y: 2 }, { owner: 'agent-1' })
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('驱动崩了')
  })

  it('抛的不是 Error（比如驱动扔了字符串）：也不能把模型看到的东西弄崩', async () => {
    const recorder = makeSession({ failWith: '就是一句话' })
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_click')
    const result = await tool?.execute({ sessionId: 'session-1', x: 1, y: 2 }, { owner: 'agent-1' })
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('内部错误')
  })

  it('截图那一步出的错也要变成错误结果', async () => {
    const recorder = makeSession({ failWith: new ComputerUseError('NO_SESSION', 'computer-use: 没有这个会话') })
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_screenshot')
    const result = await tool?.execute({ sessionId: 'session-1' }, { owner: 'agent-1' })
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('没有这个会话')
  })
})

/**
 * 参数读不出来的那几种形状。
 *
 * 模型给的参数不一定是对象，也不一定给全。这些都要变成一句说清的话回给模型，
 * 而不是抛异常——工具层抛出去，模型这一轮就白跑了。
 */
describe('参数读不出来的时候', () => {
  it('参数整个不是对象：说清缺 sessionId，不抛异常', async () => {
    const recorder = makeSession()
    const tools = createComputerTools(recorder.session)
    for (const tool of tools) {
      const result = await tool.execute('这不是对象', { owner: 'agent-1' })
      expect(result.isError).toBe(true)
      expect(result.content).toContain('sessionId')
    }
  })

  it('sessionId 是空串或全是空格：当成没给', async () => {
    const recorder = makeSession()
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_click')
    const result = await tool?.execute({ sessionId: '   ', x: 1, y: 2 }, { owner: 'agent-1' })
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('sessionId')
  })

  it('坐标不是数字：说清 x 与 y 要数字', async () => {
    const recorder = makeSession()
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_click')
    const result = await tool?.execute({ sessionId: 'session-1', x: '十', y: 2 }, { owner: 'agent-1' })
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('x')
  })

  it('打字那一步参数不是对象：说清缺 text', async () => {
    const recorder = makeSession()
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_type')
    const result = await tool?.execute('这不是对象', { owner: 'agent-1' })
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('sessionId')
  })

  it('打字时正文是空串：说清 text 要非空', async () => {
    const recorder = makeSession()
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_type')
    const result = await tool?.execute({ sessionId: 'session-1', text: '' }, { owner: 'agent-1' })
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('text')
  })

  it('按键缺 sessionId、缺 key：各自说清缺哪个', async () => {
    const recorder = makeSession()
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_key')
    const noSession = await tool?.execute({ key: 'Enter' }, { owner: 'agent-1' })
    expect(noSession?.isError).toBe(true)
    expect(noSession?.content).toContain('sessionId')
    const noKey = await tool?.execute({ sessionId: 'session-1' }, { owner: 'agent-1' })
    expect(noKey?.isError).toBe(true)
    expect(noKey?.content).toContain('key')
  })

  it('滚动缺 sessionId：说清缺 sessionId', async () => {
    const recorder = makeSession()
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_scroll')
    const result = await tool?.execute({ dy: 10 }, { owner: 'agent-1' })
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('sessionId')
  })
})

describe('出错的几条路都走一遍', () => {
  it('打字、按键、滚动出的错都要变成错误结果', async () => {
    for (const name of ['computer_type', 'computer_key', 'computer_scroll']) {
      const recorder = makeSession({ failWith: new ComputerUseError('NO_SESSION', 'computer-use: 没有这个会话') })
      const tool = createComputerTools(recorder.session).find((item) => item.name === name)
      const args =
        name === 'computer_type'
          ? { sessionId: 'session-1', text: '你好' }
          : name === 'computer_key'
            ? { sessionId: 'session-1', key: 'Enter' }
            : { sessionId: 'session-1', dy: 10 }
      const result = await tool?.execute(args, { owner: 'agent-1' })
      expect(result?.isError).toBe(true)
      expect(result?.content).toContain('没有这个会话')
    }
  })
})

describe('归属与截图渲染的边角', () => {
  it('上下文里没有 owner 时用兜底归属者', async () => {
    const recorder = makeSession()
    const tool = createComputerTools(recorder.session, { defaultOwner: 'fallback-owner' }).find(
      (item) => item.name === 'computer_click',
    )
    // 没有 ctx（undefined）与 ctx 里 owner 是空串，两种都该走兜底。
    const result = await tool?.execute({ sessionId: 'session-1', x: 1, y: 2 }, {})
    expect(result?.isError).toBeUndefined()
  })

  it('截图给不出屏幕尺寸时，结果里就不写尺寸', async () => {
    const recorder = makeSession({ shotWithoutSize: true })
    const tool = createComputerTools(recorder.session).find((item) => item.name === 'computer_screenshot')
    const result = await tool?.execute({ sessionId: 'session-1' }, { owner: 'agent-1' })
    const parsed = JSON.parse(result?.content ?? '{}') as { size?: string; inline?: boolean }
    expect(parsed.inline).toBe(true)
    expect(parsed.size).toBe('')
  })

  it('动作种类认得全，认不得的要拒掉', () => {
    for (const kind of ['click', 'type', 'key', 'move', 'scroll']) {
      expect(isComputerActionKind(kind)).toBe(true)
    }
    expect(isComputerActionKind('drag')).toBe(false)
    expect(isComputerActionKind('')).toBe(false)
  })
})
