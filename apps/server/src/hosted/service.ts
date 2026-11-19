/**
 * 云成员的运行时：工位生命周期、SSE 事件桥、审批/自定义工具回执、产物回传。
 *
 * 这里的职责边界：
 * - **不落用户消息**——单聊与群聊都由协调器先落库，再调用本服务；
 * - 单聊（`persist: true`）把云端发言与工具结果镜像进本地库；
 *   群聊（`persist: false`）交给协调器统一落库，避免同一条消息写两遍；
 * - 远端是事实源，本地只存"看过哪儿"（cursor / lastEventId）与可回看的镜像。
 * @module @ryharness/server/hosted/service
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { AbortedError, type AgentLoopEvent } from '@ryharness/agent'
import { type AssistantMessage, createAssistantMessage, type ToolCallId } from '@ryharness/llm'
import {
  composePersonaPrompt,
  type HostedMember,
  type HostedSession,
  type HostedTurnRunner,
  type SessionStore,
  TOOL_ERROR_BLOCK_TYPE,
  TOOL_RESULT_PREFIX,
} from '@ryharness/session'
import type { ApprovalBroker } from '../approvals.ts'
import {
  inputJson,
  messageText,
  readCustomToolUse,
  readDelta,
  readError,
  readStatus,
  readToolResult,
  readToolUse,
} from './bridge.ts'
import { HostedApiError, type HostedUserEvent } from './client.ts'
import type { SseFrame } from './sse.ts'
import type { HostedArtifact, HostedEventPage, HostedRemoteAgent, HostedRemoteSession, KhaEvent } from './types.ts'

/** 一次云端轮次的输入。 */
export interface HostedChatInput {
  conversationId: string
  agentId: string
  text: string
  turnIndex: number
  signal?: AbortSignal
  /** 单聊镜像落库；群聊交给协调器。 */
  persist: boolean
  /** 群聊用：把这一条云端发言交给调度器。 */
  onAssistantMessage?: (message: AssistantMessage) => void
}

/** 运行时真正用到的那部分客户端能力（测试可以注入假实现）。 */
export interface HostedClientLike {
  createSession(input: {
    agentId: string
    environmentId: string
    title?: string
    agentVersion?: string
  }): Promise<HostedRemoteSession>
  getSession(id: string): Promise<HostedRemoteSession>
  streamEvents(
    sessionId: string,
    options: { cursor?: string; includeDeltas?: boolean; signal?: AbortSignal },
  ): AsyncGenerator<SseFrame>
  sendEvents(sessionId: string, events: HostedUserEvent[]): Promise<void>
  listEvents(
    sessionId: string,
    options: { pageSize?: number; pageToken?: string; order?: 'asc' | 'desc' },
  ): Promise<HostedEventPage>
  listArtifacts(sessionId: string): Promise<HostedArtifact[]>
  downloadArtifact(id: string): Promise<Uint8Array>
  archiveAgent(id: string): Promise<void>
  updateAgent(id: string, body: Record<string, unknown>): Promise<HostedRemoteAgent>
}

/** 运行时的依赖。 */
export interface HostedRuntimeOptions {
  readonly store: SessionStore
  /**
   * 按需创建客户端。
   *
   * 不持有一个固定实例：用户在设置页改了 Key / baseUrl 之后，下一次调用就该用
   * 新的；持有一个启动时的旧客户端会让"保存成功但一直 401"变成查不出的 bug。
   */
  readonly clientProvider: () => HostedClientLike
  readonly workspaceRoot: string
  readonly approvals: ApprovalBroker
  /** 云端模型 id（只用于给合成消息标注来源）。 */
  readonly model?: string
  readonly log?: (message: string) => void
}

/** 事件处理结果：要推给上层的事件，以及这一轮是否收口。 */
interface FrameOutcome {
  events: AgentLoopEvent[]
  done: boolean
}

const DEFAULT_MODEL = 'kimi-k3.1-pro'

