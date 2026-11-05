/**
 * `@ryharness/computer-use` —— 让助理能**看着桌面动手**（截图、点击、打字、
 * 按键）。
 *
 * 这一族分三层：
 *
 * - {@link ComputerDriver}：怎么驱动一个桌面。本包**不自带桌面自动化二进制**——那要
 *   原生代码或操作系统自带的接口，装在包依赖里不合适，真用得上的场景（远程
 *   桌面、无头、多屏）又各不相同，所以驱动归宿主、契约归包。（本包自带一个
 *   **可选**的 Windows 驱动 {@link WindowsDesktopDriver}：它走系统自带的
 *   PowerShell + .NET，不需要编译任何原生代码。）
 * - {@link ComputerSessionService}：会话归谁、别人能不能碰、有没有上限、用完
 *   怎么收干净。
 * - {@link DANGEROUS_COMPUTER_ACTIONS}：哪些动作默认要人点头。
 * - 五个模型工具：`computer_screenshot` / `computer_click` / `computer_type` /
 *   `computer_key` / `computer_scroll`。
 *
 * **与浏览器那一族的根本差别**：桌面上没有「只允许 http/https、不去内网」这种
 * 天然边界。模型说「点 (800, 600)」，那就是真的在那个位置点一下——点错地方
 * 就点错地方。所以这个包的重心是**高危动作默认要人点头**：宿主没接确认回调
 * 时，一律拒绝执行。
 *
 * **截图可能含个人信息**：屏幕上有什么就截到什么（邮件、聊天记录、密码提示
 * 都在里面）。策略里能单独关掉截图；关掉之后调用方拿到的是结构化错误，而
 * 不是一张空图。
 *
 * **没装驱动时的行为**：调用会得到结构化错误 `NO_DRIVER`（见
 * {@link createUnavailableComputerDriver}），不会假装操作成功。
 *
 * @module @ryharness/computer-use
 */

export {
  DANGEROUS_COMPUTER_ACTIONS,
  describeComputerAction,
  isDangerousComputerAction,
} from './dangerous.ts'
export type { WindowsDesktopOptions } from './drivers/windows.ts'
export { findPowerShell, toSendKeys, WindowsDesktopDriver } from './drivers/windows.ts'
export type { ComputerUseErrorCode } from './errors.ts'
export { ComputerUseError, isComputerUseError } from './errors.ts'
export { createUnavailableComputerDriver, emptyComputerScreenshot } from './fallback.ts'
export { ComputerSessionService } from './service.ts'
export type { ComputerToolsOptions } from './tools.ts'
export {
  createComputerClickTool,
  createComputerKeyTool,
  createComputerScreenshotTool,
  createComputerScrollTool,
  createComputerTools,
  createComputerTypeTool,
} from './tools.ts'
export type {
  ComputerAction,
  ComputerActionKind,
  ComputerApprovalRequest,
  ComputerApprover,
  ComputerDriver,
  ComputerDriverFactory,
  ComputerOwner,
  ComputerPolicy,
  ComputerPolicyInput,
  ComputerScreenshot,
  ComputerSessionServiceOptions,
  ComputerSessionView,
  ComputerTool,
  ComputerToolContext,
  ComputerToolResult,
  ComputerToolSession,
} from './types.ts'
