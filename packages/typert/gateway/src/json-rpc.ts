/**
 * 线协议：JSON-RPC 2.0（自己写的，不引依赖）。
 *
 * 形状就是 JSON-RPC 2.0 那一套：请求带 `id`、方法名、参数；回包带 `id`，要么
 * `result` 要么 `error`。分帧用**按行分隔的 JSON**（NDJSON）——一条消息一行，
 * TCP、管道、stdio 都能用同一套。
 *
 * 与标准 JSON-RPC 的差别只有一处，而且是为了机器码：错误的 `data` 里带一个
 * `remoteCode`，对端据此重建出带同一个码的失败。人看的 `message` 照旧在
 * `message` 字段里。
 * @module @ryharness/typert-gateway/json-rpc
 */

import { RemoteError } from '@ryharness/typert-protocol'
import { badRequest, WireRemoteError } from './errors.ts'

/** JSON-RPC 协议版本号。 */
export const JSON_RPC_VERSION = '2.0'

/** 一次请求。 */
export interface JsonRpcRequest {
  readonly jsonrpc: typeof JSON_RPC_VERSION
  /** 请求 id；回包必须原样带回。 */
  readonly id: string | number
  /** 方法名。 */
  readonly method: string
  /** 参数。 */
  readonly params?: unknown
}

/** 一次通知（不回包）。 */
export interface JsonRpcNotification {
  readonly jsonrpc: typeof JSON_RPC_VERSION
  /** 方法名。 */
  readonly method: string
  /** 参数。 */
  readonly params?: unknown
}

/** 错误对象里附带的机器码与详情。 */
export interface JsonRpcErrorData {
  /** 机器码，例如 `gateway/timeout`。 */
  readonly remoteCode: string
  /** 结构化详情，原样来自宿主侧的 `details`。 */
  readonly details?: unknown
}

/** 一次错误。 */
export interface JsonRpcErrorObject {
  /** JSON-RPC 数字码。 */
  readonly code: number
  /** 人看的说明。 */
  readonly message: string
  /** 机器码与详情。 */
  readonly data?: JsonRpcErrorData
}

/** 一次回包。 */
export interface JsonRpcResponse {
  readonly jsonrpc: typeof JSON_RPC_VERSION
  /** 对应哪次请求。 */
  readonly id: string | number
  /** 成功时的结果。 */
  readonly result?: unknown
  /** 失败时的错误。 */
  readonly error?: JsonRpcErrorObject
}

/** 线上可能出现的四种消息。 */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

/** JSON-RPC 的标准数字码。 */
export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const

/** 本包自定义的数字码段（-32000 到 -32099 是 JSON-RPC 留给实现方的）。 */
const CUSTOM_CODE_BASE = -32000

/**
 * 机器码 → JSON-RPC 数字码。
 *
 * 数字码只是给不认得机器码的老客户端看的；真正判别靠 `data.remoteCode`。
 */
const REMOTE_CODE_TO_RPC_CODE: Readonly<Record<string, number>> = {
  'gateway/bad-request': JSON_RPC_ERROR_CODES.invalidRequest,
  'gateway/cancelled': -32800,
  'gateway/internal': JSON_RPC_ERROR_CODES.internalError,
  'gateway/timeout': CUSTOM_CODE_BASE - 1,
  'gateway/disconnected': CUSTOM_CODE_BASE - 2,
  'gateway/conflict': CUSTOM_CODE_BASE - 3,
}

/**
 * 读一个对象上的字符串字段。
 * @param source - 对象。
 * @param key - 字段名。
 * @returns 字段值；不是字符串时是 undefined。
 */
function readString(source: object, key: string): string | undefined {
  const value: unknown = Reflect.get(source, key)
  return typeof value === 'string' ? value : undefined
}

/**
 * 读一个对象上的数字字段。
 * @param source - 对象。
 * @param key - 字段名。
 * @returns 字段值；不是数字时是 undefined。
 */
function readNumber(source: object, key: string): number | undefined {
  const value: unknown = Reflect.get(source, key)
  return typeof value === 'number' ? value : undefined
}

/**
 * 判断一个值是不是普通对象（不是数组也不是 null）。
 * @param value - 任意值。
 * @returns 是不是普通对象。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把线上带回来的详情还原成 `gateway/bad-request` 的形状。
 * @param details - 线上的详情。
 * @returns 还原后的详情。
 */
