/**
 * 传输层：网关只认「能写文本、能收到文本、会断开」这三件事。
 *
 * 具体的载体（TCP、管道、内存对）由外面的包决定。本包自带一个**内存对**：
 * 两头直接对接，测试与「同进程两角色」的场景不用起真的网络。
 * @module @ryharness/typert-gateway/transport
 */

/**
 * 一条能传文本的连接。
 *
 * 刻意做得比「收发消息」更笨：只管字节，不管 JSON、不管 id、不管重连。上面
 * 那几件事由 JSON-RPC 对端负责。
 */
export interface RpcTransport {
  /**
   * 写出一段文本。
   *
   * 写出去的**不保证是一整帧**——分帧是对端的事。这里只保证顺序不乱。
   * @param chunk - 文本。
   */
  write(chunk: string): void
  /**
   * 注册收数据的回调。
   *
   * 只能注册一次；后注册的顶掉先注册的。
   * @param handler - 回调。
   */
  onData(handler: (chunk: string) => void): void
  /**
   * 注册连接断开的回调。
   * @param handler - 回调，参数是断开原因。
   */
  onClose(handler: (reason: string) => void): void
  /**
   * 主动断开。
   */
  close(): void
}

/**
 * 内存传输的一头。
 *
 * 一头知道另一头是谁：写出去的数据直接送到对面，关闭也会通知对面。
 */
class MemoryTransport implements RpcTransport {
  /** 对面。建好配对时才指过去。 */
  peer: MemoryTransport | undefined

  private dataHandler: ((chunk: string) => void) | undefined
  private closeHandler: ((reason: string) => void) | undefined
  private closed = false

  /**
   * 写出一段文本。
   * @param chunk - 文本。
   */
  write(chunk: string): void {
    if (this.closed) return
    this.peer?.deliver(chunk)
  }

  /**
   * 注册收数据的回调。
   * @param handler - 回调。
   */
  onData(handler: (chunk: string) => void): void {
    this.dataHandler = handler
  }

  /**
   * 注册连接断开的回调。
   * @param handler - 回调。
   */
  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler
  }

  /**
   * 主动断开。
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.peer?.breakConnection('对端已关闭')
  }

  /**
   * 把数据送到本头的收数据回调。
   * @param chunk - 文本。
   */
  deliver(chunk: string): void {
    this.dataHandler?.(chunk)
  }

  /**
   * 断开本头，并通知收断开的回调。
   * @param reason - 断开原因。
   */
  breakConnection(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.closeHandler?.(reason)
  }
}

/**
 * 做一对内存传输。
 *
 * 两头互为对端：A 写的数据 B 收到，B 写的数据 A 收到；一边关掉，另一边立刻
 * 收到断开。
 *
 * 投递是**同步**的——测试里「写完立刻看到对面反应」这件事最好判断；真网络上的
 * 异步性由 TCP 与管道的实现负责。
 * @returns 两个传输，一左一右。
 */
export function createMemoryTransportPair(): readonly [RpcTransport, RpcTransport] {
  const left = new MemoryTransport()
  const right = new MemoryTransport()
  left.peer = right
  right.peer = left
  return [left, right]
}
