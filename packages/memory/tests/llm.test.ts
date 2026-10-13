import { ChatMemoryLlm, MEMORY_LLM_CODES } from '@ryagent/memory'
import { isHarnessError } from '@ryagent/llm'
import { describe, expect, it } from 'vitest'

interface Captured {
  url: string
  body: Record<string, unknown>
  headers: Record<string, string>
}

function stubFetch(reply: unknown, init: { ok?: boolean; status?: number } = {}): {
  fetchImpl: typeof fetch
  calls: Captured[]
} {
  const calls: Captured[] = []
  const fetchImpl = (async (url: string, init2: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init2.body)) as Record<string, unknown>,
      headers: init2.headers as Record<string, string>,
    })
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => reply,
      text: async () => JSON.stringify(reply),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const contentReply = (content: unknown): unknown => {
  return { choices: [{ message: { content } }] }
}

describe('ChatMemoryLlm（配置驱动）', () => {
  it('缺 apiKey/baseURL/model 时抛 HarnessError，而不是静默走默认供应商', () => {
    for (const config of [
      { apiKey: '', baseURL: 'https://x/v1', model: 'm' },
      { apiKey: 'k', baseURL: '', model: 'm' },
      { apiKey: 'k', baseURL: 'https://x/v1', model: '' },
    ]) {
      let thrown: unknown
      try {
        new ChatMemoryLlm(config)
      } catch (error) {
        thrown = error
      }
      expect(isHarnessError(thrown)).toBe(true)
      expect((thrown as { code: string }).code).toBe(MEMORY_LLM_CODES.config)
    }
  })

  it('请求打向配置的 baseURL/model，不含任何内置供应商默认值', async () => {
    const { fetchImpl, calls } = stubFetch(contentReply('{"facts": []}'))
    const llm = new ChatMemoryLlm({
      apiKey: 'k',
      baseURL: 'https://my-gateway.example/v1/',
      model: 'qwen-max',
      fetchImpl,
    })
    await llm.extractFacts({ agentName: 'Ryen', conversationText: '我喜欢川菜' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://my-gateway.example/v1/chat/completions')
    expect(calls[0]!.body.model).toBe('qwen-max')
    expect(calls[0]!.headers.authorization).toBe('Bearer k')
  })

  it('HTTP 失败抛带状态码的 HarnessError（禁止裸 Error）', async () => {
    const { fetchImpl } = stubFetch({ error: 'no key' }, { ok: false, status: 401 })
    const llm = new ChatMemoryLlm({ apiKey: 'k', baseURL: 'https://x/v1', model: 'm', fetchImpl })
    let thrown: unknown
    try {
      await llm.extractFacts({ agentName: 'a', conversationText: 'x' })
    } catch (error) {
      thrown = error
    }
    expect(isHarnessError(thrown)).toBe(true)
    expect((thrown as { code: string }).code).toBe(MEMORY_LLM_CODES.http)
    expect((thrown as Error).message).toContain('401')
  })

  it('空回复与非 JSON 都有兜底错误；带围栏的 JSON 仍能解析', async () => {
    const empty = stubFetch(contentReply(''))
    const emptyLlm = new ChatMemoryLlm({ apiKey: 'k', baseURL: 'https://x/v1', model: 'm', fetchImpl: empty.fetchImpl })
    await expect(emptyLlm.extractFacts({ agentName: 'a', conversationText: 'x' })).rejects.toMatchObject({
      code: MEMORY_LLM_CODES.empty,
    })

    const garbage = stubFetch(contentReply('抱歉，我无法完成'))
    const garbageLlm = new ChatMemoryLlm({
      apiKey: 'k',
      baseURL: 'https://x/v1',
      model: 'm',
      fetchImpl: garbage.fetchImpl,
    })
    await expect(garbageLlm.extractFacts({ agentName: 'a', conversationText: 'x' })).rejects.toMatchObject({
      code: MEMORY_LLM_CODES.json,
    })

    const fenced = stubFetch(
      contentReply('```json\n{"facts":[{"text":"用户喜欢川菜","scope":"shared","kind":"preference"}]}\n```'),
    )
    const fencedLlm = new ChatMemoryLlm({
      apiKey: 'k',
      baseURL: 'https://x/v1',
      model: 'm',
      fetchImpl: fenced.fetchImpl,
    })
    const facts = await fencedLlm.extractFacts({ agentName: 'a', conversationText: 'x' })
    expect(facts).toEqual([{ text: '用户喜欢川菜', scope: 'shared', kind: 'preference' }])
  })

  it('分段数组形式的 content 也能拼回文本解析', async () => {
    const { fetchImpl } = stubFetch(
      contentReply([
        { type: 'text', text: '{"operations":[{"action":"ADD"}]}' },
      ]),
    )
    const llm = new ChatMemoryLlm({ apiKey: 'k', baseURL: 'https://x/v1', model: 'm', fetchImpl })
    const ops = await llm.decideOperations({
      candidate: { text: '用户喜欢川菜', scope: 'shared', kind: 'preference' },
      similar: [],
    })
    expect(ops).toEqual([{ action: 'ADD', text: undefined }])
  })

  it('DECIDE prompt 带既有记忆的 id 与内容（update/deprecate 才有依据）', async () => {
    const { fetchImpl, calls } = stubFetch(contentReply('{"operations":[{"action":"NOOP"}]}'))
    const llm = new ChatMemoryLlm({ apiKey: 'k', baseURL: 'https://x/v1', model: 'm', fetchImpl })
    await llm.decideOperations({
      candidate: { text: '用户住在杭州', scope: 'shared', kind: 'profile' },
      similar: [{ id: 'mem-1', content: '用户住在北京' }],
    })
    const prompt = String((calls[0]!.body.messages as { content: string }[])[1]!.content)
    expect(prompt).toContain('[mem-1] 用户住在北京')
  })
})