/**
 * RyVibe：一句话进、一份方案出。
 *
 * 测三件要紧的事：
 * 1. **方法与工具真的进了模型**——只断言 store 里有 skill 文本没意义，要看它出现在
 *    模型请求的系统提示与工具声明里。上一版这里没断言：整条 extraTools 链断了，
 *    功能静默降级成「小队从不发问」，测试照样全绿。
 * 2. **盘问的硬约束**：每题必带选项、一轮最多四题、问满就停手、落题失败不白吃名额。
 * 3. **失败与恢复**：一轮失败后状态是 failed（不是"方案好了"），答完的答案进小队
 *    共同看到的正文，跨会话的题 id 会被挡下。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@ryharness/cordis'
import type { GenerateOptions, StreamChunk } from '@ryharness/llm'
import { LlmAdapter } from '@ryharness/llm'
import {
  createGrillTool,
  createScaffoldTool,
  GRILL_ME_SKILL,
  GRILL_STOP,
  GRILL_TOOL_NAME,
  MAX_QUESTIONS_PER_ROUND,
  MAX_ROUNDS,
  QuestionStore,
  RyHarnessServer,
  SCAFFOLD_TOOL_NAME,
  TodoStore,
  VibeStore,
} from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ryharness-vibe-${prefix}-`))
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

/** 记录每次请求的系统提示与工具声明；回复固定一句文本。 */
class RecordingAdapter extends LlmAdapter {
  readonly systems: string[] = []
  readonly toolNames: string[][] = []

  override providerInfo(provider: string) {
    return { id: provider, name: 'Mock' }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.systems.push(options.system ?? '')
    this.toolNames.push(
      (options.tools ?? []).map((tool) => {
        return tool.name
      }),
    )
    const text = '这是小队给出的完整产品方案。'
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

/** 每次都失败的供应商：用来测「一轮失败之后状态不是 done」。 */
class FailingAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'Mock' }
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 不用 async generator：这里根本没有 yield 可写（genuine generator 会触发
    // biome 的 useYield），一个只会抛错的迭代器就够。
    return {
      [Symbol.asyncIterator]: () => {
        return {
          next: async () => {
            throw new Error('供应商炸了')
          },
        }
      },
    }
  }
}

