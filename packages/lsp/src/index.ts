/**
 * RyHarness 的代码导航：用语言服务器在代码里跳定义、找引用、找实现、读 hover。
 *
 * 三块东西：
 * - 一条**服务**（{@link LspService}）：按文件扩展名挑 provider，把四个只读操作
 *   派下去，结果一律归一化成 `{ uri, line, character }` 或一段文本；
 * - 一个**stdio provider**（{@link StdioLspProvider}）：按配置把本机的语言服务器
 *   拉起来，自己实现 LSP 的帧协议，走完整握手；
 * - 一套**结构化失败**（{@link LspError}）：每种失败有机器可读的 code 与一句中文原因。
 *
 * 本包**不含语言服务器本体**，也不注册任何模型工具——服务器由用户自己装，工具
 * 那一层（上游 dsh 的 `tool-lsp`）留给上层做。
 * @module @ryharness/lsp
 */

export type { LspConnectionOptions, LspExitInfo } from './connection.ts'
export { describeSpawnError, LspConnection } from './connection.ts'
export type { LspErrorCode } from './errors.ts'
export { describeLspFailure, LspError } from './errors.ts'
export { encodeFrame, FRAME_HEADER_SEPARATOR, LspFrameDecoder, parseContentLength } from './framing.ts'
export { normalizeHover, normalizeLocations } from './normalize.ts'
export { LspService, selectProvider } from './service.ts'
export type { SpawnPlan } from './spawn.ts'
export { planSpawn } from './spawn.ts'
export type {
  StdioLspProviderConfig,
  StdioLspProviderOptions,
  StdioLspProviderStatus,
} from './stdio-provider.ts'
export { languageIdFor, readServerOperations, StdioLspProvider } from './stdio-provider.ts'
export type {
  LspHover,
  LspLocation,
  LspOperation,
  LspProvider,
  LspProviderCapabilities,
  LspRange,
  LspSourcePosition,
} from './types.ts'
export { LSP_OPERATIONS } from './types.ts'
export { fileExtension, pathToUri, uriToPath } from './uri.ts'
