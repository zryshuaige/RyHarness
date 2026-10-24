// @vitest-environment jsdom
/**
 * 「我的」页的一键备份：点击后调 api.backup、成功把路径留在页面上、失败说人话。
 *
 * 路径必须留在页面上而不是只弹 toast——toast 一闪就没，而「备份在哪」恰恰是
 * 用户接下来要去找的东西。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, ProviderInfo } from '../renderer/src/api.ts'
import { MePage } from '../renderer/src/components/MePage.tsx'
import { getToasts, toast } from '../renderer/src/lib/toast.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ryenAgent: AgentDef = {
  id: 'ryen',
  name: 'Ryen',
  systemPrompt: '',
  provider: 'siliconflow',
  model: 'm',
  tools: [],
  isBuiltin: true,
}

const providers: ProviderInfo[] = []

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
    for (const item of [...getToasts()]) {
      toast.dismiss(item.id)
    }
    root.unmount()
  })
  container.remove()
  vi.unstubAllGlobals()
})

/** 把挂起的 promise 链跑完（点击 → await api → setState 的多级链）。 */
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

function meApi(backup: (() => Promise<{ path: string }>) | undefined) {
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
    ...(backup === undefined ? {} : { backup }),
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

function backupButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((node) => {
    return node.textContent === '立即备份'
  })
  if (button === undefined) throw new Error('找不到「立即备份」按钮')
  return button
}

describe('「我的」页一键备份', () => {
  it('点击后调 api.backup，成功把返回路径留在页面上', async () => {
    const backup = vi.fn(() => {
      return Promise.resolve({ path: 'C:/data/backups/ryharness-20261023-235959.db' })
    })
    await renderMePage(meApi(backup))
    act(() => {
      backupButton().click()
    })
    await flush()
    expect(backup).toHaveBeenCalledTimes(1)
    const path = container.querySelector('[data-testid="backup-path"]')
    expect(path?.textContent).toContain('C:/data/backups/ryharness-20261023-235959.db')
  })

  it('失败时显示错误而不是路径，原始错误文本不上屏', async () => {
    const backup = vi.fn(() => {
      return Promise.reject(new Error('HTTP 503'))
    })
    await renderMePage(meApi(backup))
    act(() => {
      backupButton().click()
    })
    await flush()
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('备份失败')
    expect(alert?.textContent).not.toContain('HTTP 503')
    expect(container.querySelector('[data-testid="backup-path"]')).toBeNull()
  })

  it('服务端没有备份能力时整行不渲染（与 usage/memoryHealth 同一口径）', async () => {
    await renderMePage(meApi(undefined))
    expect(container.textContent).not.toContain('立即备份')
    expect(container.textContent).not.toContain('数据备份')
  })
})