/** 云成员的运行时。 */
export class HostedRuntime {
  private readonly options: HostedRuntimeOptions

  constructor(options: HostedRuntimeOptions) {
    this.options = options
  }

  /** 当前的客户端（每次现取，设置改动即时生效）。 */
  private get client(): HostedClientLike {
    return this.options.clientProvider()
  }

  /** 这个 agent 是不是云成员（不判断雇佣状态——解雇后仍要走一条清楚的报错）。 */
  isHostedAgent(agentId: string): boolean {
    return this.options.store.getAgent(agentId)?.runtime === 'hosted'
  }

  /** 读雇佣契约。 */
  member(agentId: string): HostedMember | undefined {
    return this.options.store.getHostedMember(agentId)
  }

  /** 会话里有没有云成员（编辑/重新生成要挡住）。 */
  conversationHasHostedMember(conversationId: string): boolean {
    const conversation = this.options.store.getConversation(conversationId)
    if (conversation === undefined) return false
    return conversation.memberAgentIds.some((agentId) => {
      return this.isHostedAgent(agentId)
    })
  }

  /**
   * 确保这个 (会话 × 成员) 有一个可用工位。
   *
   * 远端会话是懒创建的：雇佣本身不收费，第一次发言才建。`lost` 的工位重建一个，
   * 旧上下文随之丢失——这件事要在日志里说清楚，不能假装没事。
   */
  async ensureSession(conversationId: string, agentId: string): Promise<HostedSession> {
    const { store } = this.options
    const client = this.client
    const member = this.requireMember(agentId)
    const existing = store.getHostedSession(conversationId, agentId)
    if (existing !== undefined && existing.status !== 'lost' && existing.status !== 'terminated') return existing
    if (existing !== undefined) {
      this.log(`云会话 ${existing.sessionId} 已不可用（${existing.status}），为 ${agentId} 新建一个工位`)
      store.deleteHostedSession(conversationId, agentId)
    }
    const conversation = store.getConversation(conversationId)
    let remote: HostedRemoteSession
    try {
      remote = await client.createSession({
        agentId: member.remoteAgentId,
        environmentId: member.environmentId,
        ...(conversation?.title === undefined || conversation.title.length === 0 ? {} : { title: conversation.title }),
        ...(member.agentVersion === undefined ? {} : { agentVersion: member.agentVersion }),
      })
    } catch (error) {
      throw describeError(error, '创建云会话失败')
    }
    const session = store.upsertHostedSession({
      conversationId,
      agentId,
      sessionId: remote.id,
      status: 'idle',
    })
    this.log(`为 ${agentId} 在会话 ${conversationId} 建了云工位 ${remote.id}`)
    return session
  }

