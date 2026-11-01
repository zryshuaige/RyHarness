/**
 * 网关这一层的线上约定。
 *
 * 只有一个方法名与一种参数形状——网关不搞「什么方法名都行」的通用反射，
 * 那样日志与排障会很难看。要加新动词就加新方法名，别塞进参数里。
 * @module @ryharness/typert-gateway/protocol
 */

/** 调用一个远端方法的线上方法名。 */
export const REMOTE_CALL_METHOD = 'remote/call'

/** 向宿主要一张类型图的线上方法名。 */
export const REMOTE_GRAPH_METHOD = 'remote/graph'

/**
 * 一次远端调用的线上参数。
 *
 * 参数是**位置数组**：和类里的方法签名一一对应。
 */
export interface RemoteCallParams {
  /** 命名空间。 */
  readonly namespace: string
  /** 线上的方法名。 */
  readonly method: string
  /** 位置参数。 */
  readonly args: readonly unknown[]
}
