/**
 * browser-use 家族的公共类型：驱动契约、会话视图、动作与结果。
 *
 * 这个包**不自带浏览器**。它给的是「怎么驱动一个浏览器」的接口：真正的后端
 * （Playwright / CDP / 别的自动化库）由宿主接进来。为什么不自己带：浏览器驱动要
 * 拖几百 MB 的浏览器二进制，装在包依赖里会让每个装这个包的人都付这份代价，而
 * 真正用得上的场景（本机装、容器装、远程 CDP）又各不相同——驱动归宿主、契约归包，
 * 是更省事的分法。
 *
 * 所以本包只回答两件事：**怎么把一次浏览动作做掉**，以及**这件事该不该做**。
 * @module @ryharness/browser-use/types
 */

/**
 * 会话的归属者。
 *
 * 通常是助理 id 或对话 id。**围栏按这个值精确比对**：`"agent-1"`、`"agent-1 "`、
 * `"Agent-1"` 是三个不同的 owner——不做 trim、不做大小写折叠。拿不准就当不是
 * 同一个（错杀的代价是多问一句，错放的代价是别人的会话被改了）。
 */
export type BrowserOwner = string

/**
 * 一张截图。
 *
 * 给的是**字节 + MIME 类型**，不给 data URL：base64 编码会让体积涨三分之一，
 * 而且「怎么展示」是宿主（界面）的事，不该由这个包定。
 */
export interface BrowserScreenshot {
  /** 原始字节（PNG / JPEG / WEBP，取决于驱动）。 */
  readonly bytes: Uint8Array
  /** MIME 类型，例如 `image/png`。 */
  readonly mimeType: string
}

/**
 * 一个浏览器驱动：怎么把一次浏览动作做掉。
 *
 * **一个实例对应一个标签页**。之所以这么切：驱动接口里的 `open(url)` 是「把这一页
 * 导航到某个地址」，没有「在第几个标签页里操作」这层意思——多个标签页就是多个
 * 驱动实例。这样切分之后，上层的会话服务不用认识 Playwright 的 Page / Context /
 * Browser 三层结构，也不用处理「当前是哪个标签页」这种状态。
 */
export interface BrowserDriver {
  /** 驱动名（例如 `playwright`）；出错时用来告诉人是谁出的问题。 */
  readonly name: string
  /**
   * 把这一页导航到某个地址。
   * @param url - 已经过安全校验的地址（服务层只放行 http/https 且非本机内网）。
   */
  open(url: string): Promise<void>
  /**
   * 点一下某个元素。
   * @param selector - CSS 选择器。
   */
  click(selector: string): Promise<void>
  /**
   * 在当前焦点位置打字。
   * @param text - 要打的字。
   */
  type(text: string): Promise<void>
  /** 截当前这一页的图。 */
  screenshot(): Promise<BrowserScreenshot>
  /** 读当前这一页的正文文本（已去掉脚本与样式）。 */
  readText(): Promise<string>
  /** 关掉这一页（连同它占的资源）。 */
  close(): Promise<void>
}

/**
 * 能提交表单的驱动才实现这个接口。
 *
 * 单独拆出来是因为「提交表单」是**有副作用**的动作，默认不放行（见
 * {@link BrowserPolicy.allowFormSubmit}）；驱动没实现它时，调用方要拿到一个
 * 「这个驱动干不了这件事」而不是一句含糊的失败。
 */
export interface BrowserFormSubmitter {
  /**
   * 提交表单。
   * @param selector - 提交按钮的选择器；不给就用当前焦点所在表单。
   */
  submit(selector?: string): Promise<void>
}

/**
 * 能下载文件的驱动才实现这个接口。
 *
 * 与 {@link BrowserFormSubmitter} 同理：下载会把文件写进磁盘，默认不放行
 * （见 {@link BrowserPolicy.allowDownload}）。
 */
export interface BrowserDownloader {
  /**
   * 触发一次下载。
   * @param selector - 下载链接的选择器。
   */
  download(selector: string): Promise<void>
}

/** 造一个标签页的驱动。服务每开一个标签页就调一次。 */
export type BrowserDriverFactory = () => BrowserDriver | Promise<BrowserDriver>

/**
 * 会话服务的安全策略。
 *
 * 三条默认全是关的，理由都是「模型能直接触发、而后果在用户那边」：
 * - 不去本机与内网（不然模型能把这条链路变成访问本机服务的跳板）；
 * - 不自动提交表单（提交等于替用户按下那个按钮）；
 * - 不自动下载文件（下载会往磁盘上写东西）。
 *
 * 宿主要放开哪一条，就在配置里显式写 true——**默认关着不是保守，是让「谁放开的」
 * 留在配置里可查**。
 */
export interface BrowserPolicy {
  /** 允许访问本机与内网地址。默认 false。 */
  readonly allowPrivateNetwork: boolean
  /** 允许自动提交表单。默认 false。 */
  readonly allowFormSubmit: boolean
  /** 允许自动下载文件。默认 false。 */
  readonly allowDownload: boolean
}