function toBadRequestDetails(details: unknown): { readonly issues?: readonly object[] } {
  if (!isPlainObject(details)) return {}
  const issues = Reflect.get(details, 'issues')
  if (!Array.isArray(issues)) return {}
  return { issues: issues.filter((issue): issue is object => isPlainObject(issue)) }
}

/**
 * 把线上带回来的详情还原成 `gateway/timeout` 的形状。
 * @param details - 线上的详情。
 * @returns 还原后的详情。
 */
function toTimeoutDetails(details: unknown): { readonly timeoutMs: number } {
  if (!isPlainObject(details)) return { timeoutMs: 0 }
  return { timeoutMs: readNumber(details, 'timeoutMs') ?? 0 }
}

/**
 * 把线上带回来的详情还原成 `gateway/disconnected` 的形状。
 * @param details - 线上的详情。
 * @returns 还原后的详情。
 */
function toDisconnectedDetails(details: unknown): { readonly reason: string } {
  if (!isPlainObject(details)) return { reason: '' }
  return { reason: readString(details, 'reason') ?? '' }
}

/**
 * 把线上带回来的详情还原成 `gateway/conflict` 的形状。
 * @param details - 线上的详情。
 * @returns 还原后的详情。
 */
function toConflictDetails(details: unknown): { readonly namespace: string; readonly method: string } {
  if (!isPlainObject(details)) return { namespace: '', method: '' }
  return {
    namespace: readString(details, 'namespace') ?? '',
    method: readString(details, 'method') ?? '',
  }
}

/**
 * 机器码 → 重建失败实例的工厂。
 *
 * 每个工厂在自己的包里把详情**按声明的形状**还原——线上来的 JSON 是
 * `unknown`，直接塞进去类型就不见了。
 */
const REMOTE_ERROR_FACTORIES: Readonly<Record<string, (message: string, details: unknown) => RemoteError>> = {
  'gateway/bad-request': (message, details) =>
    new RemoteError('gateway/bad-request', message, toBadRequestDetails(details)),
  'gateway/cancelled': (message) => new RemoteError('gateway/cancelled', message, {}),
  'gateway/internal': (message) => new RemoteError('gateway/internal', message, {}),
  'gateway/timeout': (message, details) => new RemoteError('gateway/timeout', message, toTimeoutDetails(details)),
  'gateway/disconnected': (message, details) =>
    new RemoteError('gateway/disconnected', message, toDisconnectedDetails(details)),
  'gateway/conflict': (message, details) => new RemoteError('gateway/conflict', message, toConflictDetails(details)),
}

/**
 * 把宿主侧的失败编码成线上的错误对象。
 * @param error - 宿主侧抛出的失败。
 * @param rpcCode - 覆盖 JSON-RPC 数字码（比如「方法不存在」该报 -32601）。
 * @returns 线上错误对象。
 */
export function encodeRemoteError(error: RemoteError, rpcCode?: number): JsonRpcErrorObject {
  const code = rpcCode ?? REMOTE_CODE_TO_RPC_CODE[error.code] ?? JSON_RPC_ERROR_CODES.internalError
  return {
    code,
    message: error.message,
    data: { remoteCode: error.code, details: error.details },
  }
}

/**
 * 把任意异常编码成线上的错误对象。
 *
 * 带机器码的失败原样带过去；不带的一律按「内部错误」处理，但**不丢原文**——
 * 排错时那句英文原文往往就是唯一线索。
 * @param error - 宿主侧抛出的异常。
 * @param rpcCode - 覆盖 JSON-RPC 数字码。
 * @returns 线上错误对象。
 */
export function encodeFailure(error: unknown, rpcCode?: number): JsonRpcErrorObject {
  const message = error instanceof Error ? error.message : String(error)
  if (typeof error === 'object' && error !== null) {
    const marker = Reflect.get(error, 'isDSHRemoteError')
    const remoteCode = Reflect.get(error, 'code')
    if (marker === true && typeof remoteCode === 'string') {
      const details = Reflect.get(error, 'details')
      return {
        code: rpcCode ?? REMOTE_CODE_TO_RPC_CODE[remoteCode] ?? JSON_RPC_ERROR_CODES.internalError,
        message,
        data: { remoteCode, details },
      }
    }
  }
  return { code: rpcCode ?? JSON_RPC_ERROR_CODES.internalError, message }
}

/**
 * 把线上的错误对象还原成宿主侧那种失败。
 * @param payload - 线上错误对象。
 * @returns 带机器码的失败。
 */
