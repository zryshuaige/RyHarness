// @vitest-environment jsdom
/**
 * 渲染层兜底边界（ErrorBoundary）：
 *  1. 子树渲染抛错时它接手，界面给中文兜底（不是一屏空白，也不是裸英文堆栈）；
 *  2. 「重试」是**重新挂载**子树（换 key），不是只清一个标志位——否则出错时攒下的
 *     半截状态原样留着，再挂一次还是坏的；
 *  3. resetKeys 让局部边界能自愈：切会话 / 切页签之后回到出错的那块，不必先让用户
 *     手点一次「重试」；
 *  4. 「复制错误详情」当场给回执（整棵树可能已经卸了，ToastHost 不一定还在），
 *     复制不了就说复制不了，不假装成功；
 *  5. 挂载点不能被悄悄摘掉：组件写好了却没人包在根上，等于这次白改；
 *  6. **边界自己不能再崩一次**：抛出物可能是 Object.create(null)、toString 为 null 或
 *     toString 自己抛错的东西；取文本时抛出去的 TypeError 落在边界自己的 render 里，
 *     整棵树随之被摘干净，#root 变成零子节点——正是它要消灭的那一屏白；
 *  7. 崩溃要留痕：两处挂载都接 onError，崩溃写进本地日志（Electron 侧落在 userData
 *     下），生产环境才有得查，不必靠用户手点复制去捞；
 *  8. 归类不能把服务端返回的 "feature not implemented" 说成「浏览器能力缺失」——
 *     把人引向错的排查方向比不猜更糟。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, type ReactNode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  describeThrown,
  ErrorBoundary,
  explainRenderFailure,
  type RenderCrashRecord,
  readRenderCrashes,
  reportRenderCrash,
} from '../renderer/src/components/ErrorBoundary.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** CJK 判定：兜底文案必须是中文，"英文原文只出现在折叠的详情里"。 */
const CJK = /[\u4e00-\u9fa5]/

/** 崩溃日志的落点：本地存储的键 + 主进程可 executeJavaScript 读走的全局键。 */
const CRASH_STORAGE_KEY = 'ryharness-crash-log'
const CRASH_GLOBAL = '__RYHARNESS_CRASH__'
const CRASH_LOG_LIMIT = 20

// 路径走 fs 而不是 import.meta.url：jsdom 环境会把全局 URL 换成 whatwg 实现。
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../renderer/src')

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

/** React 自己对渲染期异常必打一条 console.error；这里静音，只留断言要看的东西。 */
let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  // 崩溃日志是持久化的，每条用例都从「一条都没有」开始，否则计数会串。
  localStorage.clear()
  Reflect.deleteProperty(window, CRASH_GLOBAL)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = undefined
  container.remove()
  consoleError.mockRestore()
})

function Boom({ message = 'boom' }: { message?: string }): ReactNode {
  throw new Error(message)
}

/** 记录真实挂载/卸载：只有换 key 重挂才会出现 unmount → mount 这一对。 */
function makeHost(shouldThrow: () => boolean): {
  Host: (props: { extra?: string }) => ReactNode
  events: string[]
} {
  const events: string[] = []
  function Host({ extra }: { extra?: string }): ReactNode {
    useEffect(() => {
      events.push('mount')
      return () => {
        events.push('unmount')
      }
    }, [])
    if (shouldThrow()) return <Boom />
    return <p className="app-fatal-ok">{`界面回来了${extra ?? ''}`}</p>
  }
  return { Host, events }
}

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

function fatal(): HTMLElement | null {
  return container.querySelector('.app-fatal')
}

function retryButton(): HTMLButtonElement {
  const node = container.querySelector<HTMLButtonElement>('.app-fatal-retry')
  if (node === null) throw new Error('兜底 UI 上没有重试按钮')
  return node
}

/** 主进程那一侧读到的崩溃快照（window.__RYHARNESS_CRASH__）。 */
function publishedCrashes(): RenderCrashRecord[] {
  const value: unknown = Reflect.get(window, CRASH_GLOBAL)
  return Array.isArray(value) ? (value as RenderCrashRecord[]) : []
}

/** 本地存储里落盘的崩溃记录（一条崩溃一个对象，整体 JSON 编码）。 */
function storedCrashes(): RenderCrashRecord[] {
  const raw = localStorage.getItem(CRASH_STORAGE_KEY)
  return raw === null ? [] : (JSON.parse(raw) as RenderCrashRecord[])
}

