/**
 * 内置插件：插件配置表单。
 *
 * 每个插件带着自己的配置 schema 登记进来，这一层把它变成**能填的表单**：描述符
 * （控件类型、中文名、默认值、候选值）给界面画框，当前值与版本号一起给，界面改完
 * 提交回来，服务按 schema 校验、写盘、热生效。
 *
 * 两条不肯让步的规矩：版本对不上就报冲突（不静默盖掉别人刚改的东西）；应用失败就
 * 回滚（不出现「界面显示新值、插件还跑着旧值」）。
 *
 * 存储与时钟由组合根注入：这个插件不自己决定「配置存在哪儿」——那是应用级的事，
 * 而且**必须只有一份**，两份各写各的，用户看到的表单会少一半。
 * @module @ryharness/server/plugins/settings
 */

import type { ServerResponse } from 'node:http'
import { SettingsError, type SettingsService, type SettingsValues } from '@ryharness/settings'
import type { PluginEntry } from './host.ts'

export const SETTINGS_PLUGIN_ID = 'settings'

/** 插件配置表单插件的依赖。 */
export interface SettingsPluginOptions {
  /**
   * 配置服务：由组合根创建并持有。
   *
   * 不在插件里 new 的原因：服务要落盘（路径是应用级的事），而且同一时刻只能有一份
   * 在写——两份各写各的，用户改的会互相覆盖。
   */
  readonly service: SettingsService
}

/** 插件配置表单插件入口：把配置表单的读写面接出来。 */
export function settingsPlugin(options: SettingsPluginOptions): PluginEntry {
  return {
    id: SETTINGS_PLUGIN_ID,
    name: '插件配置',
    description: '把每个插件的配置项变成能填的表单：改完立刻生效，不用重启。',
    group: 'feature',
    impact: '关闭后插件的配置项不能在设置页里改了；插件本身照常跑，已经改过的配置留着。',
    inject: ['routes'],
    apply: (ctx) => {
      const router = ctx.routes

      // 全部插件的配置面板：界面一次拉齐，省得每个插件各来一次。
      router.register('GET', '/api/plugin-settings', async (_req, res) => {
        sendJson(res, 200, { plugins: options.service.list() })
      })

      // 单个插件的配置面板。
      router.register('GET', '/api/plugin-settings/:id', async (req, res) => {
        try {
          sendJson(res, 200, { plugin: options.service.get(req.params.id ?? '') })
        } catch (error) {
          sendSettingsError(res, error)
        }
      })

      // 改配置：带版本号，冲突了让界面重新拉一遍。
      router.register('PATCH', '/api/plugin-settings/:id', async (req, res) => {
        const body = await req.body()
        const parsed = readValues(body)
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.message, code: 'VALIDATION' })
          return
        }
        const revision = readRevision(body)
        try {
          const plugin = await options.service.update(req.params.id ?? '', {
            values: parsed.values,
            ...(revision === undefined ? {} : { revision }),
          })
          sendJson(res, 200, { plugin })
        } catch (error) {
          sendSettingsError(res, error)
        }
      })
    },
  }
}

/** 回一段 JSON。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/**
 * 把配置表单的错误翻成 HTTP 回答。
 *
 * 状态码分得细，是因为界面靠它决定干什么：400 标到出错的字段上，409 重新拉一遍，
 * 404 回列表，剩下的是真出事了。
 */
function sendSettingsError(res: ServerResponse, error: unknown): void {
  if (!(error instanceof SettingsError)) {
    sendJson(res, 500, { error: '配置没改成功', code: 'INTERNAL' })
    return
  }
  const status =
    error.code === 'VALIDATION' ? 400 : error.code === 'CONFLICT' ? 409 : error.code === 'UNKNOWN_PLUGIN' ? 404 : 500
  sendJson(res, status, {
    error: error.message,
    code: error.code,
    ...(error.field === undefined ? {} : { field: error.field }),
    ...(error.revision === undefined ? {} : { revision: error.revision }),
  })
}

/**
 * 从请求体里读出要改的值。
 *
 * 值不是布尔 / 字符串 / 数字就**整个拒绝**，不悄悄丢掉那一个键——悄悄丢掉的话，
 * 用户填错了一个框，界面显示「保存成功」，其实什么也没改。
 */
function readValues(body: unknown): { ok: true; values: SettingsValues } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: '请求体里没有 values' }
  }
  const raw = (body as { values?: unknown }).values
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: '请求体里没有 values' }
  }
  const out: SettingsValues = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'boolean' && typeof value !== 'string' && typeof value !== 'number') {
      return { ok: false, message: `配置项 "${key}" 的值只能是布尔、字符串或数字` }
    }
    out[key] = value
  }
  return { ok: true, values: out }
}

/** 从请求体里读出版本号；没给或不是数字就当没给。 */
function readRevision(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const raw = (body as { revision?: unknown }).revision
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  return raw
}