async function startServer(dataDir: string, adapter: LlmAdapter): Promise<RyHarnessServer> {
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

/** 把内置小队换成 mock 供应商的同款：这一轮要真的跑起来，才看得到模型收到了什么。 */
function seedMockSquad(server: RyHarnessServer): void {
  const seed = (id: string, name: string): void => {
    server.store.upsertAgent({
      id,
      name,
      systemPrompt: `你是${name}。`,
      provider: 'mock',
      model: 'mock-model',
      tools: ['file_produce'],
    })
  }
  seed('ryen', 'Ryen')
  seed('ryen-team-coding', '工程师')
  seed('ryen-team-writing', '文案')
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

describe('VibeStore', () => {
  it('一轮最多四题：第五题被拒；答完这一轮就封住（只问一轮）', async () => {
    const store = new VibeStore(tempDir('rounds'))
    const session = await store.create({
      conversationId: 'c1',
      requirement: '做个记账工具',
      skillId: 'grill-me',
      memberAgentIds: ['a1'],
    })
    for (let i = 0; i < MAX_QUESTIONS_PER_ROUND; i++) {
      expect(await store.reserveAsk(session.id)).toBe(true)
    }
    expect(await store.reserveAsk(session.id)).toBe(false)
    expect(store.get(session.id)?.askedInRound).toBe(MAX_QUESTIONS_PER_ROUND)

    expect(await store.answer(session.id, 0, '摘要一')).toBe(true)
    expect(store.get(session.id)?.round).toBe(1)
    expect(store.get(session.id)?.askedInRound).toBe(0)
    // 只问一轮：答完就封住，小队该去出方案了。
    expect(await store.reserveAsk(session.id)).toBe(false)
  })

  it('同样的答案不重复收口：改了主意（摘要变了）才重跑', async () => {
    const store = new VibeStore(tempDir('idempotent'))
    const session = await store.create({
      conversationId: 'c1',
      requirement: '做个记账工具',
      skillId: 'grill-me',
      memberAgentIds: ['a1'],
    })
    expect(await store.answer(session.id, 0, '· 跑在哪？→ 网页')).toBe(true)
    // 同样的答案再来一次：不收口，小队不必白跑一遍。
    expect(await store.answer(session.id, 0, '· 跑在哪？→ 网页')).toBe(false)
    // 改了主意：摘要变了，要重跑。
    expect(await store.answer(session.id, 0, '· 跑在哪？→ 桌面')).toBe(true)
  })

  it('最多一轮：问满就封住，不再放行', async () => {
    const store = new VibeStore(tempDir('max-rounds'))
    const session = await store.create({
      conversationId: 'c1',
      requirement: '做个记账工具',
      skillId: 'grill-me',
      memberAgentIds: ['a1'],
    })
    for (let round = 0; round < MAX_ROUNDS; round++) {
      expect(await store.reserveAsk(session.id)).toBe(true)
      await store.answer(session.id, 0, `摘要${round}`)
    }
    expect(await store.reserveAsk(session.id)).toBe(false)
  })

  it('releaseAsk 把名额还回去：问坏一次不该把这一轮问空', async () => {
    const store = new VibeStore(tempDir('release'))
    const session = await store.create({
      conversationId: 'c1',
      requirement: '做个记账工具',
      skillId: 'grill-me',
      memberAgentIds: ['a1'],
    })
    expect(await store.reserveAsk(session.id)).toBe(true)
    expect(await store.reserveAsk(session.id)).toBe(true)
    await store.releaseAsk(session.id)
    expect(store.get(session.id)?.askedInRound).toBe(1)
    expect(await store.reserveAsk(session.id)).toBe(true)
  })

  it('落盘：重开实例仍读得回来', async () => {
    const dir = tempDir('persist')
    const store = new VibeStore(dir)
    const session = await store.create({
      conversationId: 'c1',
      requirement: '做个记账工具',
      skillId: 'grill-me',
      memberAgentIds: ['a1'],
    })
    const reopened = new VibeStore(dir)
    expect(reopened.get(session.id)).toMatchObject({ conversationId: 'c1', requirement: '做个记账工具' })
    expect(reopened.byConversation('c1')?.id).toBe(session.id)
  })
})

describe('grill 工具', () => {
  it('不是 RyVibe 的会话：直接拒绝，不给普通聊天留这个口子', async () => {
    const questions = new QuestionStore(join(tempDir('not-vibe'), 'questions.json'))
    const vibe = new VibeStore(tempDir('not-vibe-store'))
    const tool = createGrillTool({ questions, vibe })
    const result = await tool.execute(
      { question: '跑在哪？', options: ['网页', '桌面'] },
      { workspaceRoot: tempDir('ws'), conversationId: 'c1', agentId: 'a1' },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('不是一次 RyVibe')
  })

  it('选项必须是 2–5 个：用户是点选的，不写字', async () => {
    const questions = new QuestionStore(join(tempDir('options'), 'questions.json'))
    const vibe = new VibeStore(tempDir('options-store'))
    const tool = createGrillTool({ questions, vibe })
    await vibe.create({
      conversationId: 'c1',
      requirement: '做个记账工具',
      skillId: 'grill-me',
      memberAgentIds: ['a1'],
    })
    const context = { workspaceRoot: tempDir('ws'), conversationId: 'c1', agentId: 'a1' }
    expect((await tool.execute({ question: '跑在哪？', options: ['网页'] }, context)).isError).toBe(true)
    expect((await tool.execute({ question: '跑在哪？' }, context)).isError).toBe(true)
    expect(
      (await tool.execute({ question: '跑在哪？', options: ['a', 'b', 'c', 'd', 'e', 'f'] }, context)).isError,
    ).toBe(true)
    const ok = await tool.execute({ question: '跑在哪？', options: ['网页', '桌面'] }, context)
    expect(ok.isError).not.toBe(true)
    expect(questions.list('c1')).toHaveLength(1)
  })

  it('问题太长：当场拒绝，而且不占名额', async () => {
    const questions = new QuestionStore(join(tempDir('too-long'), 'questions.json'))
    const vibe = new VibeStore(tempDir('too-long-store'))
    const tool = createGrillTool({ questions, vibe })
    const session = await vibe.create({
      conversationId: 'c1',
      requirement: '做个记账工具',
      skillId: 'grill-me',
      memberAgentIds: ['a1'],
    })
    const context = { workspaceRoot: tempDir('ws'), conversationId: 'c1', agentId: 'a1' }
    const long = await tool.execute({ question: '字'.repeat(300), options: ['a', 'b'] }, context)
    expect(long.isError).toBe(true)
    expect(vibe.get(session.id)?.askedInRound).toBe(0)
    expect(questions.list('c1')).toHaveLength(0)
  })

  it('一轮问满之后：工具让模型停手去出方案', async () => {
    const questions = new QuestionStore(join(tempDir('cap'), 'questions.json'))
    const vibe = new VibeStore(tempDir('cap-store'))
    const tool = createGrillTool({ questions, vibe })
    await vibe.create({
      conversationId: 'c1',
      requirement: '做个记账工具',
      skillId: 'grill-me',
      memberAgentIds: ['a1'],
    })
    const context = { workspaceRoot: tempDir('ws'), conversationId: 'c1', agentId: 'a1' }
    for (let i = 0; i < MAX_QUESTIONS_PER_ROUND; i++) {
      expect((await tool.execute({ question: `第${i}题？`, options: ['a', 'b'] }, context)).isError).not.toBe(true)
    }
    const extra = await tool.execute({ question: '还问？', options: ['a', 'b'] }, context)
    expect(extra.isError).toBe(true)
    expect(extra.content).toBe(GRILL_STOP)
    expect(questions.list('c1')).toHaveLength(MAX_QUESTIONS_PER_ROUND)
  })
})

describe('方法与工具真的进了模型', () => {
  it('RyVibe 那次会话：系统提示带方法、工具声明里有 grill；普通会话两样都没有', async () => {
    const dataDir = tempDir('wiring')
    const adapter = new RecordingAdapter()
    const server = await startServer(dataDir, adapter)
    try {
      seedMockSquad(server)
      const created = await postJson(server, '/api/vibe', { requirement: '做个记账工具' })
      expect(created.status).toBe(201)
      await waitUntil(() => {
        return adapter.systems.length > 0
      })
      expect(adapter.systems[0]).toContain(GRILL_ME_SKILL.body.slice(0, 20))
      expect(adapter.toolNames[0]).toContain(GRILL_TOOL_NAME)

      // 普通会话：方法与工具都不该出现。
      const agentId = 'plain'
      server.store.upsertAgent({
        id: agentId,
        name: '普通助理',
        systemPrompt: '你是普通助理。',
        provider: 'mock',
        model: 'mock-model',
        tools: [],
      })
      const conversation = server.store.createConversation({
        kind: 'direct',
        title: '普通会话',
        memberAgentIds: [agentId],
      })
      await postJson(server, `/api/conversations/${encodeURIComponent(conversation.id)}/messages`, { text: '你好' })
      await waitUntil(() => {
        return adapter.systems.length > 1
      })
      expect(adapter.systems[1]).not.toContain(GRILL_ME_SKILL.body.slice(0, 20))
      expect(adapter.toolNames[1]).not.toContain(GRILL_TOOL_NAME)
    } finally {
      await server.close()
    }
  })
})

describe('RyVibe 路由', () => {
  it('开一次：建出会话、给出小队', async () => {
    const dataDir = tempDir('http')
    const adapter = new RecordingAdapter()
    const server = await startServer(dataDir, adapter)
    try {
      seedMockSquad(server)
      const created = await postJson(server, '/api/vibe', { requirement: '给独立开发者做个记账工具' })
      expect(created.status).toBe(201)
      const session = created.body.session as Record<string, unknown>
      expect(session.id).toBeTruthy()
      expect(session.requirement).toBe('给独立开发者做个记账工具')
      expect(session.squad).toHaveLength(3)
      expect(server.store.getConversation(session.conversationId as string)?.kind).toBe('group')
    } finally {
      await server.close()
    }
  })

  it('空需求与超长需求都被挡在门外', async () => {
    const dataDir = tempDir('validate')
    const adapter = new RecordingAdapter()
    const server = await startServer(dataDir, adapter)
    try {
      seedMockSquad(server)
      expect((await postJson(server, '/api/vibe', { requirement: '   ' })).status).toBe(400)
      expect((await postJson(server, '/api/vibe', { requirement: '字'.repeat(600) })).status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('回答：答案进小队共同看到的正文；跨会话的题 id 会被挡下', async () => {
    const dataDir = tempDir('answer')
    const adapter = new RecordingAdapter()
    const server = await startServer(dataDir, adapter)
    try {
      seedMockSquad(server)
      const created = await postJson(server, '/api/vibe', { requirement: '做个记账工具' })
      const session = created.body.session as Record<string, unknown>
      const sessionId = session.id as string

      const grill = server.tools.get(GRILL_TOOL_NAME)
      if (grill === undefined) throw new Error('grill 没有注册')
      const asked = await grill.execute(
        { question: '跑在哪？', options: ['网页', '桌面'] },
        { workspaceRoot: server.workspaceRoot, conversationId: session.conversationId as string, agentId: 'ryen' },
      )
      expect(asked.isError).not.toBe(true)

      const state = await getJson(server, `/api/vibe/${encodeURIComponent(sessionId)}`)
      const questions = state.body.questions as Record<string, unknown>[]
      expect(questions).toHaveLength(1)
      const questionId = questions[0]?.id as string

      const answered = await postJson(server, `/api/vibe/${encodeURIComponent(sessionId)}/answer`, {
        answers: [{ questionId, selected: ['网页'] }],
      })
      expect(answered.status).toBe(200)
      expect((answered.body.session as Record<string, unknown>).pendingAnswers).toBe(0)
      expect((answered.body.session as Record<string, unknown>).round).toBe(1)

      // 答案进了小队共同看到的那条正文：谁都能读到，不只提问的那位。
      await waitUntil(() => {
        return server.store.listMessages(session.conversationId as string, { limit: 20 }).some((message) => {
          return message.contentBlocks.some((raw) => {
            const block = raw as { text?: unknown }
            return typeof block.text === 'string' && block.text.includes('跑在哪')
          })
        })
      })

      // 跨会话的题 id：404，不是 500。
      const other = await postJson(server, '/api/vibe', { requirement: '另一个需求' })
      const otherSession = other.body.session as Record<string, unknown>
      const cross = await postJson(server, `/api/vibe/${encodeURIComponent(otherSession.id as string)}/answer`, {
        answers: [{ questionId, selected: ['网页'] }],
      })
      expect(cross.status).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('一轮失败之后：状态是 failed，不是「方案好了」', async () => {
    const dataDir = tempDir('failed')
    const adapter = new FailingAdapter()
    const server = await startServer(dataDir, adapter)
    try {
      seedMockSquad(server)
      const created = await postJson(server, '/api/vibe', { requirement: '做个记账工具' })
      const session = created.body.session as Record<string, unknown>
      const sessionId = session.id as string
      await waitUntil(() => {
        return server.store.listMessages(session.conversationId as string, { limit: 20 }).length > 0
      })
      let state = await getJson(server, `/api/vibe/${encodeURIComponent(sessionId)}`)
      for (let i = 0; i < 40; i++) {
        const current = (state.body.session as Record<string, unknown>).status
        if (current === 'failed') break
        await new Promise((resolve) => {
          setTimeout(resolve, 50)
        })
        state = await getJson(server, `/api/vibe/${encodeURIComponent(sessionId)}`)
      }
      const final = state.body.session as Record<string, unknown>
      expect(final.status).toBe('failed')
      expect(typeof final.error).toBe('string')
    } finally {
      await server.close()
    }
  })

  it('落盘之后：项目与任务清单随状态下发；文件只认白名单', async () => {
    const dataDir = tempDir('scaffold-http')
    const adapter = new RecordingAdapter()
    const server = await startServer(dataDir, adapter)
    try {
      seedMockSquad(server)
      const created = await postJson(server, '/api/vibe', { requirement: '做个记账工具' })
      const session = created.body.session as Record<string, unknown>
      const sessionId = session.id as string
      const conversationId = session.conversationId as string

      const scaffold = server.tools.get(SCAFFOLD_TOOL_NAME)
      if (scaffold === undefined) throw new Error('落盘工具没有注册')
      const landed = await scaffold.execute(
        { name: '记账工具', summary: '给独立开发者记账', tasks: ['建数据表', '做分类页'] },
        { workspaceRoot: server.workspaceRoot, conversationId, agentId: 'ryen' },
      )
      expect(landed.isError).not.toBe(true)

      const state = await getJson(server, `/api/vibe/${encodeURIComponent(sessionId)}`)
      const project = (state.body.session as Record<string, unknown>).project as Record<string, unknown>
      expect(project.name).toBe('记账工具')
      expect(project.files).toHaveLength(4)
      const todos = state.body.todos as { text: string }[]
      expect(
        todos.map((todo) => {
          return todo.text
        }),
      ).toEqual(['建数据表', '做分类页'])

      // 白名单之外的文件名读不到：这条路由不能变成任意文件读取的口子。
      const readme = await getJson(
        server,
        `/api/vibe/${encodeURIComponent(sessionId)}/file?name=${encodeURIComponent('README.md')}`,
      )
      expect(readme.status).toBe(200)
      expect(String(readme.body.content)).toContain('记账工具')
      const sneaky = await getJson(
        server,
        `/api/vibe/${encodeURIComponent(sessionId)}/file?name=${encodeURIComponent('..%2F..%2Ftodos.json')}`,
      )
      expect(sneaky.status).toBe(404)
    } finally {
      await server.close()
    }
  })
})

describe('vibe_scaffold 工具：方案落成项目骨架', () => {
  /** 造一套落盘环境：存储、待办、工作区，以及工具本身。 */
  function scaffoldSetup(prefix: string) {
    const dir = tempDir(prefix)
    const vibe = new VibeStore(dir)
    const todos = new TodoStore(join(dir, 'todos.json'))
    const workspaceRoot = join(dir, 'workspace')
    mkdirSync(workspaceRoot, { recursive: true })
    const tool = createScaffoldTool({ vibe, todos, workspaceRoot })
    return { vibe, todos, workspaceRoot, tool }
  }

  it('不是 RyVibe 的会话：直接拒绝，不给普通聊天留这个口子', async () => {
    const { tool, workspaceRoot } = scaffoldSetup('scaffold-not-vibe')
    const result = await tool.execute(
      { name: '记账工具', summary: '给独立开发者记账', tasks: ['建数据表'] },
      { workspaceRoot, conversationId: 'c1', agentId: 'a1' },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('不是一次 RyVibe')
  })

  it('落盘：四个文件都在、任务进了待办、这次 RyVibe 记下项目', async () => {
    const { vibe, todos, workspaceRoot, tool } = scaffoldSetup('scaffold-ok')
    const session = await vibe.create({
      conversationId: 'c1',
      requirement: '做个记账工具',
      skillId: 'grill-me',
      memberAgentIds: ['a1'],
    })
    const result = await tool.execute(
      { name: '记账工具', summary: '给独立开发者记账', tasks: ['建数据表', '做分类页'] },
      { workspaceRoot, conversationId: 'c1', agentId: 'a1' },
    )
    expect(result.isError).not.toBe(true)
    const dir = join(workspaceRoot, 'projects', '记账工具')
    for (const name of ['README.md', 'PLAN.md', 'TODO.md', 'index.html']) {
      expect(existsSync(join(dir, name))).toBe(true)
    }
    // 首个页面是真能打开的：里面有产品名与任务清单
    const page = readFileSync(join(dir, 'index.html'), 'utf8')
    expect(page).toContain('记账工具')
    expect(page).toContain('建数据表')
    // 任务清单进了待办
    expect(
      todos.list('c1').items.map((item) => {
        return item.text
      }),
    ).toEqual(['建数据表', '做分类页'])
    // 这次 RyVibe 记下了项目
    expect(vibe.get(session.id)?.project?.files).toHaveLength(4)
  })

  it('产物形态决定文件清单：要一张表就不该落出个 index.html', async () => {
    const { vibe, workspaceRoot, tool } = scaffoldSetup('scaffold-sheet')
    await vibe.create({
      conversationId: 'c1',
      requirement: '把开支列出来',
      skillId: 'grill-me',
      memberAgentIds: ['a1'],
    })
    const result = await tool.execute(
      {
        name: '本月开支',
        summary: '把这个月的开支列出来',
        tasks: ['把账单抄进表里'],
        deliverable: 'sheet',
        artifactName: '开支表',
        content: '项目,金额\n房租,3200',
      },
      { workspaceRoot, conversationId: 'c1', agentId: 'a1' },
    )
    expect(result.isError).not.toBe(true)
    const dir = join(workspaceRoot, 'projects', '本月开支')
    expect(readdirSync(dir).sort()).toEqual(['README.md', 'TODO.md', '开支表.csv'])
    expect(readFileSync(join(dir, '开支表.csv'), 'utf8')).toContain('房租,3200')
  })

  it('形态非法就拒：别把 typo 默默当成 app', async () => {
    const { vibe, workspaceRoot, tool } = scaffoldSetup('scaffold-bad-kind')
    await vibe.create({
      conversationId: 'c1',
      requirement: '把开支列出来',
      skillId: 'grill-me',
      memberAgentIds: ['a1'],
    })
    const result = await tool.execute(
      { name: 'x', summary: 'y', tasks: ['a'], deliverable: 'spreadsheet' },
      { workspaceRoot, conversationId: 'c1', agentId: 'a1' },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('app / doc / sheet / flow')
  })

  it('落第二次：目录覆盖，任务不重复加', async () => {
    const { vibe, todos, workspaceRoot, tool } = scaffoldSetup('scaffold-twice')
    await vibe.create({
      conversationId: 'c1',
      requirement: '做个记账工具',
      skillId: 'grill-me',
      memberAgentIds: ['a1'],
    })
    const args = { name: '记账工具', summary: '给独立开发者记账', tasks: ['建数据表', '做分类页'] }
    const context = { workspaceRoot, conversationId: 'c1', agentId: 'a1' }
    await tool.execute(args, context)
    const again = await tool.execute(args, context)
    expect(again.isError).not.toBe(true)
    expect(todos.list('c1').items).toHaveLength(2)
  })

  it('项目名里的路径逃不出去：目录一定在工作区里', async () => {
    const { vibe, workspaceRoot, tool } = scaffoldSetup('scaffold-escape')
    await vibe.create({
      conversationId: 'c1',
      requirement: '做个记账工具',
      skillId: 'grill-me',
      memberAgentIds: ['a1'],
    })
    const result = await tool.execute(
      { name: '../../etc', summary: '逃逸测试', tasks: ['建数据表'] },
      { workspaceRoot, conversationId: 'c1', agentId: 'a1' },
    )
    expect(result.isError).not.toBe(true)
    const dir = vibe.get(vibe.list()[0]?.id as string)?.project?.dir ?? ''
    expect(dir.startsWith(workspaceRoot)).toBe(true)
  })

  it('任务条数与内容自己先卡一道：不合格就不落盘', async () => {
    const { vibe, workspaceRoot, tool } = scaffoldSetup('scaffold-guard')
    await vibe.create({
      conversationId: 'c1',
      requirement: '做个记账工具',
      skillId: 'grill-me',
      memberAgentIds: ['a1'],
    })
    const context = { workspaceRoot, conversationId: 'c1', agentId: 'a1' }
    expect((await tool.execute({ name: '记账工具', summary: 'x', tasks: [] }, context)).isError).toBe(true)
    const many = Array.from({ length: 20 }, (_unused, index) => {
      return `任务${index}`
    })
    expect((await tool.execute({ name: '记账工具', summary: 'x', tasks: many }, context)).isError).toBe(true)
    expect((await tool.execute({ name: '', summary: 'x', tasks: ['a'] }, context)).isError).toBe(true)
    expect(vibe.get(vibe.list()[0]?.id as string)?.project).toBeUndefined()
  })
})
