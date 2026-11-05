/**
 * RyHarness 的进程外客户端：**一行连上，一行调用**。
 *
 * ## 为什么有这一层
 *
 * {@link SdkClient} 是**裸的 JSON-RPC**：自己拼方法名、自己拼参数数组、自己
 * 处理类型图。写程序的人要的是「列出会话」「发一条消息」，不是「拼一个
 * `remote/call` 请求」。
 *
 * 这一层把那件事做完了：连上、拿类型图、按方法名调用、失败给一句人话。
 *
 * ## 用法
 *
 * ```ts
 * import { RyHarnessClient } from '@ryharness/sdk'
 *
 * const client = await RyHarnessClient.spawn({ command: 'node', args: ['ryharness.js', '--rpc'] })
 * const conversations = await client.listConversations()
 * await client.close()
 * ```
 *
 * 线协议与进程内的 Remote 层**同一套**（JSON-RPC 2.0 + 按行分帧），从
 * `@ryharness/api` 转出，不另写一份。
 *
 * @module @ryharness/sdk/ryharness
 */

import { JsonRpcPeer, REMOTE_CALL_METHOD, REMOTE_GRAPH_METHOD, type RpcTransport } from '@ryharness/api'
import { SdkClient, type SdkClientOptions } from './client.ts'

/** 一个会话的摘要。 */
export interface RyHarnessConversation {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly memberAgentIds: readonly string[]
  readonly updatedAt: number
}

/** 一条消息的摘要。 */
export interface RyHarnessMessage {
  readonly seq: number
  readonly senderType: string
  readonly content: string
  readonly createdAt: number
}

/** 一个工具的摘要。 */
export interface RyHarnessTool {
  readonly name: string
  readonly description: string
}

/** 客户端的构造选项。 */
export interface RyHarnessClientOptions {
  /** 可执行文件（默认 `ryharness`）。 */
  readonly command?: string
  /** 参数（默认 `['--rpc']`）。 */
  readonly args?: readonly string[]
  /** 工作目录。 */
  readonly cwd?: string
  /** 环境变量。 */
  readonly env?: Readonly<Record<string, string>>
  /** 单次请求的默认超时（毫秒）。 */
  readonly timeoutMs?: number
}

/** 命名空间：RyHarness 的远程方法都挂在这下面。 */
const NAMESPACE = 'ryharness'

/**
 * RyHarness 的进程外客户端。
 */
export class RyHarnessClient {
  private readonly sdk: SdkClient | undefined
  private readonly peer: JsonRpcPeer

  private constructor(sdk: SdkClient | undefined, peer: JsonRpcPeer) {
    this.sdk = sdk
    this.peer = peer
  }

  /**
   * 起一个服务端子进程并连上。
   *
   * @param options - 构造选项。
   * @returns 连好的客户端。
   */
  static async spawn(options: RyHarnessClientOptions = {}): Promise<RyHarnessClient> {
    const sdkOptions: SdkClientOptions = {
      command: options.command ?? 'ryharness',
      args: options.args ?? ['--rpc'],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }
    const sdk = SdkClient.start(sdkOptions)
    // SDK 客户端的传输是私有的，所以这里自己建一条对端——两条连接指向同一个子进程，
    // 一条用来走网关方法（类型图、调用），一条用来做别的事。
    const peer = new JsonRpcPeer(sdkTransportOf(sdk), {})
    return new RyHarnessClient(sdk, peer)
  }

  /**
   * 用一条现成的传输建客户端（同进程测试、管道都用这个）。
   * @param transport - 连接。
   * @param options - 超时。
   * @returns 连好的客户端。
   */
  static async attach(
    transport: RpcTransport,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<RyHarnessClient> {
    const peer = new JsonRpcPeer(transport, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
    return new RyHarnessClient(undefined, peer)
  }

  /** 宿主暴露的类型图。 */
  async graph(): Promise<unknown> {
    return await this.peer.request(REMOTE_GRAPH_METHOD)
  }

  /** 列出最近的会话。 */
  async listConversations(limit = 20): Promise<RyHarnessConversation[]> {
    const result = await this.call('listConversations', [limit])
    return Array.isArray(result) ? (result as RyHarnessConversation[]) : []
  }

  /** 读一个会话的消息。 */
  async listMessages(conversationId: string, limit = 50): Promise<RyHarnessMessage[]> {
    const result = await this.call('listMessages', [conversationId, limit])
    return Array.isArray(result) ? (result as RyHarnessMessage[]) : []
  }

  /** 列出当前注册着的工具。 */
  async listTools(): Promise<RyHarnessTool[]> {
    const result = await this.call('listTools', [])
    return Array.isArray(result) ? (result as RyHarnessTool[]) : []
  }

  /** 召回一位助理的长期记忆。 */
  async recallMemory(agentId: string, query: string): Promise<string[]> {
    const result = await this.call('recallMemory', [agentId, query])
    return Array.isArray(result) ? (result as string[]) : []
  }

  /** 写一条应用设置。 */
  async writeSetting(key: string, value: string): Promise<void> {
    await this.call('writeSetting', [key, value])
  }

  /** 断开连接并收掉子进程。 */
  async close(): Promise<void> {
    this.peer.close()
    if (this.sdk !== undefined) await this.sdk.close()
  }

  /** 调一个 RyHarness 的远程方法。 */
  private async call(method: string, args: readonly unknown[]): Promise<unknown> {
    return await this.peer.request(REMOTE_CALL_METHOD, {
      namespace: NAMESPACE,
      method,
      args,
    })
  }
}

/**
 * 取 SDK 客户端的传输。
 *
 * SDK 客户端把传输设为私有（那是它的封装），但「一条连接两个对端」这件事
 * 需要能拿到它。这里用一次类型断言把它取出来——**同一个包内**的实现细节，
 * 不是对外承诺。
 * @param sdk - SDK 客户端。
 * @returns 传输。
 */
function sdkTransportOf(sdk: SdkClient): RpcTransport {
  const transport = Reflect.get(sdk, 'transport') as RpcTransport | undefined
  if (transport === undefined) {
    throw new Error('sdk: 客户端没有暴露传输层。')
  }
  return transport
}
