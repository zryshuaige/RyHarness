// @vitest-environment jsdom
/**
 * 审批卡：approval-request 事件上屏成「等你点头」的卡，按钮把决议送上去，
 * approval-resolved（无论来自哪里）撤卡。用户看到并批准的是命令原文。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, Conversation } from '../renderer/src/api.ts'
import { ApiClient } from '../renderer/src/api.ts'
import { ChatView } from '../renderer/src/components/ChatView.tsx'
import { bucketOf, ChatStore } from '../renderer/src/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | undefined

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
    root?.unmount()
  })
  root = undefined
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const ryen: AgentDef = {
  id: 'ryen',
  name: 'Ryen',
  avatar: 'cat',
  systemPrompt: '你是 Ryen。',
  provider: 'siliconflow',
  model: 'deepseek-ai/DeepSeek-V3',
  tools: [],
  isBuiltin: true,
}

const conversation: Conversation = {
  id: 'c1',
  kind: 'direct',
  title: 'Ryen',
  memberAgentIds: ['ryen'],
  lastReadSeq: 0,
  createdAt: 1,
  updatedAt: 2,
}

function stubbedClient(): ApiClient {
  const api = new ApiClient('http://127.0.0.1:32100')
  vi.spyOn(api, 'subscribe').mockReturnValue(() => {})
  vi.spyOn(api, 'markRead').mockResolvedValue({ conversationId: 'c1', lastReadSeq: 0 })
  vi.spyOn(api, 'listDispatchEvents').mockResolvedValue({ events: [] })
  vi.spyOn(api, 'plugins').mockResolvedValue({ plugins: [] })
  vi.spyOn(api, 'workspace').mockResolvedValue({ path: 'C:/data/workspace' })
  vi.spyOn(api, 'decideApproval').mockResolvedValue({ approvalId: 'ap-1', decision: 'allow' })
  return api
}

async function settle(): Promise<void> {
  // ChatStore 的通知有 40ms 节流窗（NOTIFY_INTERVAL_MS）：apply 之后的那次
  // 重绘可能排在 setTimeout 里，等过一个窗口再断言。
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 80)
    })
  })
  await act(async () => {
    await Promise.resolve()
  })
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => {
    return node.textContent?.trim() === label
  })
}

describe('审批卡', () => {
  it('approval-request 上屏为审批卡，命令原文可见；点允许发送决议，resolved 撤卡', async () => {
    const api = stubbedClient()
    const store = new ChatStore()
    await act(async () => {
      root = createRoot(container)
      root.render(<ChatView api={api} conversation={conversation} agents={[ryen]} bucket={bucketOf(store)} />)
      await Promise.resolve()
    })
    act(() => {
      store.apply({
        type: 'approval-request',
        conversationId: 'c1',
        senderId: 'ryen',
        approvalId: 'ap-1',
        toolName: 'shell_exec',
        arguments: '{"command":"npm test"}',
      })
    })
    await settle()
    const card = container.querySelector('.approval-card')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('shell_exec')
    expect(card?.querySelector('.approval-command')?.textContent).toBe('npm test')

    act(() => {
      buttonByText('允许')?.click()
    })
    await settle()
    expect(api.decideApproval).toHaveBeenCalledWith('c1', 'ap-1', 'allow', false)

    act(() => {
      store.apply({ type: 'approval-resolved', conversationId: 'c1', approvalId: 'ap-1', outcome: 'allow' })
    })
    expect(container.querySelector('.approval-card')).toBeNull()
  })

  it('点拒绝发送 deny；勾选「记住」后决议带上 remember', async () => {
    const api = stubbedClient()
    const store = new ChatStore()
    await act(async () => {
      root = createRoot(container)
      root.render(<ChatView api={api} conversation={conversation} agents={[ryen]} bucket={bucketOf(store)} />)
      await Promise.resolve()
    })
    act(() => {
      store.apply({
        type: 'approval-request',
        conversationId: 'c1',
        senderId: 'ryen',
        approvalId: 'ap-2',
        toolName: 'shell_exec',
        arguments: '{"command":"rm -rf dist"}',
      })
    })
    await settle()
    const checkbox = container.querySelector<HTMLInputElement>('.approval-remember input')
    act(() => {
      if (checkbox !== null) checkbox.click()
    })
    act(() => {
      buttonByText('拒绝')?.click()
    })
    await settle()
    expect(api.decideApproval).toHaveBeenCalledWith('c1', 'ap-2', 'deny', true)
  })

  it('轮次取消的 resolved 事件同样撤卡（超时/别处决议不留死卡）', async () => {
    const api = stubbedClient()
    const store = new ChatStore()
    await act(async () => {
      root = createRoot(container)
      root.render(<ChatView api={api} conversation={conversation} agents={[ryen]} bucket={bucketOf(store)} />)
      await Promise.resolve()
    })
    act(() => {
      store.apply({
        type: 'approval-request',
        conversationId: 'c1',
        senderId: 'ryen',
        approvalId: 'ap-3',
        toolName: 'shell_exec',
        arguments: '{"command":"ls"}',
      })
    })
    await settle()
    expect(container.querySelector('.approval-card')).not.toBeNull()
    act(() => {
      store.apply({ type: 'approval-resolved', conversationId: 'c1', approvalId: 'ap-3', outcome: 'cancelled' })
    })
    await settle()
    expect(container.querySelector('.approval-card')).toBeNull()
  })
})
