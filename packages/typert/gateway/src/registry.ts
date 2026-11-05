/**
 * 宿主侧的登记表：类型图 + 本地调用。
 *
 * 「登记表」这个名字说的是它干的事——把本地对象**登记**成一张表，之后既能给
 * 别人看这张表（类型图），也能按表调用本地实现。
 * @module @ryharness/typert-gateway/registry
 */

import { badRequest, internalFailure, isGatewayError } from './errors.ts'
import { buildTypeGraphBundle, type TypeGraphBundle } from './graph.ts'
import { callMethod, readMethod } from './reflect.ts'
import type { RemoteBinding, TypeGraph } from './types.ts'

/** 登记表的构造选项。 */
export interface RemoteRegistryOptions {
  /** 要登记的本地对象。 */
  readonly bindings: readonly RemoteBinding[]
}

/** 一次调用的附加信息。 */
export interface RemoteInvokeOptions {
  /** 取消信号。方法如果最后一个参数叫 `signal`，会拿到它。 */
  readonly signal?: AbortSignal
}

/**
 * 宿主侧的登记表。
 *
 * 构造时就把冲突查出来：同一个命名空间里两个 remote 抢同一个名字，直接抛错，
 * 不等到有人调用才发现。
 */
export class RemoteRegistry {
  private readonly bundle: TypeGraphBundle

  /**
   * @param options - 构造选项。
   */
  constructor(options: RemoteRegistryOptions) {
    this.bundle = buildTypeGraphBundle(options.bindings)
  }

  /** 这张表长什么样。 */
  get graph(): TypeGraph {
    return this.bundle.graph
  }

  /**
   * 调一个本地方法。
   *
   * 参数个数对不上、方法不存在、方法抛错，都有明确的失败——不会把一个没头
   * 没脑的异常丢给调用方。
   * @param namespace - 命名空间。
   * @param method - 线上的方法名。
   * @param args - 位置参数。
   * @param options - 附加信息。
   * @returns 方法的返回值。
   */
  async invoke(
    namespace: string,
    method: string,
    args: readonly unknown[] = [],
    options: RemoteInvokeOptions = {},
  ): Promise<unknown> {
    const mounted = this.bundle.mounted.find(
      (candidate) => candidate.namespace === namespace && candidate.exportName === method,
    )
    if (mounted === undefined) {
      throw badRequest(`没有这个远端方法：${namespace}.${method}`)
    }
    const params = mounted.descriptor.params
    const required = params.filter((param) => !param.optional).length
    const hasRest = params.some((param) => param.rest)
    if (args.length < required) {
      throw badRequest(`方法 ${namespace}.${method} 至少要 ${required} 个参数，收到 ${args.length} 个`)
    }
    if (!hasRest && args.length > params.length) {
      throw badRequest(`方法 ${namespace}.${method} 最多收 ${params.length} 个参数，收到 ${args.length} 个`)
    }
    const fn = readMethod(mounted.service, mounted.methodName)
    if (fn === undefined) {
      throw internalFailure(`方法 ${namespace}.${method} 在宿主上找不到了`)
    }
    const callArgs = this.withSignal(args, params, options.signal)
    try {
      return await callMethod(mounted.service, fn, callArgs)
    } catch (error) {
      if (isGatewayError(error)) throw error
      throw internalFailure(error instanceof Error ? error.message : String(error), error)
    }
  }

  /**
   * 需要时把取消信号补到参数末尾。
   *
   * 约定：方法的最后一个参数叫 `signal` 时，宿主把这一次的取消信号塞进去。
   * 本仓的 `LlmRuntime` 就是这个写法（`signal` 摆在最后）。
   * @param args - 收到的参数。
   * @param params - 方法声明的参数。
   * @param signal - 取消信号。
   * @returns 真正要传进去的参数。
   */
  private withSignal(
    args: readonly unknown[],
    params: readonly { readonly name: string }[],
    signal: AbortSignal | undefined,
  ): readonly unknown[] {
    if (signal === undefined) return args
    const last = params[params.length - 1]
    if (last === undefined || last.name !== 'signal') return args
    if (args.length >= params.length) return args
    return [...args, signal]
  }
}