  /**
   * 跑一轮云端对话。
   *
   * 顺序是"先订阅、再发消息"：SSE 生成器第一次 pull 才发请求，服务端会立刻回一帧
   * `control`；等到它再发 `user.message`，连接已经建好，早期事件不会漏。
   */
  async *chat(input: HostedChatInput): AsyncGenerator<AgentLoopEvent> {
    const { store } = this.options
    const client = this.client
    await this.reconcileBeforeTurn(input.conversationId, input.agentId)
    const session = await this.ensureSession(input.conversationId, input.agentId)

    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    input.signal?.addEventListener('abort', onAbort, { once: true })
    const current = store.getHostedSession(input.conversationId, input.agentId)
    let cursor = current?.cursor
    let lastEventId = current?.lastEventId
    let lastEventAt = current?.lastEventAt
    let iterator: AsyncIterator<SseFrame> | undefined
    let sawTextDelta = false
    let lastTool: { callId: string; name: string } | undefined

    const persistCursor = (): void => {
      store.updateHostedSession({
        conversationId: input.conversationId,
        agentId: input.agentId,
        ...(cursor === undefined ? {} : { cursor }),
        ...(lastEventId === undefined ? {} : { lastEventId }),
        ...(lastEventAt === undefined ? {} : { lastEventAt }),
      })
    }

    try {
      const stream = client.streamEvents(session.sessionId, {
        ...(cursor === undefined ? {} : { cursor }),
        includeDeltas: true,
        signal: controller.signal,
      })
      iterator = stream[Symbol.asyncIterator]()
      // 建立连接：第一帧是服务端主动发的 control（携带当前恢复游标）。
      const head = await iterator.next()
      const buffered: SseFrame[] = head.done ? [] : [head.value]

      await client.sendEvents(session.sessionId, [
        {
          type: 'user.message',
          data: { content: [{ type: 'text', text: input.text }] },
        },
      ])
      store.updateHostedSession({ conversationId: input.conversationId, agentId: input.agentId, status: 'running' })

      let done = false
      while (!done) {
        const next = buffered.length > 0 ? { value: buffered.shift() as SseFrame, done: false } : await iterator.next()
        if (next.done === true) {
          throw new Error('云会话的事件流结束了，但这一轮还没收口。下一轮会自动对账。')
        }
        const outcome = await this.handleFrame(next.value, 'live', input, {
          sessionId: session.sessionId,
          onTextDelta: (_text) => {
            sawTextDelta = true
          },
          toolOf: () => lastTool,
          setTool: (tool) => {
            lastTool = tool
          },
          sawTextDelta: () => sawTextDelta,
          resetText: () => {
            sawTextDelta = false
          },
          setCursor: (frameCursor) => {
            cursor = frameCursor
          },
          setLastEvent: (id, at) => {
            if (id !== undefined) lastEventId = id
            if (at !== undefined) lastEventAt = at
          },
          shouldSkip: (event) => event.id.length > 0 && event.id === lastEventId,
          persistCursor,
        })
        for (const event of outcome.events) yield event
        done = outcome.done
      }
      store.updateHostedSession({ conversationId: input.conversationId, agentId: input.agentId, status: 'idle' })
    } catch (error) {
      if (controller.signal.aborted) {
        await this.interrupt(session.sessionId)
        store.updateHostedSession({
          conversationId: input.conversationId,
          agentId: input.agentId,
          status: 'idle',
          ...(cursor === undefined ? {} : { cursor }),
          ...(lastEventId === undefined ? {} : { lastEventId }),
          ...(lastEventAt === undefined ? {} : { lastEventAt }),
        })
        throw new AbortedError()
      }
      throw error
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
      controller.abort()
      if (iterator?.return !== undefined) {
        await iterator.return(undefined).catch(() => undefined)
      }
      persistCursor()
    }
  }

