/**
 * 服务与工具两边共用的文本小工具。
 *
 * 单独放一个文件是因为「同一个任务在两处显示得不一样」是这类工具最常见的毛病：
 * 列表里截到 40 字、结果页截到 80 字，主人对不上号。截断口径放在一处，两边就不会
 * 慢慢漂开。
 * @module @ryharness/jobs/format
 */

import type { JobPhase, JobSnapshot, PlanSnapshot } from './types.ts'

/** 任意 thrown value 的人类可读说明。 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 截一段摘要：一行放不下整段描述。
 * @param text - 原文。
 * @param max - 最多留多少字。
 * @returns 压掉空白后的摘要，超长时截断并加省略号。
 */
export function summary(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 毫秒数写成人类看得懂的样子。 */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} 毫秒`
  return `${(ms / 1000).toFixed(1)} 秒`
}

/** 一步的展示文本。 */
export function renderPhase(phase: JobPhase): string {
  const spent = phase.finishedAt === undefined ? '还在跑' : duration(phase.durationMs)
  const tail = phase.summary === undefined ? '' : `：${phase.summary}`
  return `${phase.label}（${spent}）${tail}`
}

/** 一个任务的展示文本：状态、耗时、结果摘要。 */
export function renderJob(job: JobSnapshot): string {
  const head = `${job.id} [${job.status}] ${summary(job.task, 40)}`
  if (job.status === 'succeeded') {
    return `${head} ｜ 结果：${summary(job.result ?? '', 80)}`
  }
  if (job.status === 'running') {
    return `${head} ｜ 已跑 ${duration(job.durationMs)}，还在跑`
  }
  if (job.status === 'queued') {
    return `${head} ｜ 排队中，等执行槽位`
  }
  return `${head} ｜ ${job.error ?? '没拿到结果'}`
}

/**
 * 任务收尾通知的正文：宿主把它写进会话，主人与模型都能一眼看懂。
 * @param job - 任务的最终快照。
 * @returns 一段中文说明。
 */
export function renderJobNotice(job: JobSnapshot): string {
  if (job.status === 'succeeded') {
    return `【后台任务跑完了】${job.id}（${duration(job.durationMs)}）：${summary(job.result ?? '', 200)}`
  }
  if (job.status === 'cancelled') {
    return `【后台任务被取消了】${job.id}：${job.error ?? '已取消'}`
  }
  return `【后台任务没跑成】${job.id}：${job.error ?? '没拿到结果'}`
}

/**
 * 计划通知的正文：宿主把它写进会话，人看到的是一份可以批的计划。
 * @param plan - 计划快照。
 * @returns 一段中文说明。
 */
export function renderPlanNotice(plan: PlanSnapshot): string {
  const lines = plan.steps.map((step, index) => {
    const detail = step.detail === undefined ? '' : `（${step.detail}）`
    return `${index + 1}. ${step.title}${detail}`
  })
  const head = `【计划 v${plan.version}·${plan.title}】`
  if (plan.status === 'approved') return `${head} 已批准，可以动手了。\n${lines.join('\n')}`
  if (plan.status === 'rejected') {
    const why = plan.feedback === undefined ? '' : ` 原因：${plan.feedback}`
    return `${head} 被打回了，改一版再交。${why}\n${lines.join('\n')}`
  }
  return `${head} 待批——批了我才动手。\n${lines.join('\n')}`
}
