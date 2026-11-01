/**
 * 内置插件：凭据引用。
 *
 * 配置里**不存明文密钥，只存引用**。这一层管的是「引用」与「授权」：谁引用了哪把
 * 密钥、为什么用、人批没批、批了多久。
 *
 * 真密钥归宿主那个加密存储管（桌面端走系统密钥库），本插件**不碰密钥落盘**。
 * 取用流程是服务端的事：某个插件要拿密钥，走注册表的授权流程（人要点头），密钥在
 * 服务端用完就走，不往界面回传。
 *
 * 存储与审批由组合根注入：这个插件不自己决定「密钥存在哪儿」「谁来点头」——那是
 * 应用级的事。
 * @module @ryharness/server/plugins/credentials
 */

import type { ServerResponse } from 'node:http'
import type { CredentialRegistry } from '@ryharness/credentials'
import type { PluginEntry } from './host.ts'

export const CREDENTIALS_PLUGIN_ID = 'credentials'

/** 凭据引用插件的依赖。 */
export interface CredentialsPluginOptions {
  /**
   * 凭据注册表：由组合根创建并持有。
   *
   * 审批函数与取密钥的回调都在注册表里，注册表由组合根建——因为「谁来点头」「密钥在
   * 哪儿」都是应用级的事。
   */
  readonly registry: CredentialRegistry
}

/** 凭据引用插件入口：把凭据清单与吊销面接出来。 */
export function credentialsPlugin(options: CredentialsPluginOptions): PluginEntry {
  return {
    id: CREDENTIALS_PLUGIN_ID,
    name: '凭据引用',
    description: '配置里只写凭据的名字：真密钥要找宿主取，而且得有人点头。',
    group: 'feature',
    impact: '关闭后设置页里看不到凭据清单，也不能再吊销凭据引用；已经在跑的请求不受影响。',
    inject: ['routes'],
    apply: (ctx) => {
      const router = ctx.routes

      // 凭据清单：只有引用（名字、供应商、末四位），**没有密钥**。
      router.register('GET', '/api/credentials', async (_req, res) => {
        sendJson(res, 200, { credentials: options.registry.list() })
      })

      // 吊销一个引用：之后用它取号会被挡下。
      router.register('DELETE', '/api/credentials/:id', async (req, res) => {
        const id = req.params.id ?? ''
        if (!options.registry.revoke(id)) {
          sendJson(res, 404, { error: `没有这个凭据引用：${id}`, code: 'UNKNOWN_CREDENTIAL' })
          return
        }
        sendJson(res, 200, { credentialId: id, revoked: true })
      })
    },
  }
}

/** 回一段 JSON。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}
