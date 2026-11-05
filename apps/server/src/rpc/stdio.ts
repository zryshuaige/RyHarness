/**
 * stdio 传输：把进程的标准输入输出当成一条 JSON-RPC 连接。
 *
 * ## 为什么是 stdio
 *
 * 外部程序要调这个应用，最省事的形态是**把它当子进程拉起来**：编辑器配一行
 * `ryharness --rpc`，然后往它的 stdin 写帧、从 stdout 读帧。没有端口、没有令牌、
 * 没有「服务起没起来」的问题——进程起来了就是连上了。
 *
 * ## 分帧
 *
 * 按行分帧（JSON-RPC 2.0 的标准做法）：一行一条 JSON 消息。**stdout 只跑协议**，
 * 任何日志都不能写进去——日志混进协议流，对端解析就炸了。所以：
 * - 本模块提供的 `log` 出口写 **stderr**；
 * - stdout 上只允许出现协议帧。
 *
 * ## 编码
 *
 * UTF-8。中文消息按字节切行是对的（换行字节不会出现在多字节序列中间）。
 *
 * @module @ryharness/server/rpc/stdio
 */

import type { RpcTransport } from '@ryharness/api'

/** stdio 传输的构造选项。 */
export interface StdioTransportOptions {
  /** 从哪儿读（缺省 `process.stdin`）。 */
  readonly input?: NodeJS.ReadableStream
  /** 往哪儿写（缺省 `process.stdout`）。 */
  readonly output?: NodeJS.WritableStream
}

/**
 * 建一条 stdio 传输。
 *
 * **stdout 只跑协议**：日志请走 stderr（见本模块顶部的说明）。
 *
 * **不自己切行**：收到的原始字节（含换行）原样交给对端，由对端的分帧器切。
 * 这一条要是搞错（在这里按行切、再把不带换行的行交给对端），对端就永远拼不
 * 出完整的一帧——表现为「请求发出去了，没回包」。
 * @param options - 输入输出流。
 * @returns 传输。
 */
export function createStdioTransport(options: StdioTransportOptions = {}): RpcTransport {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  let dataHandler: ((chunk: string) => void) | undefined
  let closeHandler: ((reason: string) => void) | undefined
  let closed = false

  input.on('data', (chunk: Buffer | string) => {
    if (closed) return
    dataHandler?.(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
  })
  input.on('end', () => {
    if (closed) return
    closed = true
    closeHandler?.('stdin 关了')
  })
  input.on('error', () => {
    if (closed) return
    closed = true
    closeHandler?.('stdin 出错')
  })

  return {
    write(chunk: string): void {
      if (closed) return
      output.write(chunk.endsWith('\n') ? chunk : `${chunk}\n`)
    },
    onData(handler: (chunk: string) => void): void {
      dataHandler = handler
    },
    onClose(handler: (reason: string) => void): void {
      closeHandler = handler
    },
    close(): void {
      if (closed) return
      closed = true
      closeHandler?.('本地已关闭')
    },
  }
}

/**
 * 一个只写 stderr 的日志出口。
 *
 * **stdout 是协议通道**：日志写进去，对端解析就炸。所以这一族只往 stderr 写。
 * @param prefix - 前缀（给人看的）。
 * @returns 打印函数。
 */
export function createRpcLogger(prefix: string): (message: string) => void {
  return (message: string) => {
    process.stderr.write(`[${prefix}] ${message}\n`)
  }
}
