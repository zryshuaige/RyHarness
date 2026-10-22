// @vitest-environment jsdom

/**
 * 产物内嵌预览：点产物卡开的是预览框，不是浏览器下载页。
 *
 * 验收网分三层——按类型分派的纯函数、预览框各分支渲染什么、两个产物卡入口
 * （气泡里的文件卡、右栏的产物行）点下去走的是预览回调而不是 <a download>。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../renderer/src/api.ts'
import { ArtifactPreview } from '../renderer/src/components/ArtifactPreview.tsx'
import { MessageBubble } from '../renderer/src/components/MessageBubble.tsx'
import { RightPanel } from '../renderer/src/components/RightPanel.tsx'
import { HTML_PREVIEW_MAX_BYTES, previewKindOf } from '../renderer/src/lib/preview.ts'
import type { UiMessage } from '../renderer/src/store.ts'
import { ChatStore } from '../renderer/src/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RAW = 'http://127.0.0.1:32100/api/files/report.md/raw'

interface Stub {
  api: ApiClient
  opened: string[]
  copied: string[]
}

/** 一个只会回固定产物的 ApiClient：预览框不发真网络请求，测的是渲染与分派。 */
function stubApi(name: string, mime: string, size: number, text?: string): Stub {
  const api = new ApiClient('http://127.0.0.1:32100')
  const opened: string[] = []
  const copied: string[] = []
  api.fileInfo = () => {
    return Promise.resolve({ name, path: `C:/ws/.ryharness-artifacts/${name}`, size, mime })
  }
  api.fileRawUrl = (target: string, download = false) => {
    return `${RAW.replace('report.md', target)}${download ? '?download=1' : ''}`
  }
  api.fileText = () => {
    return Promise.resolve(text ?? '')
  }
  window.ryharnessDesktop = {
    appName: 'RyHarness',
    openPath: (target: string) => {
      opened.push(target)
      return Promise.resolve('')
    },
  }
  Object.assign(navigator, {
    clipboard: {
      writeText: (value: string) => {
        copied.push(value)
        return Promise.resolve()
      },
    },
  })
  return { api, opened, copied }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
/** 本次用例里 createObjectURL 发出过 / revokeObjectURL 收回过的 blob URL。 */
let blobUrls: { created: string[]; revoked: string[] }

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // jsdom 没实现 blob URL（iframe 分支要拿它当 src），补一份可记账的替身：
  // 「创建过又被收回」正是这条分支的验收点，替身不记账就无从断言。
  blobUrls = { created: [], revoked: [] }
  Object.assign(URL, {
    createObjectURL: () => {
      const url = `blob:preview/${blobUrls.created.length}`
      blobUrls.created.push(url)
      return url
    },
    revokeObjectURL: (url: string) => {
      blobUrls.revoked.push(url)
    },
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.unstubAllGlobals()
})

async function mountPreview(stub: Stub, name: string, mime: string, size: number): Promise<void> {
  await act(async () => {
    root.render(<ArtifactPreview api={stub.api} target={{ name, mime, size }} onClose={() => {}} />)
  })
}

describe('产物预览的类型分派', () => {
  it('图片走 <img>、Markdown/代码走文本渲染，PDF 明确说不能内嵌', () => {
    expect(previewKindOf('chart.png')).toBe('image')
    expect(previewKindOf('周报.PDF')).toBe('pdf')
    expect(previewKindOf('周报.md')).toBe('markdown')
    expect(previewKindOf('main.ts')).toBe('code')
    expect(previewKindOf('notes.txt')).toBe('text')
  })

  it('Office 与未知二进制归 external——只能交给系统程序，不假装能内嵌', () => {
    expect(previewKindOf('方案.docx')).toBe('external')
    expect(previewKindOf('表.xlsx')).toBe('external')
    expect(previewKindOf('归档.zip')).toBe('external')
  })

  it('HTML 当页面渲染而不是源码：隔离交给 iframe 的 sandbox，不靠消毒器', () => {
    expect(previewKindOf('page.html')).toBe('html')
    expect(previewKindOf('page.HTM')).toBe('html')
    expect(previewKindOf('page.xml')).toBe('code')
    // SVG 留在 <img>：那里脚本压根不跑、外部资源压根不加载，比 sandbox 还紧。
    expect(previewKindOf('chart.svg')).toBe('image')
  })

  it('没有扩展名时按 MIME 兜底（产物名是 agent 自己起的）', () => {
    expect(previewKindOf('clipboard', 'image/png')).toBe('image')
    expect(previewKindOf('clipboard', 'application/pdf')).toBe('pdf')
    expect(previewKindOf('clipboard', 'text/html')).toBe('html')
    expect(previewKindOf('clipboard', 'text/markdown')).toBe('markdown')
    expect(previewKindOf('clipboard', 'application/zip')).toBe('external')
  })
})

describe('产物预览框', () => {
  it('Markdown 用现有渲染器出结构，不是一坨 <pre>', async () => {
    const stub = stubApi('report.md', 'text/markdown', 12, '# 周报\n\n正文')
    await mountPreview(stub, 'report.md', 'text/markdown', 12)

    expect(container.querySelector('.attach-preview-md h1')?.textContent).toBe('周报')
    expect(container.querySelector('pre')).toBeNull()
  })

  it('图片与 PDF 直接吃字节 URL：内嵌，不产生下载跳转', async () => {
    const image = stubApi('shot.png', 'image/png', 2048)
    await mountPreview(image, 'shot.png', 'image/png', 2048)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(`${RAW.replace('report.md', 'shot.png')}`)

    // PDF 交给 Chromium 自带的阅读器：<object> + type，浏览器据此挂上阅读器。
    // 早先这里断言「没有 iframe / 不能预览」，那是把症状当成了事实——真正缺的是
    // 主进程里的 webPreferences.plugins。这一条要同时钉住组件侧与主进程侧，
    // 否则少任何一边，用户看到的都是一块空白框。
    const pdf = stubApi('book.pdf', 'application/pdf', 4096)
    await mountPreview(pdf, 'book.pdf', 'application/pdf', 4096)
    const embed = container.querySelector('object[type="application/pdf"]')
    expect(embed).not.toBeNull()
    expect(embed?.getAttribute('data')).toBe(`${RAW.replace('report.md', 'book.pdf')}`)
    // 阅读器没起来时仍有出路：不能把用户丢给一个空白页。
    expect(container.textContent).toContain('用系统程序打开')
    expect(container.textContent).toContain('下载')
    expect(container.querySelector('a[download]')).not.toBeNull()
  })

  it('HTML 渲染成页面：blob URL + 不授同源的 sandbox iframe，不是一坨源码', async () => {
    const stub = stubApi('index.html', 'text/html', 128, '<h1>hi</h1>')
    await mountPreview(stub, 'index.html', 'text/html', 128)

    const frame = container.querySelector('iframe')
    expect(frame).not.toBeNull()
    // 一份 .html 产物最常见的形态就是「只有这一个文件」，所以 src 必须是自足的
    // blob：走 /api/files/…/raw 会把相对路径的 <link>/<img> 解析到 API 路由上去。
    expect(frame?.getAttribute('src')).toBe('blob:preview/0')
    expect(container.querySelector('pre')).toBeNull()
    // 默认静态预览：脚本不跑。给了 allow-same-origin 的话，产物里的 <script>
    // 就与本应用同源，那时才真的需要消毒器——所以这一位必须一直是空的。
    expect(frame?.getAttribute('sandbox')).toBe('')
  })

  it('开关切到交互预览只加 allow-scripts，同源/顶层跳转/弹窗始终不给', async () => {
    const stub = stubApi('game.html', 'text/html', 128, '<button onclick="x()">go</button>')
    await mountPreview(stub, 'game.html', 'text/html', 128)

    const toggle = [...container.querySelectorAll('button')].find((b) => {
      return b.textContent === '交互预览'
    })
    expect(toggle).not.toBeUndefined()
    await act(async () => {
      toggle?.click()
    })
    const frame = container.querySelector('iframe')
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
    for (const forbidden of ['allow-same-origin', 'allow-top-navigation', 'allow-popups']) {
      expect(frame?.getAttribute('sandbox')).not.toContain(forbidden)
    }

    // 切回去又是静态预览：开关得真的双向，不是只进不退。
    await act(async () => {
      toggle?.click()
    })
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('')
  })

  it('HTML 的 blob URL 换文件即收回、卸载即收回，不在文档上留副本', async () => {
    const stub = stubApi('a.html', 'text/html', 8, '<p>a</p>')
    await mountPreview(stub, 'a.html', 'text/html', 8)
    expect(blobUrls.created).toEqual(['blob:preview/0'])
    expect(blobUrls.revoked).toEqual([])

    await act(async () => {
      root.render(
        <ArtifactPreview api={stub.api} target={{ name: 'b.html', mime: 'text/html', size: 8 }} onClose={() => {}} />,
      )
    })
    // 切产物：上一份的 URL 必须先被 revoke，否则它一直挂在文档上直到销毁。
    expect(blobUrls.revoked).toEqual(['blob:preview/0'])

    act(() => {
      root.unmount()
    })
    expect(blobUrls.revoked).toEqual(['blob:preview/0', 'blob:preview/1'])
  })

  it('HTML 超上限就不内嵌，说清体积并给出出路', async () => {
    const stub = stubApi('huge.html', 'text/html', HTML_PREVIEW_MAX_BYTES + 1, '')
    await mountPreview(stub, 'huge.html', 'text/html', HTML_PREVIEW_MAX_BYTES + 1)

    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain('太大了')
    expect(container.textContent).toContain('在新窗口打开')
    // 读都没读：正文是主线程上三趟重活，超限时先拒绝才不算白读。
    expect(blobUrls.created).toEqual([])
  })

  it('docx 明确说清不能内嵌，并给出用系统程序打开 / 下载 / 复制路径', async () => {
    const stub = stubApi('方案.docx', 'application/octet-stream', 30_000)
    await mountPreview(stub, '方案.docx', 'application/octet-stream', 30_000)

    expect(container.textContent).toContain('不能内嵌预览')
    const open = [...container.querySelectorAll('button')].find((b) => {
      return b.textContent === '用系统程序打开'
    })
    await act(async () => {
      open?.click()
    })
    expect(stub.opened).toEqual(['C:/ws/.ryharness-artifacts/方案.docx'])

    const copy = [...container.querySelectorAll('button')].find((b) => {
      return b.textContent === '复制路径'
    })
    await act(async () => {
      copy?.click()
    })
    expect(stub.copied).toEqual(['C:/ws/.ryharness-artifacts/方案.docx'])
  })

  it('读不到文件时报错并保留重试，不是一块白板', async () => {
    const stub = stubApi('gone.txt', 'text/plain', 1)
    stub.api.fileInfo = () => {
      return Promise.reject(new Error('file not found: gone.txt'))
    }
    await mountPreview(stub, 'gone.txt', 'text/plain', 1)
    expect(container.textContent).toContain('file not found: gone.txt')
  })

  it('Esc 关掉预览框', async () => {
    let closed = 0
    const stub = stubApi('a.txt', 'text/plain', 1, 'x')
    await act(async () => {
      root.render(
        <ArtifactPreview
          api={stub.api}
          target={{ name: 'a.txt', mime: 'text/plain', size: 1 }}
          onClose={() => {
            closed += 1
          }}
        />,
      )
    })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(closed).toBe(1)
  })
})

describe('产物卡的入口', () => {
  const fileMessage: UiMessage = {
    key: 'f1',
    senderType: 'agent',
    senderId: 'ryen',
    senderName: 'Ryen',
    turnIndex: 0,
    done: true,
    parts: [{ kind: 'file', callId: 'c1', name: 'report.md', size: 2048, mime: 'text/markdown' }],
  }

  it('气泡里的文件卡点「预览」走回调；「下载」仍是显式的那一个动作', async () => {
    const opened: string[] = []
    stubApi('report.md', 'text/markdown', 2048)
    await act(async () => {
      root.render(
        <MessageBubble
          message={fileMessage}
          fileUrl={(n) => {
            return `/api/files/${n}`
          }}
          onPreview={(target) => {
            opened.push(target.name)
          }}
        />,
      )
    })
    const preview = [...container.querySelectorAll('button')].find((b) => {
      return b.textContent === '预览'
    })
    expect(preview).not.toBeUndefined()
    expect(container.querySelector('a[download]')).not.toBeNull()

    await act(async () => {
      preview?.click()
    })
    expect(opened).toEqual(['report.md'])
  })

  it('右栏产物行同样走预览回调', async () => {
    const opened: string[] = []
    const stub = stubApi('report.md', 'text/markdown', 2048)
    const store = new ChatStore()
    store.apply({ type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 0 })
    store.apply({
      type: 'produce-card',
      conversationId: 'c1',
      senderId: 'ryen',
      callId: 'c1',
      card: { path: 'C:/ws/.ryharness-artifacts/report.md', name: 'report.md', size: 2048, mime: 'text/markdown' },
    })
    await act(async () => {
      root.render(
        <RightPanel
          api={stub.api}
          store={store}
          conversation={{
            id: 'c1',
            kind: 'direct',
            title: 'Ryen',
            memberAgentIds: ['ryen'],
            lastReadSeq: 1,
            createdAt: 1,
            updatedAt: 1,
          }}
          agents={[
            { id: 'ryen', name: 'Ryen', systemPrompt: '', provider: 'p', model: 'm', tools: [], isBuiltin: true },
          ]}
          conversations={[]}
          fileUrl={(n) => {
            return `/api/files/${n}`
          }}
          collapsed={false}
          onToggle={() => {}}
          onPreview={(target) => {
            opened.push(target.name)
          }}
        />,
      )
    })
    const preview = [...container.querySelectorAll<HTMLButtonElement>('.artifact-list button')].filter((b) => {
      return b.textContent === '预览'
    })
    expect(preview).toHaveLength(1)
    await act(async () => {
      preview[0]?.click()
    })
    expect(opened).toEqual(['report.md'])
  })
})
