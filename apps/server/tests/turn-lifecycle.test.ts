/**
 * 一轮对话的端到端契约（HTTP/WS → SessionCoordinator → AgentLoop/GroupDispatcher）：
 *
 * - 取消：点「停止」后已经推给前端的半截回复仍落库、消息正常收尾，再以
 *   ABORTED 结束——刷新不丢内容，也不显示成失败。
 * - 用量：message-done 事件带本轮累计，会话详情可查累计 token，每条消息带自己
 *   那次调用的用量。
 * - 删除 agent：级联清理记忆与经验手册，并在回执里报告条数。
 * - 巩固判重只在同一个 embedding 模型内比对，跨模型同维向量不会被误删。
 * @module @ryharness/server/tests/turn-lifecycle
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@ryharness/cordis'
import { EvolveService } from '@ryharness/evolve'
import type { GenerateOptions, StreamChunk } from '@ryharness/llm'
import { LlmAdapter } from '@ryharness/llm'
import { HashEmbeddings, MemoryService } from '@ryharness/memory'
import type { WsEvent } from '@ryharness/server'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

const USAGE = { inputTokens: 42, outputTokens: 8, totalTokens: 50 }

function textChunks(text: string, usage?: { inputTokens: number; outputTokens: number; totalTokens: number }) {
  const chunks: StreamChunk[] = [
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
  ]
  if (usage !== undefined) chunks.push({ type: 'usage', usage })
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return (async function* (): AsyncGenerator<StreamChunk> {
    yield* chunks
  })()
}

/** 一次性回复并回报用量的适配器。 */
class UsageAdapter extends LlmAdapter {
  constructor(
    private readonly text: string,
    private readonly usage?: typeof USAGE,
  ) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Usage' }
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return textChunks(this.text, this.usage)
  }
}

/**
 * 先吐半截回复再挂起的适配器：挂起期间等待调用方的 signal 被掐断，
 * 与真实 provider（fetch 收到 abort 后中断连接）一致。
 */
class GatedAdapter extends LlmAdapter {
  readonly started: Promise<void>
  private markStarted: () => void = () => {}
  private readonly text: string

  constructor(text = '写到一半就') {
    super()
    this.text = text
    this.started = new Promise((resolve) => {
      this.markStarted = resolve
    })
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Gated' }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { signal } = options
    const text = this.text
    const markStarted = this.markStarted
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      markStarted()
      await new Promise<void>((_resolve, reject) => {
        if (signal === undefined) return
        const onAbort = (): void => {
          reject(signal.reason ?? new Error('aborted'))
        }
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

const tmpDirs: string[] = []
afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 句柄释放可能滞后；残留目录在临时区。
    }
  }
})

async function startServer(
  adapter: LlmAdapter,
  services?: (dataDir: string) => { memory?: MemoryService; evolution?: EvolveService },
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ryharness-turn-'))
  tmpDirs.push(dataDir)
  const server = await RyHarnessServer.create({
    port: 0,
    dataDir,
    // 记忆/进化与服务端共用同一个 ryharness.db：级联删除正是跨这两个子系统做的。
    ...(services === undefined ? {} : services(dataDir)),
    mountLlm: (ctx: Context) => {
      ctx.llm.registerAdapter(['mock'], adapter)
    },
  })
  return { server, base: server.url, dataDir }
}

async function getJson(base: string, path: string): Promise<Record<string, unknown>> {
  return (await (await fetch(`${base}${path}`)).json()) as Record<string, unknown>
}

async function postJson(base: string, path: string, payload: unknown): Promise<Record<string, unknown>> {
  return (await (
    await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  ).json()) as Record<string, unknown>
}