/** 控制台里带固定前缀的那几行：用户和主进程都靠它捞现场。 */
function consoleCrashLines(): string[] {
  return consoleError.mock.calls
    .map((call: unknown[]) => {
      return String(call[0])
    })
    .filter((line: string) => {
      return line.includes('[ryharness-crash]')
    })
}

describe('渲染层兜底：子树抛错不白屏', () => {
  it('抛出未捕获异常时接管界面，给出中文兜底而不是空白与裸堆栈', async () => {
    const { Host } = makeHost(() => {
      return true
    })
    await render(
      <ErrorBoundary>
        <Host />
      </ErrorBoundary>,
    )

    const shell = fatal()
    expect(shell, '兜底层没接管，子树异常一路掀到了根').not.toBeNull()
    expect(shell?.getAttribute('role')).toBe('alert')
    expect(shell?.getAttribute('data-testid')).toBe('app-fatal')

    const reason = container.querySelector('.app-fatal-reason')?.textContent ?? ''
    // 主因是人话，且不带英文原文；原文只在折叠的详情里。
    expect(reason).toMatch(CJK)
    expect(reason).not.toContain('boom')
    expect(container.querySelector('.app-fatal-title')?.textContent).toMatch(CJK)
    expect(container.querySelector('.app-fatal-hint')?.textContent).toMatch(CJK)

    // 详情默认收起（details 不带 open），里面才有原文与栈。
    const details = container.querySelector('details.app-fatal-more')
    expect(details?.hasAttribute('open')).toBe(false)
    const raw = container.querySelector('.app-fatal-stack')?.textContent ?? ''
    expect(raw).toContain('boom')
    // 界面上没有一坨裸英文堆栈：可见区域（标题/主因/按钮）里没有一行 at xxx。
    const visible = [...container.querySelectorAll('.app-fatal-title, .app-fatal-reason, .app-fatal-hint, button')]
      .map((node) => {
        return node.textContent ?? ''
      })
      .join(' ')
    expect(visible).not.toMatch(/\bat\s+\w+\s*\(/)
    expect(container.querySelector('.app-fatal-ok')).toBeNull()
  })

  it('onError 回调收到同一个错误（崩溃现场不会静默丢失）', async () => {
    const seen: unknown[] = []
    await render(
      <ErrorBoundary
        onError={(error) => {
          seen.push(error)
        }}
      >
        <Boom message="现场在这儿" />
      </ErrorBoundary>,
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(Error)
    expect((seen[0] as Error).message).toBe('现场在这儿')
  })

  it('点「重试」重新挂载子树：这次不抛就渲染成功', async () => {
    let broken = true
    const { Host } = makeHost(() => {
      return broken
    })
    await render(
      <ErrorBoundary>
        <Host />
      </ErrorBoundary>,
    )
    expect(fatal()).not.toBeNull()

    broken = false
    await act(async () => {
      retryButton().click()
      await Promise.resolve()
    })

    expect(container.querySelector('.app-fatal-ok')?.textContent).toBe('界面回来了')
    expect(fatal()).toBeNull()
  })

  it('重试是真的重挂：这一轮从零开始，上一轮攒下的状态不带过来', async () => {
    // 用户看得见的差别只有一处：子树是不是新的。计数停在 2 就是"接着上一轮继续"，
    // 回到 0 才是重挂——只清一个错误标志位的话，这一格就永远是 2。
    let broken = false
    function Counter(): ReactNode {
      const [count, setCount] = useState(0)
      if (broken) throw new Error('又炸了')
      return (
        <button
          type="button"
          className="counter"
          onClick={() => {
            setCount(count + 1)
          }}
        >
          {`计数 ${count}`}
        </button>
      )
    }
    const counter = (): HTMLButtonElement | null => {
      return container.querySelector<HTMLButtonElement>('.counter')
    }
    const tree = (): ReactNode => {
      return (
        <ErrorBoundary>
          <Counter />
        </ErrorBoundary>
      )
    }

    await render(tree())
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        counter()?.click()
        await Promise.resolve()
      })
    }
    expect(counter()?.textContent).toBe('计数 2')

    broken = true
    await render(tree())
    expect(fatal()).not.toBeNull()

    broken = false
    await act(async () => {
      retryButton().click()
      await Promise.resolve()
    })
    expect(fatal()).toBeNull()
    expect(counter()?.textContent, '重试不是重挂：上一轮的计数留了下来').toBe('计数 0')
  })

  it('同一个错误再抛一次仍然进兜底（重试不是把错误吞掉）', async () => {
    const { Host, events } = makeHost(() => {
      return true
    })
    await render(
      <ErrorBoundary>
        <Host />
      </ErrorBoundary>,
    )
    await act(async () => {
      retryButton().click()
      await Promise.resolve()
    })
    expect(fatal()).not.toBeNull()
    // 出问题的那次渲染不会跑 effect，所以这里一条挂载记录都没有：这一条恰恰说明
    // 「重试之后子树被重新渲染了一次、又抛了同一个错」，而不是错误被静默吞掉。
    expect(events).toEqual([])
  })

  it('resetKeys 变了就自动恢复，用户不必先点一次重试', async () => {
    let broken = true
    const { Host } = makeHost(() => {
      return broken
    })
    const tree = (conversationId: string): ReactNode => {
      return (
        <ErrorBoundary resetKeys={[conversationId]}>
          <Host extra={conversationId} />
        </ErrorBoundary>
      )
    }
    await render(tree('c1'))
    expect(fatal()).not.toBeNull()

    // 同一个会话重画：不恢复（用户还没离开出错的那一块，没理由替他决定）。
    await render(tree('c1'))
    expect(fatal()).not.toBeNull()

    broken = false
    await render(tree('c2'))
    expect(fatal(), '切到另一个会话就该自动重画一次').toBeNull()
    expect(container.querySelector('.app-fatal-ok')?.textContent).toBe('界面回来了c2')
  })

  it('局部边界可以自带标题与那句「接下来怎么办」', async () => {
    await render(
      <ErrorBoundary title="模型供应商这块没画出来" hint="先保存好手头的 Key，再点「重试」。">
        <Boom />
      </ErrorBoundary>,
    )
    expect(container.querySelector('.app-fatal-title')?.textContent).toBe('模型供应商这块没画出来')
    expect(container.querySelector('.app-fatal-hint')?.textContent).toBe('先保存好手头的 Key，再点「重试」。')
  })
})

