/**
 * 把一条 TCP 连接变成网关能用的传输。
 *
 * 网关只认「能写文本、能收到文本、会断开」；这一层负责把 socket 的事件翻译
 * 成这三件事，并且**不丢早到的数据**——连接刚建立时的第一个包常常比注册回调
 * 更早到。
 * @module @ryharness/api/socket
 */

import { createConnection, type Socket } from 'node:net'
import type { RpcTransport } from '@ryharness/typert-gateway'

/**
 * 把一个 socket 包成传输。
 * @param socket - 已经连上的 socket。
 * @returns 传输。
 */
export function createSocketTransport(socket: Socket): RpcTransport {
  let dataHandler: ((chunk: string) => void) | undefined
  let closeHandler: ((reason: string) => void) | undefined
  let closeReason: string | undefined
  const buffered: string[] = []
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    if (dataHandler === undefined) {
      buffered.push(chunk)
      return
    }
    dataHandler(chunk)
  })
  const finish = (reason: string): void => {
    closeReason = reason
    closeHandler?.(reason)
  }
  socket.on('close', () => {
    finish('连接已关闭')
  })
  socket.on('error', (error: Error) => {
    finish(`连接出错：${error.message}`)
  })
  return {
    write(chunk: string): void {
      if (closeReason !== undefined) return
      socket.write(chunk)
    },
    onData(handler: (chunk: string) => void): void {
      dataHandler = handler
      for (const chunk of buffered.splice(0)) handler(chunk)
    },
    onClose(handler: (reason: string) => void): void {
      closeHandler = handler
      if (closeReason !== undefined) handler(closeReason)
    },
    close(): void {
      socket.destroy()
    },
  }
}

/** 连接参数。 */
export interface RemoteSocketConnectOptions {
  /** 要连的地址。缺省是本机回环。 */
  readonly address?: string
  /** 端口。 */
  readonly port: number
  /** 连不上时等多久算超时（毫秒）。 */
  readonly connectTimeoutMs?: number
}

/** 连上之后的连接与传输。 */
export interface RemoteSocketConnection {
  /** 底层 socket。 */
  readonly socket: Socket
  /** 网关用的传输。 */
  readonly transport: RpcTransport
}

/**
 * 连一个远端宿主。
 *
 * 连不上、连超时都直接失败——不留一个半死不活的连接。
 * @param options - 连接参数。
 * @returns 连接与传输。
 */
export function connectRemoteSocket(options: RemoteSocketConnectOptions): Promise<RemoteSocketConnection> {
  const address = options.address ?? '127.0.0.1'
  return new Promise<RemoteSocketConnection>((resolve, reject) => {
    const socket = createConnection({ host: address, port: options.port })
    let settled = false
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error(message))
    }
    if (options.connectTimeoutMs !== undefined) {
      socket.setTimeout(options.connectTimeoutMs, () => {
        fail(`连接 ${address}:${options.port} 超时`)
      })
    }
    socket.once('error', (error: Error) => {
      fail(`连不上 ${address}:${options.port}：${error.message}`)
    })
    socket.once('connect', () => {
      if (settled) return
      settled = true
      socket.setTimeout(0)
      resolve({ socket, transport: createSocketTransport(socket) })
    })
  })
}
