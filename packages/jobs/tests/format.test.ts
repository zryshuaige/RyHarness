/**
 * 文本小工具的用例：给模型与主人看的那些句子。
 */

import { describe, expect, it } from 'vitest'
import {
  duration,
  messageOf,
  renderJob,
  renderJobNotice,
  renderPhase,
  renderPlanNotice,
  summary,
} from '../src/format.ts'
import type { JobPhase, JobSnapshot, PlanSnapshot } from '../src/types.ts'

/** 一个任务快照。 */
function job(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id: 'job-1',
    kind: 'quick',
    task: '查一件事',
    status: 'running',
    ownerAgentId: 'a1',
    conversationId: 'c1',
    createdAt: 0,
    queuedMs: 0,
    durationMs: 1500,
    phases: [],
    ...overrides,
  }
}

/** 一个计划快照。 */
function plan(overrides: Partial<PlanSnapshot> = {}): PlanSnapshot {
  return {
    conversationId: 'c1',
    version: 1,
    title: '加个后台任务',
    steps: [{ title: '写执行器', detail: '先派子代理' }, { title: '接通知' }],
    status: 'proposed',
    createdAt: 0,
    ...overrides,
  }
}

describe('文本小工具', () => {
  it('messageOf：Error 取它的 message，其它取字符串', () => {
    expect(messageOf(new Error('坏了'))).toBe('坏了')
    expect(messageOf('字符串')).toBe('字符串')
  })

  it('summary：压掉空白，超长截断', () => {
    expect(summary('  多个   空白  ', 20)).toBe('多个 空白')
    expect(summary('一二三四五六', 3)).toBe('一二三…')
  })

  it('duration：毫秒与秒两种口径', () => {
    expect(duration(120)).toBe('120 毫秒')
    expect(duration(-5)).toBe('0 毫秒')
    expect(duration(2500)).toBe('2.5 秒')
  })

  it('renderPhase：跑完的与还在跑的写法不一样', () => {
    const running: JobPhase = { label: '第一步', status: 'running', durationMs: 10 }
    expect(renderPhase(running)).toBe('第一步（还在跑）')
    const done: JobPhase = { label: '第一步', status: 'succeeded', durationMs: 1200, finishedAt: 1200, summary: '好了' }
    expect(renderPhase(done)).toBe('第一步（1.2 秒）：好了')
  })

  it('renderJob：每种状态都说人话', () => {
    expect(renderJob(job({ status: 'succeeded', result: '结论在这儿' }))).toContain('结果：结论在这儿')
    expect(renderJob(job({ status: 'running' }))).toContain('还在跑')
    expect(renderJob(job({ status: 'queued' }))).toContain('排队中')
    expect(renderJob(job({ status: 'failed', error: '挂了' }))).toContain('挂了')
  })

  it('renderJobNotice：完成的与出错的分别说清楚', () => {
    expect(renderJobNotice(job({ status: 'succeeded', result: '结论在这儿' }))).toContain('跑完了')
    expect(renderJobNotice(job({ status: 'failed', error: '挂了' }))).toContain('没跑成')
    expect(renderJobNotice(job({ status: 'cancelled', error: '被取消了。' }))).toContain('被取消')
  })

  it('renderPlanNotice：待批、已批、被打回三态', () => {
    expect(renderPlanNotice(plan())).toContain('待批')
    expect(renderPlanNotice(plan({ status: 'approved' }))).toContain('已批准')
    const rejected = renderPlanNotice(plan({ status: 'rejected', feedback: '换个方式' }))
    expect(rejected).toContain('被打回')
    expect(rejected).toContain('换个方式')
  })
})
