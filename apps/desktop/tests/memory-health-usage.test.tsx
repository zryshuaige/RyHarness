// @vitest-environment jsdom
/**
 * 记忆健康度（MemoryPanel / 「我的」页）、用量账单（MePage）、经验溯源（GroupEvolution）
 * 与记忆面板的删除反馈。
 *
 * 这三块都读服务端尚不存在的聚合能力，因此这里钉住两件事：能拿到的指标必须如实显示，
 * 拿不到的必须显示「—」而不是编一个数出来；读口缺失/失败时降级而不是报错。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentDef,
  Conversation,
  MemoryRow,
  MemoryStats,
  MessageUsageRow,
  ProviderInfo,
  TelemetrySnapshot,
} from '../renderer/src/api.ts'
import { ApiClient } from '../renderer/src/api.ts'
import { EntryExplain } from '../renderer/src/components/GroupEvolution.tsx'
import { MemoryHealth, MemoryPanel } from '../renderer/src/components/MemoryPanel.tsx'
import { MePage } from '../renderer/src/components/MePage.tsx'
import { getToasts, toast } from '../renderer/src/lib/toast.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.stubGlobal('matchMedia', (query: string) => {
    return {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }
  })
})

afterEach(() => {
  act(() => {
    // toast 队列是模块级状态，用例之间必须自己清干净。
    for (const item of [...getToasts()]) {
      toast.dismiss(item.id)
    }
    root.unmount()
  })
  container.remove()
  vi.unstubAllGlobals()
})

/** 把挂起的 promise 链跑完（组件里是 await → then 的多级链）。 */
async function flush(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

function click(element: Element): void {
  act(() => {
    ;(element as HTMLElement).click()
  })
}

function stat(label: string): string {
  const node = [...container.querySelectorAll('.health-stat')].find((el) => {
    return el.querySelector('.health-label')?.textContent === label
  })
  return node?.querySelector('.health-value')?.textContent ?? ''
}

function memoryRow(partial: Partial<MemoryRow>): MemoryRow {
  return {
    id: 'm1',
    agentId: 'ryen',
    kind: 'fact',
    content: '用户喜欢简洁的回复',
    createdAt: 1,
    updatedAt: 2,
    accessCount: 0,
    ...partial,
  }
}

function memoryStats(partial: Partial<MemoryStats> = {}): MemoryStats {
  return {
    enabled: true,
    embeddings: { label: 'configured' },
    recentLearned: 1,
    consolidation: { intervalMs: 0 },
    total: 12,
    bySpace: { ryen: 8, coder: 4 },
    byKind: {},
    byStatus: { active: 10, inactive: 2 },
    ...partial,
  }
}

function telemetry(): TelemetrySnapshot {
  return {
    turns: [
      {
        conversationId: 'c1',
        kind: 'direct',
        turnIndex: 3,
        totalMs: 900,
        memoryRecallMs: 42,
        memoryItems: 0,
        status: 'ok',
        finishedAt: Date.now() - 30_000,
      },
      {
        conversationId: 'c1',
        kind: 'direct',
        turnIndex: 2,
        totalMs: 1200,
        memoryRecallMs: 42,
        memoryItems: 3,
        status: 'ok',
        finishedAt: Date.now() - 300_000,
      },
    ],
    requests: [],
    capacity: 200,
  }
}

function panelApi(overrides: Record<string, unknown> = {}): ApiClient {
  return {
    listAgentMemories: vi.fn(() => {
      return Promise.resolve({ agent: [memoryRow({})], shared: [] })
    }),
    listArchivedMemories: vi.fn(() => {
      return Promise.resolve({
        items: [memoryRow({ id: 'm2' }), memoryRow({ id: 'm3', agentId: 'coder' })],
      })
    }),
    memoryStats: vi.fn(() => {
      return Promise.resolve(memoryStats())
    }),
    telemetry: vi.fn(() => {
      return Promise.resolve(telemetry())
    }),
    deleteMemory: vi.fn(() => {
      return Promise.resolve({ deleted: 'm1' })
    }),
    restoreMemory: vi.fn(() => {
      return Promise.resolve({ restored: 'm2' })
    }),
    reembedMemories: vi.fn(() => {
      return Promise.resolve({ reembedded: 0 })
    }),
    ...overrides,
  } as unknown as ApiClient
}

async function renderPanel(api: ApiClient): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(
      <MemoryPanel api={api} agentId="ryen" agentName="Ryen" conversationTitles={new Map()} onClose={() => {}} />,
    )
  })
  await flush()
}