export function decodeRemoteError(payload: JsonRpcErrorObject): RemoteError | WireRemoteError {
  const data = payload.data
  const remoteCode = data === undefined ? '' : data.remoteCode
  const details = data === undefined ? undefined : data.details
  const factory = REMOTE_ERROR_FACTORIES[remoteCode]
  if (factory !== undefined) return factory(payload.message, details)
  return new WireRemoteError(remoteCode, payload.message, details, payload.code)
}

/**
 * 判断一条消息是不是请求。
 * @param message - 线上消息。
 * @returns 是不是请求。
 */
export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  const id = Reflect.get(message, 'id')
  return id !== undefined && typeof Reflect.get(message, 'method') === 'string'
}

/**
 * 判断一条消息是不是通知。
 * @param message - 线上消息。
 * @returns 是不是通知。
 */
export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return Reflect.get(message, 'id') === undefined && typeof Reflect.get(message, 'method') === 'string'
}

/**
 * 判断一条消息是不是回包。
 * @param message - 线上消息。
 * @returns 是不是回包。
 */
export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return Reflect.get(message, 'id') !== undefined && typeof Reflect.get(message, 'method') !== 'string'
}

/**
 * 把一条消息编码成线上的一行。
 *
 * 结果是 `undefined` 时补成 `null`——JSON-RPC 要求成功回包必须带 `result`，
 * 而 `JSON.stringify` 会把 `undefined` 的字段直接丢掉。
 * @param message - 要发的消息。
 * @returns 一行 JSON（不带换行）。
 */
export function encodeMessage(message: JsonRpcMessage): string {
  if (isResponse(message) && message.result === undefined && message.error === undefined) {
    return JSON.stringify({ ...message, result: null })
  }
  return JSON.stringify(message)
}

/**
 * 解析一行 JSON 消息。
 * @param text - 一行文本。
 * @returns 解析出来的消息。
 * @throws RemoteError `gateway/bad-request`（这一行不是合法的 JSON-RPC 消息）。
 */
export function decodeMessage(text: string): JsonRpcMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw badRequest('这一行不是合法 JSON')
  }
  if (!isPlainObject(parsed)) throw badRequest('JSON-RPC 消息必须是一个对象')
  if (parsed.jsonrpc !== JSON_RPC_VERSION) throw badRequest('JSON-RPC 版本不认识')
  const method = parsed.method
  const id = parsed.id
  if (typeof method === 'string') {
    if (id === undefined)
      return { jsonrpc: JSON_RPC_VERSION, method, ...(parsed.params === undefined ? {} : { params: parsed.params }) }
    if (typeof id !== 'string' && typeof id !== 'number') throw badRequest('请求 id 必须是字符串或数字')
    return { jsonrpc: JSON_RPC_VERSION, id, method, ...(parsed.params === undefined ? {} : { params: parsed.params }) }
  }
  if (id === undefined) throw badRequest('回包必须带 id')
  if (typeof id !== 'string' && typeof id !== 'number') throw badRequest('请求 id 必须是字符串或数字')
  const error = parsed.error
  if (error !== undefined) {
    if (!isPlainObject(error)) throw badRequest('error 必须是一个对象')
    const code = readNumber(error, 'code')
    const message = readString(error, 'message')
    const data = Reflect.get(error, 'data')
    return {
      jsonrpc: JSON_RPC_VERSION,
      id,
      error: {
        code: code ?? JSON_RPC_ERROR_CODES.internalError,
        message: message ?? '未知错误',
        ...(isPlainObject(data)
          ? { data: { remoteCode: readString(data, 'remoteCode') ?? '', details: Reflect.get(data, 'details') } }
          : {}),
      },
    }
  }
  return { jsonrpc: JSON_RPC_VERSION, id, result: parsed.result ?? null }
}

/**
 * 按行切分的分帧器。
 *
 * 收到的字节可能是半条消息，也可能一次来三条——这里把不完整的尾巴留在缓冲
 * 里，凑齐一行才吐出去。
 */
export class JsonRpcFrameDecoder {
  private buffer = ''

  /**
   * 喂一段文本进去。
   * @param chunk - 收到的文本。
   * @returns 凑齐的完整行。
   */
  push(chunk: string): readonly string[] {
    this.buffer += chunk
    const lines: string[] = []
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim().length > 0) lines.push(line)
      index = this.buffer.indexOf('\n')
    }
    return lines
  }

  /**
   * 缓冲区里剩下的内容（连接断了时可能还有半条）。
   * @returns 剩余文本。
   */
  rest(): string {
    return this.buffer
  }
}
