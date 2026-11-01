/**
 * 网关这一层的机器码。
 *
 * 失败要能被程序分辨，不能只有一句人话：调用方得知道「是超时还是对端崩了」，
 * 才能决定重试还是改参数。所以每个失败都带一个稳定的机器码，跨线传输时原样
 * 带过去。
 *
 * 机器码的声明方式是**模块增补**：协议包把 `RemoteErrorDetailsMap` 写成可扩展
 * 的词汇表，谁拥有新的失败就在自己的包里增补一条，别去改协议包。这样协议包
 * 保持只读，各包的码也不会互相踩。
 * @module @ryharness/typert-gateway/errors
 */

import { RemoteError } from '@ryharness/typert-protocol'

declare module '@ryharness/typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 请求超时：对端在时限内没回包。 */
    'gateway/timeout': { readonly timeoutMs: number }
    /** 连接断了：传输层关闭，或对端进程没了。 */
    'gateway/disconnected': { readonly reason: string }
    /** 装配冲突：同一个命名空间里两个 remote 抢同一个名字。 */
    'gateway/conflict': { readonly namespace: string; readonly method: string }
  }
}

/**
 * 网关层新增的机器码。
 *
 * 协议包自带的三个（`gateway/bad-request`、`gateway/cancelled`、`gateway/internal`）
 * 是通用载体码，网关直接用；这里列的是网关**独占**的那几个。
 */
export type GatewayErrorCode =
  | 'gateway/bad-request'
  | 'gateway/cancelled'
  | 'gateway/internal'
  | 'gateway/timeout'
  | 'gateway/disconnected'
  | 'gateway/conflict'

/** 请求非法：方法不存在、参数个数对不上、参数名不认识。 */
export function badRequest(message: string, issues?: readonly object[]): RemoteError<'gateway/bad-request'> {
  return new RemoteError('gateway/bad-request', message, issues === undefined ? {} : { issues })
}

/** 调用被取消（AbortSignal 触发，或对端主动取消）。 */
export function cancelled(message: string): RemoteError<'gateway/cancelled'> {
  return new RemoteError('gateway/cancelled', message, {})
}

/** 没分类的宿主侧失败。 */
export function internalFailure(message: string, cause?: unknown): RemoteError<'gateway/internal'> {
  return new RemoteError('gateway/internal', message, {}, cause === undefined ? undefined : { cause })
}

/** 请求超时。 */
export function timeoutFailure(timeoutMs: number): RemoteError<'gateway/timeout'> {
  return new RemoteError('gateway/timeout', `请求超时（${timeoutMs}ms 内没有回包）`, { timeoutMs })
}

/** 连接断了。 */
export function disconnectedFailure(reason: string): RemoteError<'gateway/disconnected'> {
  return new RemoteError('gateway/disconnected', `连接断开：${reason}`, { reason })
}

/** 装配冲突。 */
export function conflictFailure(namespace: string, method: string): RemoteError<'gateway/conflict'> {
  return new RemoteError('gateway/conflict', `命名空间 "${namespace}" 里 "${method}" 挂了不止一个 remote`, {
    namespace,
    method,
  })
}

/**
 * 线上带回来的、机器码本包不认识的失败。
 *
 * 保留原来的码与详情，但它是另一个类——`instanceof` 不作数，判别一律看 `code`
 * （协议包就是这么规定的）。出现这种失败通常意味着对端是别的实现，它用了
 * 本包没声明的机器码。
 */
export class WireRemoteError extends Error {
  /** 结构标记：跨 realm 识别只看这个字段，不看 instanceof。 */
  readonly isDSHRemoteError = true

  /**
   * @param code - 机器码。
   * @param message - 人看的说明。
   * @param details - 结构化详情。
   * @param rpcCode - 线上的 JSON-RPC 数字码。
   */
  constructor(
    readonly code: string,
    message: string,
    readonly details: unknown,
    readonly rpcCode: number = -32603,
  ) {
    super(message)
    this.name = 'RemoteError'
  }
}

/**
 * 判断一个失败是不是网关层的失败。
 *
 * 判别一律看 `code`，不看 `instanceof`——失败可能来自另一个进程或另一份 bundle，
 * `instanceof` 在那种情况下必然是假的。
 * @param error - 任意异常。
 * @returns 是不是网关层的失败。
 */
export function isGatewayError(error: unknown): error is RemoteError | WireRemoteError {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'isDSHRemoteError') === true
}
