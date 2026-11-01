/**
 * 内置插件：提醒。
 *
 * 用户让助理记一句「明天上午九点提醒我」，到点后这句话会作为一条**普通的后续消息**
 * 投回原来的会话——不是邮件、不是短信、不是系统推送。
 *
 * 提醒落盘，所以 Host 重启之后它还活着；错过的时间按服务上的策略处理（跳过 / 补一次）。
 * 投递怎么写进会话由组合根注入：插件只负责「到点了、该说这句话了」。
 * @module @ryharness/server/plugins/schedule
 */

import { createScheduleTools, SCHEDULE_TOOL_NAMES, type ScheduleService } from '@ryharness/schedule'
import type { PluginEntry } from './host.ts'

export const SCHEDULE_PLUGIN_ID = 'schedule'

/** 提醒插件的依赖。 */
export interface SchedulePluginOptions {
  /**
   * 提醒服务：由组合根创建并持有。
   *
   * 不在插件里 new 的原因：存储路径与「错过时间怎么办」是应用级的事，而且**必须只有
   * 一份**——两份服务各排各的下一次，同一条提醒会被投两次。
   */
  service: ScheduleService
  /**
   * 检查周期（毫秒）：多久看一次有没有到点的提醒。
   *
   * 缺省 30 秒。提醒的精度就到这里——再密只是多烧一点 CPU。
   */
  tickIntervalMs?: number
}

/** 提醒插件入口：注册四件工具，并按周期检查到点的提醒。 */
export function schedulePlugin(options: SchedulePluginOptions): PluginEntry {
  return {
    id: SCHEDULE_PLUGIN_ID,
    name: '提醒',
    description: '让助理记下「什么时候提醒我什么」：到点时那句话会作为一条后续消息投回原来的会话，关掉应用也还在。',
    group: 'feature',
    capabilities: { tools: [...SCHEDULE_TOOL_NAMES] },
    impact:
      '关闭后助理不再能立提醒、用户也查不到提醒；已经立下的提醒留在文件里，重新打开就恢复，但插件关着期间不会响。',
    inject: ['tools'],
    apply: (ctx) => {
      for (const tool of createScheduleTools(options.service)) ctx.tools.register(tool)
      // 到点投递：按周期看一眼有没有到点的提醒。定时器归插件 fiber 管，
      // 插件一关它就停——留着它等于「关掉的插件还在偷偷发消息」。
      const interval = options.tickIntervalMs ?? 30_000
      ctx.effect(() => {
        const timer = setInterval(() => {
          void options.service.tick()
        }, interval)
        // 定时器不该拖住进程退出。
        timer.unref?.()
        return () => {
          clearInterval(timer)
        }
      }, 'schedule.tick')
    },
  }
}