describe('记忆健康度', () => {
  it('面板顶部列出总数/归档/缺向量/最近召回/存储体积五格', async () => {
    await renderPanel(panelApi())
    expect(container.textContent).toContain('记忆健康度')
    expect(stat('记忆总数')).toBe('8 条')
    expect(stat('已归档')).toBe('1 条')
    // 最近一次有召回的是第 2 轮（memoryItems 3 / 42ms），不是最近那一轮。
    expect(stat('最近召回')).toBe('3 条 · 42ms')
    expect(container.textContent).toContain('该 agent 空间')
  })

  it('服务端答不了的格显示「—」，不拿估算值冒充真实口径', async () => {
    await renderPanel(panelApi())
    expect(stat('缺向量')).toBe('—')
    expect(stat('存储体积')).toBe('—')
  })

  it('没配 embedding（纯 FTS）时缺向量等于该空间总数并标成警示色', async () => {
    await renderPanel(
      panelApi({
        memoryStats: () => {
          return Promise.resolve(memoryStats({ embeddings: { label: 'none:fts-only' } }))
        },
      } as Record<string, unknown>),
    )
    expect(stat('缺向量')).toBe('8 条')
    expect(container.querySelector('.health-value.is-warn')).not.toBeNull()
    expect(container.textContent).toContain('只能按关键词检索')
  })

  it('没有任何召回记录时说明「暂无」，而不是显示 0 条', async () => {
    await renderPanel(
      panelApi({
        telemetry: () => {
          return Promise.resolve({ turns: [], requests: [], capacity: 200 })
        },
      } as Record<string, unknown>),
    )
    expect(stat('最近召回')).toBe('暂无')
    expect(container.textContent).toContain('本次运行还没有召回记录')
  })

  it('三条读口全挂时降级成一句话，不抛错也不留空面板', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <MemoryHealth
          api={{
            memoryStats: () => {
              return Promise.reject(new Error('HTTP 500'))
            },
            telemetry: () => {
              return Promise.reject(new Error('HTTP 500'))
            },
            listArchivedMemories: () => {
              return Promise.reject(new Error('HTTP 500'))
            },
          }}
        />,
      )
    })
    await flush()
    expect(container.textContent).toContain('记忆健康度暂时读不到')
    expect(container.querySelector('.health-stat')).toBeNull()
  })

  it('记忆系统未启用时说明原因', async () => {
    await renderPanel(
      panelApi({
        memoryStats: () => {
          return Promise.resolve({
            enabled: false,
            recentLearned: 0,
            consolidation: { intervalMs: 0 },
          })
        },
        listArchivedMemories: () => {
          return Promise.resolve({ items: [] })
        },
      } as Record<string, unknown>),
    )
    expect(container.textContent).toContain('记忆系统未启用')
  })
})

