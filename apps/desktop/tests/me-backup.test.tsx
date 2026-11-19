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

interface BackupFileView {
  name: string
  path: string
  at: number
  size: number
}

function meApi(
  backup: (() => Promise<{ path: string }>) | undefined,
  listBackups?: () => Promise<{ dir: string; backups: BackupFileView[] }>,
) {
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
    ...(listBackups === undefined ? {} : { listBackups }),
  }
}

/** 一份测试备份：大小 2048 → formatSize 写成「2.0 KB」，时间是固定毫秒。 */
function backupFile(suffix: string, at: number): BackupFileView {
  const name = `ryharness-${suffix}.db`
  return { name, path: `C:/data/backups/${name}`, at, size: 2048 }
}

/** jsdom 没有剪贴板： stub 成可断言的 vi.fn，复制路径/降级复制目录都走它。 */
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(() => {
    return Promise.resolve()
  })
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  return writeText
}

/** 备份区块整体由 api.backup 是否存在把关；清单测试也要带上它，整行才渲染。 */
const anyBackup = (): Promise<{ path: string }> => {
  return Promise.resolve({ path: 'C:/data/backups/ryharness-20261023-235959.db' })
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((node) => {
    return node.textContent === text
  })
  if (button === undefined) throw new Error(`找不到「${text}」按钮`)
  return button
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

describe('备份清单（把「最近 10 份留在这里」真的列出来）', () => {
  it('读到清单后逐份列出：文件名、大小，标题带份数', async () => {
    const listBackups = vi.fn(() => {
      return Promise.resolve({
        dir: 'C:/data/backups',
        backups: [backupFile('20261023-235959', 2_000), backupFile('20261022-120000', 1_000)],
      })
    })
    await renderMePage(meApi(anyBackup, listBackups))
    expect(listBackups).toHaveBeenCalled()
    expect(container.querySelectorAll('.backup-item')).toHaveLength(2)
    expect(container.querySelector('.backup-history-title')?.textContent).toContain('最近备份（2）')
    expect(container.textContent).toContain('ryharness-20261023-235959.db')
    expect(container.textContent).toContain('2.0 KB')
  })

  it('清单为空时显示空态文案，而不是一个空列表', async () => {
    const listBackups = vi.fn(() => {
      return Promise.resolve({ dir: 'C:/data/backups', backups: [] })
    })
    await renderMePage(meApi(anyBackup, listBackups))
    expect(container.querySelector('.backup-history-empty')?.textContent).toContain('还没备份过')
    expect(container.querySelectorAll('.backup-item')).toHaveLength(0)
  })

  it('服务端没有清单能力时不渲染清单，「立即备份」仍在', async () => {
    const backup = vi.fn(() => {
      return Promise.resolve({ path: 'C:/data/backups/ryharness-20261023-235959.db' })
    })
    await renderMePage(meApi(backup))
    expect(container.querySelector('.backup-history')).toBeNull()
    expect(backupButton().textContent).toBe('立即备份')
  })

  it('复制路径把那份备份的完整路径交到剪贴板', async () => {
    const writeText = stubClipboard()
    const file = backupFile('20261023-235959', 2_000)
    const listBackups = () => {
      return Promise.resolve({ dir: 'C:/data/backups', backups: [file] })
    }
    await renderMePage(meApi(anyBackup, listBackups))
    act(() => {
      container.querySelector<HTMLButtonElement>('.backup-item-copy')?.click()
    })
    await flush()
    expect(writeText).toHaveBeenCalledWith(file.path)
  })

  it('打开目录在没有主进程桥时降级为复制目录路径（浏览器形态）', async () => {
    const writeText = stubClipboard()
    const listBackups = () => {
      return Promise.resolve({ dir: 'C:/data/backups', backups: [backupFile('20261023-235959', 2_000)] })
    }
    await renderMePage(meApi(anyBackup, listBackups))
    act(() => {
      buttonByText('打开目录').click()
    })
    await flush()
    expect(writeText).toHaveBeenCalledWith('C:/data/backups')
    expect(
      getToasts().some((item) => {
        return item.text.includes('路径已复制')
      }),
    ).toBe(true)
  })

  it('备份成功后刷新清单（新备份立刻排在清单里）', async () => {
    const backup = vi.fn(() => {
      return Promise.resolve({ path: 'C:/data/backups/ryharness-20261023-235959.db' })
    })
    const listBackups = vi.fn(() => {
      return Promise.resolve({ dir: 'C:/data/backups', backups: [] })
    })
    await renderMePage(meApi(backup, listBackups))
    const before = listBackups.mock.calls.length
    act(() => {
      backupButton().click()
    })
    await flush()
    expect(listBackups.mock.calls.length).toBeGreaterThan(before)
  })
})
