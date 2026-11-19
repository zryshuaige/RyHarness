/**
 * 内置插件：云成员（Kimi Hosted Agents）。
 *
 * 插件本身不跑对话——运行时由组合根创建并交给协调器，这里只挂 HTTP 面。
 * 关掉插件后不能新建/解雇云成员，但已经雇的成员仍在通讯录里；重开即恢复。
 * @module @ryharness/server/plugins/hosted
 */

import type { Context } from '@ryharness/cordis'
import { createHostedHandlers, type HostedRouteDeps } from '../routes/hosted.ts'
import type { PluginEntry } from './host.ts'

export const HOSTED_PLUGIN_ID = 'hosted'

/** 云成员插件：设置、远端正版清单、雇佣/解雇、手动对账。 */
export function hostedPlugin(deps: HostedRouteDeps): PluginEntry {
  return {
    id: HOSTED_PLUGIN_ID,
    name: '云成员',
    description:
      '从 Kimi 开放平台雇佣一个跑在云沙箱里的成员：可单聊、可拉群，关掉客户端它仍在工作，产物回传到本地工作区。',
    group: 'feature',
    capabilities: {
      routes: [
        'GET /api/hosted/status',
        'PUT /api/hosted/settings',
        'GET /api/hosted/catalog',
        'POST /api/hosted/hire',
        'POST /api/hosted/agents/:agentId/fire',
        'POST /api/hosted/sync',
        'GET /api/hosted/sessions',
      ],
    },
    impact: '关闭后不能雇佣/解雇云成员，管理面下线；已雇佣的云成员仍可对话，远端数据保留。',
    inject: ['routes'],
    apply: (ctx: Context) => {
      const handlers = createHostedHandlers(deps)
      ctx.routes.register('GET', '/api/hosted/status', handlers.status)
      ctx.routes.register('PUT', '/api/hosted/settings', handlers.updateSettings)
      ctx.routes.register('GET', '/api/hosted/catalog', handlers.catalog)
      ctx.routes.register('POST', '/api/hosted/hire', handlers.hire)
      ctx.routes.register('POST', '/api/hosted/agents/:agentId/fire', handlers.fire)
      ctx.routes.register('POST', '/api/hosted/sync', handlers.sync)
      ctx.routes.register('GET', '/api/hosted/sessions', handlers.sessions)
    },
  }
}
