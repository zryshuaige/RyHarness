// @vitest-environment node
/**
 * 工具执行审批桥：approval-request/resolved 事件、决议路由、超时与取消收口、
 * 「记住这条命令」的进程内白名单——shell_exec 执行前等的每一环。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RyHarnessServer } from '../src/app.ts'
import { ApprovalBroker } from '../src/approvals.ts'
import { EventHub } from '../src/bus.ts'
import type { StampedWsEvent } from '../src/events.ts'

const tmpDirs: string[] = []

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 句柄释放滞后；残留目录在临时区。
    }
  }
  vi.restoreAllMocks()
})

function hubRecorder(): { hub: EventHub; events: StampedWsEvent[] } {
  const hub = new EventHub()
  const events: StampedWsEvent[] = []
  hub.subscribe('c1', (event) => {
    events.push(event)
  })
  return { hub, events }
}

describe('ApprovalBroker（进程内语义）', () => {
  it('请求即发 approval-request；允许后 resolve true 并广播 allow', async () => {
    const { hub, events } = hubRecorder()
    const broker = new ApprovalBroker(hub)
    const pending = broker.request({
      conversationId: 'c1',
      agentId: 'a1',
      toolName: 'shell_exec',
      args: '{"command":"ls"}',
    })
    await Promise.resolve()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'approval-request', toolName: 'shell_exec', arguments: '{"command":"ls"}' })
    expect(broker.decide('c1', (events[0] as { approvalId: string }).approvalId, { decision: 'allow' })).toBe(true)
    await expect(pending).resolves.toBe(true)
    expect(events[1]).toMatchObject({ type: 'approval-resolved', outcome: 'allow' })
  })

  it('拒绝 resolve false；决议不存在的审批返回 false', async () => {
    const { hub, events } = hubRecorder()
    const broker = new ApprovalBroker(hub)
    const pending = broker.request({ conversationId: 'c1', agentId: 'a1', toolName: 'shell_exec', args: '{}' })
    await Promise.resolve()
    const approvalId = (events[0] as { approvalId: string }).approvalId
    expect(broker.decide('c1', approvalId, { decision: 'deny' })).toBe(true)
    await expect(pending).resolves.toBe(false)
    // 已决议的 id 再点一次：迟到的点击如实回 false
    expect(broker.decide('c1', approvalId, { decision: 'allow' })).toBe(false)
  })

  it('超时按拒绝收口并广播 timeout——绝不静默放行', async () => {
    vi.useFakeTimers()
    try {
      const { hub, events } = hubRecorder()
      const broker = new ApprovalBroker(hub, 30)
      const pending = broker.request({ conversationId: 'c1', agentId: 'a1', toolName: 'shell_exec', args: '{}' })
      await vi.advanceTimersByTimeAsync(35)
      await expect(pending).resolves.toBe(false)
      expect(events.at(-1)).toMatchObject({ type: 'approval-resolved', outcome: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('记住这条命令：同会话同参数原文的后续调用直接放行，不再发卡', async () => {
    const { hub, events } = hubRecorder()
    const broker = new ApprovalBroker(hub)
    const first = broker.request({
      conversationId: 'c1',
      agentId: 'a1',
      toolName: 'shell_exec',
      args: '{"command":"npm test"}',
    })
    await Promise.resolve()
    broker.decide('c1', (events[0] as { approvalId: string }).approvalId, { decision: 'allow', remember: true })
    await expect(first).resolves.toBe(true)
    const second = broker.request({
      conversationId: 'c1',
      agentId: 'a1',
      toolName: 'shell_exec',
      args: '{"command":"npm test"}',
    })
    await expect(second).resolves.toBe(true)
    expect(
      events.filter((event) => {
        return event.type === 'approval-request'
      }),
    ).toHaveLength(1)
    // 参数差一个字就不是同一条命令：精确匹配，不做近似
    const third = broker.request({
      conversationId: 'c1',
      agentId: 'a1',
      toolName: 'shell_exec',
      args: '{"command":"npm test "}',
    })
    await Promise.resolve()
    expect(
      events.filter((event) => {
        return event.type === 'approval-request'
      }),
    ).toHaveLength(2)
    void third
  })

  it('轮次取消：挂起的审批按 cancelled 撤掉', async () => {
    const { hub, events } = hubRecorder()
    const broker = new ApprovalBroker(hub)
    const pending = broker.request({ conversationId: 'c1', agentId: 'a1', toolName: 'shell_exec', args: '{}' })
    await Promise.resolve()
    broker.cancelConversation('c1')
    await expect(pending).resolves.toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'approval-resolved', outcome: 'cancelled' })
    expect(broker.pendingOf('c1')).toHaveLength(0)
  })
})

describe('审批决议路由（真服务器）', () => {
  it('POST 决议、404（不存在/别的会话）、400（非法 decision）、cancelTurn 联动撤卡', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ryharness-approvals-'))
    tmpDirs.push(dataDir)
    // 不挂 adapter：这一组只走审批桥与 HTTP，不发起任何模型调用
    const server = await RyHarnessServer.create({ port: 0, dataDir })
    try {
      const conversation = server.store.createConversation({ kind: 'direct', memberAgentIds: [] })
      const base = server.url
      const pending = server.approvals.request({
        conversationId: conversation.id,
        agentId: 'a1',
        toolName: 'shell_exec',
        args: '{"command":"ls"}',
      })
      await Promise.resolve()
      const approvalId = server.approvals.pendingOf(conversation.id)[0]?.approvalId ?? ''

      const bad = await fetch(`${base}/api/conversations/${conversation.id}/approvals/${approvalId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'maybe' }),
      })
      expect(bad.status).toBe(400)

      const wrongConversation = await fetch(`${base}/api/conversations/does-not-exist/approvals/${approvalId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allow' }),
      })
      expect(wrongConversation.status).toBe(404)

      const ok = await fetch(`${base}/api/conversations/${conversation.id}/approvals/${approvalId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allow', remember: true }),
      })
      expect(ok.status).toBe(200)
      await expect(pending).resolves.toBe(true)

      const late = await fetch(`${base}/api/conversations/${conversation.id}/approvals/${approvalId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'deny' }),
      })
      expect(late.status).toBe(404)

      // cancelTurn 联动：挂起的审批随轮次取消一起撤掉
      const pending2 = server.approvals.request({
        conversationId: conversation.id,
        agentId: 'a1',
        toolName: 'shell_exec',
        args: '{"command":"rm -rf /"}',
      })
      await Promise.resolve()
      await fetch(`${base}/api/conversations/${conversation.id}/cancel`, { method: 'POST' })
      await expect(pending2).resolves.toBe(false)
    } finally {
      await server.close()
    }
  })
})