describe('记忆删除失败要有反馈', () => {
  it('删除失败：toast 说清原因，条目留在列表里', async () => {
    await renderPanel(
      panelApi({
        deleteMemory: () => {
          return Promise.reject(new Error('memory not found'))
        },
      } as Record<string, unknown>),
    )
    const before = getToasts().length
    await act(async () => {
      ;(container.querySelector('.memory-delete') as HTMLElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getToasts().length).toBe(before + 1)
    expect(getToasts().at(-1)?.kind).toBe('error')
    expect(getToasts().at(-1)?.text).toContain('memory not found')
    expect(container.textContent).toContain('用户喜欢简洁的回复')
  })

  it('删除成功：提示已删除并刷新列表', async () => {
    const api = panelApi()
    await renderPanel(api)
    await act(async () => {
      ;(container.querySelector('.memory-delete') as HTMLElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getToasts().at(-1)?.kind).toBe('success')
    expect(api.deleteMemory).toHaveBeenCalledWith('m1')
    expect(api.listAgentMemories).toHaveBeenCalledTimes(2)
  })
})

const ryenAgent: AgentDef = {
  id: 'ryen',
  name: 'Ryen',
  systemPrompt: '',
  provider: 'siliconflow',
  model: 'm',
  tools: [],
  isBuiltin: true,
}
const coderAgent: AgentDef = { ...ryenAgent, id: 'coder', name: '码农', provider: 'openai' }
const providers: ProviderInfo[] = [
  { id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: true, models: [] },
  { id: 'openai', displayName: 'OpenAI', apiKeyConfigured: true, models: [] },
]

function conversation(partial: Partial<Conversation>): Conversation {
  return {
    id: 'c1',
    kind: 'direct',
    title: '与 Ryen 的私聊',
    memberAgentIds: ['ryen'],
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 2,
    ...partial,
  }
}

function usageRow(partial: Partial<MessageUsageRow>): MessageUsageRow {
  return {
    id: 'msg1',
    seq: 1,
    conversationId: 'c1',
    senderType: 'agent',
    senderId: 'ryen',
    contentBlocks: [{ type: 'text', text: '好' }],
    mentions: [],
    turnIndex: 0,
    createdAt: 1,
    ...partial,
  }
}

const CONVERSATIONS = [
  conversation({}),
  conversation({ id: 'c2', kind: 'group', title: '三人小组', memberAgentIds: ['ryen', 'coder'] }),
]

const USAGE_BY_CONVERSATION: Record<string, MessageUsageRow[]> = {
  c1: [
    usageRow({ usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 } }),
    // 用户消息没有 usage，必须被跳过而不是算成 0 的一条。
    usageRow({ id: 'user-msg', senderType: 'user', senderId: undefined }),
  ],
  c2: [
    usageRow({ id: 'g1', senderId: 'ryen', usage: { inputTokens: 2000, outputTokens: 500, totalTokens: 2500 } }),
    usageRow({ id: 'g2', senderId: 'coder', usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 } }),
  ],
}

function meApi(overrides: Record<string, unknown> = {}) {
  return {
    listAgentMemories: () => {
      return Promise.resolve({ agent: [], shared: [] })
    },
    patchAgent: () => {
      return Promise.resolve({ agent: ryenAgent })
    },
    workspace: () => {
      return Promise.resolve({ path: 'C:/data/workspace' })
    },
    conversations: () => {
      return Promise.resolve({ conversations: CONVERSATIONS })
    },
    listAgents: () => {
      return Promise.resolve({ agents: [ryenAgent, coderAgent] })
    },
    listUsageRows: (conversationId: string) => {
      return Promise.resolve({ messages: USAGE_BY_CONVERSATION[conversationId] ?? [] })
    },
    ...overrides,
  }
}

async function renderMePage(api: unknown): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(
      <MePage api={api as never} ryen={ryenAgent} providers={providers} theme="light" onThemeChange={() => {}} />,
    )
  })
  await flush()
}