describe('复制错误详情', () => {
  function stubClipboard(ok: boolean): { writeText: ReturnType<typeof vi.fn> } {
    const writeText = vi.fn(() => {
      return ok ? Promise.resolve() : Promise.reject(new Error('no clipboard'))
    })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    return { writeText }
  }

  it('复制成功：按钮当场改口，不靠 Toast（整棵树可能已经卸了）', async () => {
    const { writeText } = stubClipboard(true)
    await render(
      <ErrorBoundary>
        <Boom message="可复制的现场" />
      </ErrorBoundary>,
    )
    const copy = [...container.querySelectorAll('button')].find((node) => {
      return node.textContent?.includes('复制错误详情')
    })
    expect(copy).toBeDefined()
    await act(async () => {
      ;(copy as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0]?.[0]).toContain('可复制的现场')
    const after = [...container.querySelectorAll('button')].find((node) => {
      return node.textContent?.includes('详情已复制')
    })
    expect(after, '复制成功没有任何当场回执').toBeDefined()
  })

  it('复制不了就说复制不了（不假装成功，也不弹英文原文）', async () => {
    stubClipboard(false)
    await render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    const copy = [...container.querySelectorAll('button')].find((node) => {
      return node.textContent?.includes('复制错误详情')
    })
    await act(async () => {
      ;(copy as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const labels = [...container.querySelectorAll('button')].map((node) => {
      return node.textContent ?? ''
    })
    expect(
      labels.some((text) => {
        return text.includes('详情已复制')
      }),
    ).toBe(false)
    expect(
      labels.some((text) => {
        return text.includes('复制错误详情')
      }),
    ).toBe(true)
  })
})

describe('主因归类：只按错误形状，不猜业务', () => {
  it('丢 this 那一类（真机上白过一次的那次）说的是人话', () => {
    const cause = explainRenderFailure(new TypeError("Cannot read properties of undefined (reading 'request')"))
    expect(cause).toMatch(CJK)
    expect(cause).not.toContain('Cannot read')
  })

  it('不是 Error 的抛出物也有一句人话', () => {
    expect(explainRenderFailure('字符串')).toMatch(CJK)
    expect(explainRenderFailure(undefined)).toMatch(CJK)
  })

  it('认不出的错误也落到兜底句，而不是把原文端到屏幕上', () => {
    const cause = explainRenderFailure(new Error('ECONNRESET 0x8007 something odd'))
    expect(cause).toMatch(CJK)
    expect(cause).not.toContain('ECONNRESET')
  })

  it('丢 this 那一类的近亲也还认得（Firefox 与解构的措辞）', () => {
    expect(explainRenderFailure(new TypeError('x.request is not a function'))).toContain('某个值没有接上')
    expect(explainRenderFailure(new TypeError("Cannot destructure property 'a' of 'b' as it is undefined"))).toContain(
      '某个值没有接上',
    )
  })

  // 下面这一组是「不误判」的钉子：服务端把话回成英文时，方向不能被带偏。
  // 猜出来的一句错解释，比老老实实的兜底句更糟——用户会照着它去查错的方向。
  it('服务端那句 feature not implemented 不会被说成「浏览器能力缺失」', () => {
    const messages = [
      'feature not implemented',
      'not implemented by this provider',
      'Error from server: Not implemented: /api/v2/stream',
      'this model does not support tools (not implemented yet)',
    ]
    for (const message of messages) {
      const cause = explainRenderFailure(new Error(message))
      expect(cause, message).not.toContain('浏览器能力')
      expect(cause, message).toMatch(CJK)
    }
  })

  it('服务端那句 is not a function 不会被说成「某个值没接上」', () => {
    const cause = explainRenderFailure(new Error('dispatcher is not a function on this backend'))
    expect(cause).not.toContain('某个值没有接上')
    expect(cause).toMatch(CJK)
    // 反过来，引擎自己抛的 TypeError 仍然归到"值没接上"：判据是错误类型，不是这句话本身。
    expect(explainRenderFailure(new TypeError('dispatcher is not a function'))).toContain('某个值没有接上')
  })

  it('"of undefined" 不再等于"值没接上"（旧正则会把这句也吞掉）', () => {
    const cause = explainRenderFailure(new Error('list of undefined agents returned by server'))
    expect(cause).not.toContain('某个值没有接上')
    expect(cause).toMatch(CJK)
  })

  it('浏览器能力缺失仍然认得出（jsdom 的 Not implemented 与 ResizeObserver 环）', () => {
    expect(explainRenderFailure(new Error('Not implemented: window.scrollTo'))).toContain('浏览器能力')
    expect(explainRenderFailure(new Error('ResizeObserver loop completed with undelivered notifications.'))).toContain(
      '浏览器能力',
    )
  })

  it('反复更新那一类不受影响', () => {
    expect(explainRenderFailure(new Error('Maximum update depth exceeded'))).toMatch(CJK)
    expect(explainRenderFailure(new Error('Too many re-encountered updates'))).toContain('反复更新')
  })
})

describe('任意抛出物都能转成一段文字（边界自己绝不能再抛）', () => {
  it('原生 Error 是 name: message', () => {
    expect(describeThrown(new TypeError('读不到'))).toBe('TypeError: 读不到')
    expect(describeThrown(new Error(''))).toBe('Error')
  })

  it('基本类型原样成文（symbol 也不会抛）', () => {
    expect(describeThrown('就是它')).toBe('就是它')
    expect(describeThrown(42)).toBe('42')
    expect(describeThrown(undefined)).toBe('undefined')
    expect(describeThrown(null)).toBe('null')
    expect(describeThrown(Symbol('s'))).toBe('Symbol(s)')
  })

  it('没有原型 / toString 为 null / 循环引用：一律不抛', () => {
    expect(describeThrown(Object.create(null))).toBe('{}')
    expect(describeThrown({ toString: null })).toBe('{"toString":null}')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(describeThrown(circular)).toBe('[object Object]')
  })

  it('属性一读就抛的对象落到占位句，而不是把 TypeError 抛给调用方', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('读不到任何属性')
        },
        ownKeys() {
          throw new Error('连键都枚举不出来')
        },
      },
    )
    expect(describeThrown(hostile)).toBe('（这个错误对象没法转成文字）')
  })

  it('超长详情截断（别把一整个响应体塞进日志与复制文本）', () => {
    const text = describeThrown('x'.repeat(9000))
    expect(text).toContain('已截断')
    expect(text.length).toBeLessThan(5000)
  })
})

