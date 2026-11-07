/**
 * Remote 层：客户端调宿主。
 *
 * 宿主把本地对象挂出来，客户端连上去照着**类型图**调——两边可以不在同一个
 * 进程。这一层是把类型图网关（`@ryharness/typert-gateway`）接上真实连接：
 * TCP 客户端、TCP 服务端、挂载与调用。
 *
 * 线协议（JSON-RPC 2.0 + 按行分帧）在这里**原样转出**——进程外 SDK
 * （`@ryharness/sdk`）复用同一套，不另写一份。
 * @module @ryharness/api
 */

export type {
  JsonRpcErrorObject,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  RemoteBinding,
  RemoteInvoker,
  RemoteMethodAnnotation,
  RemoteMethodDescriptor,
  RemoteParamDescriptor,
  RpcTransport,
  TypeGraph,
} from '@ryharness/typert-gateway'
/**
 * 线协议：原样转出类型图网关那一套。
 *
 * 单独列出来是为了让「用哪套线协议」这件事有个明确答案：Remote 层与进程外
 * SDK 用的是**同一套**，没有第二份实现。
 */
export {
  CANCEL_REQUEST_METHOD,
  createMemoryTransportPair,
  decodeMessage,
  decodeRemoteError,
  encodeFailure,
  encodeMessage,
  encodeRemoteError,
  isNotification,
  isRequest,
  isResponse,
  JSON_RPC_ERROR_CODES,
  JSON_RPC_VERSION,
  JsonRpcFrameDecoder,
  JsonRpcPeer,
  REMOTE_CALL_METHOD,
  REMOTE_GRAPH_METHOD,
} from '@ryharness/typert-gateway'
export type { RemoteCallOptions, RemoteConnectOptions } from './client.ts'
export { RemoteClient } from './client.ts'
export type { RemoteHostOptions, RemoteMount } from './host.ts'
export { RemoteHost } from './host.ts'
export type { RemoteHostServer, RemoteHostServerOptions } from './server.ts'
export { createRemoteHostServer } from './server.ts'
export type { RemoteSocketConnection, RemoteSocketConnectOptions } from './socket.ts'
export { connectRemoteSocket, createSocketTransport } from './socket.ts'
export type { RemoteConversationView, RemoteMemoryHit, RemoteMessageView } from './views.ts'