async function patchJson(base: string, path: string, payload: unknown): Promise<unknown> {
  return (
    await fetch(`${base}${path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  ).json()
}

/** 订阅会话 WS，收满指定事件序列后返回。 */
function collectWs(base: string, conversationId: string, until: (events: WsEvent[]) => boolean, timeoutMs = 8000) {
  let readyResolve: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve
  })
  const done = new Promise<WsEvent[]>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?conversationId=${conversationId}`)
    const events: WsEvent[] = []
    const timer = setTimeout(() => {
      ws.terminate()
      reject(
        new Error(
          `WS timed out; events: ${events
            .map((event) => {
              return event.type
            })
            .join(',')}`,
        ),
      )
    }, timeoutMs)
    ws.on('open', () => {
      readyResolve()
    })
    ws.on('message', (data) => {
      const event = JSON.parse(String(data)) as WsEvent
      events.push(event)
      if (until(events)) {
        clearTimeout(timer)
        ws.terminate()
        resolve(events)
      }
    })
    ws.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return { ready, done }
}

async function newDirectConversation(base: string): Promise<string> {
  await patchJson(base, '/api/agents/ryen', { provider: 'mock', model: 'mock' })
  const created = await postJson(base, '/api/conversations', { kind: 'direct', agentId: 'ryen' })
  return (created.conversation as { id: string }).id
}

describe('RyHarnessServer 一轮对话契约', () => {
  it('取消：半截回复已落库、消息正常收尾、再以 ABORTED 结束', async () => {
    const adapter = new GatedAdapter()
    const { server, base } = await startServer(adapter)
    try {
      const conversationId = await newDirectConversation(base)
      const collector = collectWs(base, conversationId, (events) => {
        return events.some((event) => {
          return event.type === 'error'
        })
      })
      await collector.ready
      await postJson(base, `/api/conversations/${conversationId}/messages`, { text: '写长一点' })
      await adapter.started // 流已挂起：此刻点「停止」
      await postJson(base, `/api/conversations/${conversationId}/cancel`, {})
      const events = await collector.done

      // 取消不是失败：消息先收尾（done），再通知用户已停止。
      expect(events.some((event) => event.type === 'message-done')).toBe(true)
      const error = events.find((event) => {
        return event.type === 'error'
      })
      expect(error).toMatchObject({ type: 'error', code: 'ABORTED' })

      // 半截回复已经落库：刷新后仍在。
      const messages = await getJson(base, `/api/conversations/${conversationId}/messages`)
      const rows = messages.messages as { senderType: string; contentBlocks: { text?: string }[] }[]
      const assistant = rows.find((row) => {
        return row.senderType === 'agent'
      })
      expect(assistant?.contentBlocks[0]?.text).toBe('写到一半就')
    } finally {
      await server.close()
    }
  }, 20_000)

  it('usage：done 事件带本轮累计，会话详情与消息行对得上', async () => {
    const { server, base } = await startServer(new UsageAdapter('答完了', USAGE))
    try {
      const conversationId = await newDirectConversation(base)
      const collector = collectWs(base, conversationId, (events) => {
        return events.some((event) => {
          return event.type === 'message-done'
        })
      })
      await collector.ready
      await postJson(base, `/api/conversations/${conversationId}/messages`, { text: '在吗' })
      const events = await collector.done
      const done = events.find((event) => {
        return event.type === 'message-done'
      })
      expect(done).toMatchObject({ type: 'message-done', usage: USAGE })

      const detail = await getJson(base, `/api/conversations/${conversationId}`)
      expect(detail.usage).toEqual({ ...USAGE, messages: 1 })
      const messages = await getJson(base, `/api/conversations/${conversationId}/messages`)
      const rows = messages.messages as { senderType: string; usage?: typeof USAGE }[]
      expect(rows.find((row) => row.senderType === 'agent')?.usage).toEqual(USAGE)
    } finally {
      await server.close()
    }
  })

  it('turnIndex：message-start 与 message-done 必须是同一个值（渲染层靠它收口气泡）', async () => {
    /**
     * 这条契约钉的是一次真实事故：message-start 发 nextTurnIndex-1、message-done
     * 在自己的时刻重算一遍——空会话里前者算出 -1、后者算出 0，两端对不上，渲染层
     * 查不到那条流式气泡，于是光标不灭、停止按钮长亮，整轮永远停在"生成中"
     * （真实供应商 DeepSeek-V3 下实测复现，只有真机真模型才看得见）。
     *
     * 两轮都要查：第一轮验空会话的 -1 陷阱，第二轮验"同一个 turn 内序号单调增长"
     * 这条曾经的漂移源。
     */
    const { server, base } = await startServer(new UsageAdapter('答完了', USAGE))
    try {
      const conversationId = await newDirectConversation(base)
      for (const round of [1, 2]) {
        const collector = collectWs(base, conversationId, (events) => {
          return events.some((event) => {
            return event.type === 'message-done'
          })
        })
        await collector.ready
        await postJson(base, `/api/conversations/${conversationId}/messages`, { text: `第${round}轮` })
        const events = await collector.done
        const start = events.find((event) => {
          return event.type === 'message-start'
        })
        const done = events.find((event) => {
          return event.type === 'message-done'
        })
        expect(start, `第${round}轮没有 message-start`).toBeDefined()
        expect(done, `第${round}轮没有 message-done`).toBeDefined()
        const startIndex = (start as { turnIndex: number }).turnIndex
        const doneIndex = (done as { turnIndex: number }).turnIndex
        expect(startIndex, `第${round}轮 start/done 序号对不上`).toBe(doneIndex)
        // 序号还必须等于落库那一轮的 turn_index（渲染层靠它把气泡排回时间线）。
        const rows = (await getJson(base, `/api/conversations/${conversationId}/messages`)).messages as {
          senderType: string
          turnIndex: number
        }[]
        const agentRow = rows.filter((row) => {
          return row.senderType === 'agent'
        })[round - 1]
        expect(agentRow?.turnIndex, `第${round}轮事件序号与落库序号不一致`).toBe(startIndex)
      }
    } finally {
      await server.close()
    }
  }, 20_000)

  it('DELETE /api/agents/:id 级联清掉记忆与手册，并在回执里报告条数', async () => {
    let memory: MemoryService | undefined
    let evolution: EvolveService | undefined
    const { server, base } = await startServer(new UsageAdapter('你好', USAGE), (dataDir) => {
      const dbPath = join(dataDir, 'ryharness.db')
      memory = new MemoryService({ dbPath, embeddings: new HashEmbeddings(), logger: () => {} })
      evolution = new EvolveService({ dbPath, logger: () => {} })
      return { memory, evolution }
    })
    const memoryService = memory as MemoryService
    const evolveService = evolution as EvolveService
    try {
      const created = await postJson(base, '/api/agents', {
        templateKey: 'coding',
        name: 'Coder',
        provider: 'mock',
        model: 'mock',
      })
      const agentId = (created.agent as { id: string }).id
      memoryService.store.insert({ agentId, kind: 'fact', content: 'Coder 的私有记忆' })
      evolveService.store.insertEntry({ agentId, section: 'strategy', content: '先读后写', source: 'seed' })
      evolveService.store.insertReflection({ agentId, lesson: '别删错文件' })

      const before = await getJson(base, `/api/agents/${agentId}/memories`)
      expect((before.agent as unknown[]).length).toBe(1)

      const deleted = await fetch(`${base}/api/agents/${agentId}`, { method: 'DELETE' })
      const body = (await deleted.json()) as { removed: Record<string, number> }
      expect(body.removed).toMatchObject({ memories: 1, playbookEntries: 1, reflections: 1 })
      expect(memoryService.store.listActiveForAgent(agentId)).toHaveLength(0)
      expect(evolveService.store.listActiveForCompile(agentId)).toHaveLength(0)
      // 内置 Ryen 的手册不受影响：级联只针对被删的 agent。
      expect(evolveService.store.listActiveForCompile('ryen').length).toBeGreaterThan(0)
    } finally {
      await server.close()
    }
  })

  it('巩固判重只比同一个 embedding 模型的向量（跨模型同维向量不被误删）', async () => {
    let memory: MemoryService | undefined
    const { server, base } = await startServer(new UsageAdapter('你好', USAGE), (dataDir) => {
      memory = new MemoryService({
        dbPath: join(dataDir, 'ryharness.db'),
        embeddings: new HashEmbeddings(),
        logger: () => {},
      })
      return { memory, evolution: new EvolveService({ dbPath: join(dataDir, 'ryharness.db'), logger: () => {} }) }
    })
    const memoryService = memory as MemoryService
    try {
      // 同维度、数值完全相同的两个向量：混库判重会把它们当成重复（cosine=1）
      // 软删一条，可它们根本不是同一个模型算出来的。
      const vector = Float32Array.from([1, 0, 0, 0])
      const a = memoryService.store.insert({
        agentId: 'ryen',
        kind: 'fact',
        content: '模型 A 的记忆',
        embedding: vector,
        embeddingModel: 'model-a',
      })
      const b = memoryService.store.insert({
        agentId: 'ryen',
        kind: 'fact',
        content: '模型 B 的记忆',
        embedding: vector,
        embeddingModel: 'model-b',
      })

      const result = await postJson(base, '/api/evolve/consolidate', {})
      expect(result.mergedMemories).toBe(0)
      expect(memoryService.store.get(a.id)?.status).toBe('active')
      expect(memoryService.store.get(b.id)?.status).toBe('active')
    } finally {
      await server.close()
    }
  })
})