describe('抛出物连 toString 都没有：边界自己不能再崩一次', () => {
  // 这组是本次加固的核心：旧实现对抛出物直接 String(error)，Object.create(null)
  // 在那一行抛 TypeError，而这一行就发生在边界自己的 render 里 → 边界崩 → React 把
  // 整棵树摘干净 → #root 零子节点。白屏不是被这次崩溃带走的，是被"处理崩溃的代码"带走的。
  const NASTY: { label: string; value: unknown }[] = [
    { label: 'Object.create(null)', value: Object.create(null) },
    { label: 'toString 为 null', value: { toString: null } },
    {
      label: 'toString 自己抛错',
      value: {
        toString: () => {
          throw new Error('toString 里又炸了')
        },
      },
    },
  ]

  it.each(NASTY)('抛出 $label 时兜底层照常接管', async ({ value }) => {
    function Nasty(): ReactNode {
      throw value
    }
    await render(
      <ErrorBoundary onError={reportRenderCrash}>
        <Nasty />
      </ErrorBoundary>,
    )
    expect(fatal(), '边界在自己的 render 里抛了，整棵树被摘干净').not.toBeNull()
    expect(container.querySelector('.app-fatal-reason')?.textContent).toMatch(CJK)
    expect(container.querySelector('.app-fatal-stack')?.textContent?.length ?? 0).toBeGreaterThan(0)
    // 崩溃照样留痕：这类现场恰恰最需要被记下来
    expect(storedCrashes()).toHaveLength(1)
  })

  it('这类抛出物点「复制错误详情」也不会把边界再炸一次', async () => {
    const writeText = vi.fn((_text: string) => {
      return Promise.resolve()
    })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    function Nasty(): ReactNode {
      throw Object.create(null)
    }
    await render(
      <ErrorBoundary>
        <Nasty />
      </ErrorBoundary>,
    )
    const copy = [...container.querySelectorAll('button')].find((node) => {
      return node.textContent?.includes('复制错误详情')
    })
    await act(async () => {
      ;(copy as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(String(writeText.mock.calls[0]?.[0]).length).toBeGreaterThan(0)
    expect(fatal()).not.toBeNull()
  })
})

describe('崩溃留痕：崩了就得在磁盘上有东西', () => {
  it('崩溃写进本地日志，并挂到主进程读得走的窗口全局上', async () => {
    await render(
      <ErrorBoundary title="RyHarness 没能画出来" onError={reportRenderCrash}>
        <Boom message="磁盘上要有我" />
      </ErrorBoundary>,
    )

    const stored = storedCrashes()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.detail).toContain('磁盘上要有我')
    expect(stored[0]?.where, '日志要说得清是哪一块崩的').toBe('RyHarness 没能画出来')
    expect(stored[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/u)

    expect(publishedCrashes()).toHaveLength(1)
    expect(consoleCrashLines()).toHaveLength(1)
    expect(consoleCrashLines()[0]).toContain('磁盘上要有我')
    // 界面上看得见"已经记下来了"，用户才知道不必靠手点复制去捞现场。
    expect(container.querySelector('[data-testid="app-fatal-logged"]')?.textContent).toMatch(CJK)
  })

  it('内容区边界崩的也记一条，标的是它自己的标题', async () => {
    await render(
      <ErrorBoundary title="这块页面没画出来" onError={reportRenderCrash}>
        <Boom message="聊天区崩了" />
      </ErrorBoundary>,
    )
    expect(storedCrashes()[0]?.where).toBe('这块页面没画出来')
    expect(storedCrashes()[0]?.detail).toContain('聊天区崩了')
  })

  it('连崩多次会累积，且只留最近 20 条（userData 不被撑大）', () => {
    for (let i = 0; i < CRASH_LOG_LIMIT + 5; i++) {
      reportRenderCrash(new Error(`第 ${i} 次`), { componentStack: null }, '这块页面没画出来')
    }
    const stored = storedCrashes()
    expect(stored).toHaveLength(CRASH_LOG_LIMIT)
    expect(stored[0]?.detail).toContain('第 5 次')
    expect(stored[CRASH_LOG_LIMIT - 1]?.detail).toContain(`第 ${CRASH_LOG_LIMIT + 4} 次`)
  })

  it('本地存储写不进去（隐私模式/配额满）也不挡其他两处留痕，更不会自己崩', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    try {
      expect(() => {
        reportRenderCrash(new Error('配额满了也要留下'), { componentStack: null }, '渲染层')
      }).not.toThrow()
    } finally {
      setItem.mockRestore()
    }
    expect(storedCrashes()).toHaveLength(0)
    expect(publishedCrashes()).toHaveLength(1)
    expect(consoleCrashLines()).toHaveLength(1)
  })

  it('读出来的是副本，坏数据也读不崩', () => {
    const crashes = readRenderCrashes()
    crashes.push({ at: 'x', where: 'y', detail: 'z' })
    expect(readRenderCrashes()).toHaveLength(0)

    localStorage.setItem(CRASH_STORAGE_KEY, '{ 坏掉的 JSON')
    expect(readRenderCrashes()).toEqual([])

    localStorage.setItem(CRASH_STORAGE_KEY, JSON.stringify([{ at: 1 }, '垃圾']))
    expect(readRenderCrashes()).toEqual([])
  })

  it('没有接 onError 的边界不硬塞一条日志（谁挂的谁负责记）', async () => {
    await render(
      <ErrorBoundary>
        <Boom message="没人记" />
      </ErrorBoundary>,
    )
    expect(fatal()).not.toBeNull()
    expect(storedCrashes()).toHaveLength(0)
    expect(container.querySelector('[data-testid="app-fatal-logged"]')).toBeNull()
  })
})

describe('挂载点：组件存在不等于有人用它', () => {
  const main = readFileSync(resolve(SRC, 'main.tsx'), 'utf8')
  const app = readFileSync(resolve(SRC, 'App.tsx'), 'utf8')

  it('渲染层入口包住整棵 App（没有它，一次渲染异常就是整窗空白）', () => {
    expect(main).toMatch(/import \{ ErrorBoundary[^}]*\} from '\.\/components\/ErrorBoundary\.tsx'/u)
    // 包在 <App /> 外面，且仍然是 createRoot(...).render(...)
    expect(main).toMatch(/render\(\s*<ErrorBoundary[\s\S]*<App \/>\s*<\/ErrorBoundary>/)
  })

  it('App 内的内容区也有一层，且跟着页签与当前会话重画', () => {
    expect(app).toMatch(/import \{ ErrorBoundary[^}]*\} from '\.\/components\/ErrorBoundary\.tsx'/u)
    // resetKeys 跟着 [tab, activeId]：切页签 / 切会话之后这一块能自己回来
    expect(app).toMatch(/<ErrorBoundary[\s\S]*resetKeys=\{\[tab, activeId/)
  })

  it('两处挂载都接了 onError（不接的话生产崩溃在磁盘上没有任何痕迹）', () => {
    // 崩溃只在用户手点「复制错误详情」时才能捞到，恰恰是用户不会做的事。
    expect(main, '根边界没接崩溃上报').toMatch(/<ErrorBoundary[^>]*onError=\{reportRenderCrash\}/u)
    expect(app, '内容区边界没接崩溃上报').toMatch(/<ErrorBoundary[^>]*onError=\{reportRenderCrash\}/u)
  })

  it('兜底层复用既有设计 token，不另起一套视觉', () => {
    const css = readFileSync(resolve(SRC, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const blocks = [...css.matchAll(/(\.app-fatal[\w-]*(?:\s[\w-]+)?)\s*\{([^}]*)\}/g)]
    expect(blocks.length, 'styles.css 里没有 .app-fatal 的样式').toBeGreaterThan(3)
    for (const [, selector, body] of blocks) {
      expect(body, `${selector} 里有裸色值`).not.toMatch(/#[0-9A-Fa-f]{3,8}|\brgba?\(|\bhsla?\(/)
      // token 是唯一真源：不允许 var(--x, 兜底) 把同一个值抄成第二份
      expect(body, `${selector} 里有就地兜底`).not.toMatch(/var\(\s*--[a-z0-9-]+\s*,/)
    }
    // 圆角/阴影/表面全部走既有 token，而不是新起的一套数
    const card = /(\.app-fatal-card)\s*\{([^}]*)\}/.exec(css)?.[2] ?? ''
    expect(card).toContain('var(--radius-lg)')
    expect(card).toContain('var(--shadow-2)')
    expect(card).toContain('var(--bg-elevated)')
    expect(card).toContain('var(--edge)')
  })
})

describe('兜底层的图标尺寸', () => {
  it('直接写档位上的 24，不留 Icon.tsx 点名要清理的旧调用点 22', async () => {
    await render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    const svg = container.querySelector('.app-fatal-mark svg')
    expect(svg?.getAttribute('width'), '旧调用点 22 会被量化成 24，但源码仍是非档位值').toBe('24')
    expect(svg?.getAttribute('height')).toBe('24')
  })
})