/** 策略的可选片段：没写的项按默认（全是 false）算。 */
export type BrowserPolicyInput = Partial<BrowserPolicy>

/** 会话里能做的动作。 */
export type BrowserActionKind = 'click' | 'type' | 'submit' | 'download'

/** 一次动作的请求。 */
export interface BrowserAction {
  /** 动作种类。 */
  readonly kind: BrowserActionKind
  /** 元素选择器（click / submit / download 要用）。 */
  readonly selector?: string
  /** 要打的字（type 要用）。 */
  readonly text?: string
}

/** 会话里的一个标签页。 */
export interface BrowserTabView {
  /** 标签页 id。 */
  readonly id: string
  /** 当前地址。 */
  readonly url: string
}

/** 一个会话的对外视图（快照，不是活对象）。 */
export interface BrowserSessionView {
  /** 不透明会话 id。 */
  readonly id: string
  /** 归属者。 */
  readonly owner: BrowserOwner
  /** 这个会话里的标签页。 */
  readonly tabs: readonly BrowserTabView[]
  /** 当前正在操作的标签页 id。 */
  readonly activeTabId: string
  /** 创建时刻（毫秒时间戳）。 */
  readonly createdAt: number
}

/** 读页面正文的结果。 */
export interface BrowserTextResult {
  /** 结果种类。 */
  readonly kind: 'text'
  /** 正文文本。 */
  readonly text: string
}

/** 读页面截图的结果。 */
export interface BrowserImageResult {
  /** 结果种类。 */
  readonly kind: 'screenshot'
  /** 图片字节。 */
  readonly bytes: Uint8Array
  /** MIME 类型。 */
  readonly mimeType: string
}

/** 读页面的结果（正文或截图）。 */
export type BrowserReadResult = BrowserTextResult | BrowserImageResult

/** 会话服务的构造参数。 */
export interface BrowserSessionServiceOptions {
  /**
   * 造标签页驱动的工厂。
   *
   * **不给就没有浏览器**：服务会明确报「没装浏览器驱动」，不会假装操作成功。
   */
  readonly driverFactory?: BrowserDriverFactory
  /** 一个会话最多几个标签页。默认 4。 */
  readonly maxTabs?: number
  /** 一个 owner 最多几个会话。默认 8。 */
  readonly maxSessions?: number
  /** 单步操作的时限（毫秒）。默认 15000。 */
  readonly stepTimeoutMs?: number
  /** 安全策略的覆盖项。 */
  readonly policy?: BrowserPolicyInput
  /** 主机名解析器（校验内网用；测试注入固定结果）。 */
  readonly resolveHost?: HostResolver
}

/** 解析主机名到地址列表。 */
export type HostResolver = (hostname: string) => Promise<readonly string[]>

/** 工具执行上下文。 */
export interface BrowserToolContext {
  /** 调用方的会话归属者；不给就用工具选项里的默认值。 */
  readonly owner?: string
  /** 调用方的取消信号。 */
  readonly signal?: AbortSignal
}

/**
 * 工具需要的会话能力（只要这三个方法）。
 *
 * 工具只用到「开一个会话、做一件事、读一次内容」，所以它依赖的是**这三个方法**
 * 而不是整个 {@link BrowserSessionService}。这样宿主可以拿自己的实现顶上，
 * 测试也能塞一个专门失败的替身。
 */
export interface BrowserToolSession {
  /**
   * 开一个会话并打开第一个标签页。
   * @param owner - 会话归属者。
   * @param url - 第一个标签页要去的地址。
   * @returns 建好的会话。
   */
  open(owner: BrowserOwner, url: string): Promise<BrowserSessionView>
  /**
   * 做一次动作。
   * @param owner - 会话归属者。
   * @param sessionId - 会话 id。
   * @param action - 动作请求。
   */
  act(owner: BrowserOwner, sessionId: string, action: BrowserAction): Promise<void>
  /**
   * 读当前标签页的正文或截图。
   * @param owner - 会话归属者。
   * @param sessionId - 会话 id。
   * @param kind - 读正文还是读截图。
   * @returns 读到的内容。
   */
  read(owner: BrowserOwner, sessionId: string, kind: 'text' | 'screenshot'): Promise<BrowserReadResult>
}

/** 工具返回给模型的结果。 */
export interface BrowserToolResult {
  /** 文本内容。 */
  readonly content: string
  /** 出错时为 true。 */
  readonly isError?: boolean
}

/**
 * 一个浏览器工具。
 *
 * 形状（name / description / parameters / execute）与 `@ryharness/agent` 的 `Tool`
 * 兼容，宿主可以直接注册进自己的工具表；本包不引那个依赖，是为了能单独安装、
 * 单独测试。
 */
export interface BrowserTool {
  /** 工具名：模型按这个名字调用。 */
  readonly name: string
  /** 给模型看的说明。 */
  readonly description: string
  /** 入参的 JSON Schema。 */
  readonly parameters: Record<string, unknown>
  /** 执行。 */
  execute(args: unknown, ctx: BrowserToolContext): Promise<BrowserToolResult>
}
