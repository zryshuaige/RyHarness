/**
 * computer-use 家族的公共类型：驱动契约、会话视图、动作与确认。
 *
 * 这个包**不自带桌面驱动**。桌面自动化（截图、点击、按键）要么靠原生代码，
 * 要么靠操作系统自带的自动化接口，两者都不适合塞进包依赖里；而真正用得上的
 * 场景（远程桌面、无头环境、多屏）又各不相同——驱动归宿主、契约归包。
 *
 * **与 browser-use 的根本差别**：桌面操作没有「地址」这个天然的安全边界。
 * 浏览器里还能靠「只允许 http/https、不去内网」拦一道；桌面上模型说「点
 * (800, 600)」，那就是真的在那个位置点一下——点错地方就点错地方。所以这个包
 * 的重心从「判定能不能做」挪到了「**要不要人点头**」。
 * @module @ryharness/computer-use/types
 */

/**
 * 会话的归属者。
 *
 * 通常是助理 id 或对话 id。**围栏按这个值精确比对**：不做 trim、不做大小写
 * 折叠、不做前缀匹配。拿不准就当不是同一个。
 */
export type ComputerOwner = string

/**
 * 一张桌面截图。
 *
 * **这张图可能含个人信息**（屏幕上有什么就截到什么：邮件、聊天记录、密码
 * 提示都在里面）。所以它不是普通的返回值——宿主接驱动时应当知道，截图会
 * 进入模型上下文，也可能落进日志。
 */
export interface ComputerScreenshot {
  /** 原始字节（PNG / JPEG，取决于驱动）。 */
  readonly bytes: Uint8Array
  /** MIME 类型，例如 `image/png`。 */
  readonly mimeType: string
  /** 屏幕宽度（像素）。驱动报不出来时缺省。 */
  readonly width?: number
  /** 屏幕高度（像素）。驱动报不出来时缺省。 */
  readonly height?: number
}

/**
 * 一个桌面驱动：怎么把一次桌面动作做掉。
 *
 * 全部按**屏幕坐标**表达——桌面上没有 CSS 选择器，位置就是地址。
 */
export interface ComputerDriver {
  /** 驱动名（例如 `auto`）；出错时用来告诉人是谁出的问题。 */
  readonly name: string
  /** 截当前屏幕的图。 */
  screenshot(): Promise<ComputerScreenshot>
  /**
   * 点一下屏幕上的某个点。
   * @param x - 横坐标（像素，左上角为 0）。
   * @param y - 纵坐标（像素，左上角为 0）。
   */
  click(x: number, y: number): Promise<void>
  /**
   * 打一段字。
   * @param text - 要打的字。
   */
  type(text: string): Promise<void>
  /**
   * 按一个键。
   * @param name - 键名（例如 `Enter`、`ctrl+c`）。
   */
  key(name: string): Promise<void>
  /**
   * 把鼠标移到某个点。
   * @param x - 横坐标（像素）。
   * @param y - 纵坐标（像素）。
   */
  move(x: number, y: number): Promise<void>
  /**
   * 滚轮滚动。
   * @param dx - 横向滚动量（像素，正数向右）。
   * @param dy - 纵向滚动量（像素，正数向下）。
   */
  scroll(dx: number, dy: number): Promise<void>
  /** 收尾：把驱动占的资源释放掉。 */
  close(): Promise<void>
}

/** 造一个桌面驱动的工厂。服务每开一个会话就调一次。 */
export type ComputerDriverFactory = () => ComputerDriver | Promise<ComputerDriver>

/** 会话里能做的动作。 */
export type ComputerActionKind = 'click' | 'type' | 'key' | 'move' | 'scroll'

/** 一次动作的请求。 */
export interface ComputerAction {
  /** 动作种类。 */
  readonly kind: ComputerActionKind
  /** 横坐标（click / move 要用）。 */
  readonly x?: number
  /** 纵坐标（click / move 要用）。 */
  readonly y?: number
  /** 要打的字（type 要用）。 */
  readonly text?: string
  /** 要按的键（key 要用）。 */
  readonly key?: string
  /** 横向滚动量（scroll 要用）。 */
  readonly dx?: number
  /** 纵向滚动量（scroll 要用）。 */
  readonly dy?: number
}

/**
 * 一次动作的确认请求。
 *
 * 宿主拿到它就该去问人：「模型想在屏幕 (800, 600) 点一下，要不要？」——把
 * 坐标原样说出来，让人能判断那是个什么地方。**不要自己替用户猜**：屏幕上
 * 是什么，只有看得见屏幕的人知道。
 */
export interface ComputerApprovalRequest {
  /** 动作种类。 */
  readonly kind: ComputerActionKind
  /** 动作的简短描述，给人看的一句中文。 */
  readonly description: string
  /** 横坐标（click / move 有）。 */
  readonly x?: number
  /** 纵坐标（click / move 有）。 */
  readonly y?: number
  /** 要打的字（type 有）。 */
  readonly text?: string
  /** 要按的键（key 有）。 */
  readonly key?: string
  /** 横向滚动量（scroll 有）。 */
  readonly dx?: number
  /** 纵向滚动量（scroll 有）。 */
  readonly dy?: number
}