describe('用量账单', () => {
  it('按会话聚合，并写清统计口径', async () => {
    await renderMePage(meApi())
    expect(container.textContent).toContain('用量账单')
    expect(container.querySelector('.usage-total')?.textContent).toContain('累计 5.0k tokens')
    expect(container.querySelector('.usage-total')?.textContent).toContain('输入 3.9k')
    expect(container.querySelector('.usage-total')?.textContent).toContain('输出 1.1k')
    expect(container.querySelector('.usage-scope')?.textContent).toContain('覆盖 2 个会话')
    const rows = [...container.querySelectorAll('.usage-row')]
    expect(
      rows.map((row) => {
        return row.querySelector('.usage-name')?.textContent
      }),
    ).toEqual(['三人小组', '与 Ryen 的私聊'])
    expect(rows[0]!.querySelector('.usage-sub')?.textContent).toBe('群聊 · 2 位成员')
    expect(rows[0]!.querySelector('.usage-total-num')?.textContent).toBe('4.0k')
  })

  it('切到「按供应商」：按发言 agent 的供应商合并，展示名与 agent 名都对得上', async () => {
    await renderMePage(meApi())
    click(
      [...container.querySelectorAll('.usage-tab')].find((node) => {
        return node.textContent === '按供应商'
      })!,
    )
    const rows = [...container.querySelectorAll('.usage-row')]
    expect(
      rows.map((row) => {
        return row.querySelector('.usage-name')?.textContent
      }),
    ).toEqual(['SiliconFlow', 'OpenAI'])
    expect(rows[0]!.querySelector('.usage-sub')?.textContent).toBe('Ryen')
    expect(rows[1]!.querySelector('.usage-sub')?.textContent).toBe('码农')
    // 两栏必须加总相等：同一批消息算出来的，不能各算各的。
    expect(rows[0]!.querySelector('.usage-total-num')?.textContent).toBe('3.5k')
    expect(rows[1]!.querySelector('.usage-total-num')?.textContent).toBe('1.5k')
  })

  it('一条用量都没有时给空态，而不是白板', async () => {
    await renderMePage(
      meApi({
        listUsageRows: () => {
          return Promise.resolve({ messages: [] })
        },
      }),
    )
    expect(container.textContent).toContain('还没有可统计的用量')
  })

  it('服务端没有用量数据面时说明原因，不报错', async () => {
    const base = meApi()
    await renderMePage({
      listAgentMemories: base.listAgentMemories,
      patchAgent: base.patchAgent,
      workspace: base.workspace,
    })
    expect(container.querySelector('.usage-ledger')).toBeNull()
    expect(container.textContent).toContain('这版服务端还没有提供用量数据')
  })

  it('读失败时说清是读失败（空表和「没用过 token」长得一样）', async () => {
    await renderMePage(
      meApi({
        conversations: () => {
          return Promise.reject(new Error('HTTP 503'))
        },
      }),
    )
    const alert = container.querySelector('.usage-ledger, [role="alert"]')
    expect(alert?.textContent).toContain('用量没读出来：HTTP 503')
  })

  it('「我的」页同时挂着记忆健康度区块', async () => {
    await renderMePage(
      meApi({
        memoryStats: () => {
          return Promise.resolve(memoryStats())
        },
        telemetry: () => {
          return Promise.resolve(telemetry())
        },
        listArchivedMemories: () => {
          return Promise.resolve({ items: [memoryRow({})] })
        },
      }),
    )
    const health = container.querySelector('.memory-health')!
    expect(health.textContent).toContain('全部空间')
    expect(stat('记忆总数')).toBe('12 条')
    expect(stat('最近召回')).toBe('3 条 · 42ms')
  })
})

describe('ApiClient：健康度 / 账单 / 溯源三条读口', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function stubFetch(body: unknown, status = 200): string[] {
    const calls: string[] = []
    globalThis.fetch = ((url: string) => {
      calls.push(url)
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })
    }) as unknown as typeof fetch
    return calls
  }

  it('telemetry 带 limit，不给就查全量默认条数', async () => {
    const api = new ApiClient('http://127.0.0.1:32100')
    const calls = stubFetch({ turns: [], requests: [], capacity: 200 })
    await api.telemetry(50)
    await api.telemetry()
    expect(calls).toEqual(['http://127.0.0.1:32100/api/telemetry?limit=50', 'http://127.0.0.1:32100/api/telemetry'])
  })

  it('explainPlaybookEntry 打 /api/evolve/entries/:id/explain 并编码 id', async () => {
    const api = new ApiClient('http://127.0.0.1:32100')
    const calls = stubFetch({ entry: { id: 'a b' }, origins: [], summary: '来自种子' })
    const result = await api.explainPlaybookEntry('a b')
    expect(calls).toEqual(['http://127.0.0.1:32100/api/evolve/entries/a%20b/explain'])
    expect(result.summary).toBe('来自种子')
  })

  it('listUsageRows 默认按服务端单页上限取，可显式传条数', async () => {
    const api = new ApiClient('http://127.0.0.1:32100')
    const calls = stubFetch({ messages: [] })
    await api.listUsageRows('c1')
    await api.listUsageRows('c1', 50)
    expect(calls).toEqual([
      'http://127.0.0.1:32100/api/conversations/c1/messages?limit=200',
      'http://127.0.0.1:32100/api/conversations/c1/messages?limit=50',
    ])
  })

  it('路由未注册时把服务端的 error 原样抛出（界面据此降级，不吞）', async () => {
    const api = new ApiClient('http://127.0.0.1:32100')
    stubFetch({ error: 'not found: GET /api/evolve/entries/e1/explain' }, 404)
    await expect(api.explainPlaybookEntry('e1')).rejects.toThrow('not found: GET /api/evolve/entries/e1/explain')
  })
})

