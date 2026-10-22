/**
 * 渲染层兜底边界：子树渲染抛错时它接手，绝不留一屏空白。
 *
 * 为什么要它：React 里渲染期抛出的异常会一路冒到最近的边界；没有边界时它会掀掉整棵
 * 树，`#root` 变成零子节点——窗口里只剩一片底色，用户看到的是"应用死了"，而控制台里
 * 才有一条他们永远不会去看的堆栈。真机上这一类崩过不止一次，最典型的一处是拿类实例
 * 的方法裸取出来再调用（丢了 `this`），崩在 `this.request` 上，整窗随之变白。
 *
 * 四条约定：
 *  · 说人话。标题与主因都是中文，原文只在折叠起来的「错误详情」里出现——那才是给人
 *    复制去排查的，不是让人当场读的。
 *  · 能自救。「重试」不是刷新页面：它清掉错误态并给子树换一把 key，这一轮从零重挂，
 *    上一轮攒下的半截状态不带过来；切过一次会话/页签之后回来的那一屏也有机会自己长回来。
 *  · 不另起视觉。颜色、圆角、阴影、按钮全部取既有 token（styles.css 的 .app-fatal），
 *    兜底层看起来就是这套界面的一部分。
 *  · 自己不崩，也留痕。渲染期抛出的东西不保证是 Error，`Object.create(null)` 连
 *    toString 都没有——在边界自己的 render 里对它调 String() 会二次抛出 TypeError，
 *    边界随之崩掉、整棵树被摘干净，正是它要消灭的那一屏白。文本提取逐级兜底；同时把
 *    每次崩溃写进本地崩溃日志（见 reportRenderCrash），生产环境才有得查。
 */
import { Component, type ErrorInfo, Fragment, type ReactNode } from 'react'
import { copyText } from '../lib/desktop.ts'
import { readSetting, writeSetting } from '../lib/storage.ts'
import { Icon } from './Icon.tsx'

export interface ErrorBoundaryProps {
  children: ReactNode
  /**
   * 逐项浅比较；任一项变化即清错误态并重挂子树。
   * 局部边界靠它自动恢复：切会话（conversationId）、切页签（tab）之后回到出错的那块
   * 时不必先让用户手点一次「重试」。
   */
  resetKeys?: readonly unknown[]
  /** 覆盖标题。局部边界说清是"哪一块"出了事，根边界用默认那句。 */
  title?: string
  /** 主因下面那句"接下来怎么办"。 */
  hint?: string
  /** 第三个参数是边界自己的标题，用来给崩溃日志标注"哪一块崩了"。 */
  onError?: (error: unknown, info: ErrorInfo, where: string) => void
}

interface ErrorBoundaryState {
  /** null = 没在兜底态。渲染期抛的东西不保证是 Error（throw '字符串' 也合法）。 */
  error: unknown
  /** 重挂计数，每次重试 +1，作为子树的 key。
   *
   *  眼下兜底期间子树已经被 React 整个摘掉，清掉错误态就等于重新挂载；仍然换一把 key
   *  是不想把"重试一定是一棵新子树"押在这个隐含行为上——将来若改成出错时仍渲染子树
   *  （叠加一条提示而不是整体替换），key 是那时唯一还管用的手段。 */
  epoch: number
  /** 复制按钮的当场回执：整棵树都可能已经卸了，ToastHost 不一定还在。 */
  copied: boolean
  componentStack: string
}

/**
 * 把渲染期异常归成一句人话。
 *
 * 只按"错误长什么样"分级，不猜业务含义——猜出来的解释一旦和真实原因不符，用户会照着
 * 一句错的方向去排查。原文仍然完整保留在错误详情里。
 *
 * 因此每条判据都必须是引擎的固定句式，而不是"文本里出现了某几个词"：
 * 服务端把 "feature not implemented" / "is not a function" 回成一句时，那是另一类问题，
 * 说成"浏览器能力缺失"或"值没接上"会把人引到完全错的排查方向上去。
 */
/** 取属性/解构时值没接上：V8、SpiderMonkey、JSC 的措辞都收在这一条里。 */
const CAUSE_PROPERTY_MISSING =
  /cannot (?:read|set) propert(?:y|ies) of|cannot destructure propert|cannot convert undefined or null to object/i
/** "这东西不能当函数调"：同一句话服务端也会写，只在 TypeError 里才认。 */
const CAUSE_NOT_CALLABLE = /is not a function|is not a constructor/i
const CAUSE_UPDATE_LOOP = /maximum update depth|too many re-encountered updates/i
/**
 * 浏览器能力缺失：jsdom/旧内核的原文是 `Not implemented: window.scrollTo` —— 冒号后跟
 * 一条点号路径，且没有别的话。因此要求整条消息就是这个形状：服务端那句
 * "not implemented by this provider" 说的是另一回事（功能没实现），指过去查浏览器
 * 会把人带偏。ResizeObserver 报环是另一句固定文案。
 */
