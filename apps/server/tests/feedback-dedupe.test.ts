/**
 * /api/feedback 的防刷去重：同一消息（messageId）同一信号重复提交时幂等返回，
 * 不再动亲密度、也不再进自我进化的反馈通道。
 *
 * 锁住的口径：
 * - 同一 messageId + 同一信号：第二次起 { recorded:false, duplicate:true }，亲密度只涨一次；
 * - 同一 messageId + 换信号（👍 后改 👎）算改主意，照常接受；
 * - 不带 messageId 的旧客户端：不去重，行为与旧版一致；
 * - 进化系统关闭时仍回 409（亲密度也不动——bump 内联在反馈路由里，反馈被拒就没有 bump）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@ryharness/cordis'
import type { GenerateOptions, StreamChunk } from '@ryharness/llm'
import { LlmAdapter } from '@ryharness/llm'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []
const running: RyHarnessServer[] = []

function tempDataDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ryharness-feedback-${prefix}-`))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close()
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

class QuietAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'Quiet' }
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

async function startServer(options: { evolution?: 'off' } = {}): Promise<RyHarnessServer> {
  const server = await RyHarnessServer.create({
    port: 0,
    dataDir: tempDataDir('server'),
    memory: null,
    ...(options.evolution === 'off' ? { evolution: null } : {}),
    mountLlm: (ctx: Context) => {
      ctx.llm.registerAdapter(['mock'], new QuietAdapter())
    },
  })
  running.push(server)
  return server
}

async function getJson(base: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function postJson(
  base: string,
  path: string,
  payload: unknown = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

interface AgentRow {
  id: string
  persona: { affinity: number }
}

async function affinityOf(base: string, agentId: string): Promise<number> {
  const { body } = await getJson(base, '/api/agents')
  const agents = body.agents as AgentRow[]
  const agent = agents.find((row) => {
    return row.id === agentId
  })
  if (agent === undefined) throw new Error(`seed agent missing: ${agentId}`)
  return agent.persona.affinity
}

async function feedbackRounds(base: string): Promise<number> {
  const { body } = await getJson(base, '/api/evolve/stats')
  const byKind = body.byKind as Record<string, { rounds: number }> | undefined
  return byKind?.feedback?.rounds ?? 0
}

describe('/api/feedback 防刷去重', () => {
  it('同一消息同一信号重复提交：幂等返回，亲密度只涨一次，也不重复进进化通道', async () => {
    const server = await startServer()
    const before = await affinityOf(server.url, 'ryen')

    const first = await postJson(server.url, '/api/feedback', {
      conversationId: 'conv-1',
      agentId: 'ryen',
      signal: 'thumb_up',
      messageId: 'msg-1',
    })
    expect(first.status).toBe(200)
    expect(first.body.recorded).toBe(true)
    expect(await affinityOf(server.url, 'ryen')).toBe(before + 5)
    expect(await feedbackRounds(server.url)).toBe(1)

    // 连点第二、第三次：全部幂等，亲密度与进化记账都不再动。
    for (let i = 0; i < 2; i++) {
      const dup = await postJson(server.url, '/api/feedback', {
        conversationId: 'conv-1',
        agentId: 'ryen',
        signal: 'thumb_up',
        messageId: 'msg-1',
      })
      expect(dup.status).toBe(200)
      expect(dup.body).toEqual({ recorded: false, duplicate: true })
    }
    expect(await affinityOf(server.url, 'ryen')).toBe(before + 5)
    expect(await feedbackRounds(server.url)).toBe(1)
  })

  it('同一消息换信号算改主意：照常接受，按点踩规则扣分', async () => {
    const server = await startServer()
    const before = await affinityOf(server.url, 'ryen')

    const up = await postJson(server.url, '/api/feedback', {
      conversationId: 'conv-1',
      agentId: 'ryen',
      signal: 'thumb_up',
      messageId: 'msg-2',
    })
    expect(up.body.recorded).toBe(true)
    expect(await affinityOf(server.url, 'ryen')).toBe(before + 5)

    const down = await postJson(server.url, '/api/feedback', {
      conversationId: 'conv-1',
      agentId: 'ryen',
      signal: 'thumb_down',
      messageId: 'msg-2',
    })
    expect(down.body.recorded).toBe(true)
    expect(await affinityOf(server.url, 'ryen')).toBe(before + 5 - 4)
  })

  it('不带 messageId 的旧客户端不去重：每次提交都记账', async () => {
    const server = await startServer()
    const before = await affinityOf(server.url, 'ryen')

    for (let i = 0; i < 2; i++) {
      const res = await postJson(server.url, '/api/feedback', {
        conversationId: 'conv-1',
        agentId: 'ryen',
        signal: 'thumb_up',
      })
      expect(res.status).toBe(200)
      expect(res.body.recorded).toBe(true)
    }
    expect(await affinityOf(server.url, 'ryen')).toBe(before + 10)
  })

  it('进化系统关闭时仍回 409，亲密度不动', async () => {
    const server = await startServer({ evolution: 'off' })
    const before = await affinityOf(server.url, 'ryen')

    const res = await postJson(server.url, '/api/feedback', {
      conversationId: 'conv-1',
      agentId: 'ryen',
      signal: 'thumb_up',
      messageId: 'msg-3',
    })
    expect(res.status).toBe(409)
    expect(await affinityOf(server.url, 'ryen')).toBe(before)
  })

  it('缺字段仍回 400', async () => {
    const server = await startServer()
    const res = await postJson(server.url, '/api/feedback', { conversationId: 'conv-1', agentId: 'ryen' })
    expect(res.status).toBe(400)
  })
})