  /** 交给协调器的钩子。单聊镜像落库，群聊交给协调器。 */
  asTurnRunner(): HostedTurnRunner {
    return {
      chatDirect: (input) => {
        return this.chat({ ...input, persist: true })
      },
      groupRunner: (input) => {
        if (!this.isHostedAgent(input.agentId)) return undefined
        return (promptText, _context, options) => {
          return this.chat({
            conversationId: input.conversationId,
            agentId: input.agentId,
            text: promptText,
            turnIndex: input.turnIndex,
            persist: false,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.onAssistantMessage === undefined ? {} : { onAssistantMessage: options.onAssistantMessage }),
          })
        }
      },
    }
  }

  /** 取消一个会话里某位云成员的当前轮次（HTTP 取消路径走 turn-engine 的 abort）。 */
  async cancel(conversationId: string, agentId: string): Promise<void> {
    const session = this.options.store.getHostedSession(conversationId, agentId)
    if (session === undefined) return
    await this.interrupt(session.sessionId)
  }

  /**
   * 解雇：远端 agent 归档（官方 agent 只解绑、不归档），本地契约置 archived。
   *
   * 已有会话仍然可读（远端事件与本地镜像都在），但不能再用它开新会话。
   */
  async fire(agentId: string): Promise<HostedMember> {
    const member = this.requireMember(agentId)
    if (member.scope === 'custom' && member.status === 'active') {
      try {
        await this.client.archiveAgent(member.remoteAgentId)
      } catch (error) {
        // 已经归档/不存在都算"远端不再可用"，本地照常解雇。
        if (!(error instanceof HostedApiError && (error.status === 404 || error.status === 409))) throw error
      }
    }
    const updated = this.options.store.setHostedMemberStatus(agentId, 'archived')
    if (updated === undefined) throw new Error('解雇失败：雇佣契约不见了')
    return updated
  }

  /** 改了本地人设之后，把 system 同步成远端的新版本（只对自建 agent）。 */
  async syncAgent(agentId: string): Promise<void> {
    const member = this.options.store.getHostedMember(agentId)
    if (member === undefined || member.scope !== 'custom' || member.status !== 'active') return
    const agent = this.options.store.getAgent(agentId)
    if (agent === undefined) return
    const system = composePersonaPrompt(agent.systemPrompt, agent.persona)
    const updated = await this.client.updateAgent(member.remoteAgentId, { system })
    // 钉到新版本：老会话仍用创建时冻结的版本，之后新建的会话才用这次改完的人设。
    this.options.store.upsertHostedMember({
      agentId,
      remoteAgentId: member.remoteAgentId,
      environmentId: member.environmentId,
      ...(updated.version === undefined ? {} : { agentVersion: updated.version }),
      scope: member.scope,
      status: member.status,
    })
  }

  /**
   * 冷启动对账：把离线期间远端发生的事补进本地。
   *
   * 只补消息镜像，不重新触发审批/自定义工具——那些需要人当场在，历史里补一个
   * "当时没等到客户端"的结果比假装成功更诚实。
   */
  async reconcileAll(): Promise<void> {
    for (const session of this.options.store.listHostedSessions()) {
      try {
        await this.reconcileSession(session)
      } catch (error) {
        this.log(`对账云会话 ${session.sessionId} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** 对账一个工位。 */
  async reconcileSession(session: HostedSession): Promise<void> {
    const { store } = this.options
    const client = this.client
    let remote: HostedRemoteSession
    try {
      remote = await client.getSession(session.sessionId)
    } catch (error) {
      if (error instanceof HostedApiError && error.status === 404) {
        if (store.getHostedSession(session.conversationId, session.agentId)?.sessionId === session.sessionId) {
          store.updateHostedSession({
            conversationId: session.conversationId,
            agentId: session.agentId,
            status: 'lost',
          })
        }
        return
      }
      throw error
    }
    if (remote.status === 'terminated') {
      store.updateHostedSession({
        conversationId: session.conversationId,
        agentId: session.agentId,
        status: 'terminated',
      })
      return
    }
    if (remote.status === 'running') {
      await this.absorbRunning(session)
      return
    }
    await this.absorbHistory(session)
  }

  // ---- 内部 ----

  private requireMember(agentId: string): HostedMember {
    const agent = this.options.store.getAgent(agentId)
    if (agent === undefined) throw new Error(`云成员「${agentId}」不在通讯录里`)
    if (agent.runtime !== 'hosted') throw new Error(`「${agent.name}」是本机成员，不走云端`)
    const member = this.options.store.getHostedMember(agentId)
    if (member === undefined) throw new Error(`「${agent.name}」缺少雇佣契约，请重新雇佣`)
    if (member.status !== 'active') {
      throw new Error(`「${agent.name}」已经解雇了，不能再发言。要重新用它，请重新雇佣一个。`)
    }
    return member
  }

  /** 下一轮之前的对账：上一次可能是关着客户端跑完的。 */
  private async reconcileBeforeTurn(conversationId: string, agentId: string): Promise<void> {
    const session = this.options.store.getHostedSession(conversationId, agentId)
    if (session === undefined) return
    try {
      await this.reconcileSession(session)
    } catch (error) {
      this.log(`开跑前对账 ${session.sessionId} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 远端还在跑：挂着流把它跑完，顺便把消息补进本地。 */
  private async absorbRunning(session: HostedSession): Promise<void> {
    const { store } = this.options
    const client = this.client
    const controller = new AbortController()
    const stream = client.streamEvents(session.sessionId, {
      ...(session.cursor === undefined ? {} : { cursor: session.cursor }),
      includeDeltas: false,
      signal: controller.signal,
    })
    let cursor = session.cursor
    let lastEventId = session.lastEventId
    let lastEventAt = session.lastEventAt
    const iterator = stream[Symbol.asyncIterator]()
    try {
      while (true) {
        const next = await iterator.next()
        if (next.done === true) break
        const frame = next.value
        if (frame.id !== undefined) cursor = frame.id
        if (frame.event === 'control' || frame.data === undefined) continue
        const event = parseEvent(frame)
        if (event === undefined) continue
        if (event.id.length > 0 && event.id === lastEventId) continue
        lastEventId = event.id
        if (event.processed_at !== undefined) lastEventAt = event.processed_at
        await this.persistReplayEvent(event, session)
        store.updateHostedSession({
          conversationId: session.conversationId,
          agentId: session.agentId,
          ...(cursor === undefined ? {} : { cursor }),
          ...(lastEventId === undefined ? {} : { lastEventId }),
          ...(lastEventAt === undefined ? {} : { lastEventAt }),
          status: event.type === 'session.status' && readStatus(event)?.status === 'idle' ? 'idle' : 'running',
        })
        if (event.type === 'session.status' && readStatus(event)?.status === 'idle') break
      }
    } finally {
      controller.abort()
      await iterator.return(undefined).catch(() => undefined)
    }
  }

  /** 远端已空闲：把最近一页历史里没见过的事件补进来。 */
  private async absorbHistory(session: HostedSession): Promise<void> {
    const { store } = this.options
    const client = this.client
    const page = await client.listEvents(session.sessionId, { pageSize: 50, order: 'desc' })
    const events = [...page.items].reverse()
    let foundLast = session.lastEventId === undefined
    let lastEventAt = session.lastEventAt
    for (const event of events) {
      if (!foundLast) {
        if (event.id === session.lastEventId) foundLast = true
        continue
      }
      if (lastEventAt !== undefined && event.processed_at !== undefined && event.processed_at <= lastEventAt) continue
      await this.persistReplayEvent(event, session)
      if (event.processed_at !== undefined) lastEventAt = event.processed_at
    }
    store.updateHostedSession({
      conversationId: session.conversationId,
      agentId: session.agentId,
      ...(page.streamCursor === undefined ? {} : { cursor: page.streamCursor }),
      ...(page.items.length === 0 ? {} : { lastEventId: page.items[page.items.length - 1]?.id }),
      ...(lastEventAt === undefined ? {} : { lastEventAt }),
      status: 'idle',
    })
  }

  /** 对账路径的落库：只写消息与错误，不触发审批/自定义工具。 */
  private async persistReplayEvent(event: KhaEvent, session: HostedSession): Promise<void> {
    const { store } = this.options
    const turnIndex = store.nextTurnIndex(session.conversationId) - 1
    if (event.type === 'agent.message') {
      const text = messageText(event)
      if (text.trim().length === 0) return
      store.appendMessage({
        conversationId: session.conversationId,
        senderType: 'agent',
        senderId: session.agentId,
        contentBlocks: [{ type: 'text', text }],
        turnIndex: Math.max(0, turnIndex),
      })
      return
    }
    if (event.type === 'agent.tool_result') {
      const result = readToolResult(event)
      if (result === undefined) return
      store.appendMessage({
        conversationId: session.conversationId,
        senderType: 'agent',
        senderId: session.agentId,
        contentBlocks: toolBlocks(result.name ?? 'tool', result.content, result.isError),
        toolCallId: asCallId(result.callId),
        turnIndex: Math.max(0, turnIndex),
      })
      return
    }
    if (event.type === 'session.error') {
      const error = readError(event)
      if (error === undefined) return
      store.appendMessage({
        conversationId: session.conversationId,
        senderType: 'system',
        contentBlocks: [{ type: 'text', text: `[error:${error.type}] ${error.message}` }],
        turnIndex: Math.max(0, turnIndex),
      })
    }
  }

  /**
   * 处理一帧 SSE。
   *
   * `live`：正常轮次，产事件给上层，审批走审批桥；`reconcile`：后台补齐，
   * 需要人才能处理的动作直接按"客户端当时不在"收口（拒绝/报错），不弹卡。
   */
  private async handleFrame(
    frame: SseFrame,
    mode: 'live' | 'reconcile',
    input: HostedChatInput,
    state: {
      sessionId: string
      onTextDelta: (text: string) => void
      toolOf: () => { callId: string; name: string } | undefined
      setTool: (tool: { callId: string; name: string }) => void
      sawTextDelta: () => boolean
      resetText: () => void
      setCursor: (cursor: string) => void
      setLastEvent: (id: string | undefined, at: string | undefined) => void
      shouldSkip: (event: KhaEvent) => boolean
      persistCursor: () => void
    },
  ): Promise<FrameOutcome> {
    const { store, approvals } = this.options
    if (frame.id !== undefined) state.setCursor(frame.id)
    if (frame.event === 'control') {
      state.persistCursor()
      return { events: [], done: false }
    }
    if (frame.event === 'error') {
      throw new Error(`Kimi Hosted 的事件流报错：${frame.data ?? '未知错误'}`)
    }
    const event = parseEvent(frame)
    if (event === undefined) {
      state.persistCursor()
      return { events: [], done: false }
    }
    if (state.shouldSkip(event)) {
      state.persistCursor()
      return { events: [], done: false }
    }
    state.setLastEvent(event.id, event.processed_at)
    const events: AgentLoopEvent[] = []

    switch (event.type) {
      case 'agent.delta': {
        const delta = readDelta(event)
        if (delta?.kind === 'text' && delta.delta.length > 0) {
          state.onTextDelta(delta.delta)
          events.push({ type: 'text-delta', text: delta.delta })
        }
        break
      }
      case 'agent.message': {
        const text = messageText(event)
        if (text.trim().length > 0) {
          if (!state.sawTextDelta()) events.push({ type: 'text-delta', text })
          if (input.persist) {
            store.appendMessage({
              conversationId: input.conversationId,
              senderType: 'agent',
              senderId: input.agentId,
              contentBlocks: [{ type: 'text', text }],
              turnIndex: input.turnIndex,
            })
          } else {
            input.onAssistantMessage?.(this.assistantMessage(text))
          }
        }
        state.resetText()
        break
      }
      case 'agent.tool_use': {
        const tool = readToolUse(event)
        if (tool === undefined) break
        state.setTool({ callId: tool.callId, name: tool.name })
        events.push({
          type: 'tool-call-start',
          callId: asCallId(tool.callId),
          name: tool.name,
          arguments: inputJson(tool.input),
        })
        if (tool.permission === 'always_ask') {
          const allowed =
            mode === 'live'
              ? await approvals.request({
                  conversationId: input.conversationId,
                  agentId: input.agentId,
                  toolName: tool.name,
                  args: inputJson(tool.input),
                })
              : false
          await this.sendQuietly(state.sessionId, [
            {
              type: 'user.tool_confirmation',
              data: {
                event_id: event.id,
                result: allowed ? 'allow' : 'deny',
                ...(allowed ? {} : { deny_message: '客户端当时不在，或用户拒绝了这次调用' }),
              },
            },
          ])
        }
        break
      }
      case 'agent.tool_result': {
        const result = readToolResult(event)
        if (result === undefined) break
        const callId = asCallId(result.callId)
        const name = result.name ?? state.toolOf()?.name ?? 'tool'
        events.push({
          type: 'tool-result',
          callId,
          name,
          isError: result.isError,
          result: { content: result.content },
        })
        if (input.persist) {
          store.appendMessage({
            conversationId: input.conversationId,
            senderType: 'agent',
            senderId: input.agentId,
            contentBlocks: toolBlocks(name, result.content, result.isError),
            toolCallId: callId,
            turnIndex: input.turnIndex,
          })
        }
        break
      }
      case 'agent.custom_tool_use': {
        const custom = readCustomToolUse(event)
        if (custom === undefined) break
        const callId = asCallId(custom.eventId)
        const message = '本客户端暂不支持在云端执行本地工具。'
        events.push({
          type: 'tool-call-start',
          callId,
          name: custom.name,
          arguments: inputJson(custom.input),
        })
        events.push({
          type: 'tool-result',
          callId,
          name: custom.name,
          isError: true,
          result: { content: message },
        })
        await this.sendQuietly(state.sessionId, [
          {
            type: 'user.custom_tool_result',
            data: { event_id: custom.eventId, content: [{ type: 'text', text: message }], is_error: true },
          },
        ])
        if (input.persist) {
          store.appendMessage({
            conversationId: input.conversationId,
            senderType: 'agent',
            senderId: input.agentId,
            contentBlocks: toolBlocks(custom.name, message, true),
            toolCallId: callId,
            turnIndex: input.turnIndex,
          })
        }
        break
      }
      case 'session.status': {
        const status = readStatus(event)
        if (status === undefined) break
        if (status.status === 'running') {
          store.updateHostedSession({
            conversationId: input.conversationId,
            agentId: input.agentId,
            status: 'running',
          })
        }
        if (status.status === 'terminated') {
          store.updateHostedSession({
            conversationId: input.conversationId,
            agentId: input.agentId,
            status: 'terminated',
          })
          events.push({ type: 'error', message: '云会话已终止。', code: 'HOSTED_TERMINATED' })
          return { events, done: true }
        }
        if (status.status === 'idle') {
          store.updateHostedSession({
            conversationId: input.conversationId,
            agentId: input.agentId,
            status: 'idle',
          })
          if (status.stopReason?.type === 'requires_action') {
            // 需要客户端回执的事件（自定义工具 / always_ask）已在上面的分支当场回掉，
            // 云端随后会继续产出事件。这里**不收口**，继续读流直到 end_turn——
            // 把 requires_action 当成结束，会在自定义工具刚回完结果时就把整轮掐断。
            break
          }
          const artifacts = await this.collectArtifacts(input)
          events.push(...artifacts)
          events.push({ type: 'done', finish: { kind: 'stop' }, steps: 1 })
          return { events, done: true }
        }
        break
      }
      case 'session.error': {
        const error = readError(event)
        if (error === undefined) break
        if (input.persist) {
          store.appendMessage({
            conversationId: input.conversationId,
            senderType: 'system',
            contentBlocks: [{ type: 'text', text: `[error:${error.type}] ${error.message}` }],
            turnIndex: input.turnIndex,
          })
        }
        events.push({ type: 'error', message: error.message, code: error.type })
        return { events, done: true }
      }
      default:
        break
    }

    state.persistCursor()
    return { events, done: false }
  }

  /** 产物：下载到工作区、发 produce-card、单聊里落一条带 artifacts 的工具消息。 */
  private async collectArtifacts(input: HostedChatInput): Promise<AgentLoopEvent[]> {
    const { store, workspaceRoot } = this.options
    const client = this.client
    const session = store.getHostedSession(input.conversationId, input.agentId)
    if (session === undefined) return []
    let artifacts: HostedArtifact[]
    try {
      artifacts = await client.listArtifacts(session.sessionId)
    } catch {
      return []
    }
    const dir = join(workspaceRoot, '.ryharness-artifacts')
    const events: AgentLoopEvent[] = []
    for (const artifact of artifacts) {
      const path = join(dir, `${artifact.id}--${safeFileName(artifact.name)}`)
      if (existsSync(path)) continue
      let bytes: Uint8Array
      try {
        bytes = await client.downloadArtifact(artifact.id)
      } catch (error) {
        this.log(`产物 ${artifact.name} 下载失败：${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, bytes)
      const card = { path, name: artifact.name, size: bytes.length, mime: artifact.mime }
      const callId = asCallId(`artifact-${artifact.id}`)
      events.push({
        type: 'tool-result',
        callId,
        name: 'save_artifact',
        isError: false,
        result: { content: `产物：${artifact.name}`, produce: card },
      })
      if (input.persist) {
        store.appendMessage({
          conversationId: input.conversationId,
          senderType: 'agent',
          senderId: input.agentId,
          contentBlocks: toolBlocks('save_artifact', `产物：${artifact.name}`, false),
          toolCallId: callId,
          artifacts: [{ callId, ...card }],
          turnIndex: input.turnIndex,
        })
      }
    }
    return events
  }

  private async interrupt(sessionId: string): Promise<void> {
    try {
      await this.client.sendEvents(sessionId, [{ type: 'user.interrupt' }])
    } catch (error) {
      this.log(`发 user.interrupt 失败（${sessionId}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async sendQuietly(sessionId: string, events: HostedUserEvent[]): Promise<void> {
    try {
      await this.client.sendEvents(sessionId, events)
    } catch (error) {
      this.log(`回执发送失败（${sessionId}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private assistantMessage(text: string): AssistantMessage {
    return createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'kimi-hosted', model: this.options.model ?? DEFAULT_MODEL },
    })
  }

  private log(message: string): void {
    this.options.log?.(`[hosted] ${message}`)
  }
}

/** 把远端错误翻译成一句人能读懂的话。 */
function describeError(error: unknown, prefix: string): Error {
  if (error instanceof HostedApiError) {
    if (error.type === 'failed_precondition_error') {
      return new Error(`${prefix}：执行环境还没就绪（镜像可能仍在构建），稍等片刻再试。原始信息：${error.message}`)
    }
    return new Error(`${prefix}：${error.message}`)
  }
  return error instanceof Error ? new Error(`${prefix}：${error.message}`) : new Error(`${prefix}：${String(error)}`)
}

/** 解析 SSE 帧里的 KHA 事件；坏 JSON 返回 undefined（跳过这一帧）。 */
function parseEvent(frame: SseFrame): KhaEvent | undefined {
  if (frame.data === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(frame.data)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.type !== 'string') return undefined
    return {
      id: typeof record.id === 'string' ? record.id : '',
      type: record.type,
      ...(typeof record.processed_at === 'string' ? { processed_at: record.processed_at } : {}),
      ...(typeof record.session_thread_id === 'string' ? { session_thread_id: record.session_thread_id } : {}),
      ...(typeof record.data === 'object' && record.data !== null
        ? { data: record.data as Record<string, unknown> }
        : {}),
    }
  } catch {
    return undefined
  }
}

/** 工具结果消息的内容块（与协调器同一口径）。 */
function toolBlocks(name: string, content: string, isError: boolean): unknown[] {
  const blocks: unknown[] = [{ type: 'text', text: `${TOOL_RESULT_PREFIX}${name}: ${content}` }]
  if (isError) blocks.push({ type: TOOL_ERROR_BLOCK_TYPE })
  return blocks
}

/** 远端 callId 是普通字符串，本地事件是品牌类型；这里只做一次转换。 */
function asCallId(value: string): ToolCallId {
  return value as ToolCallId
}

/** 产物文件名：去掉路径分隔符与控制字符，保留中文。 */
function safeFileName(name: string): string {
  const printable = Array.from(basename(name))
    .filter((char) => {
      return char.charCodeAt(0) >= 32
    })
    .join('')
  const leaf = printable.replace(/[<>:"/\\|?*]/g, '_')
  return leaf.length === 0 ? 'artifact' : leaf
}
