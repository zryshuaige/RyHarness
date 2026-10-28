/**
 * 提问插件：存储、工具语义、回答路由、插件装卸与下一轮注入。
 *
 * 注入用例走真实 coordinator + 记录系统提示的假适配器：只断言 store 里的文本
 * 组装的话，协调器完全没把它送进模型也照样绿。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from '@ryharness/agent'
import type { Context } from '@ryharness/cordis'
import type { GenerateOptions, StreamChunk } from '@ryharness/llm'
import { LlmAdapter } from '@ryharness/llm'
import {
  ASK_USER_RESULT,
  createAskUserTool,
  QuestionStore,
  RyHarnessServer,
  renderQuestionContext,
} from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

/** 等去抖的送达写盘落完（送达标记的写盘合并在 300ms 窗口里）。 */
async function settleWrite(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 400)
  })
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ryharness-ask-user-${prefix}-`))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

/** 记录每次请求的系统提示；回复固定一句文本。 */
class RecordingAdapter extends LlmAdapter {
  readonly systems: string[] = []

  override providerInfo(provider: string) {
    return { id: provider, name: 'Mock' }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.systems.push(options.system ?? '')
    const text = '收到。'
    const chunks: StreamChunk[] = [
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield* chunks
    })()
  }
}

async function startServer(dataDir: string, adapter: RecordingAdapter): Promise<RyHarnessServer> {
  return RyHarnessServer.create({
    port: 0,
    dataDir,
    memory: null,
    evolution: null,
    proactive: false,
    mountLlm: (ctx: Context) => {
      ctx.llm.registerAdapter(['mock'], adapter)
    },
  })
}

function askToolOf(server: RyHarnessServer): Tool {
  const tool = server.tools.get('ask_user')
  if (tool === undefined) throw new Error('ask_user 没有注册')
  return tool
}

async function waitUntil(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
  }
  throw new Error('等待条件超时')
}

async function getJson(
  server: RyHarnessServer,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.url}${path}`)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function postJson(
  server: RyHarnessServer,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function patchJson(server: RyHarnessServer, path: string, payload: unknown): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

describe('QuestionStore', () => {
  it('提问校验：空问题、超长问题、选项数量与单项长度都被拒绝', async () => {
    const store = new QuestionStore(join(tempDir('validate'), 'questions.json'))
    expect(() => {
      void store.ask({ conversationId: 'c1', question: '   ' })
    }).toThrow('问题不能为空')
    expect(() => {
      void store.ask({ conversationId: 'c1', question: '字'.repeat(201) })
    }).toThrow('问题最多 200 字')
    expect(() => {
      void store.ask({ conversationId: 'c1', question: '选哪个？', options: ['只有一个'] })
    }).toThrow('选项需要 2–6 项')
    expect(() => {
      void store.ask({
        conversationId: 'c1',
        question: '选哪个？',
        options: ['1', '2', '3', '4', '5', '6', '7'],
      })
    }).toThrow('选项需要 2–6 项')
    expect(() => {
      void store.ask({ conversationId: 'c1', question: '选哪个？', options: ['短', '长'.repeat(81)] })
    }).toThrow('每个选项最多 80 字')
  })

  it('落盘：ask 返回完整字段，重开实例仍读得回来，选项去掉首尾空白', async () => {
    const path = join(tempDir('persist'), 'questions.json')
    const store = new QuestionStore(path)
    const asked = await store.ask({
      conversationId: 'c1',
      agentId: 'a1',
      question: '  你想喝什么？  ',
      options: [' 咖啡 ', '茶'],
      multiple: true,
    })
    expect(asked).toMatchObject({
      conversationId: 'c1',
      agentId: 'a1',
      question: '你想喝什么？',
      options: ['咖啡', '茶'],
      multiple: true,
    })
    expect(asked.id.length).toBeGreaterThan(0)
    expect(asked.askedAt).toBeGreaterThan(0)
    expect(existsSync(path)).toBe(true)
    const reopened = new QuestionStore(path)
    expect(reopened.list('c1')).toEqual([asked])
  })

  it('回答：pending 变 answered，selected 一并保存，未知 id 是 NOT_FOUND', async () => {
    const path = join(tempDir('answer'), 'questions.json')
    const store = new QuestionStore(path)
    const first = await store.ask({ conversationId: 'c1', agentId: 'a1', question: '颜色？', options: ['红', '蓝'] })
    const second = await store.ask({ conversationId: 'c1', question: '随便聊聊？' })
    expect(store.list('c1', 'pending')).toHaveLength(2)

    const answered = await store.answer(first.id, { text: '  蓝色  ', selected: ['蓝', '蓝'] })
    expect(answered).toMatchObject({ answer: '蓝色', selected: ['蓝'] })
    expect(answered.answeredAt).toBeGreaterThan(0)
    expect(store.list('c1', 'pending').map((entry) => entry.id)).toEqual([second.id])
    expect(store.list('c1', 'answered').map((entry) => entry.id)).toEqual([first.id])

    const reopened = new QuestionStore(path)
    expect(reopened.list('c1', 'answered')[0]).toMatchObject({ id: first.id, answer: '蓝色', selected: ['蓝'] })
    await expect(store.answer('missing', { text: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(() => {
      void store.answer(first.id, { text: '   ' })
    }).toThrow('回答内容不能为空')
  })

  it('待注入列表按 agent 归属；markDelivered 持久化且重新回答会重置送达', async () => {
    const path = join(tempDir('pending'), 'questions.json')
    const store = new QuestionStore(path)
    const mine = await store.ask({ conversationId: 'c1', agentId: 'a1', question: '我的问题' })
    const theirs = await store.ask({ conversationId: 'c1', agentId: 'a2', question: '别人的问题' })
    await store.answer(mine.id, { text: '答案一' })
    await store.answer(theirs.id, { text: '答案二' })

    expect(
      store.pendingAnswers('c1', 'a1').map((entry) => {
        return entry.id
      }),
    ).toEqual([mine.id])
    expect(
      store.pendingAnswers('c1', 'a2').map((entry) => {
        return entry.id
      }),
    ).toEqual([theirs.id])

    store.markDelivered([mine.id])
    expect(store.pendingAnswers('c1', 'a1')).toEqual([])
    // 落盘：新实例也知道这条已经送达。
    // 送达标记的写盘是**去抖**的（群聊里一轮六个 agent 各标记一次，合并成一次落盘，
    // 同步重写整份文件在几千条时一次要 142ms，正卡在出字的路径上），所以这里要等它落完。
    await settleWrite()
    expect(new QuestionStore(path).pendingAnswers('c1', 'a1')).toEqual([])

    await store.answer(mine.id, { text: '改主意了' })
    expect(store.pendingAnswers('c1', 'a1')[0]).toMatchObject({ answer: '改主意了' })
  })

  it('注入文本包含原问题与回答（含勾选项）', async () => {
    const store = new QuestionStore(join(tempDir('render'), 'questions.json'))
    const asked = await store.ask({ conversationId: 'c1', question: '周末去哪？', options: ['公园', '博物馆'] })
    const answered = await store.answer(asked.id, { text: '都可以', selected: ['公园'] })
    const text = renderQuestionContext([answered])
    expect(text).toContain('你此前问过：周末去哪？')
    expect(text).toContain('用户回答：都可以')
    expect(text).toContain('选择：公园')
    expect(renderQuestionContext([])).toBe('')
  })
})

describe('ask_user 工具', () => {
  it('没有会话上下文、空问题、非法选项都回工具错误而不是抛异常', async () => {
    const store = new QuestionStore(join(tempDir('tool-errors'), 'questions.json'))
    const tool = createAskUserTool(store)
    const context = { workspaceRoot: tempDir('workspace'), conversationId: 'c1', agentId: 'a1' }
    expect(await tool.execute({ question: '问？' }, { workspaceRoot: context.workspaceRoot })).toMatchObject({
      isError: true,
    })
    expect(await tool.execute({ question: '  ' }, context)).toMatchObject({ isError: true })
    expect(await tool.execute({ question: '问？', options: ['一个'] }, context)).toMatchObject({ isError: true })
    expect(await tool.execute({ question: '问？', options: ['a', 'b'], multiple: 'yes' }, context)).toMatchObject({
      isError: true,
    })
    expect(store.list('c1')).toEqual([])
  })

  it('成功时立刻返回「本轮结束」文案，问题带上会话与发起者', async () => {
    const store = new QuestionStore(join(tempDir('tool-ok'), 'questions.json'))
    const tool = createAskUserTool(store)
    const result = await tool.execute(
      { question: '你更喜欢哪种？', options: ['A', 'B'], multiple: true },
      { workspaceRoot: tempDir('workspace'), conversationId: 'c1', agentId: 'a1' },
    )
    expect(result.isError).not.toBe(true)
    expect(result.content).toBe(ASK_USER_RESULT)
    const stored = store.list('c1')
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      conversationId: 'c1',
      agentId: 'a1',
      question: '你更喜欢哪种？',
      options: ['A', 'B'],
      multiple: true,
    })
    expect(stored[0]?.answeredAt).toBeUndefined()
  })
})

describe('提问 HTTP 与插件生命周期', () => {
  it('问答路由、下一轮注入、插件关闭 404 与重启恢复', async () => {
    const dataDir = tempDir('http')
    const adapter = new RecordingAdapter()
    let server = await startServer(dataDir, adapter)
    const agentId = 'asker'
    server.store.upsertAgent({
      id: agentId,
      name: '提问者',
      systemPrompt: '你是测试 agent。',
      provider: 'mock',
      model: 'mock-model',
      tools: ['ask_user'],
    })
    const conversation = server.store.createConversation({
      kind: 'direct',
      title: '提问测试',
      memberAgentIds: [agentId],
    })
    const base = `/api/questions?conversationId=${encodeURIComponent(conversation.id)}`
    let questionId = ''
    try {
      expect((await getJson(server, `${base}&status=pending`)).body).toEqual({ questions: [] })

      const asked = await askToolOf(server).execute(
        { question: '你更喜欢哪种饮料？', options: ['咖啡', '茶'] },
        { workspaceRoot: server.workspaceRoot, conversationId: conversation.id, agentId },
      )
      expect(asked.isError).not.toBe(true)

      const pending = await getJson(server, `${base}&status=pending`)
      expect(pending.status).toBe(200)
      const pendingRows = pending.body.questions as Record<string, unknown>[]
      expect(pendingRows).toHaveLength(1)
      questionId = pendingRows[0]?.id as string
      expect(pendingRows[0]).toMatchObject({
        conversationId: conversation.id,
        agentId,
        question: '你更喜欢哪种饮料？',
        options: ['咖啡', '茶'],
      })
      expect(existsSync(join(dataDir, 'questions.json'))).toBe(true)

      const badAnswer = await postJson(server, `/api/questions/${encodeURIComponent(questionId)}/answer`, {
        text: '   ',
      })
      expect(badAnswer.status).toBe(400)
      const answered = await postJson(server, `/api/questions/${encodeURIComponent(questionId)}/answer`, {
        text: '咖啡',
        selected: ['咖啡'],
      })
      expect(answered.status).toBe(200)
      expect(answered.body).toMatchObject({ id: questionId, answer: '咖啡', selected: ['咖啡'] })
      expect(answered.body.answeredAt).toBeGreaterThan(0)
      expect((await getJson(server, `${base}&status=pending`)).body).toEqual({ questions: [] })
      expect((await getJson(server, `${base}&status=answered`)).body).toMatchObject({
        questions: [{ id: questionId, answer: '咖啡' }],
      })
      expect((await postJson(server, '/api/questions/missing/answer', { text: 'x' })).status).toBe(404)

      // 下一轮用户消息：真实协调器把问答拼进系统提示。
      const replyCount = (): number => {
        return server.store.listMessages(conversation.id).filter((row) => {
          return row.senderType === 'agent'
        }).length
      }
      expect(
        (
          await postJson(server, `/api/conversations/${conversation.id}/messages`, {
            text: '继续吧',
          })
        ).status,
      ).toBe(202)
      await waitUntil(() => {
        return replyCount() === 1
      })
      expect(adapter.systems[0]).toContain('你此前问过：你更喜欢哪种饮料？')
      expect(adapter.systems[0]).toContain('用户回答：咖啡')

      // 只注入一次：第二轮不再重复同一段问答。
      expect(
        (
          await postJson(server, `/api/conversations/${conversation.id}/messages`, {
            text: '再说一句',
          })
        ).status,
      ).toBe(202)
      await waitUntil(() => {
        return replyCount() === 2
      })
      expect(adapter.systems[1]).not.toContain('你此前问过：你更喜欢哪种饮料？')
      // 送达标记的写盘是去抖的：等它落完再读文件。
      await settleWrite()
      expect(new QuestionStore(join(dataDir, 'questions.json')).pendingAnswers(conversation.id, agentId)).toEqual([])

      // 关闭插件：工具与路由一起消失，文件保留。
      const off = await patchJson(server, '/api/plugins/ask-user', { enabled: false })
      expect(off.status).toBe(200)
      expect(server.tools.get('ask_user')).toBeUndefined()
      expect((await getJson(server, base)).status).toBe(404)
      const persisted = JSON.parse(readFileSync(join(dataDir, 'questions.json'), 'utf8')) as {
        questions: Record<string, unknown>[]
      }
      expect(persisted.questions[0]).toMatchObject({ id: questionId, answer: '咖啡' })

      // 重新打开：工具与路由回来，数据还在。
      expect((await patchJson(server, '/api/plugins/ask-user', { enabled: true })).status).toBe(200)
      expect(server.tools.get('ask_user')).toBeDefined()
      expect((await getJson(server, `${base}&status=answered`)).body).toMatchObject({
        questions: [{ id: questionId, answer: '咖啡' }],
      })
    } finally {
      await server.close()
    }

    // 重启：新进程从同一个 dataDir 恢复问题记录。
    const restarted = await startServer(dataDir, new RecordingAdapter())
    server = restarted
    try {
      expect((await getJson(restarted, `${base}&status=answered`)).body).toMatchObject({
        questions: [{ id: questionId, answer: '咖啡' }],
      })
      expect(restarted.tools.get('ask_user')).toBeDefined()
    } finally {
      await restarted.close()
    }
  })

  it('插件关掉后，已回答的旧问题不再注入模型', async () => {
    // 此前问答注入不看插件开关：关掉插件后工具与路由下线了，那段「已回答的问题」
    // 却还回到模型手里——而模型已经没有 ask_user 可用，只能拿着一份没人能再回答
    // 的答案继续走。skill 注入看开关、问答注入不看，是同一件事的两半口径。
    const dataDir = tempDir('off-inject')
    const adapter = new RecordingAdapter()
    const server = await startServer(dataDir, adapter)
    const agentId = 'asker'
    try {
      server.store.upsertAgent({
        id: agentId,
        name: '提问者',
        systemPrompt: '你是测试 agent。',
        provider: 'mock',
        model: 'mock-model',
        tools: ['ask_user'],
      })
      const conversation = server.store.createConversation({
        kind: 'direct',
        title: '关闭后不注入',
        memberAgentIds: [agentId],
      })

      // 先问后答：待注入列表里有内容。
      const asked = await server.questionStore.ask({
        conversationId: conversation.id,
        agentId,
        question: '关掉插件之后还会注入吗？',
      })
      await server.questionStore.answer(asked.id, { text: '不该被注入' })

      // 关掉插件：工具与路由一起下线。
      const off = await patchJson(server, '/api/plugins/ask-user', { enabled: false })
      expect(off.status).toBe(200)
      expect(server.tools.get('ask_user')).toBeUndefined()

      // 再问再答：存储在组合根里，插件关掉也不清——但这一段不该再进模型。
      const asked2 = await server.questionStore.ask({
        conversationId: conversation.id,
        agentId,
        question: '第二个问题',
      })
      await server.questionStore.answer(asked2.id, { text: '第二个答案' })

      const replyCount = (): number => {
        return server.store.listMessages(conversation.id).filter((row) => {
          return row.senderType === 'agent'
        }).length
      }
      expect(
        (
          await postJson(server, `/api/conversations/${conversation.id}/messages`, {
            text: '继续吧',
          })
        ).status,
      ).toBe(202)
      await waitUntil(() => {
        return replyCount() === 1
      })
      expect(adapter.systems[0]).not.toContain('你此前问过')
      expect(adapter.systems[0]).not.toContain('用户回答')
    } finally {
      await server.close()
    }
  })

  it('群聊：回答只注入发起提问的成员，没发言的成员不被标记送达', async () => {
    const dataDir = tempDir('group')
    const adapter = new RecordingAdapter()
    const server = await startServer(dataDir, adapter)
    try {
      server.store.upsertAgent({
        id: 'alpha',
        name: 'Alpha',
        systemPrompt: '你是 Alpha。',
        provider: 'mock',
        model: 'mock-model',
        tools: [],
      })
      server.store.upsertAgent({
        id: 'beta',
        name: 'Beta',
        systemPrompt: '你是 Beta。',
        provider: 'mock',
        model: 'mock-model',
        tools: [],
      })
      const group = server.store.createConversation({
        kind: 'group',
        title: '提问群',
        memberAgentIds: ['alpha', 'beta'],
        dispatcherAgentId: 'alpha',
      })
      const tool = askToolOf(server)
      await tool.execute(
        { question: 'Alpha 的问题' },
        { workspaceRoot: server.workspaceRoot, conversationId: group.id, agentId: 'alpha' },
      )
      await tool.execute(
        { question: 'Beta 的问题' },
        { workspaceRoot: server.workspaceRoot, conversationId: group.id, agentId: 'beta' },
      )
      const questions = new QuestionStore(join(dataDir, 'questions.json')).list(group.id, 'pending')
      for (const entry of questions) {
        const answered = await postJson(server, `/api/questions/${encodeURIComponent(entry.id)}/answer`, {
          text: `${entry.question}的答案`,
        })
        expect(answered.status).toBe(200)
      }

      const agentMessageCount = (): number => {
        return server.store.listMessages(group.id).filter((row) => {
          return row.senderType === 'agent' && row.toolCallId === undefined
        }).length
      }
      const before = agentMessageCount()
      expect(
        (
          await postJson(server, `/api/conversations/${group.id}/messages`, {
            text: '@Alpha 你来回答',
          })
        ).status,
      ).toBe(202)
      await waitUntil(() => {
        return agentMessageCount() > before
      })
      expect(adapter.systems[0]).toContain('Alpha 的问题')
      expect(adapter.systems[0]).toContain('用户回答：Alpha 的问题的答案')
      expect(adapter.systems[0]).not.toContain('Beta 的问题')

      // Beta 这轮没发言：它的回答还留在待注入列表里，不能被提前吃掉。
      await settleWrite()
      const reloaded = new QuestionStore(join(dataDir, 'questions.json'))
      expect(reloaded.pendingAnswers(group.id, 'alpha')).toEqual([])
      expect(
        reloaded.pendingAnswers(group.id, 'beta').map((entry) => {
          return entry.question
        }),
      ).toEqual(['Beta 的问题'])
    } finally {
      await server.close()
    }
  })

  it('列表与回答的 HTTP 校验：未知会话 404，status 非法 400', async () => {
    const server = await startServer(tempDir('http-errors'), new RecordingAdapter())
    try {
      expect((await getJson(server, '/api/questions')).status).toBe(400)
      expect((await getJson(server, '/api/questions?conversationId=nope')).status).toBe(404)
      const conversation = server.store.createConversation({ kind: 'direct', memberAgentIds: ['ryen'] })
      expect(
        (await getJson(server, `/api/questions?conversationId=${encodeURIComponent(conversation.id)}&status=weird`))
          .status,
      ).toBe(400)
      expect(
        (
          await postJson(server, '/api/questions/nope/answer', {
            text: 'x',
            selected: 'not-an-array',
          })
        ).status,
      ).toBe(400)
    } finally {
      await server.close()
    }
  })
})
