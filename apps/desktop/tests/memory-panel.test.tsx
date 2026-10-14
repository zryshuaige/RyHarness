// @vitest-environment jsdom
/**
 * 记忆面板的归档分区与重建向量索引：
 * 归档条目弱化但可见、可单条恢复；重建索引人走确认弹窗并有进行中状态。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient, MemoryRow } from '../renderer/src/api.ts'
import { MemoryPanel } from '../renderer/src/components/MemoryPanel.tsx'

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
    root.unmount()
  })
  container.remove()
  vi.unstubAllGlobals()
})

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

function makeApi(overrides: Partial<ApiClient> = {}) {
  return {
    listAgentMemories: vi.fn(() => {
      return Promise.resolve({ agent: [memoryRow({})], shared: [] })
    }),
    listArchivedMemories: vi.fn(() => {
      return Promise.resolve({
        items: [
          memoryRow({ id: 'm2', content: '归档：旧的工作习惯' }),
          memoryRow({ id: 'm3', agentId: 'coder', content: '别的 agent 的归档' }),
        ],
      })
    }),
    restoreMemory: vi.fn(() => {
      return Promise.resolve({ restored: 'm2' })
    }),
    reembedMemories: vi.fn(() => {
      return Promise.resolve({ reembedded: 2 })
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
    await Promise.resolve()
  })
}

function click(element: Element): void {
  act(() => {
    ;(element as HTMLElement).click()
  })
}

describe('已归档分区', () => {
  it('默认折叠，只统计本 agent 的归档条目', async () => {
    await renderPanel(makeApi())
    const toggle = container.querySelector('.memory-archived-toggle')!
    expect(toggle.textContent).toContain('已归档（1）')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.memory-row.is-archived')).toBeNull()
  })

  it('展开后归档条目弱化展示，且不含其他 agent 的归档', async () => {
    await renderPanel(makeApi())
    click(container.querySelector('.memory-archived-toggle')!)
    const rows = container.querySelectorAll('.memory-row.is-archived')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('归档：旧的工作习惯')
    expect(rows[0]!.textContent).not.toContain('别的 agent 的归档')
    expect(container.querySelector('.memory-archived-toggle')!.getAttribute('aria-expanded')).toBe('true')
  })

  it('没有归档条目时整个分区不出现', async () => {
    await renderPanel(
      makeApi({
        listArchivedMemories: () => {
          return Promise.resolve({ items: [] })
        },
      } as Partial<ApiClient>),
    )
    expect(container.querySelector('.memory-archived')).toBeNull()
  })

  it('点「恢复」调 restore 后刷新活跃与归档列表', async () => {
    const api = makeApi()
    await renderPanel(api)
    click(container.querySelector('.memory-archived-toggle')!)
    const restoreButton = container.querySelector('.memory-restore')!
    expect(restoreButton.textContent).toBe('恢复')
    await act(async () => {
      ;(restoreButton as HTMLElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.restoreMemory).toHaveBeenCalledWith('m2')
    expect(api.listAgentMemories).toHaveBeenCalledTimes(2)
    expect(api.listArchivedMemories).toHaveBeenCalledTimes(2)
  })
})

describe('重建向量索引', () => {
  it('入口在面板底部，先弹确认而不是直接动手', async () => {
    const api = makeApi()
    await renderPanel(api)
    const button = container.querySelector('.memory-reembed')!
    expect(button.textContent).toBe('重建向量索引')
    click(button)
    expect(api.reembedMemories).not.toHaveBeenCalled()
    expect(container.textContent).toContain('重建向量索引？')
    expect(container.textContent).toContain('期间检索可能暂时变慢')
  })

  it('确认后调 reembed，进行中按钮置灰并显示「重建中…」', async () => {
    let release: () => void = () => {}
    let calls = 0
    const api = makeApi({
      reembedMemories: () => {
        calls += 1
        return new Promise<{ reembedded: number }>((resolve) => {
          release = () => {
            resolve({ reembedded: 2 })
          }
        })
      },
    } as Partial<ApiClient>)
    await renderPanel(api)
    click(container.querySelector('.memory-reembed')!)
    const confirm = [...container.querySelectorAll('.modal-actions button')].find((node) => {
      return node.textContent === '重建'
    })!
    click(confirm)
    expect(calls).toBe(1)
    const button = container.querySelector('.memory-reembed') as HTMLButtonElement
    expect(button.textContent).toBe('重建中…')
    expect(button.disabled).toBe(true)
    await act(async () => {
      release()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect((container.querySelector('.memory-reembed') as HTMLButtonElement).textContent).toBe('重建向量索引')
  })

  it('取消确认则不发起请求', async () => {
    const api = makeApi()
    await renderPanel(api)
    click(container.querySelector('.memory-reembed')!)
    const cancel = [...container.querySelectorAll('.modal-actions button')].find((node) => {
      return node.textContent === '取消'
    })!
    click(cancel)
    expect(api.reembedMemories).not.toHaveBeenCalled()
  })
})
