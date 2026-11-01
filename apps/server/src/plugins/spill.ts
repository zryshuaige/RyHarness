/**
 * 内置插件：溢出文本。
 *
 * 工具结果太长时，原文落到了模型看不见的地方——模型只拿到一段预览加一个定位符。
 * 这个插件把那套东西接进服务端：注册 `spill_read` 工具（模型自己分页取回原文），
 * 再开一条 `GET /api/spills/:id` 路由（界面按定位符读原文）。
 *
 * 鉴权与目录都不归插件管：存储由宿主创建并持有（数据目录、容量上限宿主说了算），
 * 会话归属由宿主注入的解析函数给出——插件不该自己猜「这条请求属于哪个会话」。
 * @module @ryharness/server/plugins/spill
 */

import { createSpillReadTool, SpillError, type SpillStore } from '@ryharness/spill'
import type { PluginEntry } from './host.ts'

export const SPILL_PLUGIN_ID = 'spill'

/**
 * 宿主解析会话归属时能看到的东西。
 *
 * 插件只把三样交出去：路由里的 id、查询参数、请求头。宿主怎么鉴权、拿哪个字段当
 * 会话，是宿主的事——插件不 import 服务端内部类型，也不该替宿主做这个决定。
 */
export interface SpillRequest {
  /** 路由里的定位符 id。 */
  readonly id: string
  /** URL 查询参数。 */
  readonly query: URLSearchParams
  /** 请求头。 */
  readonly headers: Record<string, string | string[] | undefined>
}

/** 溢出文本插件的依赖。 */
export interface SpillPluginOptions {
  /**
   * 溢出存储：由组合根创建并持有。
   *
   * 不在插件里 new 的原因：数据目录与容量上限是应用级的事，而且**必须只有一份**
   * ——两份存储各写各的目录，模型拿到的定位符有一半取不回来。
   */
  store: SpillStore
  /**
   * 从请求里解析出会话 id（宿主注入：鉴权与目录都由宿主说了算）。
   *
   * 不给的话，只有「不归属任何会话」的溢出文本能通过路由读到——会话私有那部分
   * 一律拒绝。这是刻意的：宁可读不到，也不能让路由变成万能钥匙。
   */
  resolveSessionId?: (request: SpillRequest) => string | undefined
  /** 取回时单次最多返回多少字符（工具侧的上限）。 */
  maxReadChars?: number
}

/** 回一段 JSON。 */
function respond(
  res: { writeHead: (status: number, headers: Record<string, string>) => unknown; end: (body: string) => unknown },
  status: number,
  payload: unknown,
): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** 异常 → 一句人话。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 错误码 → HTTP 状态。 */
function statusOf(code: string): number {
  if (code === 'NOT_FOUND') return 404
  if (code === 'FORBIDDEN') return 403
  if (code === 'INVALID_INPUT') return 400
  return 500
}

/**
 * 溢出文本插件入口：注册 `spill_read` 工具与一条读原文的路由。
 *
 * 工具与路由都归插件 fiber：关掉插件，模型看不到取回工具，路由返回 404；
 * 存下来的溢出文件留着，重新打开插件还在。
 */
export function spillPlugin(options: SpillPluginOptions): PluginEntry {
  return {
    id: SPILL_PLUGIN_ID,
    name: '溢出文本',
    description: '工具结果太长时把原文存到模型看不见的地方，模型只拿到预览，需要时自己取回原文。',
    group: 'feature',
    capabilities: {
      tools: ['spill_read'],
      routes: ['GET /api/spills/:id'],
    },
    impact: '关闭后助理取不回溢出的工具结果，超长的工具结果会直接进上下文。',
    inject: ['tools', 'routes'],
    apply: (ctx) => {
      ctx.tools.register(
        createSpillReadTool({
          store: options.store,
          ...(options.maxReadChars === undefined ? {} : { maxChars: options.maxReadChars }),
        }),
      )
      ctx.routes.register('GET', '/api/spills/:id', async (req, res) => {
        const id = req.params.id ?? ''
        const sessionId = options.resolveSessionId?.({
          id,
          query: req.query,
          headers: req.raw.headers,
        })
        try {
          const result = options.store.read(id, { sessionId })
          respond(res, 200, {
            id: result.id,
            chars: result.chars,
            createdAt: result.createdAt,
            text: result.text,
          })
        } catch (error) {
          const code = error instanceof SpillError ? error.code : 'READ_FAILED'
          respond(res, statusOf(code), { error: messageOf(error), code })
        }
      })
    },
  }
}