const entry = {
  id: 'e1',
  agentId: 'ryen',
  section: 'strategy' as const,
  content: '改完配置先读一遍再动手',
  helpful: 2,
  harmful: 0,
  status: 'active' as const,
  createdAt: 1,
  updatedAt: 2,
  source: 'curator' as const,
}

describe('经验溯源：它从哪来', () => {
  it('默认收起；展开后拉证据链并按中文口径标出来源种类', async () => {
    const explainPlaybookEntry = vi.fn(() => {
      return Promise.resolve({
        entry,
        summary: '来自教训、反馈×2',
        origins: [
          { kind: 'reflection' as const, refId: 'r1', detail: '写文件前先确认目录存在', createdAt: 1 },
          { kind: 'feedback' as const, refId: 'f1', detail: '👎 这次改坏了', createdAt: 2 },
          { kind: 'feedback' as const, refId: 'f2', detail: '👍 这次改对了', createdAt: 3 },
          { kind: 'seed' as const, refId: 'coding', detail: '', createdAt: 4 },
        ],
      })
    })
    await act(async () => {
      root = createRoot(container)
      root.render(<EntryExplain api={{ explainPlaybookEntry }} entry={entry} />)
    })
    const toggle = container.querySelector('.entry-explain-toggle')!
    expect(toggle.textContent).toContain('它从哪来')
    expect(container.querySelector('.entry-explain-body')).toBeNull()
    expect(explainPlaybookEntry).not.toHaveBeenCalled()

    await act(async () => {
      ;(toggle as HTMLElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(explainPlaybookEntry).toHaveBeenCalledWith('e1')
    expect(container.querySelector('.entry-explain-summary')?.textContent).toBe('来自教训、反馈×2')
    const origins = [...container.querySelectorAll('.entry-origin')]
    expect(
      origins.map((node) => {
        return node.querySelector('.entry-origin-kind')?.textContent
      }),
    ).toEqual(['教训', '反馈', '反馈', '种子'])
    // detail 缺失时回落到种类标签，不留空白。
    expect(origins[3]!.querySelector('.entry-origin-detail')?.textContent).toBe('种子')

    // 收起再展开不再重复请求。
    click(toggle)
    click(toggle)
    expect(explainPlaybookEntry).toHaveBeenCalledTimes(1)
  })

  it('服务端没有这条路由时降级成灰字，不报错也不崩', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <EntryExplain
          api={{
            explainPlaybookEntry: () => {
              return Promise.reject(new Error('not found: GET /api/evolve/entries/e1/explain'))
            },
          }}
          entry={entry}
        />,
      )
    })
    click(container.querySelector('.entry-explain-toggle')!)
    await flush()
    expect(container.textContent).toContain('来历暂时查不到')
    expect(container.querySelector('.entry-origin-list')).toBeNull()
  })

  it('数据面整个缺失时也能展开，不请求不报错', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(<EntryExplain api={{}} entry={entry} />)
    })
    click(container.querySelector('.entry-explain-toggle')!)
    await flush()
    expect(container.querySelector('.entry-explain-body')).not.toBeNull()
    expect(container.textContent).toContain('来历暂时查不到')
  })

  it('零溯源记录：说清是种子/手动写入，而不是空白', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <EntryExplain
          api={{
            explainPlaybookEntry: () => {
              return Promise.resolve({ entry, summary: '来源未知（Curator 归纳，无溯源记录）', origins: [] })
            },
          }}
          entry={entry}
        />,
      )
    })
    click(container.querySelector('.entry-explain-toggle')!)
    await flush()
    expect(container.textContent).toContain('来源未知')
    expect(container.textContent).toContain('没有记录到具体来源')
  })
})