const CAUSE_BROWSER_GAP = /^not implemented:\s*[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*\s*$|resizeobserver loop/i

export function explainRenderFailure(error: unknown): string {
  if (!(error instanceof Error)) return '渲染这块界面时抛出了一个认不出来的错误。'
  const message = textOf(() => {
    return error.message
  })
  // 类实例的方法被拆出来调用（丢了 this）以及它的近亲，读起来都是这一类。
  if (CAUSE_PROPERTY_MISSING.test(message) || (isTypeError(error) && CAUSE_NOT_CALLABLE.test(message))) {
    return '有一段界面代码没能正常执行：它要用的某个值没有接上。'
  }
  if (CAUSE_UPDATE_LOOP.test(message)) {
    return '这块界面停在了反复更新里，同一个状态被一直改动，先停下来等重试。'
  }
  if (CAUSE_BROWSER_GAP.test(message)) {
    return '这块界面用到的浏览器能力在当前环境里没有，先停下来等重试。'
  }
  return '渲染这块界面时遇到一个还没被处理好的错误。'
}

/** 读属性本身都可能抛（getter、代理），所有取值都从这里过一道。 */
function textOf(read: () => unknown): string {
  try {
    const value = read()
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

function isTypeError(error: Error): boolean {
  return (
    textOf(() => {
      return error.name
    }) === 'TypeError'
  )
}

/** 单条崩溃记录的详情上限：别把一整个巨型响应体塞进日志与复制文本。 */
const MAX_DETAIL_CHARS = 4000

/**
 * 把任意抛出物转成一段可读文本，**任何输入都不抛**。
 *
 * 为什么不能直接 `String(error)`：`Object.create(null)` 没有原型上的 toString，
 * `{toString: null}` 的 toString 不是函数，代理与 getter 还会在读属性时再抛一次。
 * 旧实现正是在边界自己的 render 里调它，于是边界崩掉、整棵树被摘干净、`#root`
 * 变成零子节点——把要消灭的白屏又造了一遍。这里逐级退化：原生 Error → 字符串 →
 * JSON → 类型标签 → 一句占位。
 */
export function describeThrown(value: unknown): string {
  const text = tryDescribe(value)
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}\n…（已截断）` : text
}

function tryDescribe(value: unknown): string {
  try {
    if (value instanceof Error) {
      const name = textOf(() => {
        return value.name
      })
      const message = textOf(() => {
        return value.message
      })
      if (message.length > 0) return name.length > 0 ? `${name}: ${message}` : message
      return name.length > 0 ? name : 'Error'
    }
    if (typeof value === 'string') return value
    // 剩下的基本类型 String() 都安全：symbol 也是（`'' + symbol` 才抛）。
    if (value === null || typeof value !== 'object') return String(value)
    // 对象：JSON 最像人话（Object.create(null) 得到 "{}"），读不动再退到类型标签。
    const json = textOf(() => {
      return JSON.stringify(value)
    })
    if (json.length > 0) return json
    return Object.prototype.toString.call(value)
  } catch {
    return '（这个错误对象没法转成文字）'
  }
}

/** 栈只在真的拿到 Error 时才有；读它同样包一层。 */
function stackOf(value: unknown): string {
  if (!(value instanceof Error)) return ''
  return textOf(() => {
    return value.stack
  })
}

/** 复制/展示用的详情：一句人话在最上，原文与组件栈在下。 */
function failureDetail(error: unknown, componentStack: string): string {
  const head = describeThrown(error)
  const stack = stackOf(error)
  const frames = textOf(() => {
    return componentStack
  }).trim()
  return [head, stack, frames]
    .filter((part) => {
      return part.length > 0
    })
    .join('\n\n')
}

/** 一次崩溃一条记录：写进本地崩溃日志，窗口全局上是同一份快照。 */
export interface RenderCrashRecord {
  /** ISO 时间戳。 */
  at: string
  /** 哪一层边界接到的（边界自己的标题）。 */
  where: string
  /** 详情：原文、栈与组件栈，与「复制错误详情」同源。 */
  detail: string
}

/** 主进程可以 executeJavaScript 读走的全局键，与 boot-trace 的读法一致。 */
const CRASH_GLOBAL = '__RYHARNESS_CRASH__'
const CRASH_STORAGE_KEY = 'ryharness-crash-log'
/** 留最近这么多条：够看出"反复崩在同一个地方"，又不至于把 userData 撑大。 */
const CRASH_LOG_LIMIT = 20
/** 控制台里的固定前缀：用户或主进程都能 grep 到（主进程可挂 console-message 收走）。 */
const CRASH_CONSOLE_MARKER = '[ryharness-crash]'

function isRenderCrashRecord(value: unknown): value is RenderCrashRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<RenderCrashRecord>
  return typeof record.at === 'string' && typeof record.where === 'string' && typeof record.detail === 'string'
}

/** 已记下的崩溃（副本，改不动日志本身）。 */
export function readRenderCrashes(): RenderCrashRecord[] {
  try {
    const raw = readSetting(CRASH_STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRenderCrashRecord)
  } catch {
    return []
  }
}

/**
 * 记一次崩溃，挂在 ErrorBoundary 的 `onError` 上（两处挂载点都接了）。
 *
 * 三处落地，任意一处失败都不许把崩溃变成新的崩溃：
 *  · localStorage：默认会话的本地存储就在 userData 目录下（`Local Storage/leveldb`），
 *    重开应用还在——生产崩溃第一次有了磁盘上的痕迹，用户反馈时不必靠手点复制去捞；
 *  · window.__RYHARNESS_CRASH__：与 boot-trace 同一套读法，主进程随时能
 *    executeJavaScript 取走、落成 userData/crash.log 那样的一行日志；
 *  · console.error 带固定前缀：控制台里能 grep，主进程也可挂 console-message 收走。
 */
export function reportRenderCrash(error: unknown, info: ErrorInfo, where = '渲染层'): void {
  try {
    const record: RenderCrashRecord = {
      at: new Date().toISOString(),
      where,
      detail: failureDetail(
        error,
        textOf(() => info?.componentStack),
      ),
    }
    const crashes = [...readRenderCrashes(), record].slice(-CRASH_LOG_LIMIT)
    try {
      writeSetting(CRASH_STORAGE_KEY, JSON.stringify(crashes))
    } catch {
      // 隐私模式或配额满：下面两处还在，日志丢一份不该连带界面出事。
    }
    if (typeof window !== 'undefined') Reflect.set(window, CRASH_GLOBAL, crashes)
    console.error(`${CRASH_CONSOLE_MARKER} ${JSON.stringify(record)}`)
  } catch {
    // 上报失败绝不能冒回渲染里——那正是本文件开头描述的那种二次崩溃。
  }
}

/** resetKeys 逐项浅比较：任一项不同（或项数不同）就算变了。 */
function keysChanged(before: readonly unknown[] | undefined, after: readonly unknown[] | undefined): boolean {
  if (before === undefined || after === undefined) return before !== after
  if (before.length !== after.length) return true
  return before.some((value, index) => {
    return !Object.is(value, after[index])
  })
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {
    error: null,
    epoch: 0,
    copied: false,
    componentStack: '',
  }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? '' })
    this.props.onError?.(error, info, this.props.title ?? '渲染层')
  }

  override componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error === null) return
    if (!keysChanged(prev.resetKeys, this.props.resetKeys)) return
    this.reset()
  }

  /** 清错误态 + 换 key 重挂子树。放在 componentDidUpdate 里由 resetKeys 驱动时也走它。 */
  private readonly reset = (): void => {
    this.setState((prev) => {
      return { error: null, epoch: prev.epoch + 1, copied: false }
    })
  }

  private readonly copy = (): void => {
    const detail = failureDetail(this.state.error, this.state.componentStack)
    void copyText(detail).then((ok) => {
      this.setState({ copied: ok })
    })
  }

  override render(): ReactNode {
    const { error, epoch, copied, componentStack } = this.state
    if (error === null) return <Fragment key={epoch}>{this.props.children}</Fragment>

    // 崩溃日志条数：挂了 onError 的边界（两处挂载点都挂了）才会有痕迹，
    // 用户看到这一行就知道"不用靠手点复制，磁盘上已经有了"。没挂 onError 时读到的
    // 也只是别人留下的记录，所以这句话只讲"本地有几条"，不宣称"这次记下了"。
    const logged = readRenderCrashes().length
    return (
      <div className="app-fatal" data-testid="app-fatal" role="alert">
        <div className="app-fatal-card">
          <span className="app-fatal-mark" aria-hidden="true">
            <Icon name="alert" size={24} />
          </span>
          <h2 className="app-fatal-title">{this.props.title ?? '这部分界面出错了'}</h2>
          <p className="app-fatal-reason">{explainRenderFailure(error)}</p>
          <p className="app-fatal-hint">
            {/* 默认这句对任意一层都成立（"周边还活着"只有局部边界敢说，由调用方给）。 */}
            {this.props.hint ?? '点「重试」重新加载；下面的详情可以复制给开发者。'}
          </p>
          {logged > 0 && (
            <p className="app-fatal-hint" data-testid="app-fatal-logged">
              {`崩溃现场已经存在本地（最近 ${logged} 条），反馈问题时把它一起带上就行。`}
            </p>
          )}
          <div className="app-fatal-actions">
            <button type="button" className="btn btn-primary app-fatal-retry" onClick={this.reset}>
              重试
            </button>
            <button type="button" className="btn app-fatal-copy" onClick={this.copy}>
              {copied ? '详情已复制' : '复制错误详情'}
            </button>
          </div>
          <details className="app-fatal-more">
            <summary>错误详情</summary>
            <pre className="app-fatal-stack" data-testid="app-fatal-detail">
              {failureDetail(error, componentStack)}
            </pre>
          </details>
        </div>
      </div>
    )
  }
}
