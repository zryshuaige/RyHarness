/**
 * 存储这一族的错误。
 *
 * 分两类，处置方式完全不同，所以不合并成一个：
 * - **形状不对**（写进去的数据不符合这个 kind 声明的形状）：调用方的 bug，
 *   改数据重写就行。
 * - **存坏了**（落盘的东西读不出来）：磁盘上的事实坏了，重写会把现场抹掉，
 *   得让人先看一眼现场。
 * @module @ryharness/storage/errors
 */

/**
 * 写进去的数据不符合这个 kind 声明的形状。
 *
 * 错误里带着字段名：只说「数据不合法」的话，调用方得自己猜是哪个字段，
 * 而声明了形状的意义就是「错在哪一眼能看见」。
 */
export class StorageValidationError extends Error {
  /** 出问题的 kind。 */
  readonly kind: string
  /** 出问题的字段名；`<root>` 表示整体不是对象（字段级的名字说不出来）。 */
  readonly field: string
  /** 为什么不对。 */
  readonly reason: string

  constructor(kind: string, field: string, reason: string) {
    super(`存储校验失败：kind「${kind}」的字段「${field}」${reason}`)
    this.name = 'StorageValidationError'
    this.kind = kind
    this.field = field
    this.reason = reason
  }
}

/**
 * 落盘的东西读不出来（文件坏了、或不是合法 JSON）。
 *
 * 带路径：出事的文件是哪一份得说清楚，否则一整个 kind 都可能读不出来，
 * 而用户只知道「这个功能坏了」。
 */
export class StorageCorruptError extends Error {
  /** 出事的那份东西的路径。 */
  readonly path: string

  constructor(path: string, reason: string) {
    super(`存储内容损坏：${path} —— ${reason}`)
    this.name = 'StorageCorruptError'
    this.path = path
  }
}
