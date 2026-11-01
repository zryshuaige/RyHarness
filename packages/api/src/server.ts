/**
 * 起一个真的能连的宿主：监听一个 TCP 端口，每条连接交给宿主应答。
 *
 * 端口给 0 就让系统挑一个空闲端口——测试与「同机不同连接」的场景都靠这个，
 * 不用去猜哪个端口没人占。
 * @module @ryharness/api/server
 */

import { createServer, type Server } from 'node:net'
import type { RemoteHost } from './host.ts'
import { createSocketTransport } from './socket.ts'

/** 起服务的参数。 */
export interface RemoteHostServerOptions {
  /** 宿主：挂了什么由它决定。 */
  readonly host: RemoteHost
  /** 监听地址。缺省是本机回环。 */
  readonly address?: string
  /** 监听端口。缺省或 0 表示让系统挑一个空闲端口。 */
  readonly port?: number
}

/** 起好的宿主服务。 */
export interface RemoteHostServer {
  /** 实际监听的地址。 */
  readonly address: string
  /** 实际监听的端口。 */
  readonly port: number
  /** 停服务，并断开所有连接。 */
  close(): Promise<void>
}

/**
 * 起一个宿主服务。
 * @param options - 参数。
 * @returns 起好的服务。
 */
export async function createRemoteHostServer(options: RemoteHostServerOptions): Promise<RemoteHostServer> {
  const address = options.address ?? '127.0.0.1'
  const host = options.host
  const server: Server = createServer((socket) => {
    host.serve(createSocketTransport(socket))
  })
  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, address, () => {
      resolve()
    })
  })
  const bound = server.address()
  const port = typeof bound === 'object' && bound !== null ? bound.port : (options.port ?? 0)
  return {
    address,
    port,
    close: async (): Promise<void> => {
      host.close()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}
