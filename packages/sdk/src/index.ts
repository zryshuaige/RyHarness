/**
 * 进程外 SDK 的公开面。
 */

export type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, RpcTransport } from '@ryharness/api'
/**
 * 线协议：SDK 用的就是 Remote 层那一套（JSON-RPC 2.0 + 按行分帧）。
 *
 * 转出来是为了让「用哪套线协议」有个明确答案：进程内与进程外**同一套**。
 */
export {
  decodeMessage,
  decodeRemoteError,
  encodeMessage,
  JSON_RPC_VERSION,
  JsonRpcFrameDecoder,
  JsonRpcPeer,
} from '@ryharness/api'
export type { SdkClientOptions, SdkExit, SdkRequestOptions } from './client.ts'
export { SdkClient } from './client.ts'
export { processExitFailure, spawnFailedFailure } from './errors.ts'
export type {
  RyHarnessClientOptions,
  RyHarnessConversation,
  RyHarnessMessage,
  RyHarnessTool,
} from './ryharness.ts'
export { RyHarnessClient } from './ryharness.ts'
