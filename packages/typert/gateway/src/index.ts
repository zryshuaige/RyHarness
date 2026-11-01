/**
 * 类型图网关。
 *
 * 三件事：
 *
 * 1. **类型图**：从带 `@Remote` 的实例上反射出「有哪些方法、参数叫什么」，
 *    组成一张 namespace → service → method 的表。类型由注解补上。
 * 2. **网关**：把「调一个 remote 方法」变成一次跨连接调用，线上是 JSON-RPC 2.0
 *    （自己写的，不引依赖），错误带机器码，超时、取消、断线都有明确说法。
 * 3. **生成的客户端**：照着类型图生成 TypeScript 类型与运行时代理——调一个
 *    不存在的方法，编译期或运行期立刻报错。
 *
 * 与上游 dsh 的根本差别：上游是**编译期代码生成器**（从 .ts 源码编译出类型
 * 图），本包是**运行时反射**（装饰器把描述符写在原型上）。差距见 README。
 * @module @ryharness/typert-gateway
 */

export type { RemoteGatewayCallOptions, RemoteGatewayClientOptions } from './client.ts'
export { RemoteGatewayClient } from './client.ts'
export type {
  GenerateClientOptions,
  RemoteCallFn,
  RemoteClientProxy,
  RemoteNamespaceProxy,
} from './codegen.ts'
export {
  buildNamespaceTypeNames,
  createRemoteClientProxy,
  generateClientSource,
  generateClientTypes,
  namespaceTypeName,
} from './codegen.ts'
export type { GatewayErrorCode } from './errors.ts'
export {
  badRequest,
  cancelled,
  conflictFailure,
  disconnectedFailure,
  internalFailure,
  isGatewayError,
  timeoutFailure,
  WireRemoteError,
} from './errors.ts'
export type {
  MountedRemoteMethod,
  TypeGraphBundle,
} from './graph.ts'
export { buildTypeGraph, buildTypeGraphBundle, findEntry, formatGraph, isTypeGraph } from './graph.ts'
export type {
  JsonRpcErrorData,
  JsonRpcErrorObject,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from './json-rpc.ts'
export {
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
} from './json-rpc.ts'
export type { JsonRpcPeerOptions, JsonRpcRequestOptions } from './peer.ts'
export { CANCEL_REQUEST_METHOD, JsonRpcPeer } from './peer.ts'
export type { RemoteCallParams } from './protocol.ts'
export { REMOTE_CALL_METHOD, REMOTE_GRAPH_METHOD } from './protocol.ts'
export type { RemoteMethodMarker } from './reflect.ts'
export { isIdentifier, readRemoteMarkers, reflectParameters } from './reflect.ts'
export type { RemoteInvokeOptions, RemoteRegistryOptions } from './registry.ts'
export { RemoteRegistry } from './registry.ts'
export type { RemoteGatewayServerOptions } from './server.ts'
export { RemoteGatewayServer } from './server.ts'
export type { RpcTransport } from './transport.ts'
export { createMemoryTransportPair } from './transport.ts'
export type {
  RemoteBinding,
  RemoteEntry,
  RemoteInvoker,
  RemoteMethodAnnotation,
  RemoteMethodDescriptor,
  RemoteParamAnnotation,
  RemoteParamDescriptor,
  RemoteServiceDescriptor,
  TypeGraph,
} from './types.ts'
export { TYPE_GRAPH_VERSION } from './types.ts'
