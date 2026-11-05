/**
 * `@ryharness/browser-use` —— 让助理能**开网页、点东西、读内容**。
 *
 * 这一族分三层：
 *
 * - {@link BrowserDriver}：怎么驱动一个浏览器。本包**不自带浏览器二进制**——驱动要
 *   拖几百 MB 的浏览器，装在包依赖里不划算，真用得上的场景又各不相同，
 *   所以驱动归宿主、契约归包。（本包自带一个**可选**的 CDP 驱动
 *   {@link createCdpDriverFactory}：它连的是本机已装的 Edge / Chrome，不下载任何东西。）
 * - {@link BrowserSessionService}：会话归谁、别人能不能碰、边界在哪、用完怎么
 *   收干净。安全判定（只允许 http/https、默认不去本机内网、默认不自动提交表单
 *   与下载文件）全在这一层，模型工具与宿主直调走同一条路。
 * - 三个模型工具：`browser_open` / `browser_act` / `browser_read`。
 *
 * **没装驱动时的行为**：调用会得到结构化错误 `NO_DRIVER`（见
 * {@link createUnavailableBrowserDriver}），不会假装操作成功。
 *
 * @module @ryharness/browser-use
 */

export type { CdpBrowserOptions, CdpDriverOptions } from './drivers/cdp.ts'
export { CdpBrowser, CdpTabDriver, createCdpDriverFactory, findBrowserExecutable } from './drivers/cdp.ts'
export type { BrowserUseErrorCode } from './errors.ts'
export { BrowserUseError, isBrowserUseError } from './errors.ts'
export { createUnavailableBrowserDriver, emptyBrowserScreenshot } from './fallback.ts'
export type { HostVerdict } from './guard.ts'
export { assertNavigableUrl, isPrivateAddress, judgeHost } from './guard.ts'
export { BrowserSessionService, defaultResolveHost } from './service.ts'
export type { BrowserToolsOptions } from './tools.ts'
export {
  createBrowserActTool,
  createBrowserOpenTool,
  createBrowserReadTool,
  createBrowserTools,
} from './tools.ts'
export type {
  BrowserAction,
  BrowserActionKind,
  BrowserDownloader,
  BrowserDriver,
  BrowserDriverFactory,
  BrowserFormSubmitter,
  BrowserImageResult,
  BrowserOwner,
  BrowserPolicy,
  BrowserPolicyInput,
  BrowserReadResult,
  BrowserScreenshot,
  BrowserSessionServiceOptions,
  BrowserSessionView,
  BrowserTabView,
  BrowserTextResult,
  BrowserTool,
  BrowserToolContext,
  BrowserToolResult,
  BrowserToolSession,
  HostResolver,
} from './types.ts'
