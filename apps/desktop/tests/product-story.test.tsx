// @vitest-environment jsdom
/**
 * 第 8 轮 P0/P1 的五条不变断言：
 *
 * 1. 真正选模型的地方（建 agent 的下拉）接的是目录真源，看得见上下文长度；
 * 2. 上下文长度的缺口是诚实的——未知就说未知，值只能由人补，补的值随保存落进本机
 *    providers.json，一路进内核的请求预算；
 * 3. 凭据是首屏的硬前置：排在能打字之前，没有可用来源时发送键是禁用的；
 * 4. 亲密度会涨，所以关系进展有环境信号（跨档一句 + 头部一枚徽标）；
 * 5. 定位叙事先说人格，而不是先列机制差异点。
 *
 * 断联判据一律用"不许变"的断言：这些曾经各自"做过"，但真源没有接上、顺序排错了、
 * 信号没有人看——所以钉的是行为与文案，不是某段实现。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AffinityMilestone, affinityMilestones } from '../renderer/src/App.tsx'
import type { AgentDef, AgentTemplate, Conversation, ProviderInfo } from '../renderer/src/api.ts'
import { ChatView } from '../renderer/src/components/ChatView.tsx'
import { CreateAgentModal } from '../renderer/src/components/ContactsPage.tsx'
import type { ProviderApi, ProviderModelEntry } from '../renderer/src/components/ProviderSettings.tsx'
import { ProviderSettings } from '../renderer/src/components/ProviderSettings.tsx'
import { WelcomeHome } from '../renderer/src/components/WelcomeHome.tsx'
import {
  catalogFromProvider,
  contextWindowDrafts,
  parseContextWindowInput,
  providerModelPayload,
} from '../renderer/src/lib/model-catalog.ts'
import { ConversationCache } from '../renderer/src/store.ts'
import { groupLabels, openSelect, optionLabels, optionRows } from './select-dom.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom 环境的全局 URL 不认第二个参数（相对路径会按 http://localhost:3000/ 解析），
// 所以这里走 brand-tiers.test.tsx 那套写法：先转成文件路径再 join。
const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(DESKTOP, '..', '..')

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  localStorage.clear()
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
    root?.unmount()
  })
  root = undefined
  container.remove()
  localStorage.clear()
  vi.unstubAllGlobals()
})

/** 受控 input 输入：原生 setter + input 事件（React 受控组件标准打法）。 */
function typeInto(node: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
  if (setter === undefined) throw new Error('取不到 value 的原生 setter')
  act(() => {
    setter.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function buttonByText(text: string, scope: ParentNode = container): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((node) => {
    return node.textContent?.trim() === text || node.textContent?.includes(text)
  })
  if (found === undefined) throw new Error(`找不到按钮：${text}`)
  return found
}

const template: AgentTemplate = {
  key: 'general',
  name: '通用',
  description: '什么都能干一点',
  suggestedSystemPrompt: '你是通用助理。',
  defaultModel: 'deepseek-ai/DeepSeek-V3',
  defaultTools: ['fs_read'],
}

/** 一家"只有部分模型报了长度"的供应商：真实世界最常见的样子。 */
const mixedProvider: ProviderInfo = {
  id: 'siliconflow',
  displayName: 'SiliconFlow',
  apiKeyConfigured: true,
  protocol: 'openai',
  baseUrl: 'https://api.siliconflow.cn/v1',
  models: [
    { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek-V3', contextWindow: 64_000 },
    { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen2.5-7B' },
  ],
}

/**
 * 建 agent 表单里那一格（它是自绘下拉：取值要打开弹层看，不是读原生 select 的 options）。
 */
function modelOptionLabels(): string[] {
  return optionLabels(openSelect(container, '模型'))
}

/**
 * 设置页补录上下文长度的完整往返：打开行内编辑 → 在指定模型的输入框里敲值 → 保存。
 * 返回 updateProvider 收到的 models 声明——服务端就按它重写 providers.json，随后这份
 * 值一路进 OpenAI 适配器的 resolveModel() 与内核的请求预算（见 apps/server 的
 * applyDeclaredModels 与 @ryharness/agent 的 resolveRequestBudget）。
 */
async function saveContextWindowInSettings(modelId: string, raw: string): Promise<ProviderModelEntry[]> {
  const declared: ProviderModelEntry[] = []
  const api: ProviderApi = {
    setApiKey: () => {
      return Promise.resolve({ providerId: 'x', configured: true })
    },
    updateProvider: (_id, patch) => {
      declared.push(...patch.models)
      return Promise.resolve({ provider: mixedProvider })
    },
  }
  await act(async () => {
    root = createRoot(container)
    root.render(<ProviderSettings api={api} providers={[mixedProvider]} onChanged={() => {}} />)
    await Promise.resolve()
  })
  await act(async () => {
    buttonByText('SiliconFlow').click()
    await Promise.resolve()
  })
  await act(async () => {
    buttonByText('编辑').click()
    await Promise.resolve()
  })
  const field = container.querySelector<HTMLInputElement>(`input[aria-label="${modelId} 的上下文长度（token）"]`)
  if (field === null) throw new Error('找不到上下文长度的输入框')
  typeInto(field, raw)
  await act(async () => {
    buttonByText('保存修改').click()
    await Promise.resolve()
  })
  return declared
}

describe('P0-1 真正选模型的地方接的是目录真源', () => {
  async function renderModal(providers: ProviderInfo[] = [mixedProvider]): Promise<void> {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <CreateAgentModal
          templates={[template]}
          providers={providers}
          onSubmit={() => {
            return Promise.resolve()
          }}
          onClose={() => {}}
        />,
      )
      await Promise.resolve()
    })
    // 模型下拉收在「高级设置」里（那一格是实现层选择，不是「她是谁」），
    // 所以断言下拉内容之前先把入口展开。
    const advanced = container.querySelector<HTMLButtonElement>('button.advanced-toggle')
    if (advanced === null) throw new Error('找不到「高级设置」入口')
    expect(advanced.getAttribute('aria-expanded'), '高级设置默认应折叠').toBe('false')
    await act(async () => {
      advanced.click()
      await Promise.resolve()
    })
  }

  it('下拉里每条都带着上下文读数：有的给长度，没报的明说未知', async () => {
    await renderModal()
    const texts = modelOptionLabels()
    // 这一格正是"要不要选上下文更大的那个"的决定点，此前它只显示模型名。
    expect(texts.join('\n')).toContain('64K 上下文')
    expect(texts.join('\n')).toContain('上下文未知')
    // 未知不是留空，也不是编一个 0 出来。
    expect(texts.join('\n')).not.toContain('0 上下文')
  })

  it('按厂商前缀分组，已知长度的排在未知的前面', async () => {
    await renderModal()
    const popover = openSelect(container, '模型')
    expect(groupLabels(popover)).toEqual(['deepseek-ai', 'Qwen'])
    // 组内已知长度排前，组与组之间按厂商前缀排。
    const second = optionRows(popover).filter((node) => {
      return node.dataset.value?.startsWith('Qwen/') === true
    })
    expect(second[0]?.querySelector('.select-option-label')?.textContent).toContain('上下文未知')
  })

  it('补过的长度会出现在这一个下拉里（设置页填的 → 保存 → 这里看得见）', async () => {
    // 设置页补 32k 并保存：声明里带上了这条的 contextWindow。
    const declared = await saveContextWindowInSettings('Qwen/Qwen2.5-7B-Instruct', '32k')
    expect(declared).toEqual([
      { id: 'deepseek-ai/DeepSeek-V3', contextWindow: 64_000 },
      { id: 'Qwen/Qwen2.5-7B-Instruct', contextWindow: 32_000 },
    ])
    // 服务端把声明写进这条路由后回给界面的那份（名字沿用旧条目）——选模型的这一格
    // 立刻看得见。此前这一格读的是另一份本机覆盖层，设置页填的永远到不了这里。
    act(() => {
      root?.unmount()
    })
    root = undefined
    await renderModal([
      {
        ...mixedProvider,
        models: [
          { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek-V3', contextWindow: 64_000 },
          { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen2.5-7B', contextWindow: 32_000 },
        ],
      },
    ])
    expect(modelOptionLabels().join('\n')).toContain('32K 上下文')
  })
})

describe('P0-2 上下文长度的缺口：诚实 + 由人补', () => {
  it('只认人明确敲进来的写法，其余一律未知（不把 12abc 猜成 12）', () => {
    expect(parseContextWindowInput('131072')).toBe(131_072)
    expect(parseContextWindowInput('128k')).toBe(128_000)
    expect(parseContextWindowInput(' 1M ')).toBe(1_000_000)
    expect(parseContextWindowInput('')).toBeUndefined()
    expect(parseContextWindowInput('12abc')).toBeUndefined()
    expect(parseContextWindowInput('-1')).toBeUndefined()
    expect(parseContextWindowInput('0')).toBeUndefined()
  })

  it('保存往返的三种输入：新值生效、清空撤回、手滑不丢旧值', () => {
    const declared = catalogFromProvider(mixedProvider)
    // 草稿来自服务端现存的值：已知长度如实进框，没存过的是空串（不猜）。
    expect(contextWindowDrafts(declared)).toEqual({
      'deepseek-ai/DeepSeek-V3': '64000',
      'Qwen/Qwen2.5-7B-Instruct': '',
    })
    // 补上 32k：随声明带出去，服务端写进 providers.json，内核按它算预算。
    expect(
      providerModelPayload(
        ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-7B-Instruct'],
        { ...contextWindowDrafts(declared), 'Qwen/Qwen2.5-7B-Instruct': '32k' },
        declared,
      ),
    ).toEqual([
      { id: 'deepseek-ai/DeepSeek-V3', contextWindow: 64_000 },
      { id: 'Qwen/Qwen2.5-7B-Instruct', contextWindow: 32_000 },
    ])
    // 清空 = 撤回：声明里不带 contextWindow，服务端清掉旧值，界面与内核一起回「未知」。
    const cleared = providerModelPayload(['deepseek-ai/DeepSeek-V3'], { 'deepseek-ai/DeepSeek-V3': '' }, declared)
    expect(cleared).toEqual([{ id: 'deepseek-ai/DeepSeek-V3' }])
    expect('contextWindow' in (cleared[0] as object)).toBe(false)
    // 手滑写成看不懂的字：声明保持服务端现存的 64000，半个错字不把旧值抹掉。
    expect(providerModelPayload(['deepseek-ai/DeepSeek-V3'], { 'deepseek-ai/DeepSeek-V3': '很长' }, declared)).toEqual([
      { id: 'deepseek-ai/DeepSeek-V3', contextWindow: 64_000 },
    ])
  })

  it('两家供应商的同名模型各记各的，不串味', () => {
    // 值存在各自供应商路由的声明里：a 补过的 128k 只出现在 a 的载荷中，
    // b 的同名模型按 b 自己存的那份算（这里没存过，就是未知）。
    const payloadA = providerModelPayload(['gpt-4o'], { 'gpt-4o': '128k' }, [
      { id: 'gpt-4o', contextWindow: 128_000, source: 'preset' },
    ])
    expect(payloadA).toEqual([{ id: 'gpt-4o', contextWindow: 128_000 }])
    const payloadB = providerModelPayload(['gpt-4o'], { 'gpt-4o': '' }, [])
    expect(payloadB).toEqual([{ id: 'gpt-4o' }])
  })

  it('设置页里能逐个补：读数当场变成人话，保存进声明发去服务端', async () => {
    const declared = await saveContextWindowInSettings('Qwen/Qwen2.5-7B-Instruct', '32k')
    expect(
      declared.find((model) => {
        return typeof model !== 'string' && model.id === 'Qwen/Qwen2.5-7B-Instruct'
      }),
    ).toEqual({ id: 'Qwen/Qwen2.5-7B-Instruct', contextWindow: 32_000 })

    // 手滑打出的半个字不进声明：值留在框里给用户改，不猜、也不写进服务端。
    act(() => {
      root?.unmount()
    })
    root = undefined
    const patched: ProviderModelEntry[] = []
    const api: ProviderApi = {
      setApiKey: () => {
        return Promise.resolve({ providerId: 'x', configured: true })
      },
      updateProvider: (_id, patch) => {
        patched.push(...patch.models)
        return Promise.resolve({ provider: mixedProvider })
      },
    }
    await act(async () => {
      root = createRoot(container)
      root.render(<ProviderSettings api={api} providers={[mixedProvider]} onChanged={() => {}} />)
      await Promise.resolve()
    })
    await act(async () => {
      buttonByText('SiliconFlow').click()
      await Promise.resolve()
    })
    await act(async () => {
      buttonByText('编辑').click()
      await Promise.resolve()
    })
    const field = container.querySelector<HTMLInputElement>(
      'input[aria-label="Qwen/Qwen2.5-7B-Instruct 的上下文长度（token）"]',
    )
    if (field === null) throw new Error('找不到上下文长度的输入框')
    typeInto(field, '很长')
    expect(container.textContent).toContain('看不懂这个写法')
    await act(async () => {
      buttonByText('保存修改').click()
      await Promise.resolve()
    })
    // 这条模型服务端本来没存过长度，看不懂的写法保持「未知」，而不是编一个数进去。
    expect(
      patched.find((model) => {
        return typeof model !== 'string' && model.id === 'Qwen/Qwen2.5-7B-Instruct'
      }),
    ).toEqual({ id: 'Qwen/Qwen2.5-7B-Instruct' })
  })
})

describe('P1-3 首屏：凭据是硬前置', () => {
  const noKeyProviders: ProviderInfo[] = [
    { id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: false, models: [] },
  ]

  async function renderWelcome(providers: ProviderInfo[], onSend: () => void = () => {}): Promise<void> {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <WelcomeHome
          ryen={undefined}
          agents={[]}
          conversations={[]}
          providers={providers}
          onSaveApiKey={() => {
            return Promise.resolve()
          }}
          onSend={onSend}
          onOpenConversation={() => {}}
        />,
      )
      await Promise.resolve()
    })
  }

  it('凭据卡排在能打字之前（此前在页尾，用户得先失败一次才发现）', async () => {
    await renderWelcome(noKeyProviders)
    const order = [...container.querySelectorAll('.apikey-card, .welcome-compose')]
    expect(order.map((node) => node.className)).toEqual(['apikey-card', 'welcome-compose'])
  })

  it('没有可用凭据时发送键与输入框都是禁用的，点了也不会真发出去', async () => {
    const sent: string[] = []
    await renderWelcome(noKeyProviders, () => {
      sent.push('sent')
    })
    const send = container.querySelector<HTMLButtonElement>('.send-btn')
    const textarea = container.querySelector<HTMLTextAreaElement>('.welcome-compose textarea')
    if (send === null || textarea === null) throw new Error('首屏没有输入框')
    expect(send.disabled).toBe(true)
    expect(textarea.disabled).toBe(true)
    // 绕过 disabled 直接调用回调也拦得住：Enter 走的是 textarea 的 onKeyDown。
    typeInto(textarea, '你好')
    await act(async () => {
      send.click()
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    expect(sent).toEqual([])
  })

  it('填好凭据（或本地服务在位）时输入框照常能发，前置卡整体消失', async () => {
    const sent: string[] = []
    await renderWelcome(
      [{ id: 'ollama', displayName: 'Ollama', apiKeyConfigured: false, protocol: 'ollama', models: [] }],
      () => {
        sent.push('sent')
      },
    )
    expect(container.querySelector('.apikey-card')).toBeNull()
    const textarea = container.querySelector<HTMLTextAreaElement>('.welcome-compose textarea')
    const send = container.querySelector<HTMLButtonElement>('.send-btn')
    if (textarea === null || send === null) throw new Error('首屏没有输入框')
    typeInto(textarea, '晚上好')
    expect(send.disabled).toBe(false)
    await act(async () => {
      send.click()
      await Promise.resolve()
    })
    expect(sent).toEqual(['sent'])
  })

  it('连"缺哪家"都指不出来时（供应商列表空）也给得出路，不留一个空卡', async () => {
    await renderWelcome([])
    expect(container.textContent).toContain('先填一个 API Key')
    expect(container.textContent).toContain('任选一条路')
  })
})

describe('P1-4 亲密度外显', () => {
  function agent(id: string, affinity: number): AgentDef {
    return {
      id,
      name: id === 'ryen' ? 'Ryen' : id,
      systemPrompt: 'p',
      provider: 'x',
      model: 'm',
      tools: [],
      isBuiltin: true,
      persona: {
        extroversion: 50,
        rigor: 60,
        humor: 40,
        initiative: 50,
        catchphrase: '',
        affinity,
        voiceId: 'none',
        appearance: '',
      },
    }
  }

  it('只在跨档时提醒；第一次见到某人、以及同档内的普通上涨都不出声', () => {
    // 首见不是"关系变了"，只是数据到齐了。
    expect(affinityMilestones(new Map(), [agent('ryen', 60)])).toEqual([])
    // 同档内涨（10 → 20）不提醒：按分数说"又 +N"等于每隔几轮弹一次。
    const previous = new Map([
      ['ryen', 10],
      ['阿码', 10],
    ])
    expect(affinityMilestones(previous, [agent('ryen', 20), agent('阿码', 10)])).toEqual([])
    const crossed: AffinityMilestone[] = affinityMilestones(previous, [agent('ryen', 50)])
    expect(crossed).toHaveLength(1)
    expect(crossed[0]).toMatchObject({ agentId: 'ryen', name: 'Ryen', affinity: 50, up: true })
    expect(crossed[0]?.tier.label).toBe('亲近')
  })

  it('掉档也照实标出来（只是不拿它当喜报）', () => {
    const previous = new Map([['ryen', 60]])
    const dropped = affinityMilestones(previous, [agent('ryen', 30)])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.up).toBe(false)
    expect(dropped[0]?.tier.label).toBe('熟面孔')
  })

  it('单聊头部有一枚关系徽标；亲密度为 0 时不显示（人人 0 等于没有信息）', async () => {
    const conversation: Conversation = {
      id: 'c1',
      kind: 'direct',
      title: 'Ryen',
      memberAgentIds: ['ryen'],
      lastReadSeq: 0,
      createdAt: 1,
      updatedAt: 2,
    }
    const bucket = new ConversationCache().bucket(conversation.id)
    const api = {
      base: 'http://127.0.0.1:32100',
      fileUrl: (name: string) => {
        return name
      },
      conversationDetail: () => {
        return Promise.resolve({ usage: undefined })
      },
      messages: () => {
        return Promise.resolve({ messages: [] })
      },
      markRead: () => {
        return Promise.resolve({ conversationId: 'c1', lastReadSeq: 0 })
      },
      listDispatchEvents: () => {
        return Promise.resolve({ events: [] })
      },
      subscribe: () => {
        return () => {}
      },
    }
    const render = async (affinity: number): Promise<void> => {
      await act(async () => {
        root?.unmount()
        root = createRoot(container)
        root.render(
          <ChatView
            api={api as never}
            conversation={conversation}
            agents={[agent('ryen', affinity)]}
            bucket={bucket}
          />,
        )
        await Promise.resolve()
      })
    }
    await render(0)
    expect(container.querySelector('.chat-header .chip')).toBeNull()
    await render(46)
    const chip = container.querySelector('.chat-header .chip')
    expect(chip?.textContent).toBe('亲近 · 46/100')
    expect(chip?.getAttribute('title')).toContain('可以直呼其名')
  })

  it('一轮跑完就通知外侧重拉清单（不重拉的话亲密度要等到切会话才更新）', async () => {
    const conversation: Conversation = {
      id: 'c1',
      kind: 'direct',
      title: 'Ryen',
      memberAgentIds: ['ryen'],
      lastReadSeq: 0,
      createdAt: 1,
      updatedAt: 2,
    }
    const bucket = new ConversationCache().bucket(conversation.id)
    let onEvent: ((event: unknown) => void) | undefined
    const api = {
      base: 'http://127.0.0.1:32100',
      fileUrl: (name: string) => {
        return name
      },
      conversationDetail: () => {
        return Promise.resolve({ usage: undefined })
      },
      messages: () => {
        return Promise.resolve({ messages: [] })
      },
      markRead: () => {
        return Promise.resolve({ conversationId: 'c1', lastReadSeq: 0 })
      },
      listDispatchEvents: () => {
        return Promise.resolve({ events: [] })
      },
      subscribe: (_id: string, handler: (event: unknown) => void) => {
        onEvent = handler
        return () => {}
      },
    }
    let ended = 0
    await act(async () => {
      root = createRoot(container)
      root.render(
        <ChatView
          api={api as never}
          conversation={conversation}
          agents={[agent('ryen', 10)]}
          bucket={bucket}
          onTurnEnd={() => {
            ended += 1
          }}
        />,
      )
      await Promise.resolve()
    })
    // store 的通知按 40ms 合并（流式 token 批量重绘），所以这里等一个窗口再断言。
    const settle = async (): Promise<void> => {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 60)
        })
      })
    }
    const start = { type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 1 }
    await act(async () => {
      onEvent?.(start)
      await Promise.resolve()
    })
    await settle()
    expect(ended).toBe(0)
    await act(async () => {
      onEvent?.({ ...start, type: 'message-done' })
      await Promise.resolve()
    })
    await settle()
    expect(ended).toBe(1)
    // 下一轮再结束时再报一次，不是一次性的。
    await act(async () => {
      onEvent?.({ ...start, turnIndex: 2 })
      await Promise.resolve()
    })
    await settle()
    await act(async () => {
      onEvent?.({ ...start, turnIndex: 2, type: 'message-done' })
      await Promise.resolve()
    })
    await settle()
    expect(ended).toBe(2)
  })
})

describe('P1-5 定位叙事：先说人格', () => {
  const rootReadme = readFileSync(join(REPO, 'README.md'), 'utf8')
  const desktopReadme = readFileSync(join(REPO, 'apps/desktop/README.md'), 'utf8')

  it('两份 README 的定位段都把人格/亲密度/首次相遇说在前面', () => {
    const positioning = (text: string): string => {
      return (
        text.split('\n').find((line) => {
          return line.includes('定位')
        }) ?? ''
      )
    }
    for (const readme of [rootReadme, desktopReadme]) {
      const sentence = positioning(readme)
      expect(sentence).not.toBe('')
      // 人格是第一卖点，机制差异点是第二件——句子必须先说前者。
      expect(sentence).toContain('人格')
      expect(sentence.indexOf('人格')).toBeLessThan(sentence.indexOf('第一卖点'))
      expect(sentence).toContain('亲密度')
      expect(sentence).toContain('首次相遇')
    }
  })

  it('根 README 的功能清单把人格排在机制条目之前', () => {
    const list = rootReadme.split('## 特性')[1] ?? ''
    expect(list).toContain('人格与关系')
    expect(list.indexOf('人格与关系')).toBeLessThan(list.indexOf('**群聊**'))
  })
})
