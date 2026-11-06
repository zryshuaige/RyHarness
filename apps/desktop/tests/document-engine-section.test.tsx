// @vitest-environment jsdom
/**
 * 「我的」页的文档转换区块：这台电脑上能不能把 Office 文件转成 PDF。
 *
 * 这一族盯的是**三件不同的事不能混成一件**：
 * - 有引擎（Word / LibreOffice）：说清现在用的是哪一个；
 * - 没引擎：说清该装什么；
 * - 插件被关掉了（路由 404）：这是「功能没开」，不是「本机缺依赖」——
 *   两者的下一步完全不一样，混成一句「读不到」等于让用户自己猜。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentEngineSection } from '../renderer/src/components/DocumentEngineSection.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

/** 把挂起的 promise 链跑完。 */
async function flush(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

async function render(api: unknown): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<DocumentEngineSection api={api as never} />)
  })
  await flush()
}

describe('文档转换引擎的状态', () => {
  it('有引擎时说清现在用的是哪一个', async () => {
    await render({
      documentEngines: () => {
        return Promise.resolve({ engine: { kind: 'word', converterId: 'word-com', label: 'Microsoft Word' } })
      },
    })
    expect(container.textContent).toContain('Microsoft Word')
    expect(container.textContent).not.toContain('还没有可用的转换引擎')
  })

  it('LibreOffice 也认', async () => {
    await render({
      documentEngines: () => {
        return Promise.resolve({ engine: { kind: 'libreoffice', converterId: 'soffice', label: 'LibreOffice' } })
      },
    })
    expect(container.textContent).toContain('LibreOffice')
  })

  it('没有引擎：说清该装什么，而不是只说「失败了」', async () => {
    await render({
      documentEngines: () => {
        return Promise.resolve({ engine: { kind: 'none', converterId: 'unavailable', label: '没装' } })
      },
    })
    expect(container.textContent).toContain('还没有可用的转换引擎')
    expect(container.textContent).toContain('Microsoft Office')
    expect(container.textContent).toContain('LibreOffice')
  })

  it('插件被关掉了（路由 404）：说读不到，不说「没装引擎」', async () => {
    await render({
      documentEngines: () => {
        return Promise.reject(new Error('HTTP 404'))
      },
    })
    expect(container.textContent).not.toContain('还没有可用的转换引擎')
    expect(container.textContent).toContain('读不到')
  })

  it('服务端没有这个能力：说明一句，不让整页空着', async () => {
    await render({})
    expect(container.textContent).toContain('转换引擎')
    expect(container.textContent).not.toContain('还没有可用的转换引擎')
  })

  it('报回来的形状看不懂：宁可说看不懂，也不显示半个状态', async () => {
    await render({
      documentEngines: () => {
        return Promise.resolve({ engine: undefined })
      },
    })
    expect(container.textContent).not.toContain('正在看本机装了什么')
  })
})