/**
 * 确认回调：宿主问完人，把答案告诉服务。
 *
 * 返回 true 表示放行，false 表示拒绝。宿主也可以在这里挂超时、挂权限档位、
 * 挂审计日志——这个包只管「问不问」与「答案是什么」。
 */
export type ComputerApprover = (request: ComputerApprovalRequest) => Promise<boolean>

/**
 * 安全策略。
 *
 * 与 browser-use 相比少一条（没有「别去内网」），多一条更重要的：
 * **高危动作默认要人点头**。
 */
export interface ComputerPolicy {
  /**
   * 高危动作要不要人点头。默认 true。
   *
   * 哪些算高危：{@link DANGEROUS_COMPUTER_ACTIONS} 里列的那几类（坐标点击、
   * 打字、按键）。**鼠标移动与滚动不算**——它们不改变任何东西，点了才算。
   */
  readonly requireApproval: boolean
  /**
   * 截图要不要允许。默认 true。
   *
   * 关掉之后 {@link ComputerSessionService.screenshot} 会报结构化错误，而不是
   * 返回一张空图——「以为拿到了截图其实是空的」比「明确报错」难查。
   */
  readonly allowScreenshot: boolean
}

/** 策略的可选片段：没写的项按默认算。 */
export type ComputerPolicyInput = Partial<ComputerPolicy>

/** 一个会话的对外视图（快照，不是活对象）。 */
export interface ComputerSessionView {
  /** 不透明会话 id。 */
  readonly id: string
  /** 归属者。 */
  readonly owner: ComputerOwner
  /** 驱动名。 */
  readonly driver: string
  /** 创建时刻（毫秒时间戳）。 */
  readonly createdAt: number
}

/** 工具执行上下文。 */
export interface ComputerToolContext {
  /** 调用方的会话归属者；不给就用工具选项里的默认值。 */
  readonly owner?: string
  /** 调用方的取消信号。 */
  readonly signal?: AbortSignal
}

/**
 * 工具需要的会话能力（只要这三个方法）。
 *
 * 工具只用到「开一个会话、做一件事、截一次图」，所以它依赖的是**这三个方法**
 * 而不是整个 {@link ComputerSessionService}。这样宿主可以拿自己的实现顶上，
 * 测试也能塞一个专门失败的替身。
 */
export interface ComputerToolSession {
  /**
   * 开一个会话。
   * @param owner - 会话归属者。
   * @returns 建好的会话。
   */
  open(owner: ComputerOwner): Promise<ComputerSessionView>
  /**
   * 做一次动作。
   * @param owner - 会话归属者。
   * @param sessionId - 会话 id。
   * @param action - 动作请求。
   */
  act(owner: ComputerOwner, sessionId: string, action: ComputerAction): Promise<void>
  /**
   * 截当前屏幕。
   * @param owner - 会话归属者。
   * @param sessionId - 会话 id。
   * @returns 截图。
   */
  screenshot(owner: ComputerOwner, sessionId: string): Promise<ComputerScreenshot>
}

/** 工具返回给模型的结果。 */
export interface ComputerToolResult {
  /** 文本内容。 */
  readonly content: string
  /** 出错时为 true。 */
  readonly isError?: boolean
}

/**
 * 一个桌面工具。
 *
 * 形状（name / description / parameters / execute）与 `@ryharness/agent` 的 `Tool`
 * 兼容，宿主可以直接注册进自己的工具表；本包不引那个依赖，是为了能单独安装、
 * 单独测试。
 */
export interface ComputerTool {
  /** 工具名：模型按这个名字调用。 */
  readonly name: string
  /** 给模型看的说明。 */
  readonly description: string
  /** 入参的 JSON Schema。 */
  readonly parameters: Record<string, unknown>
  /** 执行。 */
  execute(args: unknown, ctx: ComputerToolContext): Promise<ComputerToolResult>
}

/** 会话服务的构造参数。 */
export interface ComputerSessionServiceOptions {
  /**
   * 造桌面驱动的工厂。
   *
   * **不给就没有桌面**：服务会明确报「没装桌面驱动」，不会假装操作成功。
   */
  readonly driverFactory?: ComputerDriverFactory
  /** 一个 owner 最多几个会话。默认 4。 */
  readonly maxSessions?: number
  /** 单步操作的时限（毫秒）。默认 15000。 */
  readonly stepTimeoutMs?: number
  /** 安全策略的覆盖项。 */
  readonly policy?: ComputerPolicyInput
  /**
   * 确认回调：高危动作问它要不要放行。
   *
   * **不给就等于全拒绝**：桌面上点错地方的后果比点错网页严重得多，宁可让
   * 模型什么都做不了，也不要让它自己决定。
   */
  readonly approver?: ComputerApprover
}
